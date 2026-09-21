/**
 * The lamp's age adjustment: the sealed year of birth and the switch beside it.
 *
 * The sealing vectors come from the Python reference in test/vectors.json,
 * which reproduces the handshake's own key from the same long-term key — so a
 * change that quietly swapped the two `info` strings would fail here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { deriveAesKey, deriveSensitiveKey, sealBlock, unsealBlock } from '../src/dyson/crypto.ts';
import {
  ATTR_AGE_ADJUST,
  ATTR_YEAR_OF_BIRTH,
  MsgType,
  YEAR_OF_BIRTH_SEALED_LENGTH,
  attributeValue,
  buildAgeAdjustWrite,
  buildYearOfBirthSetAt,
  buildYearOfBirthWrite,
  decodeAttributeValue,
  decodeYearOfBirth,
  encodeYearOfBirth,
  fragmentMessage,
  MessageAssembler,
} from '../src/dyson/protocol.ts';
import { validateLightConfig } from '../src/config.ts';

const v = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const hex = (s: string) => Buffer.from(s, 'hex');

const ltk = hex(v.ltk);
const sensitiveKey = deriveSensitiveKey(ltk);

test('the sealed settings use a key of their own', () => {
  assert.equal(sensitiveKey.toString('hex'), v.sensitiveKey);
  // The whole point of the second derivation: the handshake's key must not
  // open the lamp's settings, or the two info strings have been confused.
  assert.notEqual(sensitiveKey.toString('hex'), deriveAesKey(ltk).toString('hex'));
});

test('the year is two little-endian bytes and fourteen of padding', () => {
  const plaintext = encodeYearOfBirth(v.yearOfBirth);
  assert.equal(plaintext.length, 16);
  assert.equal(plaintext.toString('hex'), v.yearPlaintext);
});

test('sealing a year matches the reference', () => {
  const sealed = sealBlock(sensitiveKey, encodeYearOfBirth(v.yearOfBirth), hex(v.iv));
  assert.equal(sealed.toString('hex'), v.yearSealed);
  assert.equal(sealed.length, YEAR_OF_BIRTH_SEALED_LENGTH);
});

test('unsealing the reference gives the year back', () => {
  const plaintext = unsealBlock(sensitiveKey, hex(v.yearSealed));
  assert.deepEqual(decodeYearOfBirth(plaintext!), { year: v.yearOfBirth, status: 'set' });
});

test('a blob the key does not open is refused rather than guessed at', () => {
  const tampered = hex(v.yearSealed);
  tampered[20] ^= 0xff;
  assert.equal(unsealBlock(sensitiveKey, tampered), undefined);
  assert.equal(unsealBlock(deriveAesKey(ltk), hex(v.yearSealed)), undefined);
  assert.equal(unsealBlock(sensitiveKey, Buffer.alloc(0)), undefined);
  assert.equal(unsealBlock(sensitiveKey, hex(v.yearSealed).subarray(0, 48)), undefined);
});

test('the lamp’s status byte says whose year it is', () => {
  const withStatus = (status: number) => {
    const plaintext = encodeYearOfBirth(0);
    plaintext[2] = status;
    return decodeYearOfBirth(plaintext);
  };
  assert.deepEqual(withStatus(0), { year: 0, status: 'set' });
  assert.deepEqual(withStatus(1), { year: 0, status: 'other-account' });
  assert.deepEqual(withStatus(2), { year: 0, status: 'not-set' });
  // Firmware is free to invent one; a number nobody has documented must not
  // read as "the year is good".
  assert.deepEqual(withStatus(7), { year: 0, status: 'unknown' });
  assert.equal(decodeYearOfBirth(Buffer.alloc(2)), undefined);
});

test('the sealed year needs four fragments, and survives them', () => {
  const fragments = buildYearOfBirthWrite(hex(v.yearSealed));
  assert.equal(fragments.length, 4);

  const assembler = new MessageAssembler();
  let message;
  for (const fragment of fragments) {
    message = assembler.push(fragment) ?? message;
  }
  assert.equal(message!.type, MsgType.ATTRIBUTE_SET);
  assert.equal(message!.payload.readUInt16LE(0), ATTR_YEAR_OF_BIRTH);
  assert.equal(message!.payload.readUInt16LE(2), YEAR_OF_BIRTH_SEALED_LENGTH);
  assert.deepEqual(message!.payload.subarray(4), hex(v.yearSealed));
});

test('a 64-byte reply is read once it has been put back together', () => {
  // What the lamp sends back: attribute, status, length, then the blob, split
  // across four notifications. Reading the first one alone would see nothing.
  const body = Buffer.concat([
    Buffer.from([0, 0, 0x00, 0, 0]),
    hex(v.yearSealed),
  ]);
  body.writeUInt16LE(ATTR_YEAR_OF_BIRTH, 0);
  body.writeUInt16LE(YEAR_OF_BIRTH_SEALED_LENGTH, 3);

  const assembler = new MessageAssembler();
  let message;
  for (const fragment of fragmentMessage(MsgType.ATTRIBUTE_VALUE, body)) {
    message = assembler.push(fragment) ?? message;
  }
  const frame = Buffer.concat([Buffer.from([0x80, message!.type]), message!.payload]);
  assert.deepEqual(attributeValue(frame, ATTR_YEAR_OF_BIRTH), hex(v.yearSealed));
});

test('a year that will not fit the wire is refused before it is written', () => {
  assert.throws(() => buildYearOfBirthWrite(Buffer.alloc(32)), /64 bytes/);
});

test('the timestamp beside the year is unix seconds', () => {
  const when = new Date('2026-01-21T12:35:55Z');
  const [fragment] = buildYearOfBirthSetAt(when);
  assert.equal(fragment!.readUInt16LE(2), 0x2025);
  assert.equal(fragment!.readUInt16LE(4), 4);
  assert.equal(fragment!.readUInt32LE(6), 1768998955);
});

test('the age-adjust switch is a one-byte attribute', () => {
  const on = buildAgeAdjustWrite(true)[0]!;
  assert.equal(on.readUInt16LE(2), ATTR_AGE_ADJUST);
  assert.deepEqual(on.subarray(4), Buffer.from([0x01, 0x00, 0x01]));
  assert.equal(buildAgeAdjustWrite(false)[0]!.at(-1), 0x00);
  // It is not one of the flags the state decoder claims, or a lamp reporting
  // its age setting would be read as a preset changing.
  const frame = Buffer.from([0x80, MsgType.ATTRIBUTE_VALUE, 0, 0, 0x00, 1, 0, 0x01]);
  frame.writeUInt16LE(ATTR_AGE_ADJUST, 2);
  assert.equal(decodeAttributeValue(frame), undefined);
});

test('a year of birth outside the app’s own picker is rejected', () => {
  const light = { name: 'Lamp', mac: 'F0:B1:A7:75:B1:D1', serial: 'E5T-EU-NFA1279A' };
  const thisYear = new Date().getFullYear();
  assert.deepEqual(validateLightConfig({ ...light, yearOfBirth: 1974 }, 0), []);
  assert.deepEqual(validateLightConfig({ ...light, yearOfBirth: thisYear }, 0), []);
  assert.match(validateLightConfig({ ...light, yearOfBirth: 1899 }, 0)[0]!, /whole year between 1900/);
  assert.match(validateLightConfig({ ...light, yearOfBirth: thisYear + 1 }, 0)[0]!, /whole year between 1900/);
  assert.match(validateLightConfig({ ...light, yearOfBirth: 1974.5 }, 0)[0]!, /whole year/);
});

test('the switch on its own is rejected, because it would adjust for nobody', () => {
  const light = { name: 'Lamp', mac: 'F0:B1:A7:75:B1:D1', serial: 'E5T-EU-NFA1279A' };
  assert.match(validateLightConfig({ ...light, ageAdjust: true }, 0)[0]!, /no yearOfBirth/);
  assert.deepEqual(validateLightConfig({ ...light, yearOfBirth: 1974, ageAdjust: false }, 0), []);
});
