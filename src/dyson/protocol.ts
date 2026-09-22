/**
 * Wire-level constants and framing for the Dyson BLE light protocol.
 *
 * Reverse-engineered from the MyDyson Android app and verified against the
 * Lightcycle Morph (CD06) / Solarcycle Morph (CF06). See docs/PROTOCOL.md.
 */

// Characteristics are spread across three services on this lamp, so the client
// sweeps every service and matches on these UUIDs, which are unique on their
// own. docs/PROTOCOL.md has the full map, including what is not used here.

/** Fragmented request/response channel used for the authentication handshake. */
export const CHAR_AUTH = '2dd10011-1c37-452d-8979-d1b4a787d0a4';
/**
 * Signal strength as the lamp sees it, int8 dBm, notified while connected.
 *
 * BlueZ drops its own RSSI once a device is connected — it is an advertising
 * property — so this is the only reading available during a session.
 */
export const CHAR_RSSI = '2dd10013-1c37-452d-8979-d1b4a787d0a4';

/** Generic attribute write channel (see DAYLIGHT_MODE_* payloads). */
export const CHAR_WRITE_ATTR = '2dd10021-1c37-452d-8979-d1b4a787d0a4';

/** Colour temperature in Kelvin, uint16 LE. */
export const CHAR_COLOR_TEMP = '2dd11001-1c37-452d-8979-d1b4a787d0a4';
/** Power, 1 byte: 0 = off, 1 = on. */
export const CHAR_POWER = '2dd11005-1c37-452d-8979-d1b4a787d0a4';
/**
 * Auto brightness, the lamp's "Auto" button: 1 byte, 0 = off, 1 = on.
 *
 * With it on the lamp trims its own output to hold the room at a steady level,
 * which is what makes brightness drift by a few lumens a minute. Nothing to do
 * with daylight tracking, which moves colour temperature instead.
 */
export const CHAR_AUTO_BRIGHTNESS = '2dd11006-1c37-452d-8979-d1b4a787d0a4';
/**
 * Movement mode, the lamp's motion button: 1 byte, 0 = off, 1 = on.
 *
 * With it on the lamp lights when it sees movement and goes out when the room
 * has been still. The lamp acts on its sensor internally and reports nothing:
 * `2dd11008` looks like a motion feed and is a constant. See docs/PROTOCOL.md.
 */
export const CHAR_MOVEMENT = '2dd11007-1c37-452d-8979-d1b4a787d0a4';
/** Brightness in lumens, uint16 LE. Used by CD06/CF06. */
export const CHAR_BRIGHTNESS_LM = '2dd11009-1c37-452d-8979-d1b4a787d0a4';

/** Message type bytes on {@link CHAR_AUTH}. */
export const MsgType = {
  /** → lamp: fresh-pair auth step 1 */
  AUTH_PAYLOAD_A: 0x01,
  /** ← lamp: fresh-pair auth step 2 */
  AUTH_PAYLOAD_B: 0x02,
  /** → lamp: fresh-pair final verify */
  AUTH_PAYLOAD_3: 0x03,
  /** → lamp: begin fresh pairing */
  HELLO: 0x04,
  /** ← lamp: 32-byte unique product code */
  UNIQUE_PRODUCT_CODE: 0x05,
  /** → lamp: 82-byte LTK re-auth challenge */
  REAUTH_PAYLOAD_A: 0x06,
  /** ← lamp: challenge response */
  REAUTH_PAYLOAD_B: 0x07,
  /** → lamp: 66-byte reply */
  REAUTH_PAYLOAD_C: 0x08,
  /** → lamp: session nonce */
  SEND_API_RAN_NUM: 0x09,
  /** → lamp: request firmware/hardware info */
  REQUEST_PRODUCT_INFO: 0x0a,
  /** ← lamp: firmware/hardware info */
  PRODUCT_INFO: 0x0b,
  /** → lamp: RSSI proximity probe, empty payload */
  SUBSCRIBE_RSSI: 0x0c,
  /** ← lamp: user held the Flash button */
  USER_CONFIRMED: 0x0d,
  /** ← lamp: authentication complete */
  CONNECTION_ESTABLISHED: 0x26,
  /** → lamp: ask for an attribute's value, on {@link CHAR_WRITE_ATTR} */
  ATTRIBUTE_GET: 0x90,
  /** ← lamp: the value asked for */
  ATTRIBUTE_VALUE: 0x91,
  /** → lamp: set an attribute, on {@link CHAR_WRITE_ATTR} */
  ATTRIBUTE_SET: 0x93,
  /** ← lamp: an attribute write was accepted, or was not */
  ATTRIBUTE_ACK: 0x94,
  /** ← lamp: an attribute changed, on {@link CHAR_WRITE_ATTR} */
  ATTRIBUTE_REPORT: 0x97,
} as const;

/**
 * Daylight mode, attribute `0x2013` on {@link CHAR_WRITE_ATTR}.
 *
 * The attribute channel is a small protocol of its own, and the only one on
 * this lamp whose writes are acknowledged: `0x93` sets a value, the lamp
 * answers `0x94` with a status byte, and `0x97` announces the value whenever it
 * changes for any reason. Earlier notes recorded `13 20 01 00 00` as the thing
 * to write, which is the body without its type — written bare it is ignored,
 * silently, which is how it came to be believed to work.
 */
export const ATTR_DAYLIGHT = 0x2013;

/**
 * The lamp's preset modes, each activated by writing `01` to its attribute.
 *
 * Mutually exclusive, and the lamp keeps them so itself: turning one on makes
 * it report the previous one off, unasked. Writing `00` clears one without
 * disturbing the brightness and colour temperature it left behind.
 *
 * The app's fourth preset, `SYNCHRONISED`, is not here — it is daylight
 * tracking under another name, and `he0/a.java`'s `k()` returns null for it.
 */
export const PRESETS = {
  study: 0x201e,
  relax: 0x201f,
  precision: 0x2021,
} as const;

export type Preset = keyof typeof PRESETS;

/**
 * Where the lamp believes it is, attributes `0x2003` and `0x2004`.
 *
 * Daylight tracking works from sunrise and sunset, and the lamp computes those
 * from these two numbers — without them it has nothing to track. Each is an
 * IEEE-754 double in little-endian order: the app builds one with
 * `ByteBuffer.putDouble`, which is big-endian, and then reverses the array
 * (`pd0/b.java`, `pd0/c.java`, `bm0/c.java`'s `j()`).
 *
 * The MyDyson app only ever fills these from the phone's own GPS
 * (`md0/i.java`) and offers no way to type them in, which is why the plugin
 * takes them from its configuration instead.
 */
export const COORDINATES = {
  latitude: 0x2003,
  longitude: 0x2004,
} as const;

export type Coordinate = keyof typeof COORDINATES;

/**
 * The lamp's clock: how far it is from UTC, and when its local time jumps.
 *
 * `0x2005` is the offset as a little-endian `float`, and it is written
 * **hours.minutes rather than decimal hours** (`pd0/d.java`): the app takes
 * `getRawOffset() + DST_OFFSET` in hours and rebuilds it as the whole part plus
 * the fraction times 0.6, rounded to two places. So half past five reads `5.30`,
 * not `5.5`. Germany in summer is `2.0` under either reading, which is why the
 * encoding went unnoticed until the app was read closely.
 *
 * `0x201d` carries the daylight-saving rules in eight bytes (`pd0/a.java`):
 * start rule and month packed into one byte, start date, start time in minutes,
 * the adjustment in minutes, then the same three for the end, and finally the
 * two days of the week packed together. A packed byte is `(rule << 4) | month`
 * (`bm0/c.java`'s `a()`, which builds it from two hex nibbles and so refuses
 * anything above 15).
 *
 * The app fills both on **every connection** (`nd0/e.java`), 500 ms after the
 * coordinates: the offset from the phone's own time zone, and the rules from a
 * Dyson cloud endpoint keyed by the zone's IANA id (`pj0/b.java`).
 */
export const ATTR_UTC_OFFSET = 0x2005;

/**
 * When the lamp's own day starts and ends, in minutes past midnight.
 *
 * Read as 480 and 1080 — 08:00 and 18:00 — and written by the app as plain
 * two-byte counts (`he0/u.java`). The settings screen calls them "when your day
 * starts and ends" and the lamp falls back to its baseline once the day is
 * over, natural or custom.
 */
/**
 * The lamp's own sunrise and sunset for today, minutes past local midnight.
 *
 * Worked out by the lamp from its coordinates and its UTC offset, and the only
 * way to see from outside whether it has actually taken a location: the
 * daylight attribute accepts a write whether or not the lamp can act on it, and
 * a lamp with no location refuses the mode with nothing but an LED on its base.
 *
 * Checked against a NOAA calculation for 48.6719, 9.2807 on two dates and
 * agreeing to the minute; see docs/PROTOCOL.md.
 */
export const ATTR_SUNRISE = 0x2014;
export const ATTR_SUNSET = 0x2015;

export const ATTR_DAY_START = 0x2023;
export const ATTR_DAY_END = 0x2024;
export const ATTR_DST_RULES = 0x201d;

/**
 * Age adjustment: the lamp trims Study and Relax brightness for the eyes of
 * someone born in a given year.
 *
 * Two attributes, and both matter. `0x201b` is the switch the app's own screen
 * puts at the top of the section (`fd0/q1.java` writes it from the toggle's
 * `onCheckedChanged`); `0x201a` holds the year, sealed. A year with the switch
 * off changes nothing.
 *
 * The app's description: "Light requirements change as a person ages. You can
 * add a birth year for the main intended user, and the brightness of Study mode
 * and Relax mode will automatically adjust."
 */
export const ATTR_AGE_ADJUST = 0x201b;
export const ATTR_YEAR_OF_BIRTH = 0x201a;
/**
 * When the year was last written, unix seconds, uint32 LE.
 *
 * The app sets it in the same breath as the year (`he0/u.java`'s `x()`), so
 * this does too rather than leaving the lamp with a stale one.
 */
export const ATTR_YEAR_OF_BIRTH_SET_AT = 0x2025;

/** The sealed year of birth is one AES block of plaintext, so 64 bytes sealed. */
export const YEAR_OF_BIRTH_SEALED_LENGTH = 64;

/**
 * The plaintext behind {@link ATTR_YEAR_OF_BIRTH}: the year, then padding.
 *
 * Read back, the third byte is a status the app logs by name (`bd0/c.java`):
 * `0` the year is good, `1` another account set it, `2` no year is set. The
 * last two come with a year of zero.
 */
export interface YearOfBirth {
  year: number;
  status: 'set' | 'other-account' | 'not-set' | 'unknown';
}

/** Build the 16-byte plaintext the lamp expects, per `je0/a.java`. */
export function encodeYearOfBirth(year: number): Buffer {
  const plaintext = Buffer.alloc(16);
  plaintext.writeUInt16LE(year, 0);
  return plaintext;
}

/** Read the plaintext recovered from {@link ATTR_YEAR_OF_BIRTH}. */
export function decodeYearOfBirth(plaintext: Buffer): YearOfBirth | undefined {
  if (plaintext.length < 3) {
    return undefined;
  }
  const status = (
    { 0: 'set', 1: 'other-account', 2: 'not-set' } as const
  )[plaintext[2] as 0 | 1 | 2];
  return { year: plaintext.readUInt16LE(0), status: status ?? 'unknown' };
}

/** Set one of the lamp's coordinates, in degrees. */
export function buildCoordinateWrite(coordinate: Coordinate, degrees: number): Buffer[] {
  const value = Buffer.alloc(8);
  value.writeDoubleLE(degrees, 0);
  return buildAttributeWrite(COORDINATES[coordinate], value);
}

/** Turn age adjustment on or off. */
export function buildAgeAdjustWrite(on: boolean): Buffer[] {
  return buildAttributeWrite(ATTR_AGE_ADJUST, Buffer.from([on ? 0x01 : 0x00]));
}

/** Store a sealed year of birth. Pair it with {@link buildYearOfBirthSetAt}. */
export function buildYearOfBirthWrite(sealed: Buffer): Buffer[] {
  if (sealed.length !== YEAR_OF_BIRTH_SEALED_LENGTH) {
    throw new Error(`sealed year of birth must be ${YEAR_OF_BIRTH_SEALED_LENGTH} bytes, got ${sealed.length}`);
  }
  return buildAttributeWrite(ATTR_YEAR_OF_BIRTH, sealed);
}

/** Record when the year of birth was set, as the app does alongside it. */
export function buildYearOfBirthSetAt(when: Date = new Date()): Buffer[] {
  const value = Buffer.alloc(4);
  value.writeUInt32LE(Math.floor(when.getTime() / 1000), 0);
  return buildAttributeWrite(ATTR_YEAR_OF_BIRTH_SET_AT, value);
}

/**
 * Pull a value of any length out of a reply to `0x90`.
 *
 * {@link decodeAttributeValue} answers what a one-byte flag means;
 * this hands back the bytes, for the attributes whose meaning is not a switch.
 * The frame is `attribute(2) || status || length(2) || value`.
 */
export function attributeValue(buffer: Buffer, attribute: number): Buffer | undefined {
  if (buffer.length < 7) {
    return undefined;
  }
  if ((buffer[0]! & 0x80) === 0 || buffer[1] !== MsgType.ATTRIBUTE_VALUE) {
    return undefined;
  }
  if (buffer[4] !== 0x00 || buffer.readUInt16LE(2) !== attribute) {
    return undefined;
  }
  const length = buffer.readUInt16LE(5);
  const value = buffer.subarray(7, 7 + length);
  return value.length === length ? value : undefined;
}

/**
 * Build an attribute write: `attribute(2) || length(2) || value`, framed.
 *
 * Both lengths are little-endian, matching every other multi-byte value here.
 */
export function buildAttributeWrite(attribute: number, value: Buffer): Buffer[] {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(attribute, 0);
  header.writeUInt16LE(value.length, 2);
  return fragmentMessage(MsgType.ATTRIBUTE_SET, Buffer.concat([header, value]));
}

/**
 * Tell the lamp how far it is from UTC.
 *
 * A little-endian `float`, and the value is hours.minutes rather than decimal
 * hours; see {@link ATTR_UTC_OFFSET} and `utcOffset` in `timezone.ts`.
 */
export function buildUtcOffsetWrite(offset: number): Buffer[] {
  const payload = Buffer.alloc(4);
  payload.writeFloatLE(offset);
  return buildAttributeWrite(ATTR_UTC_OFFSET, payload);
}

/** Give the lamp the eight bytes that say when the local clock jumps. */
export function buildDstRulesWrite(rules: Buffer): Buffer[] {
  return buildAttributeWrite(ATTR_DST_RULES, rules);
}

/** Switch daylight tracking on or off. */
export function buildDaylightWrite(on: boolean): Buffer[] {
  return buildAttributeWrite(ATTR_DAYLIGHT, Buffer.from([on ? 0x01 : 0x00]));
}

/** Activate a preset, or clear it. */
export function buildPresetWrite(preset: Preset, on: boolean): Buffer[] {
  return buildAttributeWrite(PRESETS[preset], Buffer.from([on ? 0x01 : 0x00]));
}

/** Ask the lamp for an attribute's value. The answer arrives as `0x91`. */
export function buildAttributeRead(attribute: number): Buffer[] {
  const body = Buffer.alloc(2);
  body.writeUInt16LE(attribute, 0);
  return fragmentMessage(MsgType.ATTRIBUTE_GET, body);
}

/**
 * Read the answer to {@link buildAttributeRead} for a one-byte attribute.
 *
 * The reply carries a status byte the report does not, so the two cannot share
 * a decoder: `attribute(2) || status || length(2) || value`.
 */
export function decodeAttributeValue(buffer: Buffer): AttributeReport | undefined {
  if (buffer.length < 8) {
    return undefined;
  }
  if ((buffer[0]! & 0x80) === 0 || buffer[1] !== MsgType.ATTRIBUTE_VALUE) {
    return undefined;
  }
  // A non-zero status means the lamp refused the question, not that it said no.
  if (buffer[4] !== 0x00) {
    return undefined;
  }
  return named(buffer.readUInt16LE(2), buffer[7]!);
}

/**
 * Read a notification from {@link CHAR_WRITE_ATTR}.
 *
 * @returns Whether daylight mode is on, or `undefined` for anything that is not
 * a daylight-mode report — acknowledgements and other attributes both land here.
 */
export function decodeAttributeReport(buffer: Buffer): AttributeReport | undefined {
  // header, type, attribute id (2), length (2), value (1)
  if (buffer.length < 7) {
    return undefined;
  }
  if ((buffer[0]! & 0x80) === 0 || buffer[1] !== MsgType.ATTRIBUTE_REPORT) {
    return undefined;
  }
  return named(buffer.readUInt16LE(2), buffer[buffer.length - 1]!);
}

/** One attribute this client understands, and what the lamp said about it. */
export type AttributeReport =
  | { daylight: boolean }
  | { preset: Preset; active: boolean };

function named(attribute: number, value: number): AttributeReport | undefined {
  if (attribute === ATTR_DAYLIGHT) {
    return { daylight: value !== 0 };
  }
  for (const [preset, id] of Object.entries(PRESETS)) {
    if (id === attribute) {
      return { preset: preset as Preset, active: value !== 0 };
    }
  }
  // Plenty of other attributes exist and are not decoded; see docs/PROTOCOL.md.
  return undefined;
}

export const MIN_KELVIN = 2700;
export const MAX_KELVIN = 6500;
export const MIN_LUMENS = 100;
export const MAX_LUMENS = 1000;

/**
 * Bytes per fragment.
 *
 * The conservative ATT payload, and deliberately not the negotiated MTU. The
 * app does ask for 251 (`ble/a.java`) and keeps a per-machine fragment capacity
 * for when it gets it, but 20 needs no negotiation and is what every message
 * here has always been written at. Measured on a CF06: the 64-byte year of
 * birth, four fragments at this size, was accepted twelve times out of twelve —
 * while BlueZ refuses to send it whole at the MTU it settles on, with "Failed
 * to initiate write". Fragmenting is the path that works.
 */
const FRAGMENT_CAPACITY = 20;

/** A reassembled logical message. */
export interface DysonMessage {
  type: number;
  payload: Buffer;
}

/**
 * Split a logical message into ATT-sized fragments.
 *
 * The first fragment's header is `0x80 | (total - 1)`; every following header
 * is its own 0-based index. The type byte is part of the payload stream, so it
 * only appears in the first fragment.
 */
export function fragmentMessage(
  type: number,
  payload: Buffer = Buffer.alloc(0),
  capacity: number = FRAGMENT_CAPACITY,
): Buffer[] {
  const logical = Buffer.concat([Buffer.from([type]), payload]);
  const perFragment = capacity - 1;
  const total = Math.max(1, Math.ceil(logical.length / perFragment));
  const fragments: Buffer[] = [];
  for (let i = 0; i < total; i++) {
    const chunk = logical.subarray(i * perFragment, (i + 1) * perFragment);
    const header = i === 0 ? 0x80 | (total - 1) : i & 0x7f;
    fragments.push(Buffer.concat([Buffer.from([header]), chunk]));
  }
  return fragments;
}

/**
 * Reassembles fragments arriving as notifications on {@link CHAR_AUTH}.
 *
 * The lamp emits unsolicited messages (product info, RSSI) interleaved with
 * handshake responses, so a stray fragment must not wedge the stream: a new
 * first fragment always restarts the buffer.
 */
export class MessageAssembler {
  private buffer: Buffer[] = [];
  private typeId = -1;
  private expected = 0;
  private received = 0;

  /** Feed one raw notification. Returns a message once it is complete. */
  push(fragment: Buffer): DysonMessage | undefined {
    if (fragment.length < 1) {
      return undefined;
    }
    const header = fragment[0]!;
    const body = fragment.subarray(1);

    if ((header & 0x80) !== 0) {
      // First fragment: carries the type byte and the total fragment count.
      if (body.length < 1) {
        return undefined;
      }
      this.typeId = body[0]!;
      this.expected = (header & 0x7f) + 1;
      this.received = 1;
      this.buffer = [body.subarray(1)];
    } else {
      if (this.expected === 0) {
        // Continuation without a start — nothing we can do with it.
        return undefined;
      }
      this.buffer.push(body);
      this.received = (header & 0x7f) + 1;
    }

    if (this.received >= this.expected) {
      const message: DysonMessage = {
        type: this.typeId,
        payload: Buffer.concat(this.buffer),
      };
      this.reset();
      return message;
    }
    return undefined;
  }

  reset(): void {
    this.buffer = [];
    this.typeId = -1;
    this.expected = 0;
    this.received = 0;
  }
}

/** HomeKit brightness (0-100 %) to the lamp's lumen scale. */
export function percentToLumens(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.round(MIN_LUMENS + (clamped / 100) * (MAX_LUMENS - MIN_LUMENS));
}

/** The lamp's lumen scale back to HomeKit brightness (0-100 %). */
export function lumensToPercent(lumens: number): number {
  const clamped = Math.min(MAX_LUMENS, Math.max(MIN_LUMENS, lumens));
  return Math.round(((clamped - MIN_LUMENS) / (MAX_LUMENS - MIN_LUMENS)) * 100);
}

/** HomeKit reports colour temperature in mireds; the lamp wants Kelvin. */
export function miredToKelvin(mired: number): number {
  const kelvin = Math.round(1_000_000 / mired);
  return Math.min(MAX_KELVIN, Math.max(MIN_KELVIN, kelvin));
}

export function kelvinToMired(kelvin: number): number {
  const clamped = Math.min(MAX_KELVIN, Math.max(MIN_KELVIN, kelvin));
  return Math.round(1_000_000 / clamped);
}
