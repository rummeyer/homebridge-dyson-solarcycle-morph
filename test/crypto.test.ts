/**
 * Cross-checks the TypeScript handshake implementation against vectors produced
 * by the Python reference (see test/vectors.json).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildReauthPayloadA,
  buildReauthPayloadC,
  deriveAesKey,
  parseReauthPayloadB,
  sealBlock,
  uuidToBytes,
} from '../src/dyson/crypto.ts';
import { fragmentMessage, MessageAssembler, MsgType } from '../src/dyson/protocol.ts';

const v = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const hex = (s: string) => Buffer.from(s, 'hex');

const ltk = hex(v.ltk);
const nonce = hex(v.nonce);
const iv = hex(v.iv);
const key = deriveAesKey(ltk);

test('HKDF derives the reference AES key', () => {
  assert.equal(key.toString('hex'), v.aesKey);
});

test('encrypt-then-MAC matches the reference', () => {
  assert.equal(sealBlock(key, nonce, iv).toString('hex'), v.sealed);
});

test('PayloadA matches the reference and is 82 bytes', () => {
  const a = buildReauthPayloadA(v.account, key, nonce);
  assert.equal(a.length, 82);
  // The random IV differs, so compare the deterministic prefix and re-seal.
  assert.equal(a.subarray(0, 18).toString('hex'), hex(v.payloadA).subarray(0, 18).toString('hex'));
  assert.equal(
    Buffer.concat([a.subarray(0, 18), sealBlock(key, nonce, iv)]).toString('hex'),
    v.payloadA,
  );
});

test('PayloadC matches the reference and is 66 bytes', () => {
  const c = buildReauthPayloadC(key, nonce);
  assert.equal(c.length, 66);
  assert.equal(
    Buffer.concat([c.subarray(0, 2), sealBlock(key, nonce, iv)]).toString('hex'),
    v.payloadC,
  );
});

test('PayloadB yields the lamp challenge', () => {
  assert.equal(parseReauthPayloadB(key, hex(v.payloadB)).toString('hex'), v.challenge);
});

test('PayloadB with a bad MAC is rejected', () => {
  const bad = hex(v.payloadB);
  bad[60] ^= 0xff;
  assert.throws(() => parseReauthPayloadB(key, bad), /HMAC verification/);
});

test('PayloadB that is too short is rejected', () => {
  assert.throws(() => parseReauthPayloadB(key, Buffer.alloc(20)), /too short/);
});

test('account UUID is encoded big-endian', () => {
  assert.equal(uuidToBytes(v.account).toString('hex'), '1234567890abcdef1234567890abcdef');
  assert.throws(() => uuidToBytes('not-a-uuid'), /invalid account UUID/);
});

test('fragmenter matches the reference for an empty payload', () => {
  const f = fragmentMessage(MsgType.REQUEST_PRODUCT_INFO);
  assert.deepEqual(f.map((b) => b.toString('hex')), v.fragments_short);
});

test('fragmenter matches the reference for a multi-fragment payload', () => {
  const f = fragmentMessage(MsgType.REAUTH_PAYLOAD_A, hex(v.payloadA));
  assert.deepEqual(f.map((b) => b.toString('hex')), v.fragments_long);
});

test('assembler round-trips what the fragmenter produced', () => {
  const asm = new MessageAssembler();
  const payload = hex(v.payloadA);
  const fragments = fragmentMessage(MsgType.REAUTH_PAYLOAD_A, payload);
  const results = fragments.map((f) => asm.push(f));
  assert.equal(results.slice(0, -1).filter(Boolean).length, 0, 'only the last fragment completes');
  const msg = results.at(-1);
  assert.ok(msg);
  assert.equal(msg.type, MsgType.REAUTH_PAYLOAD_A);
  assert.equal(msg.payload.toString('hex'), payload.toString('hex'));
});

test('assembler handles a single-fragment message', () => {
  const asm = new MessageAssembler();
  const msg = asm.push(Buffer.from([0x80, MsgType.CONNECTION_ESTABLISHED]));
  assert.equal(msg?.type, MsgType.CONNECTION_ESTABLISHED);
  assert.equal(msg?.payload.length, 0);
});

test('a new first fragment resets a half-finished message', () => {
  const asm = new MessageAssembler();
  asm.push(fragmentMessage(MsgType.REAUTH_PAYLOAD_A, hex(v.payloadA))[0]!);
  const msg = asm.push(Buffer.from([0x80, MsgType.CONNECTION_ESTABLISHED]));
  assert.equal(msg?.type, MsgType.CONNECTION_ESTABLISHED);
});

test('a stray continuation fragment is ignored', () => {
  const asm = new MessageAssembler();
  assert.equal(asm.push(Buffer.from([0x01, 0xde, 0xad])), undefined);
});
