/**
 * Switching a stuck Bluetooth adapter off and on.
 *
 * BlueZ or the controller under it can get stuck so that the adapter hears
 * nothing at all: every connection is aborted locally, a scan finds nothing,
 * and starting one answers "Busy". On 27.10.2026 that lasted a day, for both
 * lamps and the desk on the same adapter, until the Bluetooth service was
 * restarted. Switching the adapter's power off and on through BlueZ resets the
 * controller the same way, and needs no root.
 *
 * It is only done when it can help: when, during a scan, no device near the
 * adapter changes its signal strength for ten seconds. A lamp switched off at
 * the wall is not heard either, but its neighbours are — then nothing is
 * reset. Every other plugin on the adapter loses its devices for a moment, so
 * resets are kept apart, the longer the more of them did not help.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { EventEmitter } from 'node:events';

import { Variant } from 'dbus-next';
import type { MessageBus } from 'dbus-next';

/** Failed connections in a row before the adapter is looked at. */
export const CHECK_AFTER_ATTEMPTS = 5;
/** How long the adapter is listened to for any device changing its signal. */
export const LISTEN_MS = 10_000;
/** The least time between two resets; doubled after each, up to the most. */
export const FIRST_PAUSE_MS = 30 * 60_000;
export const LONGEST_PAUSE_MS = 6 * 60 * 60_000;

interface Log {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/** Whether any device's signal appeared or changed between two samples: the adapter hears. */
export function heardBetween(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): boolean {
  for (const [path, rssi] of after) {
    if (before.get(path) !== rssi) {
      return true;
    }
  }
  return false;
}

/** When the next reset may be, after so many that did not end the failures. */
export class ResetPacing {
  #last: number | undefined;
  #pause = FIRST_PAUSE_MS;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get due(): boolean {
    return this.#last === undefined || this.#now() - this.#last >= this.#pause;
  }

  reset(): void {
    if (this.#last !== undefined) {
      this.#pause = Math.min(this.#pause * 2, LONGEST_PAUSE_MS);
    }
    this.#last = this.#now();
  }

  /** A connection made: the adapter works, the next trouble starts afresh. */
  connected(): void {
    this.#last = undefined;
    this.#pause = FIRST_PAUSE_MS;
  }
}

/** One pacing per adapter in this process: lamps on the same adapter share it. */
const pacings = new Map<string, ResetPacing>();
const checking = new Set<string>();

export function pacingFor(adapter: string): ResetPacing {
  let pacing = pacings.get(adapter);
  if (!pacing) {
    pacing = new ResetPacing();
    pacings.set(adapter, pacing);
  }
  return pacing;
}

/** The signal strength of every device BlueZ knows under this adapter, by object path. */
async function sample(bus: MessageBus, adapterPath: string): Promise<Map<string, number>> {
  const root = await bus.getProxyObject('org.bluez', '/');
  const manager = root.getInterface('org.freedesktop.DBus.ObjectManager');
  const objects = (await manager.GetManagedObjects()) as Record<string, Record<string, Record<string, Variant>>>;
  const signals = new Map<string, number>();
  for (const [path, interfaces] of Object.entries(objects)) {
    const rssi = interfaces['org.bluez.Device1']?.RSSI?.value;
    if (path.startsWith(`${adapterPath}/`) && typeof rssi === 'number') {
      signals.set(path, rssi);
    }
  }
  return signals;
}

/**
 * After failed connections, switches the adapter off and on if it hears
 * nothing; says what it did. `handle` is node-ble's Adapter, which holds the
 * D-Bus connection and the adapter's name, such as `hci0`.
 */
export async function recoverAdapter(handle: unknown, attempts: number, log: Log): Promise<boolean> {
  const { dbus: bus, adapter } = (handle ?? {}) as { dbus?: MessageBus & EventEmitter; adapter?: string };
  if (!bus || !adapter) {
    return false;
  }
  const pacing = pacingFor(adapter);
  if (attempts < CHECK_AFTER_ATTEMPTS || !pacing.due || checking.has(adapter)) {
    return false;
  }
  checking.add(adapter);
  const path = `/org/bluez/${adapter}`;
  try {
    const object = await bus.getProxyObject('org.bluez', path);
    const properties = object.getInterface('org.freedesktop.DBus.Properties');
    const discovery = object.getInterface('org.bluez.Adapter1');
    // Listened to while scanning; a scan already running, ours or another's, will do.
    let scanning = false;
    try {
      await discovery.StartDiscovery();
      scanning = true;
    } catch (error) {
      log.debug(`starting a scan on ${adapter} to listen: ${(error as Error).message}`);
    }
    const before = await sample(bus, path);
    await sleep(LISTEN_MS);
    const after = await sample(bus, path);
    if (scanning) {
      await discovery.StopDiscovery().catch(() => {});
    }
    if (heardBetween(before, after)) {
      log.debug(`${adapter} hears other devices: the adapter is fine, not resetting it`);
      return false;
    }

    pacing.reset();
    log.warn(
      `Bluetooth adapter ${adapter} heard nothing for ${LISTEN_MS / 1000} s after ${attempts} failed ` +
        'connections — switching it off and on. Other devices on it reconnect in a moment.',
    );
    await properties.Set('org.bluez.Adapter1', 'Powered', new Variant('b', false));
    await sleep(2_000);
    await properties.Set('org.bluez.Adapter1', 'Powered', new Variant('b', true));
    for (let waited = 0; waited < 10_000; waited += 500) {
      const powered = (await properties.Get('org.bluez.Adapter1', 'Powered')) as Variant;
      if (powered.value === true) {
        log.info(`Bluetooth adapter ${adapter} is on again`);
        return true;
      }
      await sleep(500);
    }
    log.warn(`Bluetooth adapter ${adapter} did not come back on; restarting the Bluetooth service may help`);
    return true;
  } catch (error) {
    log.warn(`Could not check or reset Bluetooth adapter ${adapter}: ${(error as Error).message}`);
    return false;
  } finally {
    checking.delete(adapter);
  }
}
