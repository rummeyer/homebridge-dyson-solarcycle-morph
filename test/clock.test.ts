import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ATTR_DAYLIGHT,
  MsgType,
  buildAttributeSubscribe,
  buildClockWrite,
} from '../src/dyson/protocol.ts';

/**
 * Read off the wire: an iOS HCI capture of 2026-09-22 caught MyDyson opening
 * three connections to this lamp, each starting with the clock. The bytes
 * below are the third, sent at 18:12:38 local.
 */
const CAPTURED_CLOCK = Buffer.from('f6a8b26a', 'hex');
const CAPTURED_AT = 1790093558;

test('the clock goes out as the app sends it', () => {
  const fragments = buildClockWrite(new Date(CAPTURED_AT * 1000));
  assert.equal(fragments.length, 1, 'one fragment');
  assert.deepEqual(
    fragments[0],
    Buffer.concat([Buffer.from([0x80, MsgType.SET_CLOCK]), CAPTURED_CLOCK]),
  );
});

test('the clock is whole seconds, not milliseconds', () => {
  // Milliseconds would overflow the field and put nonsense in the lamp, which
  // is worse than the missing clock this fixes.
  const body = buildClockWrite(new Date(CAPTURED_AT * 1000 + 789))[0]!.subarray(2);
  assert.equal(body.readUInt32LE(0), CAPTURED_AT);
});

test('the clock still fits after the 2038 rollover of a signed int', () => {
  const late = new Date(Date.UTC(2100, 0, 1));
  const body = buildClockWrite(late)[0]!.subarray(2);
  assert.equal(body.readUInt32LE(0), Math.floor(late.getTime() / 1000));
});

test('a subscription names its attribute and ends in a zero', () => {
  // Captured: 96 1320 00 for daylight.
  const fragments = buildAttributeSubscribe(ATTR_DAYLIGHT);
  assert.deepEqual(
    fragments[0],
    Buffer.concat([Buffer.from([0x80, MsgType.ATTRIBUTE_SUBSCRIBE]), Buffer.from('132000', 'hex')]),
  );
});
