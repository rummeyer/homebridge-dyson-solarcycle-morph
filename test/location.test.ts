import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COORDINATES,
  MsgType,
  attributeValue,
  buildAttributeRead,
  buildCoordinateWrite,
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
const LAMP_LATITUDE = Buffer.from('6a9a779ca2634840', 'hex');
const LAMP_LONGITUDE = Buffer.from('5b8fc2f5285c2240', 'hex');
const LAMP_DEGREES = { latitude: 48.77839999999999, longitude: 9.179999999999998 };

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
  const latitude = attributeValue(reply(COORDINATES.latitude, LAMP_LATITUDE), COORDINATES.latitude);
  assert.equal(latitude?.readDoubleLE(0), LAMP_DEGREES.latitude);
  const longitude = attributeValue(reply(COORDINATES.longitude, LAMP_LONGITUDE), COORDINATES.longitude);
  assert.equal(longitude?.readDoubleLE(0), LAMP_DEGREES.longitude);
});

test('a typed decimal is the same place as the lamp\u2019s own reading', () => {
  // What the settings page stores, against what the app put in the lamp. The
  // plugin must not read the difference as a move and rewrite it every time.
  assert.ok(Math.abs(48.7784 - LAMP_DEGREES.latitude) < 1e-6);
  assert.ok(Math.abs(9.18 - LAMP_DEGREES.longitude) < 1e-6);
});

test('a coordinate read asks for the right attribute', () => {
  const [fragment] = buildAttributeRead(COORDINATES.longitude);
  assert.equal(fragment!.length, 4);
  assert.equal(fragment![1], MsgType.ATTRIBUTE_GET);
  assert.equal(fragment!.readUInt16LE(2), COORDINATES.longitude);
});

test('southern and western coordinates survive the round trip', () => {
  for (const degrees of [-33.8688, -70.6693, 0, 179.999999]) {
    const value = buildCoordinateWrite('latitude', degrees)[0]!.subarray(6);
    const back = attributeValue(reply(COORDINATES.latitude, value), COORDINATES.latitude);
    assert.equal(back?.readDoubleLE(0), degrees);
  }
});

test('a reply about another attribute is not mistaken for this one', () => {
  // Daylight mode, which shares the channel and the frame.
  assert.equal(attributeValue(reply(0x2013, Buffer.from([0x01])), COORDINATES.latitude), undefined);
  // A refusal, which the lamp marks with a status byte of its own.
  const refused = reply(COORDINATES.latitude, LAMP_LATITUDE);
  refused[4] = 0x01;
  assert.equal(attributeValue(refused, COORDINATES.latitude), undefined);
  assert.equal(attributeValue(Buffer.alloc(0), COORDINATES.latitude), undefined);
});

test('half a location is rejected', () => {
  const light = { name: 'Lamp', mac: 'AA:BB:CC:DD:EE:FF', serial: 'E5T-EU-6DYYJX5E' };
  assert.deepEqual(validateLightConfig({ ...light, latitude: 48.7784, longitude: 9.18 }, 0), []);
  assert.deepEqual(validateLightConfig(light, 0), []);
  assert.match(validateLightConfig({ ...light, latitude: 48.7784 }, 0)[0]!, /only one of latitude\/longitude/);
});

test('coordinates outside the globe are rejected', () => {
  const light = { name: 'Lamp', mac: 'AA:BB:CC:DD:EE:FF', serial: 'E5T-EU-6DYYJX5E' };
  assert.match(
    validateLightConfig({ ...light, latitude: 91, longitude: 9.18 }, 0)[0]!,
    /latitude must be a number between -90 and 90/,
  );
  assert.match(
    validateLightConfig({ ...light, latitude: 48.7784, longitude: -181 }, 0)[0]!,
    /longitude must be a number between -180 and 180/,
  );
  assert.match(
    validateLightConfig({ ...light, latitude: Number.NaN, longitude: 9.18 }, 0)[0]!,
    /latitude must be a number/,
  );
});

test('a coordinate reply is read out of the frame', () => {
  assert.deepEqual(
    attributeValue(reply(COORDINATES.latitude, LAMP_LATITUDE), COORDINATES.latitude),
    LAMP_LATITUDE,
  );
  assert.equal(
    attributeValue(reply(COORDINATES.latitude, LAMP_LATITUDE), COORDINATES.latitude)!.readDoubleLE(0),
    LAMP_DEGREES.latitude,
  );
});

/**
 * Read off the lamp at 15:53 on 2026-09-22, after it had been unplugged. It had
 * accepted the Stuttgart pair two hours earlier and was refusing it again.
 */
const FACTORY_LATITUDE = Buffer.from('000000200fcb4940', 'hex');
const FACTORY_LONGITUDE = Buffer.from('000000c088d200c0', 'hex');

test('the factory pair is recognisable, and is not where anyone lives', () => {
  const latitude = attributeValue(
    reply(COORDINATES.latitude, FACTORY_LATITUDE),
    COORDINATES.latitude,
  )!.readDoubleLE(0);
  const longitude = attributeValue(
    reply(COORDINATES.longitude, FACTORY_LONGITUDE),
    COORDINATES.longitude,
  )!.readDoubleLE(0);

  // Malmesbury, which every lamp holds from the factory and reads after losing
  // power while it has no clock. The plugin tells this pair apart so it can
  // name that cause instead of calling the refusal unexpected.
  const factory = { latitude: 51.5864, longitude: -2.1028 };
  const epsilon = 1e-3;
  assert.ok(Math.abs(latitude - factory.latitude) < epsilon, 'the factory latitude is matched');
  assert.ok(Math.abs(longitude - factory.longitude) < epsilon, 'the factory longitude is matched');

  // And a lamp that does have a location must never be told it has none.
  assert.ok(Math.abs(LAMP_DEGREES.latitude - factory.latitude) > epsilon);
  assert.ok(Math.abs(LAMP_DEGREES.longitude - factory.longitude) > epsilon);
});
