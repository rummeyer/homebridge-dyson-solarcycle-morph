import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  kelvinToMired,
  lumensToPercent,
  MAX_KELVIN,
  MAX_LUMENS,
  miredToKelvin,
  MIN_KELVIN,
  MIN_LUMENS,
  percentToLumens,
} from '../src/dyson/protocol.ts';
import { validateLightConfig } from '../src/config.ts';

test('brightness maps across the lamp lumen range', () => {
  assert.equal(percentToLumens(0), MIN_LUMENS);
  assert.equal(percentToLumens(100), MAX_LUMENS);
  assert.equal(percentToLumens(50), 550);
});

test('brightness clamps out-of-range input', () => {
  assert.equal(percentToLumens(-20), MIN_LUMENS);
  assert.equal(percentToLumens(500), MAX_LUMENS);
  assert.equal(lumensToPercent(0), 0);
  assert.equal(lumensToPercent(99_999), 100);
});

test('brightness round-trips', () => {
  for (const percent of [0, 1, 25, 50, 75, 99, 100]) {
    assert.equal(lumensToPercent(percentToLumens(percent)), percent, `at ${percent}%`);
  }
});

test('colour temperature converts between mired and Kelvin', () => {
  assert.equal(kelvinToMired(2700), 370);
  assert.equal(kelvinToMired(6500), 154);
  assert.equal(miredToKelvin(370), 2703);
  assert.equal(miredToKelvin(154), 6494);
});

test('colour temperature clamps to what the lamp supports', () => {
  assert.equal(miredToKelvin(1000), MIN_KELVIN);
  assert.equal(miredToKelvin(50), MAX_KELVIN);
  assert.equal(kelvinToMired(100), kelvinToMired(MIN_KELVIN));
  assert.equal(kelvinToMired(99_999), kelvinToMired(MAX_KELVIN));
});

const valid = {
  name: 'Desk',
  mac: 'AA:BB:CC:DD:EE:FF',
  serial: 'ABC-DE-12345678',
  ltk: 'deadbeef',
  accountId: '12345678-90ab-cdef-1234-567890abcdef',
};

test('a complete config validates', () => {
  assert.deepEqual(validateLightConfig(valid, 0), []);
});

test('a malformed MAC is rejected', () => {
  const problems = validateLightConfig({ ...valid, mac: 'F0-B1-A7-75-B1-D1' }, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /lights\[0\]\.mac/);
});

test('an odd-length or non-hex LTK is rejected', () => {
  assert.match(validateLightConfig({ ...valid, ltk: 'abc' }, 1)[0]!, /lights\[1\]\.ltk/);
  assert.match(validateLightConfig({ ...valid, ltk: 'zz' }, 0)[0]!, /ltk/);
});

test('a missing account ID is rejected', () => {
  assert.match(validateLightConfig({ ...valid, accountId: 'nope' }, 0)[0]!, /accountId/);
});

test('every missing field is reported at once', () => {
  assert.equal(validateLightConfig({}, 0).length, 5);
});
