/**
 * Cryptography for the Dyson LTK re-authentication handshake.
 *
 * Despite what Dyson's own protocol notes claim, this is not AES-GCM: the app
 * derives an AES-128 key from the long-term key via HKDF-SHA256 and then uses
 * unpadded AES-CBC with a separate HMAC-SHA256 over the ciphertext
 * (encrypt-then-MAC), with the same key serving both roles.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** HKDF `info` string, matching `g20/b.d` in the MyDyson Android app. */
const HKDF_INFO = Buffer.from('USER_AUTH_AES\x00\x00\x00', 'binary');

/**
 * HKDF `info` for the lamp's sealed settings, from `q50/a.java`'s static
 * initialiser.
 *
 * The year of birth is the one thing on this lamp that is stored encrypted, and
 * it is deliberately not readable with the key the handshake uses: same LTK,
 * same derivation, different `info`.
 */
const HKDF_INFO_SENSITIVE = Buffer.from('SENSITIVE_STATE\x00', 'binary');

/** Every encrypted block in this protocol is exactly one AES block. */
const BLOCK = 16;

/**
 * HKDF-SHA256 with an empty salt, truncated to the first expansion block.
 *
 * An empty salt and 32 zero bytes are the same thing to HMAC, which pads a
 * short key with zeros, so this matches `t50/b.java` substituting the latter.
 */
function hkdf(ltk: Buffer, info: Buffer): Buffer {
  const prk = createHmac('sha256', Buffer.alloc(0)).update(ltk).digest();
  const block1 = createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  return block1.subarray(0, BLOCK);
}

/** Derive the 16-byte AES key the re-authentication handshake uses. */
export function deriveAesKey(ltk: Buffer): Buffer {
  return hkdf(ltk, HKDF_INFO);
}

/** Derive the 16-byte AES key the lamp's sealed settings use. */
export function deriveSensitiveKey(ltk: Buffer): Buffer {
  return hkdf(ltk, HKDF_INFO_SENSITIVE);
}

/**
 * Undo {@link sealBlock}, checking the MAC before trusting the plaintext.
 *
 * @param sealed `IV(16) || ciphertext || HMAC-SHA256(ciphertext)(32)`.
 * @returns The plaintext, or `undefined` if it is malformed or the MAC does not
 * match — which for a lamp's setting means the key is wrong, not that an
 * attacker is about, and is worth handling rather than throwing over.
 */
export function unsealBlock(key: Buffer, sealed: Buffer): Buffer | undefined {
  const ciphertextLength = sealed.length - BLOCK - 32;
  if (ciphertextLength <= 0 || ciphertextLength % BLOCK !== 0) {
    return undefined;
  }
  const ciphertext = sealed.subarray(BLOCK, BLOCK + ciphertextLength);
  const mac = createHmac('sha256', key).update(ciphertext).digest();
  if (!timingSafeEqual(mac, sealed.subarray(BLOCK + ciphertextLength))) {
    return undefined;
  }
  return openBlock(key, sealed.subarray(0, BLOCK), ciphertext);
}

/**
 * Encrypt-then-MAC one or more AES blocks.
 *
 * @returns `IV(16) || ciphertext || HMAC-SHA256(ciphertext)(32)` — 64 bytes for
 * the single-block plaintexts this protocol uses.
 */
export function sealBlock(key: Buffer, plaintext: Buffer, iv: Buffer = randomBytes(BLOCK)): Buffer {
  if (plaintext.length % BLOCK !== 0) {
    throw new Error(`plaintext must be a multiple of ${BLOCK} bytes, got ${plaintext.length}`);
  }
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac('sha256', key).update(ct).digest();
  return Buffer.concat([iv, ct, mac]);
}

/** Unpadded AES-128-CBC decryption. */
function openBlock(key: Buffer, iv: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Build the 82-byte re-auth PayloadA (message type 0x06).
 *
 * Layout: `account GUID(16) || 0x00 0x00 || sealBlock(nonce)(64)`.
 */
export function buildReauthPayloadA(accountUuid: string, key: Buffer, nonce: Buffer = randomBytes(BLOCK)): Buffer {
  return Buffer.concat([uuidToBytes(accountUuid), Buffer.from([0x00, 0x00]), sealBlock(key, nonce)]);
}

/**
 * Build the 66-byte re-auth PayloadC (message type 0x08).
 *
 * Layout: `0x00 0x00 || sealBlock(challenge)(64)`.
 */
export function buildReauthPayloadC(key: Buffer, challenge: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x00, 0x00]), sealBlock(key, challenge)]);
}

/**
 * Recover the lamp's challenge from PayloadB (message type 0x07).
 *
 * Layout: `0x00 0x00 || IV(16) || ciphertext(32) || MAC(32)?`. The MAC is
 * absent on some firmware; when present we verify it, since a mismatch is the
 * earliest and clearest signal that the stored LTK is wrong.
 *
 * @param payload The reassembled PayloadB, type byte already stripped.
 * @returns The 16-byte challenge to echo back in PayloadC.
 */
export function parseReauthPayloadB(key: Buffer, payload: Buffer): Buffer {
  if (payload.length < 50) {
    throw new Error(
      `PayloadB too short (${payload.length} bytes, need >= 50) — the lamp likely rejected the handshake`,
    );
  }
  const iv = payload.subarray(2, 18);
  const ct = payload.subarray(18, 50);
  const mac = payload.subarray(50, 82);

  if (mac.length === 32) {
    const expected = createHmac('sha256', key).update(ct).digest();
    if (!timingSafeEqual(mac, expected)) {
      throw new Error('PayloadB failed HMAC verification — the stored LTK is wrong or corrupted');
    }
  }

  // Plaintext is our echoed nonce followed by the lamp's own challenge.
  return openBlock(key, iv, ct).subarray(BLOCK, 2 * BLOCK);
}

/** Dyson sends account GUIDs in big-endian (RFC 4122) byte order. */
export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`invalid account UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}
