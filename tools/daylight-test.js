#!/usr/bin/env node
/**
 * Does the lamp actually need to be taken out of daylight mode before it will
 * accept a brightness or colour-temperature write?
 *
 * The plugin sends `13 20 01 00 00` to `2dd10021` before every such write,
 * because the reverse-engineering notes say the lamp otherwise discards the
 * value. That has never been checked against hardware, and it costs the user a
 * feature they like: the lamp stops tracking daylight the moment HomeKit
 * touches it. If writes land without it, the whole mechanism can go.
 *
 * Runs on the Raspberry Pi, from a directory where `node-ble` is installed:
 *
 *   node daylight-test.js watch      F0:B1:… E5T-EU-… [seconds]
 *   node daylight-test.js hunt       F0:B1:… E5T-EU-…
 *   node daylight-test.js trial      F0:B1:… E5T-EU-… [--manual] [--repeat N]
 *
 * Crypto and framing are imported from the installed plugin rather than
 * reimplemented, so what this exercises is the code that actually ships.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';

import { createBluetooth } from 'node-ble';

const PLUGIN = process.env.DYSON_PLUGIN_DIR
  ?? '/var/lib/homebridge/node_modules/homebridge-dyson-solarcycle-morph';
const PERSIST = process.env.DYSON_PERSIST_DIR
  ?? '/var/lib/homebridge/homebridge-dyson-solarcycle-morph/persist';

const { deriveAesKey, buildReauthPayloadA, buildReauthPayloadC, parseReauthPayloadB } =
  await import(join(PLUGIN, 'dist/dyson/crypto.js'));
const {
  CHAR_AUTH, CHAR_RSSI, CHAR_WRITE_ATTR, CHAR_COLOR_TEMP, CHAR_POWER, CHAR_BRIGHTNESS_LM,
  MsgType, DAYLIGHT_MODE_DISABLE, MessageAssembler, fragmentMessage,
} = await import(join(PLUGIN, 'dist/dyson/protocol.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (buf) => buf.toString('hex').replace(/(..)/g, '$1 ').trim();

/**
 * The two targets each trial alternates between.
 *
 * Far apart, so a value that lands is unmistakable, and both well inside the
 * lamp's range so neither can be explained away as clamping.
 */
const TARGETS = [
  { lumens: 200, kelvin: 2700 },
  { lumens: 900, kelvin: 6500 },
];

/** How long to give the lamp before reading back. */
const SETTLE_MS = 2_000;

function usage() {
  console.error('Usage: node daylight-test.js <watch|hunt|trial> <MAC> <SERIAL> [options]');
  process.exit(1);
}

/**
 * Read the long-term key straight out of node-persist's directory.
 *
 * Deliberately not via the plugin's CredentialStore: this script has no
 * business initialising a store the running plugin also writes to.
 */
function loadCredentials(serial) {
  const wanted = `${serial.trim().toUpperCase()}:credentials`;
  for (const name of readdirSync(PERSIST)) {
    try {
      const entry = JSON.parse(readFileSync(join(PERSIST, name), 'utf8'));
      if (entry.key === wanted && entry.value?.ltk && entry.value?.accountId) {
        return entry.value;
      }
    } catch {
      // Not one of ours, or half-written. Either way, keep looking.
    }
  }
  throw new Error(`No stored credentials for ${serial} in ${PERSIST} — is the serial right?`);
}

/** Everything the lamp says, in one stream, so ordering is visible. */
class Session {
  constructor(mac, credentials) {
    this.mac = mac;
    this.key = deriveAesKey(Buffer.from(credentials.ltk, 'hex'));
    this.accountId = credentials.accountId;
    this.assembler = new MessageAssembler();
    this.waiters = new Map();
    this.chars = {};
    this.writeTypes = {};
    this.t0 = Date.now();
  }

  log(...parts) {
    const t = ((Date.now() - this.t0) / 1000).toFixed(2).padStart(7);
    console.log(`[${t}s]`, ...parts);
  }

  async open() {
    const { bluetooth, destroy } = createBluetooth();
    this.destroy = destroy;
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isPowered())) {
      throw new Error('Bluetooth adapter is powered off — run: bluetoothctl power on');
    }
    // The plugin found a scan has to be running across the connect, not before it.
    if (!(await adapter.isDiscovering())) {
      await adapter.startDiscovery();
      this.startedDiscovery = true;
      await sleep(500);
    }

    this.log(`Waiting for ${this.mac} …`);
    this.device = await adapter.waitDevice(this.mac, 60_000);
    // The link to this lamp runs a few dB above the plugin's weak threshold and
    // drops occasionally. A drop between the write and the read-back would look
    // exactly like the lamp discarding the write, which is the one conclusion
    // this script exists to get right, so trials that span one are thrown away.
    this.drops = 0;
    this.device.on('disconnect', () => {
      this.drops++;
      this.log('Link dropped');
    });

    let lastError;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await this.device.connect();
        this.log(`Connected on attempt ${attempt}`);
        lastError = undefined;
        break;
      } catch (e) {
        lastError = e;
        await sleep(1_000);
      }
    }
    if (lastError) {
      throw lastError;
    }

    const gatt = await this.device.gatt();
    const wanted = new Set([
      CHAR_AUTH, CHAR_RSSI, CHAR_WRITE_ATTR, CHAR_COLOR_TEMP, CHAR_POWER, CHAR_BRIGHTNESS_LM,
    ]);
    for (const serviceUuid of await gatt.services()) {
      const service = await gatt.getPrimaryService(serviceUuid);
      for (const charUuid of await service.characteristics()) {
        if (!wanted.has(charUuid)) {
          continue;
        }
        const characteristic = await service.getCharacteristic(charUuid);
        this.chars[charUuid] = characteristic;
        const flags = await characteristic.getFlags().catch(() => []);
        this.writeTypes[charUuid] = flags.includes('write') ? 'request' : 'command';
      }
    }
    if (this.startedDiscovery) {
      await adapter.stopDiscovery().catch(() => {});
      this.startedDiscovery = false;
    }

    const auth = this.chars[CHAR_AUTH];
    auth.on('valuechanged', (buffer) => {
      const message = this.assembler.push(buffer);
      if (!message) {
        return;
      }
      const waiter = this.waiters.get(message.type);
      if (waiter) {
        this.waiters.delete(message.type);
        waiter(message);
      }
    });
    await auth.startNotifications();
    await this.authenticate();
  }

  async write(uuid, value) {
    await this.chars[uuid].writeValue(value, { type: this.writeTypes[uuid] ?? 'command' });
  }

  async send(type, payload) {
    for (const fragment of fragmentMessage(type, payload)) {
      await this.write(CHAR_AUTH, fragment);
    }
  }

  waitFor(type, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(type);
        reject(new Error(`timed out waiting for 0x${type.toString(16)}`));
      }, timeoutMs);
      this.waiters.set(type, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  async authenticate() {
    await this.send(MsgType.REQUEST_PRODUCT_INFO);
    await this.waitFor(MsgType.PRODUCT_INFO, 5_000).catch(() => {});
    const nonce = randomBytes(16);
    await this.send(MsgType.REAUTH_PAYLOAD_A, buildReauthPayloadA(this.accountId, this.key, nonce));
    const payloadB = await this.waitFor(MsgType.REAUTH_PAYLOAD_B, 10_000);
    const challenge = parseReauthPayloadB(this.key, payloadB.payload);
    await this.send(MsgType.REAUTH_PAYLOAD_C, buildReauthPayloadC(this.key, challenge));
    await this.waitFor(MsgType.CONNECTION_ESTABLISHED, 10_000);
    this.log('Authenticated');
  }

  /** Subscribe to every characteristic that will notify, and print what arrives. */
  async watchAll() {
    const labels = {
      [CHAR_WRITE_ATTR]: 'attr',
      [CHAR_BRIGHTNESS_LM]: 'lumens',
      [CHAR_COLOR_TEMP]: 'kelvin',
      [CHAR_POWER]: 'power',
    };
    for (const [uuid, label] of Object.entries(labels)) {
      const characteristic = this.chars[uuid];
      if (!characteristic) {
        continue;
      }
      characteristic.on('valuechanged', (buf) => {
        const extra = buf.length === 2 ? ` u16le=${buf.readUInt16LE(0)}` : buf.length === 1 ? ` u8=${buf[0]}` : '';
        this.log(`notify ${label.padEnd(6)} ${hex(buf)}${extra}`);
      });
      await characteristic.startNotifications().catch((e) => {
        this.log(`notify ${label}: unavailable (${e.message})`);
      });
    }
  }

  async readState() {
    const read = async (uuid) => {
      try {
        return await this.chars[uuid].readValue();
      } catch {
        return undefined;
      }
    };
    const lumens = await read(CHAR_BRIGHTNESS_LM);
    const kelvin = await read(CHAR_COLOR_TEMP);
    const power = await read(CHAR_POWER);
    return {
      lumens: lumens?.length === 2 ? lumens.readUInt16LE(0) : undefined,
      kelvin: kelvin?.length === 2 ? kelvin.readUInt16LE(0) : undefined,
      power: power?.length ? power[0] : undefined,
    };
  }

  async close() {
    await this.device?.disconnect().catch(() => {});
    this.destroy?.();
  }
}

const ask = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
};

/**
 * One measurement: write a target and see where the lamp ends up.
 *
 * Brightness is the weaker signal of the two — the lamp adjusts it to track
 * daylight, so landing off-target proves nothing on its own. Colour temperature
 * is the one that decides this, because nothing else moves it.
 */
async function runTrial(session, requested, { manual, only = 'both', gapMs = 0 }) {
  const dropsAtStart = session.drops;
  const current = await session.readState();
  // Aim at whichever end of the range the lamp is furthest from, so every trial
  // has an unambiguous answer.
  const target = {
    lumens: (current.lumens ?? 0) > 550 ? 200 : 900,
    kelvin: (current.kelvin ?? 0) > 4600 ? 2700 : 6500,
  };
  if (manual) {
    await session.write(CHAR_WRITE_ATTR, DAYLIGHT_MODE_DISABLE);
    await sleep(200);
  }
  const before = current;

  if (only !== 'kelvin') {
    const lumens = Buffer.alloc(2);
    lumens.writeUInt16LE(target.lumens);
    await session.write(CHAR_BRIGHTNESS_LM, lumens);
  }

  if (only === 'both' && gapMs > 0) {
    await sleep(gapMs);
  }

  if (only !== 'lumens') {
    const kelvin = Buffer.alloc(2);
    kelvin.writeUInt16LE(target.kelvin);
    await session.write(CHAR_COLOR_TEMP, kelvin);
  }

  await sleep(SETTLE_MS);
  const after = await session.readState();

  if (session.drops !== dropsAtStart) {
    session.log('Discarding this trial: the link dropped while it was running');
    return { manual, asked: target, void: true };
  }

  const row = {
    manual,
    asked: target,
    before: { lumens: before.lumens, kelvin: before.kelvin },
    after: { lumens: after.lumens, kelvin: after.kelvin },
    kelvinLanded: after.kelvin === target.kelvin,
    kelvinMoved: before.kelvin !== after.kelvin,
    lumensDelta: after.lumens === undefined ? undefined : after.lumens - target.lumens,
  };
  session.log(
    `${manual ? 'manual  ' : 'no-manual'} [${only}${gapMs ? `+${gapMs}ms` : ''}] ` +
      `ask ${target.lumens}lm/${target.kelvin}K  ` +
      `→ ${after.lumens ?? '?'}lm/${after.kelvin ?? '?'}K  ` +
      `(kelvin ${row.kelvinLanded ? 'LANDED' : row.kelvinMoved ? 'moved, off target' : 'DID NOT MOVE'})`,
  );
  return row;
}

async function main() {
  const [mode, mac, serial, ...rest] = process.argv.slice(2);
  if (!mode || !mac || !serial) {
    usage();
  }
  const manual = rest.includes('--manual');
  // Set when the lamp is already in the state the trial needs and nobody is
  // sitting at the terminal to confirm it.
  const noPrompt = rest.includes('--no-prompt');
  // The plugin debounces per characteristic, so its writes are always spaced
  // apart in real time. Writing both back to back is this tool's invention, and
  // it is a difference worth being able to switch off.
  const only = rest.includes('--kelvin-only') ? 'kelvin' : rest.includes('--lumens-only') ? 'lumens' : 'both';
  const gapIndex = rest.indexOf('--gap');
  const gapMs = gapIndex === -1 ? 0 : Number(rest[gapIndex + 1] ?? 0);
  const repeatFlag = rest.indexOf('--repeat');
  const repeat = repeatFlag === -1 ? 1 : Number(rest[repeatFlag + 1] ?? 1);
  const seconds = Number(rest.find((a) => /^\d+$/.test(a)) ?? 60);

  const session = new Session(mac.toUpperCase(), loadCredentials(serial));
  await session.open();

  try {
    if (mode === 'watch') {
      // Answers the standing question of whether daylight mode is observable at
      // all: if toggling it in the app notifies on 2dd10021, it is readable
      // state and the TTL guesswork can be replaced with a subscription.
      await session.watchAll();
      session.log(`Initial state: ${JSON.stringify(await session.readState())}`);
      console.log(
        `\nWatching for ${seconds}s. Toggle daylight mode in the MyDyson app, then use the\n` +
          'physical buttons, and note the wall-clock order — anything that appears below is\n' +
          'state the plugin could subscribe to instead of guessing.\n',
      );
      await sleep(seconds * 1_000);
      return;
    }

    if (mode === 'hunt') {
      // The disable payload is known; its counterpart is not. Without a way to
      // put the lamp back into daylight mode, every no-manual trial after the
      // first is contaminated, so this is worth finding.
      await session.watchAll();
      const candidates = [
        Buffer.from([0x13, 0x20, 0x01, 0x00, 0x01]),
        Buffer.from([0x13, 0x20, 0x01, 0x01, 0x00]),
        Buffer.from([0x13, 0x20, 0x01, 0x01, 0x01]),
        Buffer.from([0x13, 0x20, 0x00, 0x00, 0x01]),
      ];
      for (const candidate of candidates) {
        session.log(`Writing ${hex(candidate)} to the attribute channel`);
        await session.write(CHAR_WRITE_ATTR, candidate);
        await sleep(3_000);
        session.log(`State now: ${JSON.stringify(await session.readState())}`);
        const answer = await ask('  Did the lamp go back to tracking daylight? [y/N/q] ');
        if (answer.toLowerCase().startsWith('y')) {
          console.log(`\nFound it: ${hex(candidate)} re-enables daylight mode.`);
          return;
        }
        if (answer.toLowerCase().startsWith('q')) {
          return;
        }
      }
      console.log('\nNone of the candidates re-enabled daylight mode.');
      return;
    }

    if (mode === 'trial') {
      await session.watchAll();
      const rows = [];
      for (let i = 0; i < repeat; i++) {
        if (!manual && !noPrompt) {
          await ask(
            `\nTrial ${i + 1}/${repeat}: put the lamp into daylight mode (MyDyson app or the\n` +
              '  button on the lamp), confirm it is tracking, then press Enter. ',
          );
        }
        session.log(`--- trial ${i + 1}/${repeat} ---`);
        rows.push(await runTrial(session, TARGETS[i % TARGETS.length], { manual, only, gapMs }));
      }

      const valid = rows.filter((r) => !r.void);
      const landed = valid.filter((r) => r.kelvinLanded).length;
      const discarded = rows.length - valid.length;
      console.log(`\n${manual ? 'With' : 'Without'} the daylight-off write: ` +
        `colour temperature landed on target in ${landed} of ${valid.length} trials` +
        `${discarded ? ` (${discarded} discarded to link drops)` : ''}.`);
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    usage();
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
});
