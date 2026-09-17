#!/usr/bin/env node
/**
 * Standalone GATT probe. Plain JavaScript so it runs on the Raspberry Pi with
 * nothing but `npm install node-ble` — no build step, no plugin install.
 *
 *   node tools/ble-probe.js AA:BB:CC:DD:EE:FF
 *
 * Dumps every service and characteristic the lamp exposes, reads what it can,
 * and watches for notifications. Use this to confirm the documented UUIDs
 * before trusting them, and to see whether unauthenticated reads are allowed.
 */
import { createBluetooth } from 'node-ble';

const MAC = (process.argv[2] || '').toUpperCase();
const WATCH_SECONDS = Number(process.argv[3] || 20);

if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('Usage: node tools/ble-probe.js <MAC> [seconds-to-watch]');
  process.exit(1);
}

/** UUIDs we expect, from the reverse-engineered Lightcycle/Solarcycle protocol. */
const KNOWN = {
  '2dd10010-1c37-452d-8979-d1b4a787d0a4': 'Dyson service',
  '2dd10011-1c37-452d-8979-d1b4a787d0a4': 'auth channel',
  '2dd10013-1c37-452d-8979-d1b4a787d0a4': 'RSSI',
  '2dd10021-1c37-452d-8979-d1b4a787d0a4': 'attribute write',
  '2dd11000-1c37-452d-8979-d1b4a787d0a4': 'brightness %',
  '2dd11001-1c37-452d-8979-d1b4a787d0a4': 'colour temp (K, uint16 LE)',
  '2dd11005-1c37-452d-8979-d1b4a787d0a4': 'power (0/1)',
  '2dd11006-1c37-452d-8979-d1b4a787d0a4': 'runtime flags',
  '2dd11007-1c37-452d-8979-d1b4a787d0a4': 'ambient sensor',
  '2dd11008-1c37-452d-8979-d1b4a787d0a4': 'motion',
  '2dd11009-1c37-452d-8979-d1b4a787d0a4': 'brightness (lm, uint16 LE)',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Render a value as hex plus the interpretations that are plausible for it. */
function describeValue(buf) {
  const parts = [`hex=${buf.toString('hex') || '(empty)'}`];
  if (buf.length === 1) {
    parts.push(`u8=${buf[0]}`);
  }
  if (buf.length === 2) {
    parts.push(`u16le=${buf.readUInt16LE(0)}`);
  }
  return parts.join('  ');
}

async function main() {
  const { bluetooth, destroy } = createBluetooth();
  const adapter = await bluetooth.defaultAdapter();

  if (!(await adapter.isPowered())) {
    throw new Error('Bluetooth adapter is powered off — run: bluetoothctl power on');
  }
  if (!(await adapter.isDiscovering())) {
    await adapter.startDiscovery();
  }

  console.log(`Waiting for ${MAC} …`);
  const device = await adapter.waitDevice(MAC, 60_000);

  for (const [label, fn] of [
    ['name', 'getName'],
    ['alias', 'getAlias'],
    ['RSSI', 'getRSSI'],
    ['paired', 'isPaired'],
  ]) {
    try {
      console.log(`  ${label}: ${await device[fn]()}`);
    } catch (e) {
      console.log(`  ${label}: (unavailable)`);
    }
  }

  console.log('Connecting …');
  await device.connect();
  const gatt = await device.gatt();

  const notifying = [];

  for (const serviceUuid of await gatt.services()) {
    const service = await gatt.getPrimaryService(serviceUuid);
    console.log(`\nService ${serviceUuid}  ${KNOWN[serviceUuid] ? `(${KNOWN[serviceUuid]})` : ''}`);

    for (const charUuid of await service.characteristics()) {
      const characteristic = await service.getCharacteristic(charUuid);
      const flags = await characteristic.getFlags();
      const label = KNOWN[charUuid] ? `  ← ${KNOWN[charUuid]}` : '';
      console.log(`  ${charUuid}  [${flags.join(', ')}]${label}`);

      if (flags.includes('read')) {
        try {
          console.log(`      read: ${describeValue(await characteristic.readValue())}`);
        } catch (e) {
          // A permission error here is the interesting case: it tells us the
          // lamp gates this characteristic behind the auth handshake.
          console.log(`      read failed: ${e.message}`);
        }
      }

      if (flags.includes('notify')) {
        try {
          characteristic.on('valuechanged', (buf) => {
            console.log(`  [notify] ${charUuid}  ${describeValue(buf)}`);
          });
          await characteristic.startNotifications();
          notifying.push(characteristic);
        } catch (e) {
          console.log(`      notify failed: ${e.message}`);
        }
      }
    }
  }

  console.log(`\nWatching notifications for ${WATCH_SECONDS}s — touch the lamp or wave at it now.`);
  await sleep(WATCH_SECONDS * 1000);

  for (const characteristic of notifying) {
    await characteristic.stopNotifications().catch(() => {});
  }
  await device.disconnect().catch(() => {});
  destroy();
  console.log('Done.');
}

main().catch((e) => {
  console.error(`\nProbe failed: ${e.message}`);
  process.exit(1);
});
