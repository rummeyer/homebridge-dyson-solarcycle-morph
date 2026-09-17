import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planReconciliation, type LampValues } from '../src/dyson/reconcile.ts';

const tolerances = { brightness: 3, kelvin: 120 };
const plan = (wanted: LampValues, actual: LampValues) => planReconciliation(wanted, actual, tolerances);

test('nothing to do when the lamp agrees', () => {
  const result = plan({ on: true, brightness: 50, kelvin: 4000 }, { on: true, brightness: 50, kelvin: 4000 });
  assert.deepEqual(result.corrections, []);
  assert.deepEqual(result.missed, []);
});

test('a lamp that stayed on when it should be off is corrected', () => {
  const result = plan({ on: false }, { on: true, brightness: 80, kelvin: 4000 });
  assert.deepEqual(result.corrections, [{ field: 'on', value: false }]);
  assert.match(result.missed[0]!, /power .*wanted off, lamp is on/);
});

test('values are never corrected while the lamp should be off', () => {
  // The regression this guards: an off lamp reports zero lumens, so brightness
  // looks lost — and resending it switches the lamp back on.
  const result = plan({ on: false, brightness: 71, kelvin: 3300 }, { on: false, brightness: 0, kelvin: 3300 });
  assert.deepEqual(result.corrections, [], 'nothing is resent to a lamp that is meant to be dark');
});

test('values are not corrected on a lamp that is simply off', () => {
  const result = plan({ brightness: 71 }, { on: false, brightness: 0 });
  assert.deepEqual(result.corrections, []);
});

test('switching off takes precedence over the values it makes irrelevant', () => {
  const result = plan({ on: false, brightness: 100 }, { on: true, brightness: 20 });
  assert.deepEqual(result.corrections, [{ field: 'on', value: false }], 'only the power correction');
});

test('a lost brightness on a lit lamp is resent', () => {
  const result = plan({ on: true, brightness: 80 }, { on: true, brightness: 20 });
  assert.deepEqual(result.corrections, [{ field: 'brightness', value: 80 }]);
});

test('rounding within tolerance is not treated as a lost command', () => {
  assert.deepEqual(plan({ on: true, brightness: 50 }, { on: true, brightness: 52 }).corrections, []);
  assert.deepEqual(plan({ on: true, kelvin: 4000 }, { on: true, kelvin: 4100 }).corrections, []);
});

test('a difference beyond tolerance is corrected', () => {
  assert.deepEqual(plan({ on: true, brightness: 50 }, { on: true, brightness: 60 }).corrections, [
    { field: 'brightness', value: 50 },
  ]);
  assert.deepEqual(plan({ on: true, kelvin: 4000 }, { on: true, kelvin: 4500 }).corrections, [
    { field: 'kelvin', value: 4000 },
  ]);
});

test('unknown values are left alone', () => {
  assert.deepEqual(plan({}, { on: true, brightness: 50 }).corrections, []);
  assert.deepEqual(plan({ on: true, brightness: 50 }, { on: true }).corrections, [], 'nothing read back');
});

test('switching on restores the values too', () => {
  const result = plan({ on: true, brightness: 80, kelvin: 2700 }, { on: false, brightness: 0, kelvin: 4000 });
  assert.deepEqual(result.corrections, [
    { field: 'on', value: true },
    { field: 'brightness', value: 80 },
    { field: 'kelvin', value: 2700 },
  ]);
});
