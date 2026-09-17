/**
 * Loads the built plugin against a stand-in Homebridge API. Catches wiring
 * mistakes (registration names, accessory setup, characteristic handlers) that
 * type-checking alone would not, without needing a lamp or a BlueZ host.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
  constructor(kind: string, displayName?: string) { this.kind = kind; this.displayName = displayName; }
  getCharacteristic(name: string): FakeCharacteristic {
    if (!this.characteristics.has(name)) {
      this.characteristics.set(name, new FakeCharacteristic(name));
    }
    return this.characteristics.get(name)!;
  }
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
  addService(kind: string, displayName?: string) {
    const service = new FakeService(kind, displayName);
    this.services.push(service);
    return service;
  }
}

function fakeApi() {
  const api = new EventEmitter() as unknown as Record<string, unknown> & EventEmitter;
  const registered: { registered: unknown[][]; unregistered: unknown[][] } = { registered: [], unregistered: [] };
  Object.assign(api, {
    platformAccessory: FakeAccessory,
    hap: {
      uuid: { generate: (s: string) => `uuid:${s}` },
      // The plugin only uses these as opaque keys, so their names suffice.
      Service: new Proxy({}, { get: (_t, p) => String(p) }),
      Characteristic: new Proxy({}, { get: (_t, p) => String(p) }),
    },
    registerPlatform: () => {},
    registerPlatformAccessories: (_p: string, _n: string, a: unknown[]) => registered.registered.push(a),
    unregisterPlatformAccessories: (_p: string, _n: string, a: unknown[]) => registered.unregistered.push(a),
    updatePlatformAccessories: () => {},
  });
  return { api, registered };
}

/** Give the lamp's background connect attempt time to fail and unwind. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const fakeLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, log: () => {}, success: () => {} };

const light = {
  name: 'Desk',
  mac: 'AA:BB:CC:DD:EE:FF',
  serial: 'ABC-DE-12345678',
  ltk: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  accountId: '12345678-90ab-cdef-1234-567890abcdef',
};

test('the entry point registers the platform under the documented names', () => {
  const entry = require('../dist/index.js').default;
  const { api } = fakeApi();
  let seen: [string, string] | undefined;
  (api as unknown as { registerPlatform: unknown }).registerPlatform = (plugin: string, platform: string) => {
    seen = [plugin, platform];
  };
  entry(api);
  assert.deepEqual(seen, ['homebridge-dyson-solarcycle-morph', 'DysonSolarcycleMorph']);

  // config.schema.json's pluginAlias is what Homebridge UI writes into config.json.
  const schema = require('../config.schema.json');
  assert.equal(schema.pluginAlias, seen![1]);
});

test('a configured light produces a lightbulb accessory with working handlers', async () => {
  const { MorphPlatform } = require('../dist/platform.js');
  const { api, registered } = fakeApi();

  new MorphPlatform(fakeLog, { platform: 'DysonSolarcycleMorph', lights: [light] }, api);
  api.emit('didFinishLaunching');

  assert.equal(registered.registered.length, 1, 'one accessory registered');
  const accessory = registered.registered[0]![0] as FakeAccessory;
  assert.equal(accessory.UUID, `uuid:homebridge-dyson-solarcycle-morph:${light.serial}`);

  const bulb = accessory.getService('Lightbulb');
  assert.ok(bulb, 'a Lightbulb service exists');
  assert.ok(!accessory.getService('MotionSensor'), 'no motion sensor unless configured');

  // Defaults are readable before the lamp has ever connected.
  assert.equal(await (bulb.getCharacteristic('On').handlers.get as () => unknown)(), false);
  assert.equal(await (bulb.getCharacteristic('Brightness').handlers.get as () => unknown)(), 100);

  // HomeKit must be told the lamp's narrower mired range.
  assert.deepEqual(bulb.getCharacteristic('ColorTemperature').props, { minValue: 154, maxValue: 370 });

  // A write with no lamp present must be reported, not thrown at HomeKit.
  await assert.doesNotReject(() => (bulb.getCharacteristic('On').handlers.set as (v: unknown) => Promise<void>)(true));

  api.emit('shutdown');
  await settle();
});

test('the motion sensor is added only when enabled', async () => {
  const { MorphPlatform } = require('../dist/platform.js');
  const { api, registered } = fakeApi();
  new MorphPlatform(fakeLog, { platform: 'x', lights: [{ ...light, motionSensor: true }] }, api);
  api.emit('didFinishLaunching');
  assert.ok((registered.registered[0]![0] as FakeAccessory).getService('MotionSensor'));
  api.emit('shutdown');
  await settle();
});

test('an invalid light is skipped instead of crashing the bridge', () => {
  const { MorphPlatform } = require('../dist/platform.js');
  const { api, registered } = fakeApi();
  const errors: string[] = [];
  new MorphPlatform(
    { ...fakeLog, error: (m: string) => errors.push(m) },
    { platform: 'x', lights: [{ ...light, mac: 'garbage' }] },
    api,
  );
  api.emit('didFinishLaunching');
  assert.equal(registered.registered.length, 0);
  assert.ok(errors.some((e) => e.includes('.mac')), 'the MAC problem is reported');
});
