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

import { createBluetooth } from 'node-ble';
import type { Adapter, Device, GattCharacteristic, GattServer } from 'node-ble';

import { buildReauthPayloadA, buildReauthPayloadC, deriveAesKey, parseReauthPayloadB } from './crypto.js';
import { Debouncer } from './debounce.js';
import { OperationQueue } from './queue.js';
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
 * How long a command issued while disconnected stays worth applying.
 *
 * Long enough to cover a reconnect, short enough that a request from an hour
 * ago does not surprise anyone by taking effect when the link returns.
 */
const INTENT_TTL_MS = 120_000;

/** How long to give the lamp to apply a command before checking it took. */
const VERIFY_DELAY_MS = 400;

/** Granularity for noticing that a slower operation has been overridden. */
const INTERRUPT_POLL_MS = 50;

/**
 * Tolerances when checking a write landed.
 *
 * The lamp rounds what it stores, so an exact comparison would report a
 * mismatch for a command that was in fact applied.
 */
const LUMEN_TOLERANCE = 25;
const KELVIN_TOLERANCE = 120;

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

  private running = false;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private manualModeSetAt = 0;

  private state: LampState = { on: false, brightness: 100, kelvin: 2700 };

  /**
   * What was asked for while the lamp was unreachable.
   *
   * Dropping a command because the link happened to be down is the one failure
   * the user cannot work around: HomeKit shows the new state, the lamp never
   * hears about it, and nothing retries. Held here and applied once the link is
   * back.
   */
  private intent: Partial<LampState> = {};
  private intentAt = 0;

  /**
   * Bumped by a command that makes slower work pointless.
   *
   * Cancelling the queue only drops what has not started. A value write already
   * in flight still owes a verification and possibly a retry, and switching off
   * should not wait behind a brightness nobody will see.
   */
  private interrupt = 0;

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
    this.patchState({ on });
    if (this.deferWhileOffline({ on })) {
      return;
    }
    const requestedAt = Date.now();
    const queued = this.operations.depth;
    // Power overrides everything: drop what is waiting, and cut short whatever
    // verification or retry is still running for a value write.
    this.interrupt++;
    this.writes.cancelAll();
    this.operations.cancelQueued();
    await this.enqueue(async () => {
      const waited = Date.now() - requestedAt;
      await this.writeVerified(
        CHAR_POWER,
        Buffer.from([on ? 0x01 : 0x00]),
        (value) => (value.length ? value[0] !== 0 : undefined),
        on,
        (actual, target) => actual === target,
        (value) => this.patchState({ on: value }),
      );
      this.log.info(
        `Power ${on ? 'on' : 'off'} took ${Date.now() - requestedAt}ms ` +
          `(${waited}ms waiting behind ${queued} queued, ${Date.now() - requestedAt - waited}ms on the lamp)`,
      );
    });
  }

  /** @param percent HomeKit brightness, 0-100 %. */
  async setBrightness(percent: number): Promise<void> {
    const lumens = percentToLumens(percent);
    this.log.debug(`Brightness ${percent}% requested (${this.operations.depth} queued)`);
    this.patchState({ brightness: lumensToPercent(lumens) });
    if (this.deferWhileOffline({ brightness: lumensToPercent(lumens) })) {
      return;
    }
    await this.writes.schedule(CHAR_BRIGHTNESS_LM, () =>
      this.writeUint16(CHAR_BRIGHTNESS_LM, lumens, LUMEN_TOLERANCE, (actual) =>
        this.patchState({ brightness: lumensToPercent(actual) }),
      ),
    );
  }

  async setColorTemperature(kelvin: number): Promise<void> {
    const clamped = Math.min(MAX_KELVIN, Math.max(MIN_KELVIN, Math.round(kelvin)));
    this.patchState({ kelvin: clamped });
    if (this.deferWhileOffline({ kelvin: clamped })) {
      return;
    }
    await this.writes.schedule(CHAR_COLOR_TEMP, () =>
      this.writeUint16(CHAR_COLOR_TEMP, clamped, KELVIN_TOLERANCE, (actual) => this.patchState({ kelvin: actual })),
    );
  }

  private async writeUint16(
    uuid: string,
    value: number,
    tolerance: number,
    apply: (actual: number) => void,
  ): Promise<void> {
    await this.ensureManualMode();
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value);
    await this.writeVerified(
      uuid,
      buffer,
      (raw) => (raw.length >= 2 ? raw.readUInt16LE(0) : undefined),
      value,
      (actual, target) => Math.abs(actual - target) <= tolerance,
      apply,
    );
  }

  /**
   * Write, then look at whether the lamp took it.
   *
   * Control writes are unacknowledged — the characteristics offer no `write`
   * flag at all — so a command can be dropped with nothing to say so. The lamp
   * notifies on change, but a lost write changes nothing and therefore notifies
   * nothing, which is exactly the case that would leave HomeKit showing a state
   * the lamp is not in. So the value is read back, retried once if it did not
   * land, and whatever the lamp actually reports becomes the state we publish.
   *
   * Verification is skipped entirely when a newer value for the same
   * characteristic is already waiting. Mid-drag the lamp has moved on by the
   * time the read returns, so comparing against this target would report a
   * mismatch that never happened — and retrying would write a stale value back
   * over the newer one, dragging the slider backwards.
   */
  private async writeVerified<T>(
    uuid: string,
    value: Buffer,
    decode: (raw: Buffer) => T | undefined,
    target: T,
    matches: (actual: T, target: T) => boolean,
    apply: (actual: T) => void,
  ): Promise<void> {
    const interruptedAt = this.interrupt;
    const overtaken = (): boolean => this.writes.isPending(uuid) || this.interrupt !== interruptedAt;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      await this.write(uuid, value);
      this.log.debug(`Wrote ${uuid} in ${Date.now() - started}ms (attempt ${attempt})`);
      if (overtaken()) {
        return;
      }
      // Waited in slices so a command arriving mid-verification is noticed now
      // rather than after the full delay.
      for (let waited = 0; waited < VERIFY_DELAY_MS; waited += INTERRUPT_POLL_MS) {
        await sleep(INTERRUPT_POLL_MS);
        if (overtaken()) {
          return;
        }
      }

      const raw = await this.chars[uuid]?.readValue().catch((error: unknown) => {
        // Not being able to check is not a reason to fail the command; the
        // write may well have landed. Notifications will correct us if not.
        this.log.debug(`Could not verify ${uuid}: ${describe(error)}`);
        return undefined;
      });
      const actual = raw ? decode(raw) : undefined;
      if (actual === undefined || overtaken()) {
        return;
      }
      if (matches(actual, target)) {
        return;
      }

      if (attempt === 1) {
        this.log.debug(`${uuid} did not take (wanted ${String(target)}, lamp reports ${String(actual)}); retrying`);
      } else {
        // Report what the lamp is actually doing rather than what was asked
        // for, so HomeKit stops claiming something untrue.
        this.log.warn(
          `${this.mac} did not accept a command (wanted ${String(target)}, lamp reports ${String(actual)})`,
        );
        apply(actual);
      }
    }
  }

  /**
   * Hold a command that cannot be sent right now.
   *
   * @returns true when the caller should stop, because there is no link and the
   * command has been remembered instead.
   */
  private deferWhileOffline(patch: Partial<LampState>): boolean {
    if (this.connected) {
      return false;
    }
    this.intent = { ...this.intent, ...patch };
    this.intentAt = Date.now();
    this.log.debug(`Not connected; holding ${JSON.stringify(patch)} until the link is back`);
    return true;
  }

  /**
   * Apply what was asked for while the lamp was unreachable.
   *
   * Runs after the state has been read back, so only genuine differences are
   * written — the lamp may already be where the user wanted it.
   */
  private async applyIntent(): Promise<void> {
    const intent = this.intent;
    const age = Date.now() - this.intentAt;
    this.intent = {};
    if (Object.keys(intent).length === 0) {
      return;
    }
    if (age > INTENT_TTL_MS) {
      this.log.debug(`Discarding a ${Math.round(age / 1000)}s old command rather than applying it late`);
      return;
    }

    this.log.info(`Applying ${JSON.stringify(intent)}, requested while the lamp was unreachable`);

    // Switching off overrides the rest: nobody will see a brightness or colour
    // that is applied purely to be extinguished a round-trip later, and going
    // dark promptly is the whole point.
    if (intent.on === false) {
      await this.setPower(false);
      return;
    }

    if (intent.kelvin !== undefined && intent.kelvin !== this.state.kelvin) {
      await this.setColorTemperature(intent.kelvin);
    }
    if (intent.brightness !== undefined && intent.brightness !== this.state.brightness) {
      await this.setBrightness(intent.brightness);
    }
    // Power last, so the lamp reaches its final brightness before coming on.
    if (intent.on === true && !this.state.on) {
      await this.setPower(true);
    }
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
    this.device = await this.acquireDevice(adapter);
    await this.device.connect();
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
    await this.refreshState();
    await this.subscribeToState();
    this.log.info(`Connected to Dyson Morph at ${this.mac} — ${describeState(this.state)}`);
    await this.reportSignalStrength();
    this.emit('connected');
    await this.applyIntent();
  }

  /**
   * Get a device object to connect to, scanning only if BlueZ has never seen
   * this lamp.
   *
   * Connecting to an address BlueZ already knows needs no discovery at all and
   * is by far the fastest path. Scanning is the fallback, and it has to settle
   * first: a connect issued immediately after discovery starts is aborted by
   * the controller, which BlueZ reports as `le-connection-abort-by-local` — a
   * message that reads like a local fault rather than a timing problem.
   *
   * Discovery is stopped again before connecting. Leaving it running makes the
   * radio time-slice between scan windows and connection events, which starves
   * the link until it hits its supervision timeout.
   */
  private async acquireDevice(adapter: Adapter): Promise<Device> {
    if ((await adapter.devices()).includes(this.mac)) {
      return adapter.getDevice(this.mac);
    }

    this.log.debug(`${this.mac} is unknown to BlueZ; scanning for it`);
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
      patch.brightness = lumensToPercent(brightness.readUInt16LE(0));
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
    this.patchState(patch);
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
      [CHAR_BRIGHTNESS_LM, (value) => (value.length >= 2 ? { brightness: lumensToPercent(value.readUInt16LE(0)) } : undefined)],
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
          this.patchState(patch);
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
