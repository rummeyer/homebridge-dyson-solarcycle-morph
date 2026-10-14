import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateWatts, STANDBY_WATTS } from '../src/dyson/power.ts';
import { parseProductInfo } from '../src/dyson/protocol.ts';

test('reads the product type and firmware a CD06 reports', () => {
  const info = parseProductInfo(Buffer.from('05110200504630303035353200000000', 'hex'));
  assert.deepEqual(info, { productType: '552', firmware: '0552PF.00.05.017.0002' });
});

test('refuses product info of another shape', () => {
  assert.equal(parseProductInfo(Buffer.alloc(4)), undefined);
  assert.equal(parseProductInfo(Buffer.from('0511020000000000', 'hex')), undefined);
});

test('gives the measured value at a measured point', () => {
  assert.equal(estimateWatts('552', { on: true, brightness: 50, kelvin: 2700 }), 9.3);
  assert.equal(estimateWatts('552', { on: true, brightness: 100, kelvin: 6500 }), 11.35);
});

test('interpolates between measured points', () => {
  // Halfway between 25 % (5.0) and 50 % (9.0) at 2700 K, plus standby.
  assert.equal(estimateWatts('552', { on: true, brightness: 37.5, kelvin: 2700 }), 7.3);
  // Halfway between 2700 K (9.0) and 4600 K (8.0) at 50 %, plus standby.
  assert.equal(estimateWatts('552', { on: true, brightness: 50, kelvin: 3650 }), 8.8);
});

test('keeps to the table outside its range', () => {
  assert.equal(
    estimateWatts('552', { on: true, brightness: 100, kelvin: 9000 }),
    estimateWatts('552', { on: true, brightness: 100, kelvin: 6500 }),
  );
});

test('draws standby while off', () => {
  assert.equal(estimateWatts('552', { on: false, brightness: 100, kelvin: 2700 }), STANDBY_WATTS);
});

test('says nothing for a model that was not measured', () => {
  assert.equal(estimateWatts(undefined, { on: true, brightness: 50, kelvin: 2700 }), undefined);
  assert.equal(estimateWatts('553', { on: true, brightness: 50, kelvin: 2700 }), undefined);
});
