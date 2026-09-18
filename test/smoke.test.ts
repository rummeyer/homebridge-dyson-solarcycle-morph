/**
 * Loads the built plugin against a stand-in Homebridge API. Catches wiring
 * mistakes (registration names, accessory setup, characteristic handlers) that
 * type-checking alone would not, without needing a lamp or a BlueZ host.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const load = (file: string) => import(pathToFileURL(resolve(file)).href);

class FakeCharacteristic {
  handlers: Record<string, unknown> = {};
  props: Record<string, unknown> = {};
  name: string;
  constructor(name: string) { this.name = name; }
  onGet(fn: unknown) { this.handlers.get = fn; return this; }
  onSet(fn: unknown) { this.handlers.set = fn; return this; }
  setProps(p: Record<string, unknown>) { Object.assign(this.props, p); return this; }
}

class FakeService {
  characteristics = new Map<string, FakeCharacteristic>();
  kind: string;
  displayName: string | undefined;
  subtype: string | undefined;
  constructor(kind: string, displayName?: string, subtype?: string) {
    this.kind = kind;
    this.displayName = displayName;
    this.subtype = subtype;
  }
  getCharacteristic(name: string): FakeCharacteristic {
    if (!this.characteristics.has(name)) {
      this.characteristics.set(name, new FakeCharacteristic(name));
    }
    return this.characteristics.get(name)!;
  }
  linked: FakeService[] = [];
  addLinkedService(service: FakeService) { this.linked.push(service); return this; }
  setCharacteristic(name: string, _value: unknown) { this.getCharacteristic(name); return this; }
  updateCharacteristic(name: string, _value: unknown) { this.getCharacteristic(name); return this; }
}

class FakeAccessory {
  services: FakeService[] = [];
  context: Record<string, unknown> = {};
  displayName: string;
  UUID: string;
  constructor(displayName: string, uuid: string) { this.displayName = displayName; this.UUID = uuid; }
  getService(kind: string) { return this.services.find((s) => s.kind === kind); }
  getServiceById(kind: string, subtype: string) {
    return this.services.find((s) => s.kind === kind && s.subtype === subtype);
  }
  addService(kind: string, displayName?: string, subtype?: string) {
    const service = new FakeService(kind, displayName, subtype);
    this.services.push(service);
    return service;
  }
}

function fakeApi(storagePath: string = mkdtempSync(join(tmpdir(), 'morph-test-'))) {
  const api = new EventEmitter() as unknown as Record<string, unknown> & EventEmitter;
  const registered: { registered: unknown[][]; unregistered: unknown[][] } = { registered: [], unregistered: [] };
  Object.assign(api, {
    platformAccessory: FakeAccessory,
    user: { storagePath: () => storagePath },
    hap: {
      uuid: { generate: (s: string) => `uuid:${s}` },
      // Stand-in for HAP's way of saying an accessory cannot be reached.
      HapStatusError: class HapStatusError extends Error {
        hapStatus: number;
        constructor(status: number) {
          super(`HapStatusError ${status}`);
          this.hapStatus = status;
        }
      },
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
      // The plugin only uses these as opaque keys, so their names suffice.
      Service: new Proxy({}, { get: (_t, p) => String(p) }),
      Characteristic: new Proxy({}, { get: (_t, p) => String(p) }),
    },
    registerPlatform: () => {},
    registerPlatformAccessories: (_p: string, _n: string, a: unknown[]) => registered.registered.push(a),
    unregisterPlatformAccessories: (_p: string, _n: string, a: unknown[]) => registered.unregistered.push(a),
    updatePlatformAccessories: () => {},
  });
  return { api, registered, storagePath };
}

/** Give async device discovery and the lamp's background connect time to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

const fakeLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, log: () => {}, success: () => {} };

const light = {
  name: 'Desk',
  mac: 'AA:BB:CC:DD:EE:FF',
  serial: 'ABC-DE-12345678',
  ltk: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  accountId: '12345678-90ab-cdef-1234-567890abcdef',
};

test('Homebridge can load the built entry point and register the platform', async () => {
  // Mirrors homebridge/dist/plugin.js: dynamic import, then the default export
  // (falling back to a nested default, which only CommonJS builds need).
  const namespace = await load('dist/index.js');
  const exported = namespace.default;
  const initializer = typeof exported === 'function' ? exported : exported?.default;
  assert.equal(typeof exported, 'function', 'the default export is the initializer itself');
  assert.equal(typeof initializer, 'function');

  const { api } = fakeApi();
  let seen: [string, string] | undefined;
  (api as unknown as { registerPlatform: unknown }).registerPlatform = (plugin: string, platform: string) => {
    seen = [plugin, platform];
  };
  (initializer as (a: unknown) => void)(api);
  assert.deepEqual(seen, ['homebridge-dyson-solarcycle-morph', 'DysonSolarcycleMorph']);

  // config.schema.json's pluginAlias is what Homebridge UI writes into config.json.
  assert.equal(readJson('../config.schema.json').pluginAlias, seen![1]);

  // package.json's name is the plugin name Homebridge registers accessories under.
  assert.equal(readJson('../package.json').name, seen![0]);
});

test('a configured light produces a lightbulb accessory with working handlers', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();

  new MorphPlatform(fakeLog, { platform: 'DysonSolarcycleMorph', lights: [light] }, api);
  api.emit('didFinishLaunching');
  await settle();

  assert.equal(registered.registered.length, 1, 'one accessory registered');
  const accessory = registered.registered[0]![0] as FakeAccessory;
  assert.equal(accessory.UUID, `uuid:homebridge-dyson-solarcycle-morph:${light.serial}`);

  const bulb = accessory.getService('Lightbulb');
  assert.ok(bulb, 'a Lightbulb service exists');
  assert.ok(!accessory.getService('MotionSensor'), 'no motion sensor unless configured');

  // An unreachable lamp must report itself as such rather than serving the last
  // value it happened to know, which HomeKit would show as current.
  for (const name of ['On', 'Brightness', 'ColorTemperature']) {
    await assert.rejects(
      async () => (bulb.getCharacteristic(name).handlers.get as () => unknown)(),
      /HapStatusError -70402/,
      `${name} should report a communication failure while disconnected`,
    );
  }

  // HomeKit must be told the lamp's narrower mired range.
  assert.deepEqual(bulb.getCharacteristic('ColorTemperature').props, { minValue: 154, maxValue: 370 });

  // A write that cannot be delivered must be reported to HomeKit, not silently
  // accepted: nothing retries it, so the Home app would otherwise show a value
  // the lamp never received.
  await assert.rejects(
    async () => (bulb.getCharacteristic('On').handlers.set as (v: unknown) => Promise<void>)(true),
    /HapStatusError -70402/,
  );

  api.emit('shutdown');
  await settle();
});

test('the motion sensor is added only when enabled', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  new MorphPlatform(fakeLog, { platform: 'x', lights: [{ ...light, motionSensor: true }] }, api);
  api.emit('didFinishLaunching');
  await settle();
  assert.ok((registered.registered[0]![0] as FakeAccessory).getService('MotionSensor'));
  api.emit('shutdown');
  await settle();
});

test('the daylight switch is there unless it is turned off', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  // On by default: without it there is no way back into daylight tracking from
  // HomeKit once a colour temperature has been set.
  new MorphPlatform(fakeLog, { platform: 'x', lights: [light] }, api);
  api.emit('didFinishLaunching');
  await settle();
  assert.ok((registered.registered[0]![0] as FakeAccessory).getServiceById('Switch', 'daylight'));
  api.emit('shutdown');
  await settle();
});

test('the daylight switch can be turned off', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  new MorphPlatform(fakeLog, { platform: 'x', lights: [{ ...light, daylightSwitch: false }] }, api);
  api.emit('didFinishLaunching');
  await settle();
  const accessory = registered.registered[0]![0] as FakeAccessory;
  assert.equal(accessory.getServiceById('Switch', 'daylight'), undefined);
  assert.ok(accessory.getServiceById('Switch', 'auto'), 'the other switches are unaffected');
  api.emit('shutdown');
  await settle();
});

test('each mode gets its own switch, and they are distinct', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  new MorphPlatform(fakeLog, { platform: 'x', lights: [light] }, api);
  api.emit('didFinishLaunching');
  await settle();
  const accessory = registered.registered[0]![0] as FakeAccessory;
  const subtypes = ['daylight', 'auto', 'movement'].map((t) => accessory.getServiceById('Switch', t));
  // Three Switch services on one accessory: binding any of them by type alone
  // would wire several handlers to whichever came first.
  assert.ok(subtypes.every(Boolean), 'all three switches exist');
  assert.equal(new Set(subtypes).size, 3, 'and they are three different services');
  api.emit('shutdown');
  await settle();
});

test('the movement switch can be turned off on its own', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  new MorphPlatform(fakeLog, { platform: 'x', lights: [{ ...light, movementSwitch: false }] }, api);
  api.emit('didFinishLaunching');
  await settle();
  const accessory = registered.registered[0]![0] as FakeAccessory;
  assert.equal(accessory.getServiceById('Switch', 'movement'), undefined);
  assert.ok(accessory.getServiceById('Switch', 'auto'), 'auto brightness is unaffected');
  assert.ok(accessory.getServiceById('Switch', 'daylight'), 'daylight is unaffected');
  api.emit('shutdown');
  await settle();
});

test('each preset gets its own switch on the lamp', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  new MorphPlatform(fakeLog, { platform: 'x', lights: [light] }, api);
  api.emit('didFinishLaunching');
  await settle();
  assert.equal(registered.registered.length, 1, 'all on the one accessory');
  const accessory = registered.registered[0]![0] as FakeAccessory;
  const switches = ['daylight', 'auto', 'movement', 'study', 'relax', 'precision'].map((t) =>
    accessory.getServiceById('Switch', t),
  );
  assert.ok(switches.every(Boolean), 'six switches');
  assert.equal(new Set(switches).size, 6, 'and all of them distinct');
  api.emit('shutdown');
  await settle();
});

test('the preset switches can be turned off', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  new MorphPlatform(fakeLog, { platform: 'x', lights: [{ ...light, presetSwitches: false }] }, api);
  api.emit('didFinishLaunching');
  await settle();
  const accessory = registered.registered[0]![0] as FakeAccessory;
  assert.equal(accessory.getServiceById('Switch', 'study'), undefined);
  assert.ok(accessory.getServiceById('Switch', 'daylight'), 'the mode switches are unaffected');
  api.emit('shutdown');
  await settle();
});

test('an invalid light is skipped instead of crashing the bridge', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  const errors: string[] = [];
  new MorphPlatform(
    { ...fakeLog, error: (m: string) => errors.push(m) },
    { platform: 'x', lights: [{ ...light, mac: 'garbage' }] },
    api,
  );
  api.emit('didFinishLaunching');
  await settle();
  assert.equal(registered.registered.length, 0);
  assert.ok(errors.some((e) => e.includes('.mac')), 'the MAC problem is reported');
});

test('a light with no stored credentials is skipped with a pairing hint', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  const errors: string[] = [];
  const { ltk: _ltk, accountId: _accountId, ...unpaired } = light;

  new MorphPlatform({ ...fakeLog, error: (m: string) => errors.push(m) }, { platform: 'x', lights: [unpaired] }, api);
  api.emit('didFinishLaunching');
  await settle();

  assert.equal(registered.registered.length, 0, 'no accessory without credentials');
  assert.ok(errors.some((e) => e.includes('not paired yet')), `expected a pairing hint, got ${errors.join(' | ')}`);
});

test('credentials stored by the settings UI are used when the config omits them', async () => {
  const { CredentialStore } = await load('dist/dyson/credentials.js');
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered, storagePath } = fakeApi();
  const { ltk: _ltk, accountId: _accountId, ...unpaired } = light;

  // Exactly what the settings page writes.
  await new CredentialStore(storagePath, 'homebridge-dyson-solarcycle-morph').set(light.serial, {
    ltk: light.ltk,
    accountId: light.accountId,
  });

  new MorphPlatform(fakeLog, { platform: 'x', lights: [unpaired] }, api);
  api.emit('didFinishLaunching');
  await settle();

  assert.equal(registered.registered.length, 1, 'the stored key was picked up');
  api.emit('shutdown');
  await settle();
});

test('a serial is matched case-insensitively against the store', async () => {
  const { CredentialStore } = await load('dist/dyson/credentials.js');
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered, storagePath } = fakeApi();
  const { ltk: _ltk, accountId: _accountId, ...unpaired } = light;

  await new CredentialStore(storagePath, 'homebridge-dyson-solarcycle-morph').set(light.serial.toLowerCase(), {
    ltk: light.ltk,
    accountId: light.accountId,
  });

  new MorphPlatform(fakeLog, { platform: 'x', lights: [unpaired] }, api);
  api.emit('didFinishLaunching');
  await settle();

  assert.equal(registered.registered.length, 1);
  api.emit('shutdown');
  await settle();
});
