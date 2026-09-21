import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COORDINATES,
  MsgType,
  buildCoordinateRead,
  buildCoordinateWrite,
  decodeCoordinateValue,
} from '../src/dyson/protocol.ts';
import { validateLightConfig } from '../src/config.ts';

/**
 * Captured from a CF06 on 2026-09-21, placed there by the MyDyson app.
 *
 * Both sit one unit in the last place below the tidy decimal a person would
 * type: the app writes whatever `Location.getLatitude()` handed it rather than
 * a parsed string. That is the reason the plugin compares coordinates with a
 * tolerance instead of for equality.
 */
const LAMP_LATITUDE = Buffer.from('5817b7d100564840', 'hex');
const LAMP_LONGITUDE = Buffer.from('71f90fe9b78f2240', 'hex');
const LAMP_DEGREES = { latitude: 48.671899999999994, longitude: 9.280699999999998 };

/** Wrap a value the way the lamp does when answering a 0x90. */
function reply(attribute: number, value: Buffer): Buffer {
  const header = Buffer.from([0x80, MsgType.ATTRIBUTE_VALUE, 0, 0, 0x00, 0, 0]);
  header.writeUInt16LE(attribute, 2);
  header.writeUInt16LE(value.length, 5);
  return Buffer.concat([header, value]);
}

test('coordinates are written as little-endian doubles', () => {
  const [fragment] = buildCoordinateWrite('latitude', LAMP_DEGREES.latitude);
  // header, type, attribute (2), length (2), value (8)
  assert.equal(fragment!.length, 14);
  assert.equal(fragment!.readUInt16LE(2), COORDINATES.latitude);
  assert.equal(fragment!.readUInt16LE(4), 8);
  assert.deepEqual(fragment!.subarray(6), LAMP_LATITUDE);
});

test('a coordinate write fits in one fragment', () => {
  const fragments = buildCoordinateWrite('longitude', LAMP_DEGREES.longitude);
  assert.equal(fragments.length, 1);
  assert.deepEqual(fragments[0]!.subarray(6), LAMP_LONGITUDE);
});

test('the lamp’s own bytes decode to where it stands', () => {
  const latitude = decodeCoordinateValue(reply(COORDINATES.latitude, LAMP_LATITUDE));
  assert.deepEqual(latitude, { coordinate: 'latitude', degrees: LAMP_DEGREES.latitude });
  const longitude = decodeCoordinateValue(reply(COORDINATES.longitude, LAMP_LONGITUDE));
  assert.deepEqual(longitude, { coordinate: 'longitude', degrees: LAMP_DEGREES.longitude });
});

test('a typed decimal is the same place as the lamp\u2019s own reading', () => {
  // What the settings page stores, against what the app put in the lamp. The
  // plugin must not read the difference as a move and rewrite it every time.
  assert.ok(Math.abs(48.6719 - LAMP_DEGREES.latitude) < 1e-6);
  assert.ok(Math.abs(9.2807 - LAMP_DEGREES.longitude) < 1e-6);
});

test('a coordinate read asks for the right attribute', () => {
  const [fragment] = buildCoordinateRead('longitude');
  assert.equal(fragment!.length, 4);
  assert.equal(fragment![1], MsgType.ATTRIBUTE_GET);
  assert.equal(fragment!.readUInt16LE(2), COORDINATES.longitude);
});

test('southern and western coordinates survive the round trip', () => {
  for (const degrees of [-33.8688, -70.6693, 0, 179.999999]) {
    const value = buildCoordinateWrite('latitude', degrees)[0]!.subarray(6);
    assert.equal(decodeCoordinateValue(reply(COORDINATES.latitude, value))?.degrees, degrees);
  }
});

test('anything that is not a coordinate reply is left alone', () => {
  // Daylight mode, which shares the channel and the frame.
  assert.equal(decodeCoordinateValue(reply(0x2013, Buffer.from([0x01]))), undefined);
  // The right attribute, the wrong length.
  assert.equal(decodeCoordinateValue(reply(COORDINATES.latitude, Buffer.alloc(4))), undefined);
  // A refusal, which carries a status byte of its own.
  const refused = reply(COORDINATES.latitude, LAMP_LATITUDE);
  refused[4] = 0x01;
  assert.equal(decodeCoordinateValue(refused), undefined);
  assert.equal(decodeCoordinateValue(Buffer.alloc(0)), undefined);
});

test('half a location is rejected', () => {
  const light = { name: 'Lamp', mac: 'F0:B1:A7:75:B1:D1', serial: 'E5T-EU-NFA1279A' };
  assert.deepEqual(validateLightConfig({ ...light, latitude: 48.6719, longitude: 9.2807 }, 0), []);
  assert.deepEqual(validateLightConfig(light, 0), []);
  assert.match(validateLightConfig({ ...light, latitude: 48.6719 }, 0)[0]!, /only one of latitude\/longitude/);
});

test('coordinates outside the globe are rejected', () => {
  const light = { name: 'Lamp', mac: 'F0:B1:A7:75:B1:D1', serial: 'E5T-EU-NFA1279A' };
  assert.match(
    validateLightConfig({ ...light, latitude: 91, longitude: 9.2807 }, 0)[0]!,
    /latitude must be a number between -90 and 90/,
  );
  assert.match(
    validateLightConfig({ ...light, latitude: 48.6719, longitude: -181 }, 0)[0]!,
    /longitude must be a number between -180 and 180/,
  );
  assert.match(
    validateLightConfig({ ...light, latitude: Number.NaN, longitude: 9.2807 }, 0)[0]!,
    /latitude must be a number/,
  );
});
