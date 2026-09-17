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
import type { Adapter, Device, GattCharacteristic, GattService } from 'node-ble';

import { buildReauthPayloadA, buildReauthPayloadC, deriveAesKey, parseReauthPayloadB } from './crypto.js';
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
  SERVICE_UUID,
  fragmentMessage,
  lumensToPercent,
  percentToLumens,
} from './protocol.js';

/** Delays between reconnect attempts; the last value repeats. */
const RECONNECT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];

/** How often to poll the lamp so BlueZ keeps the link up. */
const KEEPALIVE_INTERVAL_MS = 20_000;

/** The lamp can take a while to answer the first handshake message. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Re-assert manual mode if the last write was longer ago than this. Writing it
 * before every command would be wasteful; never writing it means the lamp
 * silently ignores us after someone used the physical daylight button.
 */
const MANUAL_MODE_TTL_MS = 60_000;

/** The lamp needs a moment to apply a mode change before the next write. */
const MODE_SETTLE_MS = 200;

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

  private readonly assembler = new MessageAssembler();
  private readonly waiters = new Map<number, (message: DysonMessage) => void>();

  /** Serialises all GATT access. */
  private queue: Promise<unknown> = Promise.resolve();

  private running = false;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private keepaliveTimer?: NodeJS.Timeout;
  private manualModeSetAt = 0;

  private state: LampState = { on: false, brightness: 100, kelvin: 2700 };

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
    clearInterval(this.keepaliveTimer);
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
    await this.enqueue(async () => {
      // Power uses write-without-response; the lamp never acknowledges it.
      await this.characteristic(CHAR_POWER).writeValueWithoutResponse(Buffer.from([on ? 0x01 : 0x00]));
      this.patchState({ on });
    });
  }

  /** @param percent HomeKit brightness, 0-100 %. */
  async setBrightness(percent: number): Promise<void> {
    const lumens = percentToLumens(percent);
    await this.enqueue(async () => {
      await this.ensureManualMode();
      const value = Buffer.alloc(2);
      value.writeUInt16LE(lumens);
      await this.characteristic(CHAR_BRIGHTNESS_LM).writeValueWithResponse(value);
      this.patchState({ brightness: lumensToPercent(lumens) });
    });
  }

  async setColorTemperature(kelvin: number): Promise<void> {
    const clamped = Math.min(MAX_KELVIN, Math.max(MIN_KELVIN, Math.round(kelvin)));
    await this.enqueue(async () => {
      await this.ensureManualMode();
      const value = Buffer.alloc(2);
      value.writeUInt16LE(clamped);
      await this.characteristic(CHAR_COLOR_TEMP).writeValueWithResponse(value);
      this.patchState({ kelvin: clamped });
    });
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
    if (!(await adapter.isDiscovering())) {
      await adapter.startDiscovery();
    }

    this.log.debug(`Waiting for ${this.mac} to advertise…`);
    this.device = await adapter.waitDevice(this.mac);
    await this.device.connect();
    this.device.on('disconnect', () => this.handleDisconnect());

    const gatt = await this.device.gatt();
    const service: GattService = await gatt.getPrimaryService(SERVICE_UUID);
    for (const uuid of [CHAR_AUTH, CHAR_POWER, CHAR_BRIGHTNESS_LM, CHAR_COLOR_TEMP, CHAR_WRITE_ATTR, CHAR_MOTION]) {
      this.chars[uuid] = await service.getCharacteristic(uuid);
    }

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
    this.keepaliveTimer = setInterval(() => void this.keepalive(), KEEPALIVE_INTERVAL_MS);
    this.log.info(`Connected to Dyson Morph at ${this.mac}`);
    this.emit('connected');
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
    const auth = this.characteristic(CHAR_AUTH);
    for (const fragment of fragmentMessage(type, payload)) {
      await auth.writeValueWithoutResponse(fragment);
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
    const attr = this.chars[CHAR_WRITE_ATTR];
    if (!attr) {
      return;
    }
    await attr.writeValueWithResponse(DAYLIGHT_MODE_DISABLE);
    await sleep(MODE_SETTLE_MS);
    this.manualModeSetAt = Date.now();
  }

  private async refreshState(): Promise<void> {
    const patch: Partial<LampState> = {};
    const power = await this.chars[CHAR_POWER]?.readValue().catch(() => undefined);
    if (power?.length) {
      patch.on = power[0] !== 0;
    }
    const brightness = await this.chars[CHAR_BRIGHTNESS_LM]?.readValue().catch(() => undefined);
    if (brightness && brightness.length >= 2) {
      patch.brightness = lumensToPercent(brightness.readUInt16LE(0));
    }
    const kelvin = await this.chars[CHAR_COLOR_TEMP]?.readValue().catch(() => undefined);
    if (kelvin && kelvin.length >= 2) {
      patch.kelvin = kelvin.readUInt16LE(0);
    }
    this.patchState(patch);
  }

  private async keepalive(): Promise<void> {
    if (!this.connected) {
      return;
    }
    try {
      await this.enqueue(() => this.refreshState());
    } catch (error) {
      this.log.debug(`Keepalive failed: ${describe(error)}`);
      this.handleDisconnect();
    }
  }

  private handleDisconnect(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    clearInterval(this.keepaliveTimer);
    this.log.warn(`Lost connection to ${this.mac}`);
    this.emit('disconnected');
    if (this.running) {
      void this.teardown().then(() => this.connectLoop());
    }
  }

  private async teardown(): Promise<void> {
    this.connected = false;
    this.assembler.reset();
    this.waiters.clear();
    clearInterval(this.keepaliveTimer);
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

  /** Run `task` after every previously queued GATT operation has settled. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  private patchState(patch: Partial<LampState>): void {
    if (Object.keys(patch).length === 0) {
      return;
    }
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(patch) as (keyof LampState)[]).some((k) => this.state[k] !== next[k]);
    this.state = next;
    if (changed) {
      this.emit('state', next);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
