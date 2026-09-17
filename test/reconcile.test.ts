import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planReconciliation, type LampValues } from '../src/dyson/reconcile.ts';

const plan = (wanted: LampValues, actual: LampValues) => planReconciliation(wanted, actual);

test('nothing to do when the lamp agrees', () => {
  const result = plan({ on: true, brightness: 50 }, { on: true, brightness: 50 });
  assert.deepEqual(result.corrections, []);
  assert.deepEqual(result.missed, []);
});

test('a lamp that stayed on when it should be off is corrected', () => {
  const result = plan({ on: false }, { on: true, brightness: 80 });
  assert.deepEqual(result.corrections, [{ field: 'on', value: false }]);
  assert.match(result.missed[0]!, /power .*wanted off, lamp is on/);
});

test('a lamp that stayed off when it should be on is corrected', () => {
  assert.deepEqual(plan({ on: true }, { on: false }).corrections, [{ field: 'on', value: true }]);
});

test('brightness is never corrected, however far off it is', () => {
  // The lamp tracks daylight by location and time, so asking for 100% and
  // finding 88% is it working correctly — indistinguishable from a dropped
  // command, and resending would fight the adjustment the user wants.
  assert.deepEqual(plan({ on: true, brightness: 100 }, { on: true, brightness: 88 }).corrections, []);
  assert.deepEqual(plan({ on: true, brightness: 0 }, { on: true, brightness: 100 }).corrections, []);
  assert.deepEqual(plan({ on: true, brightness: 80 }, { on: true, brightness: 20 }).corrections, []);
});

test('an off lamp reporting no brightness is not treated as a lost command', () => {
  // An off lamp reports zero lumens; correcting that would switch it back on.
  assert.deepEqual(plan({ on: false, brightness: 100 }, { on: false, brightness: 0 }).corrections, []);
});

test('colour temperature is never corrected', () => {
  assert.deepEqual(plan({ on: true, kelvin: 2700 }, { on: true, kelvin: 6500 }).corrections, []);
});

test('switching off is the only correction, whatever else disagrees', () => {
  const result = plan({ on: false, brightness: 100, kelvin: 2700 }, { on: true, brightness: 20, kelvin: 6500 });
  assert.deepEqual(result.corrections, [{ field: 'on', value: false }]);
});

test('unknown values are left alone', () => {
  assert.deepEqual(plan({}, { on: true }).corrections, [], 'nothing was asked for');
  assert.deepEqual(plan({ on: true }, {}).corrections, [], 'nothing was read back');
});
