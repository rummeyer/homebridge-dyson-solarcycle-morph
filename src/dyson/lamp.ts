/**
 * BLE transport and session management for a single Morph lamp.
 *
 * Owns the BlueZ connection, runs the LTK handshake after every reconnect, and
 * exposes the lamp as a small state machine with cached state. All GATT traffic
 * is serialised through one queue: BlueZ will happily return `InProgress` or
 * drop replies if two D-Bus calls overlap on the same characteristic.
 */
import { describeError } from '../errors.js';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

import { Variant } from 'dbus-next';
import { createBluetooth } from 'node-ble';
import type { Adapter, Device, GattCharacteristic, GattServer } from 'node-ble';

import { buildReauthPayloadA, buildReauthPayloadC, deriveAesKey, parseReauthPayloadB } from './crypto.js';
import { Debouncer } from './debounce.js';
import { Pacer } from './pace.js';
import { OperationQueue } from './queue.js';
import { planReconciliation } from './reconcile.js';
import { SettleWindow } from './settle.js';
import type { Preset } from './protocol.js';
import {
  CHAR_AUTH,
  CHAR_BRIGHTNESS_LM,
  CHAR_COLOR_TEMP,
  CHAR_AUTO_BRIGHTNESS,
  CHAR_MOVEMENT,
  CHAR_POWER,
  CHAR_RSSI,
  CHAR_WRITE_ATTR,
  buildCoordinateRead,
  buildCoordinateWrite,
  buildDaylightRead,
  buildDaylightWrite,
  buildPresetRead,
  buildPresetWrite,
  PRESETS,
  decodeAttributeReport,
  decodeAttributeValue,
  decodeCoordinateValue,
  DysonMessage,
  Coordinate,
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
  CHAR_RSSI,
  CHAR_POWER,
  CHAR_BRIGHTNESS_LM,
  CHAR_COLOR_TEMP,
  CHAR_WRITE_ATTR,
  CHAR_AUTO_BRIGHTNESS,
  CHAR_MOVEMENT,
]);

/** Without these there is no point continuing. */
const REQUIRED_CHARACTERISTICS = [CHAR_AUTH, CHAR_POWER];

/**
 * Delays between reconnect attempts; the last value repeats.
 *
 * Attempts thin out rather than hammering, but stop thinning at a minute. The
 * lamp can reach a state where it advertises normally but refuses every
 * connection until it loses power, and no retry interval fixes that — but a
 * longer gap does mean the lamp is back for minutes before the plugin notices,
 * which is the more common case. A minute is the compromise.
 */
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** Consecutive failures after which the log suggests what actually helps. */
const STUCK_AFTER_ATTEMPTS = 8;

/** How long to scan for a lamp BlueZ has never seen. */
const DISCOVERY_TIMEOUT_MS = 30_000;

/** Pause after starting a scan before the first connect attempt. */
const DISCOVERY_SETTLE_MS = 3_000;

/**
 * Connect attempts per reconnect cycle, and the gap between them.
 *
 * Measured over repeated runs: a single attempt succeeds roughly two times in
 * three even under the best conditions, and no arrangement of scanning and
 * waiting does better. Individual attempts are cheap, so several in quick
 * succession are worth far more than a cleverer single one — four of them put
 * a cycle above 98%.
 */
const CONNECT_ATTEMPTS = 4;
const CONNECT_RETRY_MS = 1_500;

/** The lamp can take a while to answer the first handshake message. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** Signal strength worth warning about, so a weak link is visible in the log. */
const WEAK_RSSI_DBM = -80;

/**
 * How often to report signal strength.
 *
 * The lamp sends readings several times a second and they swing by several dBm
 * between them, so reporting on change — at any threshold — fills the log with
 * noise. A reading a minute is enough to tell whether a lamp is too far away,
 * which is the only question it has to answer.
 */
const RSSI_REPORT_INTERVAL_MS = 60_000;

/**
 * Spread within a reporting window that points at interference.
 *
 * Distance and obstacles give a steady reading; a lamp that is not moving
 * cannot swing this far on its own, so something else is using the band.
 */
const NOISY_SPREAD_DB = 20;

/**
 * How long to wait for a slider to settle before writing. HomeKit emits several
 * values a second while dragging; only the one it stops on matters.
 */
const WRITE_DEBOUNCE_MS = 400;

/**
 * Minimum spacing between control writes; see {@link Pacer} for the measurement
 * behind it. 150 ms keeps a margin over the 100 ms that tested clean, and is
 * still far below what anyone notices in a lamp.
 *
 * Not applied to the auth channel, whose fragments are written back to back by
 * design and have never shown the problem.
 */
const MIN_WRITE_GAP_MS = 150;

/**
 * How long after the last command to check the lamp agrees. Verification cannot
 * sit in the command's own path: the write costs a millisecond, reading it back
 * costs hundreds.
 */
const RECONCILE_DELAY_MS = 900;

/**
 * How long to disregard the lamp's own reports about a value just commanded.
 * It ramps rather than jumping, and those steps are the command happening, not
 * news worth publishing.
 */
const SETTLE_MS = 3_000;

/**
 * How often to read the lamp's state as a backstop.
 *
 * Notifications are the primary path and usually suffice, but subscribing to a
 * characteristic occasionally fails, and a lamp changed at the device would
 * then never reach HomeKit. Deliberately slow: an earlier 20-second poll was
 * implicated in connections dying, and nothing here is urgent enough to justify
 * that risk.
 */
const POLL_INTERVAL_MS = 60_000;

/**
 * How long to wait for the lamp to answer a question on the attribute channel.
 *
 * Generous because nothing is blocked on it: the coordinates are read once per
 * connection, and a question that goes unanswered only means the location is
 * left as it is.
 */
const ATTRIBUTE_REPLY_MS = 2_000;

/**
 * Spacing between the two coordinate writes.
 *
 * The MyDyson app waits 300 ms between them (`md0/l.java`) where it spaces most
 * other writes by less, and a location half-applied would aim the lamp's
 * daylight tracking at somewhere nobody is. Matching the app is cheap here.
 */
const COORDINATE_WRITE_GAP_MS = 300;

/**
 * How close two coordinates must be to count as the same place.
 *
 * A millionth of a degree is about 10 cm, far below anything a phone's GPS or a
 * map lookup can tell apart. Comparing the doubles exactly would rewrite the
 * lamp on every connection over a value that only differs in its last bit.
 */
const COORDINATE_EPSILON = 1e-6;

/** Attempts at subscribing to a characteristic before falling back to the poll. */
const SUBSCRIBE_ATTEMPTS = 3;
const SUBSCRIBE_RETRY_MS = 500;

export interface LampState {
  on: boolean;
  /** HomeKit-style brightness, 0-100 %. */
  brightness: number;
  /** Colour temperature in Kelvin, 2700-6500. */
  kelvin: number;
  /**
   * Whether the lamp is tracking daylight.
   *
   * Asked for on connecting and reported by the lamp on every change. Carried
   * across reconnects rather than reset, so that a lamp which does not answer
   * starts from the last value seen rather than from a guess.
   */
  daylight: boolean;
  /**
   * Whether the lamp is trimming its own brightness to the room — its "Auto".
   *
   * Unlike daylight mode this is a plain characteristic: readable, writable and
   * notified, so it needs none of the asking-and-inferring that one does.
   */
  autoBrightness: boolean;
  /** Whether the lamp lights on movement and goes out when the room is still. */
  movement: boolean;
  /**
   * Which preset the lamp is in, or `none`.
   *
   * The lamp keeps these mutually exclusive itself and reports both sides of a
   * change, so this follows rather than decides.
   */
  preset: Preset | 'none';
}

/** Where the lamp is, in decimal degrees. */
export interface LampLocation {
  latitude: number;
  longitude: number;
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
  /**
   * Where the lamp stands. Put into the lamp on connecting when it does not
   * already hold it; left alone entirely when absent, since a lamp set up
   * through the MyDyson app already knows.
   */
  location?: LampLocation;
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
}

export class DysonMorphLamp extends EventEmitter {
  private readonly mac: string;
  private readonly aesKey: Buffer;
  private readonly accountId: string;
  private readonly adapterName: string | undefined;
  private readonly location: LampLocation | undefined;
  private readonly log: Logger;

  private bluetooth?: ReturnType<typeof createBluetooth>;
  private adapter?: Adapter;
  private device?: Device;
  private chars: Partial<Record<string, GattCharacteristic>> = {};
  /** Per-characteristic write mode, derived from the flags the lamp advertises. */
  private writeTypes: Partial<Record<string, 'request' | 'command'>> = {};

  private readonly assembler = new MessageAssembler();
  private readonly waiters = new Map<number, (message: DysonMessage) => void>();
  /** Outstanding coordinate questions, answered on the attribute channel. */
  private readonly coordinateWaiters = new Map<Coordinate, (degrees: number) => void>();

  /** Serialises all GATT access. */
  private readonly operations = new OperationQueue();

  private readonly writes = new Debouncer(WRITE_DEBOUNCE_MS, (task, key) => this.enqueue(task, key));
  private readonly pacer = new Pacer(MIN_WRITE_GAP_MS);
  /** Whether the lamp has stated the daylight mode, rather than it being inferred. */
  private daylightReported = false;
  private readonly reconciles = new Debouncer(RECONCILE_DELAY_MS, (task, key) => this.enqueue(task, key));
  private readonly settling = new SettleWindow(SETTLE_MS);

  /** Whether the running scan is one we started and must clean up. */
  private discoveryIsOurs = false;

  /** So the "try power-cycling" hint is given once, not on every attempt. */
  private hintedStuck = false;

  private running = false;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  /** Most recent reading, reported when the link drops. */
  private lastRssi?: number;
  /** Last value reported, for the trend note. */
  private reportedRssi?: number;
  /** Readings since the last report. The spread matters as much as the mean. */
  private rssiSum = 0;
  private rssiCount = 0;
  private rssiMin = 0;
  private rssiMax = 0;
  private rssiReportedAt = 0;

  private state: LampState = {
    on: false,
    brightness: 100,
    kelvin: 2700,
    daylight: false,
    autoBrightness: false,
    movement: false,
    preset: 'none',
  };

  /** What the user last asked for. Reconciliation aims at this, not at guesses. */
  private desired: Partial<LampState> = {};

  constructor(options: LampOptions) {
    super();
    this.mac = options.mac.toUpperCase();
    this.aesKey = deriveAesKey(Buffer.from(options.ltk.replace(/[^0-9a-fA-F]/g, ''), 'hex'));
    this.accountId = options.accountId;
    this.adapterName = options.adapter;
    this.location = options.location;
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
      this.log.error(`D-Bus error talking to BlueZ: ${describeError(error)}`);
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
    clearInterval(this.pollTimer);
    await this.teardown();
    try {
      this.bluetooth?.destroy();
    } catch (error) {
      this.log.debug(`Releasing the D-Bus connection failed: ${describeError(error)}`);
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
    // Not reconciled: the lamp ramps towards a value rather than jumping to it,
    // and trims the level to suit the room while auto brightness is on, so a
    // reading that differs from the request is the lamp working rather than a
    // command that went missing.
    await this.writes.schedule(CHAR_BRIGHTNESS_LM, () => this.writeUint16(CHAR_BRIGHTNESS_LM, lumens));
  }

  /**
   * Turn daylight tracking on or off.
   *
   * Goes out on the attribute channel, which is the one part of this lamp that
   * acknowledges a write. Not reconciled all the same: the lamp announces the
   * mode itself whenever it changes, from here, from the app, from the button
   * on its base, or because setting a value by hand ended the tracking, so the
   * report is a better answer than anything read back would be.
   */
  /** Turn the lamp's own brightness trimming on or off. */
  async setAutoBrightness(on: boolean): Promise<void> {
    await this.setFlag(CHAR_AUTO_BRIGHTNESS, 'autoBrightness', on, 'Auto brightness');
  }

  /** Turn movement-triggered lighting on or off. */
  async setMovement(on: boolean): Promise<void> {
    await this.setFlag(CHAR_MOVEMENT, 'movement', on, 'Movement mode');
  }

  /**
   * Write one of the lamp's one-byte mode flags.
   *
   * Set optimistically like every other command here, but unusually well
   * covered afterwards: these characteristics notify, so the lamp corrects us
   * within a moment if the write did not land.
   */
  private async setFlag(
    uuid: string,
    field: 'autoBrightness' | 'movement',
    on: boolean,
    label: string,
  ): Promise<void> {
    this.requireConnection();
    if (!this.chars[uuid]) {
      throw new Error(`this lamp does not expose ${label.toLowerCase()}`);
    }
    this.log.debug(`${label} ${on ? 'on' : 'off'} requested`);
    this.patchState({ [field]: on });
    await this.writes.schedule(uuid, () => this.write(uuid, Buffer.from([on ? 0x01 : 0x00])));
  }

  /**
   * Put the lamp into a preset, or take it out of the one it is in.
   *
   * Only the chosen preset is written: the lamp turns the previous one off by
   * itself and says so, and writing both would race that.
   */
  async setPreset(preset: Preset | 'none'): Promise<void> {
    this.requireConnection();
    if (!this.chars[CHAR_WRITE_ATTR]) {
      throw new Error('this lamp does not expose the attribute channel');
    }
    const previous = this.state.preset;
    this.log.debug(`Preset ${preset} requested`);
    this.patchState({ preset });
    const write = preset === 'none' ? previous : preset;
    if (write === 'none') {
      return;
    }
    await this.writes.schedule(`${CHAR_WRITE_ATTR}:preset`, async () => {
      for (const fragment of buildPresetWrite(write, preset !== 'none')) {
        await this.write(CHAR_WRITE_ATTR, fragment);
      }
    });
  }

  async setDaylight(on: boolean): Promise<void> {
    this.requireConnection();
    if (!this.chars[CHAR_WRITE_ATTR]) {
      throw new Error('this lamp does not expose the attribute channel');
    }
    this.log.debug(`Daylight mode ${on ? 'on' : 'off'} requested`);
    this.patchState({ daylight: on });
    await this.writes.schedule(CHAR_WRITE_ATTR, async () => {
      for (const fragment of buildDaylightWrite(on)) {
        await this.write(CHAR_WRITE_ATTR, fragment);
      }
    });
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
      .catch((error: unknown) => this.log.debug(`Reconcile failed: ${describeError(error)}`));
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
        this.hintedStuck = false;
        return;
      } catch (error) {
        if (!this.running) {
          return;
        }
        const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!;
        this.reconnectAttempt++;
        this.log.warn(
          `Connection to ${this.mac} failed (attempt ${this.reconnectAttempt}): ${describeError(error)}. Retrying in ${delay / 1000}s.`,
        );
        if (this.reconnectAttempt >= STUCK_AFTER_ATTEMPTS && !this.hintedStuck) {
          this.hintedStuck = true;
          this.log.warn(
            `${this.mac} keeps refusing connections while still advertising. The lamp's Bluetooth ` +
              'stack gets stuck like this occasionally; disconnecting it from power for ten seconds ' +
              'clears it. Retries continue in the meantime, more slowly.',
          );
        }
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

    await this.stopOurDiscovery();

    this.connected = true;
    this.pacer.reset();
    this.daylightReported = false;
    this.settling.clear();
    await this.refreshState();
    // The lamp is the authority on where it is. Anything asked for before the
    // link dropped is history, and aiming at it would have reconciliation
    // "correct" the lamp to a state nobody is asking for any more.
    this.desired = { ...this.state };
    await this.subscribeToState();
    await this.readDaylight();
    await this.syncLocation();
    await this.subscribeToSignal();
    this.startPolling();
    const rssi = this.lastRssi;
    this.resetSignalWindow(rssi);
    this.log.info(
      `Connected to Dyson Morph at ${this.mac} — ${describeState(this.state)}${this.describeSignal(rssi)}`,
    );
    if (rssi !== undefined && rssi <= WEAK_RSSI_DBM) {
      this.log.warn(
        `Signal from ${this.mac} is weak. At this level the connection times out and drops; ` +
          'move the lamp or the Homebridge host closer to each other.',
      );
    }
    this.emit('connected');
  }

  /**
   * Connect, with a scan running, retrying briskly.
   *
   * Two things came out of measuring this. A scan has to be running and must
   * stay running through the connect — stopping it first roughly halves the
   * success rate. And no arrangement is reliable: the best managed two
   * successes in three, so the answer is repetition rather than a cleverer
   * sequence.
   */
  private async connectDevice(adapter: Adapter): Promise<Device> {
    if (!(await adapter.isDiscovering())) {
      await adapter.startDiscovery();
      this.discoveryIsOurs = true;
      this.log.debug(`Scanning for ${this.mac}`);
      await sleep(DISCOVERY_SETTLE_MS);
    }

    const device = await adapter.waitDevice(this.mac, DISCOVERY_TIMEOUT_MS);
    await this.markTrusted(device);
    await this.readAdvertisedSignal(device);

    let lastError: unknown;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
      try {
        await device.connect();
        if (attempt > 1) {
          // Repeated attempts point at collisions on the advertising channels,
          // which is what interference looks like from here.
          this.log.info(`Connected to ${this.mac} on attempt ${attempt} of ${CONNECT_ATTEMPTS}`);
        }
        return device;
      } catch (error) {
        lastError = error;
        if (attempt < CONNECT_ATTEMPTS) {
          await sleep(CONNECT_RETRY_MS);
        }
      }
    }
    throw lastError;
  }

  /**
   * Stop the scan we started, now that it has served its purpose.
   *
   * Leaving it running makes the radio time-slice between scan windows and
   * connection events for as long as the session lasts.
   */
  private async stopOurDiscovery(): Promise<void> {
    if (!this.discoveryIsOurs || !this.adapter) {
      return;
    }
    this.discoveryIsOurs = false;
    await this.adapter.stopDiscovery().catch((error: unknown) => {
      this.log.debug(`Could not stop discovery: ${describeError(error)}`);
    });
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
      this.log.debug(`Could not mark ${this.mac} trusted: ${describeError(error)}`);
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

  /**
   * Write using whichever acknowledgement mode the characteristic supports,
   * never closer than {@link MIN_WRITE_GAP_MS} behind the previous one.
   */
  private async write(uuid: string, value: Buffer): Promise<void> {
    if (uuid !== CHAR_AUTH) {
      await this.pacer.pace();
    }
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
   * Ask the lamp whether it is tracking daylight.
   *
   * The characteristic has no `read` flag, but the attribute channel carries a
   * request of its own, so the mode does not have to be guessed at. The answer
   * arrives as a notification and is handled with the change reports.
   *
   * Best-effort: a lamp that does not answer leaves the inference in
   * {@link publishFromLamp} to work it out from the tracking instead.
   */
  private async readDaylight(): Promise<void> {
    if (!this.chars[CHAR_WRITE_ATTR]) {
      return;
    }
    try {
      const asks = [buildDaylightRead(), ...Object.keys(PRESETS).map((p) => buildPresetRead(p as Preset))];
      for (const fragment of asks.flat()) {
        await this.write(CHAR_WRITE_ATTR, fragment);
      }
    } catch (error) {
      this.log.debug(`Could not ask for the daylight mode: ${describeError(error)}`);
    }
  }

  /**
   * Make sure the lamp knows where it is.
   *
   * The lamp turns its coordinates into sunrise and sunset, and daylight
   * tracking follows those, so a lamp with the wrong location tracks the wrong
   * day. They are normally set once by the MyDyson app from the phone's GPS and
   * then never revisited — including after the lamp moves house.
   *
   * Read first, write only on a difference: these are settings rather than
   * controls, and rewriting them every connection would be churn on a channel
   * shared with the mode switches.
   */
  private async syncLocation(): Promise<void> {
    if (!this.chars[CHAR_WRITE_ATTR]) {
      return;
    }
    const current = {
      latitude: await this.readCoordinate('latitude'),
      longitude: await this.readCoordinate('longitude'),
    };
    if (current.latitude !== undefined && current.longitude !== undefined) {
      this.log.debug(`Lamp ${this.mac} places itself at ${describeLocation(current as LampLocation)}`);
    }

    const wanted = this.location;
    if (!wanted) {
      return;
    }
    const settled =
      current.latitude !== undefined &&
      current.longitude !== undefined &&
      Math.abs(current.latitude - wanted.latitude) < COORDINATE_EPSILON &&
      Math.abs(current.longitude - wanted.longitude) < COORDINATE_EPSILON;
    if (settled) {
      return;
    }

    try {
      await this.enqueue(async () => {
        for (const fragment of buildCoordinateWrite('latitude', wanted.latitude)) {
          await this.write(CHAR_WRITE_ATTR, fragment);
        }
        await sleep(COORDINATE_WRITE_GAP_MS);
        for (const fragment of buildCoordinateWrite('longitude', wanted.longitude)) {
          await this.write(CHAR_WRITE_ATTR, fragment);
        }
      });
    } catch (error) {
      this.log.warn(`Could not set the location of ${this.mac}: ${describeError(error)}`);
      return;
    }

    const was =
      current.latitude !== undefined && current.longitude !== undefined
        ? ` (was ${describeLocation(current as LampLocation)})`
        : '';
    this.log.info(`Location of ${this.mac} set to ${describeLocation(wanted)}${was}`);
  }

  /**
   * Ask the lamp for one coordinate.
   *
   * @returns The value in degrees, or `undefined` if the lamp did not answer —
   * which is not an error worth raising, only a reason to leave the setting be.
   */
  private async readCoordinate(coordinate: Coordinate): Promise<number | undefined> {
    const answer = new Promise<number | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.coordinateWaiters.delete(coordinate);
        this.log.debug(`No answer from ${this.mac} about its ${coordinate}`);
        resolve(undefined);
      }, ATTRIBUTE_REPLY_MS);
      this.coordinateWaiters.set(coordinate, (degrees) => {
        clearTimeout(timer);
        this.coordinateWaiters.delete(coordinate);
        resolve(degrees);
      });
    });

    try {
      for (const fragment of buildCoordinateRead(coordinate)) {
        await this.write(CHAR_WRITE_ATTR, fragment);
      }
    } catch (error) {
      this.log.debug(`Could not ask for the ${coordinate}: ${describeError(error)}`);
    }
    return answer;
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
        failures.push(`${label}: ${describeError(error)}`);
        return undefined;
      }
    };

    const power = await read(CHAR_POWER, 'power');
    const autoBrightness = await read(CHAR_AUTO_BRIGHTNESS, 'auto brightness');
    const movement = await read(CHAR_MOVEMENT, 'movement mode');
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
    if (autoBrightness?.length) {
      patch.autoBrightness = autoBrightness[0] !== 0;
    }
    if (movement?.length) {
      patch.movement = movement[0] !== 0;
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
   * Take the adapter's reading while the lamp is still advertising.
   *
   * BlueZ publishes RSSI only for devices it is hearing; the property goes away
   * once one is connected. So this is read before connecting, and the lamp's own
   * reports take over from there.
   */
  private async readAdvertisedSignal(device: Device): Promise<void> {
    const raw = await device.getRSSI().catch(() => undefined);
    const rssi = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    if (typeof rssi === 'number' && !Number.isNaN(rssi)) {
      this.lastRssi = rssi;
    }
  }

  /** Describe the signal for a log line, or nothing when it is unavailable. */
  private describeSignal(rssi: number | undefined): string {
    return rssi === undefined ? '' : `, ${rssi} dBm${rssi <= WEAK_RSSI_DBM ? ' (weak)' : ''}`;
  }

  /**
   * Report the signal at most once a minute.
   *
   * Logging every reading buries everything else; logging none leaves the one
   * question a user can act on — is it too far away — unanswerable. The average
   * since the last report says more than whichever value happened to arrive, as
   * consecutive readings differ by several dBm.
   */
  private reportSignalChange(rssi: number): void {
    this.rssiMin = this.rssiCount === 0 ? rssi : Math.min(this.rssiMin, rssi);
    this.rssiMax = this.rssiCount === 0 ? rssi : Math.max(this.rssiMax, rssi);
    this.rssiSum += rssi;
    this.rssiCount++;
    if (Date.now() - this.rssiReportedAt < RSSI_REPORT_INTERVAL_MS) {
      return;
    }

    const mean = Math.round(this.rssiSum / this.rssiCount);
    const spread = this.rssiMax - this.rssiMin;
    const previous = this.reportedRssi;
    this.resetSignalWindow(mean);

    const trend = previous === undefined || Math.abs(mean - previous) < 3
      ? ''
      : mean > previous ? ' (improving)' : ' (worsening)';
    // The mean says how far away the lamp is; the spread says whether something
    // else is using the band. A stationary lamp cannot swing by 20 dB on its own.
    const interference = spread >= NOISY_SPREAD_DB
      ? ' — that spread suggests interference rather than distance; check for Wi-Fi or Zigbee on nearby channels'
      : '';
    const advice = mean <= WEAK_RSSI_DBM
      ? ' — at this level the connection times out and drops; move the lamp or the Homebridge host closer'
      : '';
    this.log.info(
      `Signal from ${this.mac}: ${mean} dBm average, ${this.rssiMin} to ${this.rssiMax}${trend}${advice}${interference}`,
    );
  }

  private resetSignalWindow(reported?: number): void {
    this.rssiSum = 0;
    this.rssiCount = 0;
    this.rssiReportedAt = Date.now();
    if (reported !== undefined) {
      this.reportedRssi = reported;
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
  private async subscribeToSignal(): Promise<void> {
    const characteristic = this.chars[CHAR_RSSI];
    if (!characteristic) {
      return;
    }
    characteristic.on('valuechanged', (value) => {
      if (value.length) {
        this.lastRssi = value.readInt8(0);
        this.reportSignalChange(this.lastRssi);
      }
    });
    await characteristic.startNotifications().catch((error: unknown) => {
      this.log.debug(`No signal reports from ${this.mac}: ${describeError(error)}`);
    });
  }

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
      [CHAR_AUTO_BRIGHTNESS, (value) => (value.length ? { autoBrightness: value[0] !== 0 } : undefined)],
      [CHAR_MOVEMENT, (value) => (value.length ? { movement: value[0] !== 0 } : undefined)],
      // Daylight mode arrives here twice over: the reply to the question asked
      // on connecting, and a report whenever it changes.
      [
        CHAR_WRITE_ATTR,
        (value) => {
          // Anything the lamp says about the mode outranks what we inferred.
          // Logged raw: this channel carries attributes that are not decoded,
          // and a report that arrives but says nothing looks exactly like one
          // that never arrived.
          this.log.debug(`Attribute report ${value.toString('hex')}`);
          // Coordinates share this channel but are not lamp state — HomeKit has
          // nothing to show for them — so they go to whoever asked and no
          // further.
          const coordinate = decodeCoordinateValue(value);
          if (coordinate) {
            this.coordinateWaiters.get(coordinate.coordinate)?.(coordinate.degrees);
            return undefined;
          }
          const report = decodeAttributeReport(value) ?? decodeAttributeValue(value);
          if (!report) {
            return undefined;
          }
          if ('daylight' in report) {
            this.daylightReported = true;
            return { daylight: report.daylight };
          }
          // A preset going off only means "none" if it is the one we thought was
          // on; the lamp reports the old one off just after reporting the new
          // one on, and that must not undo it.
          if (report.active) {
            return { preset: report.preset };
          }
          return this.state.preset === report.preset ? { preset: 'none' as const } : undefined;
        },
      ],
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

      // Subscribing fails intermittently with ATT 0x0e, and a characteristic
      // left unsubscribed silently stops reporting for the whole session.
      let subscribed = false;
      for (let attempt = 1; attempt <= SUBSCRIBE_ATTEMPTS && !subscribed; attempt++) {
        try {
          await characteristic.startNotifications();
          subscribed = true;
        } catch (error) {
          if (attempt === SUBSCRIBE_ATTEMPTS) {
            this.log.warn(
              `Could not subscribe to ${uuid} (${describeError(error)}). Changes made at the lamp ` +
                `will take up to ${POLL_INTERVAL_MS / 1000}s to show up.`,
            );
          } else {
            await sleep(SUBSCRIBE_RETRY_MS);
          }
        }
      }
    }
  }

  /**
   * Read the lamp periodically, so a change made at the device is not missed.
   *
   * Runs through the same queue as everything else, and its result goes through
   * the settle window, so it cannot overwrite a value the user has just set.
   */
  private startPolling(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (!this.connected) {
        return;
      }
      void this.enqueue(async () => {
        this.publishFromLamp(await this.readState());
      }, 'poll').catch((error: unknown) => {
        // A failed read is not a reason to drop a working connection; the next
        // poll, or a notification, will catch up.
        this.log.debug(`Polling the lamp failed: ${describeError(error)}`);
      });
    }, POLL_INTERVAL_MS);
  }

  private handleDisconnect(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.log.warn(
      `Lost connection to ${this.mac} — reconnecting` +
        (this.lastRssi === undefined ? '' : ` (signal was ${this.lastRssi} dBm)`),
    );
    this.emit('disconnected');
    if (this.running) {
      void this.teardown().then(() => this.connectLoop());
    }
  }

  private async teardown(): Promise<void> {
    this.connected = false;
    clearInterval(this.pollTimer);
    await this.stopOurDiscovery();
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
  /**
   * Take what the lamp reports, and read daylight mode out of it where it can.
   *
   * A fallback for a lamp that does not answer the question asked on connecting,
   * which would otherwise leave the mode unknown until something changed it.
   * Colour temperature moving when nobody asked for it is the tell: with
   * daylight mode off, nothing but a write moves it.
   *
   * Only ever concludes the mode is on. Stillness proves nothing — the lamp
   * drifts a few Kelvin a minute and less than that on a plateau — and a report
   * from the lamp always wins over an inference once one arrives.
   */
  private publishFromLamp(patch: Partial<LampState>): void {
    const filtered = this.settling.filter(patch);
    if (
      !this.daylightReported &&
      !this.state.daylight &&
      filtered.kelvin !== undefined &&
      filtered.kelvin !== this.state.kelvin
    ) {
      this.log.debug(`Colour temperature moved to ${filtered.kelvin}K unasked — the lamp is tracking daylight`);
      filtered.daylight = true;
    }
    this.patchState(filtered);
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

export function describeState(state: LampState): string {
  // Each mode is named only while the lamp is in it: spelling out the ones it
  // is not would put "no daylight, no auto, no movement" on nearly every line.
  //
  // All of them, though, not just daylight. A line is logged when the state
  // changes, so a mode missing from it produces a line identical to the one
  // before — which reads as a repeat rather than as the change it is, and hides
  // exactly the switch someone is trying to watch.
  const modes = [
    state.daylight ? 'daylight' : '',
    state.autoBrightness ? 'auto' : '',
    state.movement ? 'movement' : '',
    state.preset !== 'none' ? state.preset : '',
  ].filter(Boolean);
  return [state.on ? 'on' : 'off', `${state.brightness}%`, `${state.kelvin}K`, ...modes].join(', ');
}

/**
 * Render a location for the log.
 *
 * Five decimal places is about a metre, which is as fine as the lamp's own use
 * of it — sunrise and sunset — can possibly care about.
 */
function describeLocation(location: LampLocation): string {
  return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

