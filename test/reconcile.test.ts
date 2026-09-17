import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planReconciliation, type LampValues } from '../src/dyson/reconcile.ts';

const tolerances = { brightness: 3 };
const plan = (wanted: LampValues, actual: LampValues) => planReconciliation(wanted, actual, tolerances);

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

test('values are never corrected while the lamp should be off', () => {
  // The regression this guards: an off lamp reports zero lumens, so brightness
  // looks lost — and resending it switches the lamp back on.
  const result = plan({ on: false, brightness: 100 }, { on: false, brightness: 0 });
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

test('a mid-range brightness is left alone even when it clearly did not land', () => {
  // Deliberate: the user fixes this with one slider movement, and checking it
  // costs a read on a link that is not always there.
  assert.deepEqual(plan({ on: true, brightness: 80 }, { on: true, brightness: 20 }).corrections, []);
});

test('full brightness is resent when it did not land', () => {
  assert.deepEqual(plan({ on: true, brightness: 100 }, { on: true, brightness: 40 }).corrections, [
    { field: 'brightness', value: 100 },
  ]);
});

test('minimum brightness is resent when it did not land', () => {
  assert.deepEqual(plan({ on: true, brightness: 0 }, { on: true, brightness: 60 }).corrections, [
    { field: 'brightness', value: 0 },
  ]);
});

test('rounding at an extreme is not treated as a lost command', () => {
  assert.deepEqual(plan({ on: true, brightness: 100 }, { on: true, brightness: 98 }).corrections, []);
  assert.deepEqual(plan({ on: true, brightness: 0 }, { on: true, brightness: 2 }).corrections, []);
});

test('colour temperature is never checked', () => {
  assert.deepEqual(plan({ on: true, kelvin: 2700 }, { on: true, kelvin: 6500 }).corrections, []);
});

test('unknown values are left alone', () => {
  assert.deepEqual(plan({}, { on: true, brightness: 50 }).corrections, []);
  assert.deepEqual(plan({ on: true, brightness: 50 }, { on: true }).corrections, [], 'nothing read back');
});

test('switching on carries full brightness with it', () => {
  const result = plan({ on: true, brightness: 100 }, { on: false, brightness: 0 });
  assert.deepEqual(result.corrections, [
    { field: 'on', value: true },
    { field: 'brightness', value: 100 },
  ]);
});

test('switching on does not drag a mid-range brightness along', () => {
  assert.deepEqual(plan({ on: true, brightness: 60 }, { on: false, brightness: 0 }).corrections, [
    { field: 'on', value: true },
  ]);
});
