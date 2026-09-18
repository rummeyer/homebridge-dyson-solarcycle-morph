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
 *   node daylight-test.js watch     F0:B1:… E5T-EU-… [seconds]
 *   node daylight-test.js trial     F0:B1:… E5T-EU-… [--repeat N] [--kelvin-only]
 *   node daylight-test.js attrread  F0:B1:… E5T-EU-…
 *   node daylight-test.js writescan F0:B1:… E5T-EU-…
 *
 * `watch` prints everything the lamp notifies. `trial` writes values and checks
 * whether they landed. `attrread` reads an attribute range, which cannot
 * disturb anything, and `setattr` writes one. `charwrite` reads and writes a
 * characteristic by its four-digit id — how the lamp's mode switches were
 * found. `monitor` polls everything and reports what changed, so whoever is at
 * the lamp can flip a switch whenever they like rather than inside a window
 * someone else opened.
 *
 * Crypto and framing are imported from the installed plugin rather than
 * reimplemented, so what this exercises is the code that actually ships.
 *
 * Modes that answered a question once have been removed rather than left to
 * rot; what they found is in docs/PROTOCOL.md.
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
  MsgType, MessageAssembler, fragmentMessage,
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
  console.error('Usage: node daylight-test.js <watch|trial|attrread|setattr|charwrite|monitor> <MAC> <SERIAL> [options]');
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
      '2dd11000-1c37-452d-8979-d1b4a787d0a4',
      '2dd11004-1c37-452d-8979-d1b4a787d0a4',
      '2dd11006-1c37-452d-8979-d1b4a787d0a4',
      '2dd11008-1c37-452d-8979-d1b4a787d0a4',
      '2dd11007-1c37-452d-8979-d1b4a787d0a4',
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
      '2dd11000-1c37-452d-8979-d1b4a787d0a4': 'pct',
      '2dd11004-1c37-452d-8979-d1b4a787d0a4': '1004',
      '2dd11006-1c37-452d-8979-d1b4a787d0a4': 'auto',
      '2dd11007-1c37-452d-8979-d1b4a787d0a4': 'movemode',
      '2dd11008-1c37-452d-8979-d1b4a787d0a4': '1008',
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
    await session.write(CHAR_WRITE_ATTR, Buffer.from([0x80, 0x93, 0x13, 0x20, 0x01, 0x00, 0x00]));
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

    if (mode === 'attrread') {
      // Read every attribute the app knows about. Type 0x90 asks, and whatever
      // the lamp answers with is captured raw. Nothing is written, so this
      // cannot disturb a setting whose meaning we do not know yet.
      const answers = new Map();
      const attr = session.chars[CHAR_WRITE_ATTR];
      attr?.on('valuechanged', (buf) => {
        if (buf.length >= 4 && buf[0] === 0x80) {
          answers.set(`${buf[1].toString(16)}:${buf.readUInt16LE(2).toString(16)}`, hex(buf));
        }
      });
      await attr?.startNotifications();

      const state = await session.readState();
      session.log(`Lamp is at ${state.lumens}lm / ${state.kelvin}K — look for those values below`);

      // Sweep the range rather than only the ids the app's light module names:
      // reads cannot disturb anything, and the live values have to live
      // somewhere. Anything matching the lamp's current state is the answer.
      // Range is settable: `attrread <MAC> <SERIAL> 0x2040 0x2100`.
      const from = rest[0] ? Number(rest[0]) : 0x2000;
      const to = rest[1] ? Number(rest[1]) : 0x2040;
      const ids = [];
      for (let id = from; id <= to; id++) {
        ids.push(id);
      }
      for (const id of ids) {
        answers.clear();
        const body = Buffer.alloc(2);
        body.writeUInt16LE(id);
        for (const fragment of fragmentMessage(0x90, body)) {
          await session.write(CHAR_WRITE_ATTR, fragment);
        }
        await sleep(180);
        const got = [...answers.values()];
        // The value follows attribute(2) and length(2); decode it both ways so
        // a 2-byte number is readable at a glance.
        const decoded = got.map((raw) => {
          const b = Buffer.from(raw.replace(/ /g, ''), 'hex');
          if (b.length >= 7) {
            // header, type, attribute(2), status, length(2), value
            const v = b.subarray(7);
            return v.length === 2 ? `${v.readUInt16LE(0)}` : v.length === 1 ? `${v[0]}` : hex(v);
          }
          return '';
        }).filter(Boolean);
        if (got.length === 0) {
          continue;
        }
        const hit = decoded.some(
          (d) => Math.abs(Number(d) - (state.kelvin ?? -1)) < 40 || Math.abs(Number(d) - (state.lumens ?? -1)) < 25,
        );
        session.log(`0x${id.toString(16)}  → ${decoded.join(' ')}${hit ? '   *** MATCHES LAMP STATE ***' : ''}`);
      }
      return;
    }

    if (mode === 'charwrite') {
      // Read and optionally write one characteristic by its short id:
      //   charwrite <MAC> <SERIAL> 1006 [value]
      // The app drives the lamp's Auto and movement switches this way rather
      // than through the attribute channel.
      const short = rest[0];
      const uuid = `2dd1${short}-1c37-452d-8979-d1b4a787d0a4`;
      const characteristic = session.chars[uuid];
      if (!characteristic) {
        session.log(`${uuid} was not discovered`);
        return;
      }
      characteristic.on('valuechanged', (buf) => session.log(`  notify ${short}: ${hex(buf)}`));
      await characteristic.startNotifications().catch(() => {});
      session.log(`${short} reads ${hex(await characteristic.readValue())}`);
      if (rest[1] !== undefined) {
        const value = Number(rest[1]);
        session.log(`Writing ${short} = ${value}`);
        await session.write(uuid, Buffer.from([value]));
        await sleep(3_000);
        session.log(`${short} now reads ${hex(await characteristic.readValue())}`);
      }
      return;
    }

    if (mode === 'setattr') {
      // Write one attribute by hand: `setattr <MAC> <SERIAL> 0x2026 1`.
      // Reads it first and prints the old value, so it can be put back.
      const id = Number(rest[0]);
      const value = Number(rest[1]);
      const attr = session.chars[CHAR_WRITE_ATTR];
      attr?.on('valuechanged', (buf) => session.log(`  attr ${hex(buf)}`));
      await attr?.startNotifications();
      await session.watchAll();

      const body = Buffer.alloc(2);
      body.writeUInt16LE(id);
      for (const f of fragmentMessage(0x90, body)) {
        await session.write(CHAR_WRITE_ATTR, f);
      }
      await sleep(600);
      session.log(`Writing 0x${id.toString(16)} = ${value}`);
      const set = Buffer.alloc(4);
      set.writeUInt16LE(id, 0);
      set.writeUInt16LE(1, 2);
      for (const f of fragmentMessage(0x93, Buffer.concat([set, Buffer.from([value])]))) {
        await session.write(CHAR_WRITE_ATTR, f);
      }
      await sleep(5_000);
      session.log(`State now ${JSON.stringify(await session.readState())}`);
      return;
    }

    if (mode === 'monitor') {
      // Identification without a stopwatch. Reads every attribute in a loop and
      // says only what changed, so whoever is at the lamp can flip a switch
      // whenever they like instead of inside a window someone else opened.
      const ids = [
        0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2009, 0x200a, 0x200b, 0x200d,
        0x2013, 0x2014, 0x2015, 0x2017, 0x2018, 0x201b, 0x201c, 0x201d, 0x201e,
        0x201f, 0x2021, 0x2023, 0x2024, 0x2025, 0x2026, 0x2028, 0x2029, 0x2030,
        0x2031, 0x2032,
      ];
      const attr = session.chars[CHAR_WRITE_ATTR];
      attr?.on('valuechanged', (buf) => {
        if (buf.length >= 7 && buf[1] === 0x97) {
          console.log(`*** LAMP REPORTS 0x${buf.readUInt16LE(2).toString(16)} = ${buf[buf.length - 1]}`);
        }
      });
      await attr?.startNotifications();

      const readOne = async (id) => {
        let answer;
        const handler = (buf) => {
          if (buf.length >= 8 && buf[1] === 0x91 && buf.readUInt16LE(2) === id && buf[4] === 0) {
            answer = hex(buf.subarray(7));
          }
        };
        attr?.on('valuechanged', handler);
        const body = Buffer.alloc(2);
        body.writeUInt16LE(id);
        for (const f of fragmentMessage(0x90, body)) {
          await session.write(CHAR_WRITE_ATTR, f);
        }
        await sleep(200);
        attr?.off('valuechanged', handler);
        return answer;
      };

      const known = new Map();
      for (const id of ids) {
        known.set(id, await readOne(id));
      }
      console.log(`\nWatching ${known.size} attributes for ${seconds}s. Flip the switch whenever you like.`);
      console.log('Anything that changes is printed the moment it is noticed.\n');

      const until = Date.now() + seconds * 1_000;
      while (Date.now() < until) {
        for (const id of ids) {
          const now = await readOne(id);
          if (now !== undefined && now !== known.get(id)) {
            console.log(`*** 0x${id.toString(16)}: ${known.get(id)} → ${now}`);
            known.set(id, now);
          }
        }
      }
      console.log('\nDone watching.');
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
