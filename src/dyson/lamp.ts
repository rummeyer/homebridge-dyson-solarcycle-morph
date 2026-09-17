/**
 * BLE transport and session management for a single Morph lamp.
 *
 * Owns the BlueZ connection, runs the LTK handshake after every reconnect, and
 * exposes the lamp as a small state machine with cached state. All GATT traffic
 * is serialised through one queue: BlueZ will happily return `InProgress` or
 * drop replies if two D-Bus calls overlap on the same characteristic.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

import { Variant } from 'dbus-next';
import { createBluetooth } from 'node-ble';
import type { Adapter, Device, GattCharacteristic, GattServer } from 'node-ble';

import { buildReauthPayloadA, buildReauthPayloadC, deriveAesKey, parseReauthPayloadB } from './crypto.js';
import { Debouncer } from './debounce.js';
import { OperationQueue } from './queue.js';
import { planReconciliation } from './reconcile.js';
import { SettleWindow } from './settle.js';
import {
  CHAR_AUTH,
  CHAR_BRIGHTNESS_LM,
  CHAR_COLOR_TEMP,
  CHAR_MOTION,
  CHAR_POWER,
  CHAR_WRITE_ATTR,
  DAYLIGHT_MODE_DISABLE,
  DysonMessage,
  MAX_KELVIN,
  MessageAssembler,
  MIN_KELVIN,
  MsgType,
  fragmentMessage,
  lumensToPercent,
  percentToLumens,
} from './protocol.js';

/** Characteristics we look for. Anything else the lamp exposes is ignored. */
const WANTED_CHARACTERISTICS = new Set([
  CHAR_AUTH,
  CHAR_POWER,
  CHAR_BRIGHTNESS_LM,
  CHAR_COLOR_TEMP,
  CHAR_WRITE_ATTR,
  CHAR_MOTION,
]);

/** Without these there is no point continuing. */
const REQUIRED_CHARACTERISTICS = [CHAR_AUTH, CHAR_POWER];

/** Delays between reconnect attempts; the last value repeats. */
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** How long to scan for a lamp BlueZ has never seen. */
const DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Pause between starting discovery and connecting.
 *
 * Measured, not guessed: a connect issued straight after discovery starts is
 * aborted by the controller every time, while the same connect succeeds after
 * a few seconds of scanning.
 */
const DISCOVERY_SETTLE_MS = 8_000;

/** The lamp can take a while to answer the first handshake message. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Re-assert manual mode if the last write was longer ago than this. Writing it
 * before every command would be wasteful; never writing it means the lamp
 * silently ignores us after someone used the physical daylight button.
 */
const MANUAL_MODE_TTL_MS = 60_000;

/**
 * Signal strength below which the link is unreliable.
 *
 * BLE connections start timing out around here, and the symptom — connect,
 * drop, reconnect — looks like a software fault unless the number is shown.
 */
const WEAK_RSSI_DBM = -80;

/** The lamp needs a moment to apply a mode change before the next write. */
const MODE_SETTLE_MS = 200;


/**
 * How long after the last command to check the lamp agrees.
 *
 * Verification cannot sit in the command's own path. The write itself takes a
 * millisecond; waiting for the lamp to apply it and reading it back costs
 * several hundred more, which was most of the time it took to switch the lamp
 * off. It runs once instead, after commands stop arriving, against the state
 * the user ended up asking for.
 */
const RECONCILE_DELAY_MS = 900;

/**
 * How long to disregard the lamp's own reports about a value just commanded.
 *
 * The lamp ramps rather than jumping, notifying each step on the way. Long
 * enough to cover that climb, short enough that a change made at the lamp
 * itself shows up promptly.
 */
const SETTLE_MS = 3_000;


/**
 * How long to wait for a slider to settle before writing.
 *
 * Dragging brightness or colour temperature in HomeKit emits several values a
 * second. Sending each one queues writes faster than the lamp applies them, so
 * it visibly lags the slider. Only the value the user stops on matters.
 */
const WRITE_DEBOUNCE_MS = 400;

export interface LampState {
  on: boolean;
  /** HomeKit-style brightness, 0-100 %. */
  brightness: number;
  /** Colour temperature in Kelvin, 2700-6500. */
  kelvin: number;
}

export interface LampOptions {
  /** BLE MAC, e.g. `AA:BB:CC:DD:EE:FF`. */
  mac: string;
  /** Long-term key as a hex string, from {@link DysonCloud.fetchLtk}. */
  ltk: string;
  /** Dyson account GUID that the LTK was issued to. */
  accountId: string;
  /** Optional HCI adapter name, e.g. `hci0`. Defaults to the system default. */
  adapter?: string;
  log?: Logger;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export declare interface DysonMorphLamp {
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;
  on(event: 'state', listener: (state: LampState) => void): this;
  on(event: 'motion', listener: (detected: boolean) => void): this;
}

export class DysonMorphLamp extends EventEmitter {
  private readonly mac: string;
  private readonly aesKey: Buffer;
  private readonly accountId: string;
  private readonly adapterName: string | undefined;
  private readonly log: Logger;

  private bluetooth?: ReturnType<typeof createBluetooth>;
  private adapter?: Adapter;
  private device?: Device;
  private chars: Partial<Record<string, GattCharacteristic>> = {};
  /** Per-characteristic write mode, derived from the flags the lamp advertises. */
  private writeTypes: Partial<Record<string, 'request' | 'command'>> = {};

  private readonly assembler = new MessageAssembler();
  private readonly waiters = new Map<number, (message: DysonMessage) => void>();

  /** Serialises all GATT access. */
  private readonly operations = new OperationQueue();

  private readonly writes = new Debouncer(WRITE_DEBOUNCE_MS, (task, key) => this.enqueue(task, key));
  private readonly reconciles = new Debouncer(RECONCILE_DELAY_MS, (task, key) => this.enqueue(task, key));
  private readonly settling = new SettleWindow(SETTLE_MS);

  private running = false;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private manualModeSetAt = 0;

  private state: LampState = { on: false, brightness: 100, kelvin: 2700 };


  /** What the user last asked for. Reconciliation aims at this, not at guesses. */
  private desired: Partial<LampState> = {};




  constructor(options: LampOptions) {
    super();
    this.mac = options.mac.toUpperCase();
    this.aesKey = deriveAesKey(Buffer.from(options.ltk.replace(/[^0-9a-fA-F]/g, ''), 'hex'));
    this.accountId = options.accountId;
    this.adapterName = options.adapter;
    this.log = options.log ?? noopLog;
  }

  /** Last known state. Updated by notifications and polling. */
  getState(): Readonly<LampState> {
    return this.state;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Begin connecting, and keep reconnecting until {@link stop} is called. */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.bluetooth = createBluetooth();

    // dbus-next emits socket failures on the bus itself rather than rejecting
    // the call in flight, and an unhandled 'error' event would take Homebridge
    // down with it. Treat it as a lost link and let the backoff handle it.
    const bus = (this.bluetooth.bluetooth as unknown as { dbus?: EventEmitter }).dbus;
    bus?.on('error', (error: unknown) => {
      this.log.error(`D-Bus error talking to BlueZ: ${describe(error)}`);
      this.handleDisconnect();
    });

    this.adapter = this.adapterName
      ? await this.bluetooth.bluetooth.getAdapter(this.adapterName)
      : await this.bluetooth.bluetooth.defaultAdapter();
    void this.connectLoop();
  }

  /** Disconnect and release the D-Bus connection. */
  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    await this.teardown();
    try {
      this.bluetooth?.destroy();
    } catch (error) {
      this.log.debug(`Releasing the D-Bus connection failed: ${describe(error)}`);
    }
    this.bluetooth = undefined;
    this.adapter = undefined;
  }

  async setPower(on: boolean): Promise<void> {
    // Turning the lamp on or off is the one command that must feel immediate,
    // so anything still queued behind a slider drag is dropped rather than
    // made to run first: those values are about to be overtaken anyway, and
    // waiting for them is what made switching off take seconds.
    this.requireConnection();
    this.desired = { ...this.desired, on };
    this.settling.hold('on');
    this.patchState({ on });
    const requestedAt = Date.now();
    const queued = this.operations.depth;
    // Power overrides everything: drop the slider values still waiting, which
    // nobody will see once the lamp is switching.
    this.writes.cancelAll();
    this.reconciles.cancelAll();
    this.operations.cancelQueued();
    await this.enqueue(async () => {
      const waited = Date.now() - requestedAt;
      await this.write(CHAR_POWER, Buffer.from([on ? 0x01 : 0x00]));
      this.log.debug(
        `Power ${on ? 'on' : 'off'} took ${Date.now() - requestedAt}ms (${waited}ms waiting behind ${queued} queued)`,
      );
    });
    this.scheduleReconcile();
  }

  /** @param percent HomeKit brightness, 0-100 %. */
  async setBrightness(percent: number): Promise<void> {
    const lumens = percentToLumens(percent);
    this.log.debug(`Brightness ${percent}% requested (${this.operations.depth} queued)`);
    this.requireConnection();
    this.desired = { ...this.desired, brightness: lumensToPercent(lumens) };
    this.settling.hold('brightness');
    this.patchState({ brightness: lumensToPercent(lumens) });
    // Not reconciled: the lamp adjusts brightness to track daylight, so a value
    // that differs from what was asked for is the lamp working, not a command
    // that went missing.
    await this.writes.schedule(CHAR_BRIGHTNESS_LM, () => this.writeUint16(CHAR_BRIGHTNESS_LM, lumens));
  }

  async setColorTemperature(kelvin: number): Promise<void> {
    const clamped = Math.min(MAX_KELVIN, Math.max(MIN_KELVIN, Math.round(kelvin)));
    this.requireConnection();
    this.desired = { ...this.desired, kelvin: clamped };
    this.settling.hold('kelvin');
    this.patchState({ kelvin: clamped });
    // Not reconciled: a colour temperature that lands slightly off is invisible,
    // and checking it would cost a read on a link that is not always there.
    await this.writes.schedule(CHAR_COLOR_TEMP, () => this.writeUint16(CHAR_COLOR_TEMP, clamped));
  }

  private async writeUint16(uuid: string, value: number): Promise<void> {
    await this.ensureManualMode();
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value);
    await this.write(uuid, buffer);
  }

  /**
   * Check the lamp ended up where it was asked to, once commands stop arriving.
   *
   * Control writes are unacknowledged — the characteristics offer no `write`
   * flag at all — so one can be dropped with nothing to say so. The lamp
   * notifies on change, but a lost write changes nothing and therefore notifies
   * nothing, which is exactly the case that leaves HomeKit showing a state the
   * lamp is not in. Checking once at the end costs one read of each value
   * instead of one per command, and none of it in the path the user waits on.
   */
  private scheduleReconcile(): void {
    void this.reconciles
      .schedule('reconcile', () => this.reconcile())
      .catch((error: unknown) => this.log.debug(`Reconcile failed: ${describe(error)}`));
  }

  /**
   * Refuse a command there is no way to deliver.
   *
   * Holding it until the link returns sounds helpful and is not: the lamp is
   * already reported as unreachable, so the user knows it did not happen, and
   * replaying a handful of presses minutes later switches the lamp around on
   * its own. Failing plainly leaves them in control.
   */
  private requireConnection(): void {
    if (!this.connected) {
      throw new Error(`${this.mac} is not connected`);
    }
  }

  private async reconcile(): Promise<void> {
    if (!this.connected) {
      return;
    }
    const actual = await this.readState();
    const { corrections, missed } = planReconciliation(this.desired, actual);

    if (corrections.length === 0) {
      this.publishFromLamp(actual);
      return;
    }

    for (const correction of corrections) {
      switch (correction.field) {
        case 'on':
          await this.write(CHAR_POWER, Buffer.from([correction.value ? 0x01 : 0x00]));
          break;
      }
    }

    this.log.info(`${this.mac} did not apply ${missed.join(', ')} — resent`);
    // Publish what the lamp reports rather than what was asked for, so HomeKit
    // stops claiming something untrue if the resend does not land either.
    this.publishFromLamp(await this.readState());
  }

  // ---------------------------------------------------------------- internals

  private async connectLoop(): Promise<void> {
    while (this.running && !this.connected) {
      try {
        await this.connectOnce();
        this.reconnectAttempt = 0;
        return;
      } catch (error) {
        if (!this.running) {
          return;
        }
        const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!;
        this.reconnectAttempt++;
        this.log.warn(
          `Connection to ${this.mac} failed (attempt ${this.reconnectAttempt}): ${describe(error)}. Retrying in ${delay / 1000}s.`,
        );
        await this.teardown();
        await sleep(delay);
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) {
      throw new Error('Bluetooth adapter is not available');
    }
    this.device = await this.connectDevice(adapter);
    this.device.on('disconnect', () => this.handleDisconnect());

    await this.discoverCharacteristics(await this.device.gatt());

    const auth = this.characteristic(CHAR_AUTH);
    auth.on('valuechanged', (buffer) => this.handleAuthFragment(buffer));
    await auth.startNotifications();

    await this.authenticate();

    const motion = this.chars[CHAR_MOTION];
    if (motion) {
      motion.on('valuechanged', (buffer) => this.emit('motion', buffer.some((b) => b !== 0)));
      await motion.startNotifications().catch((error) => {
        this.log.debug(`Motion notifications unavailable: ${describe(error)}`);
      });
    }

    this.connected = true;
    this.manualModeSetAt = 0;
    this.settling.clear();
    await this.refreshState();
    // The lamp is the authority on where it is. Anything asked for before the
    // link dropped is history, and aiming at it would have reconciliation
    // "correct" the lamp to a state nobody is asking for any more.
    this.desired = { ...this.state };
    await this.subscribeToState();
    this.log.info(`Connected to Dyson Morph at ${this.mac} — ${describeState(this.state)}`);
    await this.reportSignalStrength();
    this.emit('connected');
  }

  /**
   * Connect, preferring the record BlueZ already holds.
   *
   * Connecting to a known address needs no discovery at all and is by far the
   * fastest path. But BlueZ keeps listing a device for a while after it stops
   * hearing from it, and connecting to such a stale record is refused — so a
   * failure here falls straight through to a scan rather than giving up and
   * waiting out the backoff on a record already known to be suspect.
   */
  private async connectDevice(adapter: Adapter): Promise<Device> {
    if ((await adapter.devices()).includes(this.mac)) {
      const cached = await adapter.getDevice(this.mac);
      await this.markTrusted(cached);
      try {
        await cached.connect();
        return cached;
      } catch (error) {
        this.log.debug(`Cached record for ${this.mac} did not connect (${describe(error)}); scanning instead`);
      }
    }

    const discovered = await this.discoverDevice(adapter);
    await this.markTrusted(discovered);
    await discovered.connect();
    return discovered;
  }

  /**
   * Find the lamp by scanning.
   *
   * A connect issued immediately after discovery starts is aborted by the
   * controller, so this settles first. Discovery is stopped again before
   * connecting: leaving it running makes the radio time-slice between scan
   * windows and connection events, which starves the link.
   */
  private async discoverDevice(adapter: Adapter): Promise<Device> {
    this.log.debug(`Scanning for ${this.mac}`);
    const startedDiscovery = !(await adapter.isDiscovering());
    if (startedDiscovery) {
      await adapter.startDiscovery();
    }
    try {
      const device = await adapter.waitDevice(this.mac, DISCOVERY_TIMEOUT_MS);
      await sleep(DISCOVERY_SETTLE_MS);
      return device;
    } finally {
      if (startedDiscovery) {
        await adapter.stopDiscovery().catch((error) => {
          this.log.debug(`Could not stop discovery: ${describe(error)}`);
        });
      }
    }
  }

  /**
   * Ask BlueZ to hold on to this device.
   *
   * An untrusted, unbonded device is dropped from the cache once it is neither
   * connected nor being discovered, and the address then stops resolving at all
   * — `bluetoothctl` reports it as "not available". Trusting it keeps the
   * record, so a reconnect does not have to rediscover the lamp first.
   */
  private async markTrusted(device: Device): Promise<void> {
    const helper = (device as unknown as {
      helper?: { prop(name: string): Promise<unknown>; set(name: string, value: unknown): Promise<void> };
    }).helper;
    if (!helper) {
      return;
    }
    try {
      if (await helper.prop('Trusted')) {
        return;
      }
      await helper.set('Trusted', new Variant('b', true));
      this.log.debug(`Marked ${this.mac} trusted so BlueZ keeps its record`);
    } catch (error) {
      this.log.debug(`Could not mark ${this.mac} trusted: ${describe(error)}`);
    }
  }

  /**
   * Locate the characteristics we need, wherever the firmware puts them.
   *
   * The published protocol notes place everything under one service, but the
   * Solarcycle Morph spreads them across three (`2dd10010` for auth and RSSI,
   * `2dd10020` for attribute writes, `2dd1fff0` for the control values). Rather
   * than hard-coding a layout that varies by model, we sweep every service and
   * match on characteristic UUID, which is unique regardless of its parent.
   */
  private async discoverCharacteristics(gatt: GattServer): Promise<void> {
    this.chars = {};
    this.writeTypes = {};

    for (const serviceUuid of await gatt.services()) {
      const service = await gatt.getPrimaryService(serviceUuid);
      for (const charUuid of await service.characteristics()) {
        if (!WANTED_CHARACTERISTICS.has(charUuid)) {
          continue;
        }
        const characteristic = await service.getCharacteristic(charUuid);
        this.chars[charUuid] = characteristic;

        // The Morph declares its control characteristics write-without-response
        // only; asking BlueZ for an acknowledged write would be rejected. Other
        // models do offer `write`, so take whichever the firmware advertises.
        const flags = await characteristic.getFlags().catch(() => [] as string[]);
        this.writeTypes[charUuid] = flags.includes('write') ? 'request' : 'command';
        this.log.debug(`Found ${charUuid} in service ${serviceUuid} [${flags.join(', ')}]`);
      }
    }

    const missing = REQUIRED_CHARACTERISTICS.filter((uuid) => !this.chars[uuid]);
    if (missing.length > 0) {
      throw new Error(`${this.mac} is missing required characteristics: ${missing.join(', ')} — is this a Dyson Morph?`);
    }
  }

  /** Write using whichever acknowledgement mode the characteristic supports. */
  private async write(uuid: string, value: Buffer): Promise<void> {
    await this.characteristic(uuid).writeValue(value, { type: this.writeTypes[uuid] ?? 'command' });
  }

  /**
   * LTK re-authentication: prove we hold the key without contacting the cloud.
   *
   * We send an encrypted nonce, the lamp returns it alongside a challenge of
   * its own, and we send that challenge back encrypted. Until the lamp answers
   * with `CONNECTION_ESTABLISHED` it silently discards every control write.
   */
  private async authenticate(): Promise<void> {
    // Some firmware needs the product-info exchange before it will talk auth.
    await this.sendMessage(MsgType.REQUEST_PRODUCT_INFO);
    await this.waitForMessage(MsgType.PRODUCT_INFO, 5_000).catch(() => {
      this.log.debug('No product info returned; continuing with the handshake');
    });

    const nonce = randomBytes(16);
    await this.sendMessage(MsgType.REAUTH_PAYLOAD_A, buildReauthPayloadA(this.accountId, this.aesKey, nonce));
    const payloadB = await this.waitForMessage(MsgType.REAUTH_PAYLOAD_B, HANDSHAKE_TIMEOUT_MS);

    const challenge = parseReauthPayloadB(this.aesKey, payloadB.payload);
    await this.sendMessage(MsgType.REAUTH_PAYLOAD_C, buildReauthPayloadC(this.aesKey, challenge));
    await this.waitForMessage(MsgType.CONNECTION_ESTABLISHED, HANDSHAKE_TIMEOUT_MS);
    this.log.debug(`Handshake with ${this.mac} complete`);
  }

  private handleAuthFragment(fragment: Buffer): void {
    const message = this.assembler.push(fragment);
    if (!message) {
      return;
    }
    const waiter = this.waiters.get(message.type);
    if (waiter) {
      this.waiters.delete(message.type);
      waiter(message);
    } else {
      this.log.debug(`Unsolicited message 0x${message.type.toString(16)} (${message.payload.length} bytes)`);
    }
  }

  private async sendMessage(type: number, payload?: Buffer): Promise<void> {
    for (const fragment of fragmentMessage(type, payload)) {
      await this.write(CHAR_AUTH, fragment);
    }
  }

  private waitForMessage(type: number, timeoutMs: number): Promise<DysonMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(type);
        reject(new Error(`Timed out waiting for message 0x${type.toString(16)} from ${this.mac}`));
      }, timeoutMs);
      this.waiters.set(type, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  /**
   * Take the lamp out of daylight mode so it accepts explicit values.
   *
   * Refreshed on a TTL rather than tracked as state: the lamp offers no way to
   * read the current mode back, and the physical button can change it.
   */
  private async ensureManualMode(): Promise<void> {
    if (Date.now() - this.manualModeSetAt < MANUAL_MODE_TTL_MS) {
      return;
    }
    if (!this.chars[CHAR_WRITE_ATTR]) {
      return;
    }
    await this.write(CHAR_WRITE_ATTR, DAYLIGHT_MODE_DISABLE);
    await sleep(MODE_SETTLE_MS);
    this.manualModeSetAt = Date.now();
  }

  private async refreshState(): Promise<void> {
    this.patchState(await this.readState());
  }

  /** Read what the lamp currently reports. Values it will not give up are absent. */
  private async readState(): Promise<Partial<LampState>> {
    const patch: Partial<LampState> = {};
    const failures: string[] = [];
    const read = async (uuid: string, label: string): Promise<Buffer | undefined> => {
      try {
        return await this.chars[uuid]?.readValue();
      } catch (error) {
        failures.push(`${label}: ${describe(error)}`);
        return undefined;
      }
    };

    const power = await read(CHAR_POWER, 'power');
    if (power?.length) {
      patch.on = power[0] !== 0;
    }
    const brightness = await read(CHAR_BRIGHTNESS_LM, 'brightness');
    if (brightness && brightness.length >= 2) {
      const lumens = brightness.readUInt16LE(0);
      // An off lamp reports no output rather than the level it will return to,
      // and HomeKit uses brightness to decide how bright to come back on. Keep
      // the last real level instead of overwriting it with zero.
      if (lumens > 0 || patch.on !== false) {
        patch.brightness = lumensToPercent(lumens);
      }
    }
    const kelvin = await read(CHAR_COLOR_TEMP, 'colour temperature');
    if (kelvin && kelvin.length >= 2) {
      patch.kelvin = kelvin.readUInt16LE(0);
    }

    // Reads failing after a successful handshake means the session was dropped
    // or never really authorised — worth surfacing rather than silently
    // serving stale state to HomeKit.
    if (failures.length > 0) {
      this.log.warn(`Could not read lamp state (${failures.join('; ')})`);
    }
    return patch;
  }

  /**
   * Report how strong the radio link is, and say so plainly when it is weak.
   *
   * A marginal link presents as repeated `Connection Timeout` disconnects,
   * which is indistinguishable from a bug in the plugin unless the signal
   * strength is in the log next to it.
   */
  private async reportSignalStrength(): Promise<void> {
    const raw = await this.device?.getRSSI().catch(() => undefined);
    const rssi = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    if (typeof rssi !== 'number' || Number.isNaN(rssi)) {
      return;
    }
    if (rssi <= WEAK_RSSI_DBM) {
      this.log.warn(
        `Signal from ${this.mac} is weak (${rssi} dBm). Below about ${WEAK_RSSI_DBM} dBm the ` +
          'connection times out and drops repeatedly. Move the lamp or the Homebridge host closer, ' +
          'or put a Bluetooth adapter nearer the lamp.',
      );
    } else {
      this.log.debug(`Signal from ${this.mac}: ${rssi} dBm`);
    }
  }

  /**
   * Follow the lamp's own state changes instead of polling for them.
   *
   * There is no need to poll to hold the link open — a BLE connection is
   * maintained by the link layer, not by ATT traffic — and polling actively
   * hurt: a periodic read would eventually come back `ATT error 0x0e` and take
   * the connection down with it. Notifications also pick up changes made at the
   * lamp itself, which polling only caught on its next tick.
   */
  private async subscribeToState(): Promise<void> {
    const sources: [string, (value: Buffer) => Partial<LampState> | undefined][] = [
      [CHAR_POWER, (value) => (value.length ? { on: value[0] !== 0 } : undefined)],
      [
        CHAR_BRIGHTNESS_LM,
        (value) => {
          if (value.length < 2) {
            return undefined;
          }
          const lumens = value.readUInt16LE(0);
          // Zero means "not lit", not "dimmed to nothing"; keep the level the
          // lamp will return to so HomeKit can restore it.
          return lumens > 0 ? { brightness: lumensToPercent(lumens) } : undefined;
        },
      ],
      [CHAR_COLOR_TEMP, (value) => (value.length >= 2 ? { kelvin: value.readUInt16LE(0) } : undefined)],
    ];

    for (const [uuid, decode] of sources) {
      const characteristic = this.chars[uuid];
      if (!characteristic) {
        continue;
      }
      characteristic.on('valuechanged', (value) => {
        const patch = decode(value);
        if (patch) {
          this.publishFromLamp(patch);
        }
      });
      await characteristic.startNotifications().catch((error) => {
        this.log.debug(`No notifications for ${uuid}: ${describe(error)}`);
      });
    }
  }

  private handleDisconnect(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.log.warn(`Lost connection to ${this.mac} — reconnecting`);
    this.emit('disconnected');
    if (this.running) {
      void this.teardown().then(() => this.connectLoop());
    }
  }

  private async teardown(): Promise<void> {
    this.connected = false;
    this.writes.cancelAll();
    this.reconciles.cancelAll();
    this.assembler.reset();
    this.waiters.clear();
    this.writeTypes = {};
    for (const characteristic of Object.values(this.chars)) {
      characteristic?.removeAllListeners('valuechanged');
    }
    this.chars = {};
    if (this.device) {
      this.device.removeAllListeners('disconnect');
      await this.device.disconnect().catch(() => {});
      this.device = undefined;
    }
  }

  private characteristic(uuid: string): GattCharacteristic {
    const characteristic = this.chars[uuid];
    if (!characteristic) {
      throw new Error(`Not connected: characteristic ${uuid} is unavailable`);
    }
    return characteristic;
  }

  /**
   * Run `task` after every previously queued GATT operation has settled.
   *
   * @param key Marks the operation replaceable: queueing another under the same
   * key drops this one. Used for value writes, where an older value is worthless
   * once a newer one is waiting, and omitted for power so it always runs.
   */
  private enqueue<T>(task: () => Promise<T>, key?: string): Promise<T | undefined> {
    return this.operations.run(task, key);
  }

  /**
   * Publish what the lamp reports, minus the echo of our own commands.
   *
   * A value the user just set must stay where they put it; the steps the lamp
   * takes on its way there are not news, they are the command happening.
   */
  private publishFromLamp(patch: Partial<LampState>): void {
    this.patchState(this.settling.filter(patch));
  }

  private patchState(patch: Partial<LampState>): void {
    if (Object.keys(patch).length === 0) {
      return;
    }
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(patch) as (keyof LampState)[]).some((k) => this.state[k] !== next[k]);
    this.state = next;
    if (changed) {
      this.log.debug(`State now ${describeState(next)}`);
      this.emit('state', next);
    }
  }
}

function describeState(state: LampState): string {
  return `${state.on ? 'on' : 'off'}, ${state.brightness}%, ${state.kelvin}K`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
