import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_KELVIN,
  MAX_LUMENS,
  MIN_KELVIN,
  MIN_LUMENS,
  buildAttributeWrite,
  buildAttributeRead,
  buildDaylightWrite,
  decodeAttributeReport,
  decodeAttributeValue,
  kelvinToMired,
  lumensToPercent,
  miredToKelvin,
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
};

const credentials = {
  ltk: 'deadbeef',
  accountId: '12345678-90ab-cdef-1234-567890abcdef',
};

test('a config without credentials validates — they come from the store', () => {
  assert.deepEqual(validateLightConfig(valid, 0), []);
});

test('a config that overrides both credentials validates', () => {
  assert.deepEqual(validateLightConfig({ ...valid, ...credentials }, 0), []);
});

test('a malformed MAC is rejected', () => {
  const problems = validateLightConfig({ ...valid, mac: 'F0-B1-A7-75-B1-D1' }, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /lights\[0\]\.mac/);
});

test('a supplied LTK is still checked for shape', () => {
  assert.match(validateLightConfig({ ...valid, ...credentials, ltk: 'abc' }, 1)[0]!, /lights\[1\]\.ltk/);
  assert.match(validateLightConfig({ ...valid, ...credentials, ltk: 'zz' }, 0)[0]!, /ltk/);
});

test('a supplied account ID is still checked for shape', () => {
  assert.match(validateLightConfig({ ...valid, ...credentials, accountId: 'nope' }, 0)[0]!, /accountId/);
});

test('supplying only one credential is rejected', () => {
  // Half an override would silently fall back for the other half, which is a
  // confusing way to end up using a key that does not match the account.
  assert.match(validateLightConfig({ ...valid, ltk: 'deadbeef' }, 0)[0]!, /only one of ltk\/accountId/);
  assert.match(validateLightConfig({ ...valid, accountId: credentials.accountId }, 0)[0]!, /only one of ltk\/accountId/);
});

test('every missing required field is reported at once', () => {
  assert.equal(validateLightConfig({}, 0).length, 3);
});

// Daylight mode. The bytes here were captured from a CF06 on 2026-09-18 — what
// the lamp sent when the button on its base was pressed, and what it accepted
// as a command — rather than constructed to match the implementation.

test('a daylight-mode report is decoded in both directions', () => {
  assert.deepEqual(
    decodeAttributeReport(Buffer.from([0x80, 0x97, 0x13, 0x20, 0x01, 0x00, 0x01])),
    { daylight: true },
  );
  assert.deepEqual(
    decodeAttributeReport(Buffer.from([0x80, 0x97, 0x13, 0x20, 0x01, 0x00, 0x00])),
    { daylight: false },
  );
});

test('the daylight command is the one the lamp accepted', () => {
  // Verified against the hardware: this exact write turned tracking back on.
  assert.deepEqual(buildDaylightWrite(true), [
    Buffer.from([0x80, 0x93, 0x13, 0x20, 0x01, 0x00, 0x01]),
  ]);
  assert.deepEqual(buildDaylightWrite(false), [
    Buffer.from([0x80, 0x93, 0x13, 0x20, 0x01, 0x00, 0x00]),
  ]);
});

test('a command is not mistaken for a report', () => {
  // 0x93 commands, 0x94 acknowledges, 0x97 reports. Reading our own command
  // back as state would make the switch believe every write succeeded.
  for (const frame of buildDaylightWrite(true)) {
    assert.equal(decodeAttributeReport(frame), undefined);
  }
  // The acknowledgement the lamp sends, which carries no value at all.
  assert.equal(decodeAttributeReport(Buffer.from([0x80, 0x94, 0x13, 0x20, 0x00])), undefined);
});

test('the lamp can be asked for the daylight mode', () => {
  assert.deepEqual(buildAttributeRead(0x2013), [Buffer.from([0x80, 0x90, 0x13, 0x20])]);
});

test('the answer to that question is decoded', () => {
  // Captured from a CF06: header, type, attribute, status, length, value.
  assert.deepEqual(
    decodeAttributeValue(Buffer.from([0x80, 0x91, 0x13, 0x20, 0x00, 0x01, 0x00, 0x00])),
    { daylight: false },
  );
  assert.deepEqual(
    decodeAttributeValue(Buffer.from([0x80, 0x91, 0x13, 0x20, 0x00, 0x01, 0x00, 0x01])),
    { daylight: true },
  );
  // A non-zero status means the lamp refused the question, not that it said no.
  assert.equal(
    decodeAttributeValue(Buffer.from([0x80, 0x91, 0x13, 0x20, 0x02, 0x01, 0x00, 0x01])),
    undefined,
  );
  // Another attribute's value must not be read as this one.
  assert.equal(
    decodeAttributeValue(Buffer.from([0x80, 0x91, 0x15, 0x20, 0x00, 0x02, 0x00, 0x92, 0x04])),
    undefined,
  );
});

test('a reply and a report are not confused for each other', () => {
  // They differ by a status byte, so decoding one as the other reads the value
  // from the wrong offset — and would have the switch showing the opposite.
  const reply = Buffer.from([0x80, 0x91, 0x13, 0x20, 0x00, 0x01, 0x00, 0x01]);
  assert.equal(decodeAttributeReport(reply), undefined);
  const report = Buffer.from([0x80, 0x97, 0x13, 0x20, 0x01, 0x00, 0x01]);
  assert.equal(decodeAttributeValue(report), undefined);
});

test('an attribute write carries its length little-endian', () => {
  assert.deepEqual(buildAttributeWrite(0x2013, Buffer.from([0xaa, 0xbb])), [
    Buffer.from([0x80, 0x93, 0x13, 0x20, 0x02, 0x00, 0xaa, 0xbb]),
  ]);
});

test('anything that is not a daylight report is ignored', () => {
  // Other attributes exist on this channel and must not be read as daylight.
  assert.equal(decodeAttributeReport(Buffer.from([0x80, 0x97, 0x99, 0x20, 0x01, 0x00, 0x01])), undefined);
  // A continuation fragment, not the start of a message.
  assert.equal(decodeAttributeReport(Buffer.from([0x01, 0x97, 0x13, 0x20, 0x01, 0x00, 0x01])), undefined);
  // Truncated, and empty.
  assert.equal(decodeAttributeReport(Buffer.from([0x80, 0x97, 0x13, 0x20])), undefined);
  assert.equal(decodeAttributeReport(Buffer.alloc(0)), undefined);
});
