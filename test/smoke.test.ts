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
  // Real characteristics hold their value, and Homebridge saves it to its
  // accessory cache and restores it on the next start. Names depend on that.
  value: unknown;
  constructor(name: string) { this.name = name; }
  updateValue(value: unknown) { this.value = value; return this; }
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
  // HAP keeps these two lists apart, and saves both to the accessory cache.
  optionalCharacteristics: string[] = [];
  testCharacteristic(name: string) { return this.characteristics.has(name); }
  addOptionalCharacteristic(name: string) { this.optionalCharacteristics.push(name); }
  setCharacteristic(name: string, value: unknown) { this.getCharacteristic(name).value = value; return this; }
  updateCharacteristic(name: string, value: unknown) { this.getCharacteristic(name).value = value; return this; }
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
  removeService(service: FakeService) {
    this.services = this.services.filter((s) => s !== service);
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

const LIGHT_UUID = `uuid:homebridge-dyson-solarcycle-morph:${light.serial}`;
const SWITCH_UUID = `${LIGHT_UUID}:switches`;

/** One lamp is two accessories now; pick whichever the assertion is about. */
const find = (registered: { registered: unknown[][] }, uuid: string) =>
  (registered.registered.flat() as FakeAccessory[]).find((a) => a.UUID === uuid);

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

  assert.equal(registered.registered.length, 2, 'the light and its switches');
  const accessory = find(registered, LIGHT_UUID);
  assert.ok(accessory, 'the light keeps the UUID it has always had');

  const bulb = accessory.getService('Lightbulb');
  assert.ok(bulb, 'a Lightbulb service exists');

  // The point of the split: tapping the lamp in the Home app turns it on,
  // rather than opening a folder of controls.
  assert.equal(accessory.getService('Switch'), undefined, 'and no switch sits on the lamp itself');

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

test('the daylight switch is there unless it is turned off', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  // On by default: without it there is no way back into daylight tracking from
  // HomeKit once a colour temperature has been set.
  new MorphPlatform(fakeLog, { platform: 'x', lights: [light] }, api);
  api.emit('didFinishLaunching');
  await settle();
  assert.ok(find(registered, SWITCH_UUID)!.getServiceById('Switch', 'daylight'));
  api.emit('shutdown');
  await settle();
});

test('the daylight switch can be turned off', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  new MorphPlatform(fakeLog, { platform: 'x', lights: [{ ...light, daylightSwitch: false }] }, api);
  api.emit('didFinishLaunching');
  await settle();
  const accessory = find(registered, SWITCH_UUID)!;
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
  const accessory = find(registered, SWITCH_UUID)!;
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
  const accessory = find(registered, SWITCH_UUID)!;
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
  const accessory = find(registered, SWITCH_UUID)!;
  const switches = ['daylight', 'auto', 'movement', 'study', 'relax', 'precision'].map((t) =>
    accessory.getServiceById('Switch', t),
  );
  assert.ok(switches.every(Boolean), 'six switches, all on the one accessory');
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
  const accessory = find(registered, SWITCH_UUID)!;
  assert.equal(accessory.getServiceById('Switch', 'study'), undefined);
  assert.ok(accessory.getServiceById('Switch', 'daylight'), 'the mode switches are unaffected');
  api.emit('shutdown');
  await settle();
});

test('a motion sensor left on a cached accessory is taken off it', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  const platform = new MorphPlatform(fakeLog, { platform: 'x', lights: [light] }, api);

  // An accessory from before 1.0.0, with the sensor HomeKit is still showing.
  const cached = new FakeAccessory(light.name, `uuid:homebridge-dyson-solarcycle-morph:${light.serial}`);
  cached.addService('MotionSensor', 'Desk Motion');
  (platform as unknown as { configureAccessory: (a: unknown) => void }).configureAccessory(cached);

  api.emit('didFinishLaunching');
  await settle();
  assert.equal(cached.getService('MotionSensor'), undefined, 'the sensor is gone');
  assert.ok(cached.getService('Lightbulb'), 'and the lamp is still there');
  assert.equal(registered.registered.length, 1, 'only the switches accessory is new');
  assert.ok(find(registered, SWITCH_UUID), 'and the cached lamp was reused');
  api.emit('shutdown');
  await settle();
});

test('switches left on a cached lamp from before 1.1.0 are taken off it', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  const platform = new MorphPlatform(fakeLog, { platform: 'x', lights: [light] }, api);

  // An accessory as 1.0.2 left it: the light and all six switches together.
  const cached = new FakeAccessory(light.name, LIGHT_UUID);
  cached.addService('Lightbulb', 'Desk');
  for (const subtype of ['daylight', 'auto', 'movement', 'study', 'relax', 'precision']) {
    cached.addService('Switch', `Desk ${subtype}`, subtype);
  }
  (platform as unknown as { configureAccessory: (a: unknown) => void }).configureAccessory(cached);

  api.emit('didFinishLaunching');
  await settle();

  // Not adding them here any more is not the same as removing them: without
  // this they would show in both places at once.
  assert.equal(cached.getService('Switch'), undefined, 'the lamp is a light and nothing else');
  assert.ok(cached.getService('Lightbulb'), 'and it is still a light');
  const switches = find(registered, SWITCH_UUID);
  assert.ok(switches, 'the switches have an accessory of their own');
  assert.equal(
    ['daylight', 'auto', 'movement', 'study', 'relax', 'precision'].filter((t) =>
      switches.getServiceById('Switch', t),
    ).length,
    6,
    'and all six are on it',
  );
  api.emit('shutdown');
  await settle();
});

test('with every switch turned off there is no switch accessory at all', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  const platform = new MorphPlatform(
    fakeLog,
    {
      platform: 'x',
      lights: [
        {
          ...light,
          daylightSwitch: false,
          autoBrightnessSwitch: false,
          movementSwitch: false,
          presetSwitches: false,
        },
      ],
    },
    api,
  );

  // One from a run before they were all turned off, which has to go.
  const cachedSwitches = new FakeAccessory(`${light.name} Switches`, SWITCH_UUID);
  (platform as unknown as { configureAccessory: (a: unknown) => void }).configureAccessory(cachedSwitches);

  api.emit('didFinishLaunching');
  await settle();

  assert.equal(registered.registered.length, 1, 'just the light');
  assert.ok(find(registered, LIGHT_UUID), 'and it is the light');
  assert.deepEqual(registered.unregistered, [[cachedSwitches]], 'the empty switch accessory is dropped');
  api.emit('shutdown');
  await settle();
});

test('a switch turned off later comes off the accessory it is on', async () => {
  const { MorphPlatform } = await load('dist/platform.js');
  const { api, registered } = fakeApi();
  const platform = new MorphPlatform(
    fakeLog,
    { platform: 'x', lights: [{ ...light, movementSwitch: false }] },
    api,
  );

  // Cached from a run when movement was still on.
  const cached = new FakeAccessory(`${light.name} Switches`, SWITCH_UUID);
  cached.addService('Switch', 'Desk Movement', 'movement');
  (platform as unknown as { configureAccessory: (a: unknown) => void }).configureAccessory(cached);

  api.emit('didFinishLaunching');
  await settle();

  assert.equal(cached.getServiceById('Switch', 'movement'), undefined, 'the disabled switch is gone');
  assert.ok(cached.getServiceById('Switch', 'daylight'), 'the ones still wanted are there');
  assert.equal(registered.unregistered.length, 0, 'and the accessory itself stays');
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

  assert.ok(find(registered, LIGHT_UUID), 'the stored key was picked up');
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

  assert.ok(find(registered, LIGHT_UUID));
  api.emit('shutdown');
  await settle();
});

test('a switch renamed in the Home app keeps its name across a restart', async () => {
  const { MorphPlatform } = await load('dist/platform.js');

  /**
   * Start the platform the way Homebridge does, handing back whatever it
   * registered. Accessories passed in arrive through `configureAccessory`
   * first, which is how a restart looks from a plugin's side: the same objects,
   * carrying the values and context saved from the run before.
   */
  const boot = async (lightConfig: Record<string, unknown>, cached: FakeAccessory[] = []) => {
    const { api, registered } = fakeApi();
    const platform = new MorphPlatform(fakeLog, { platform: 'DysonSolarcycleMorph', lights: [lightConfig] }, api);
    for (const accessory of cached) {
      platform.configureAccessory(accessory);
    }
    api.emit('didFinishLaunching');
    await settle();
    const accessories = cached.length > 0 ? cached : (registered.registered.flat() as FakeAccessory[]);
    api.emit('shutdown');
    await settle();
    return accessories;
  };

  const first = await boot(light);
  const switches = first.find((a) => a.UUID === SWITCH_UUID);
  assert.ok(switches, 'the switches accessory is registered');

  const daylight = switches.getServiceById('Switch', 'daylight');
  assert.ok(daylight, 'the daylight switch is there');
  assert.equal(
    daylight.getCharacteristic('ConfiguredName').value,
    'Daylight',
    'a new switch is named for what it does, without repeating the lamp name',
  );

  // What the Home app does when someone renames a switch: it writes
  // ConfiguredName, and Homebridge saves it with the accessory.
  daylight.getCharacteristic('ConfiguredName').value = 'Reading Light';

  await boot(light, first);
  assert.equal(
    daylight.getCharacteristic('ConfiguredName').value,
    'Reading Light',
    'the rename survives a restart rather than being overwritten with the generated name',
  );

  // Renaming the lamp in the config leaves the switch names alone now that they
  // no longer carry it, and must still not disturb a rename.
  const movement = switches.getServiceById('Switch', 'movement');
  assert.equal(movement?.getCharacteristic('ConfiguredName').value, 'Movement');

  await boot({ ...light, name: 'Office' }, first);
  assert.equal(movement?.getCharacteristic('ConfiguredName').value, 'Movement');

  // Declaring ConfiguredName is a bare push that HAP saves with the accessory,
  // so it has to happen once and not once per start — three boots have now
  // happened, and the cache would grow on every one of them.
  assert.deepEqual(
    daylight.optionalCharacteristics,
    ['ConfiguredName'],
    'the optional characteristic is declared once, not on every restart',
  );
  assert.equal(
    daylight.getCharacteristic('ConfiguredName').value,
    'Reading Light',
    'and the renamed one is still left alone',
  );
});

test('switches named by an older version are renamed, unless they were renamed by hand', async () => {
  const { MorphPlatform } = await load('dist/platform.js');

  // How 1.2.2 and earlier left an accessory: every switch prefixed with the
  // lamp's name, and no record of which names the plugin generated.
  const cached = new FakeAccessory('Desk Switches', SWITCH_UUID);
  for (const [subtype, name] of [
    ['daylight', 'Desk Daylight'],
    ['auto', 'Desk Auto Brightness'],
    ['movement', 'Keep An Eye Out'],
  ] as const) {
    cached.addService('Switch', name, subtype).setCharacteristic('ConfiguredName', name);
  }
  const cachedLight = new FakeAccessory('Desk', LIGHT_UUID);

  const { api } = fakeApi();
  const platform = new MorphPlatform(fakeLog, { platform: 'DysonSolarcycleMorph', lights: [light] }, api);
  platform.configureAccessory(cachedLight);
  platform.configureAccessory(cached);
  api.emit('didFinishLaunching');
  await settle();

  assert.equal(
    cached.getServiceById('Switch', 'daylight')?.getCharacteristic('ConfiguredName').value,
    'Daylight',
    'a switch still carrying the old generated name is moved to the new one',
  );
  assert.equal(
    cached.getServiceById('Switch', 'auto')?.getCharacteristic('ConfiguredName').value,
    'Auto Brightness',
  );
  assert.equal(
    cached.getServiceById('Switch', 'movement')?.getCharacteristic('ConfiguredName').value,
    'Keep An Eye Out',
    'but one renamed before the upgrade is not mistaken for a generated name',
  );

  api.emit('shutdown');
  await settle();
});
