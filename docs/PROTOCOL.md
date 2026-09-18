# Dyson Morph BLE protocol

Notes on the protocol this plugin speaks. Reverse-engineered by others; this
file records what the implementation relies on, so a future reader can tell
what is verified from what is assumed.

**Source:** the protocol was reverse-engineered from the MyDyson Android app
(`g20/a.java`, `g20/b.java`, `g20/c.java`) by S-Termi and documented in
[cmgrayb/hass-dyson](https://github.com/cmgrayb/hass-dyson) under
`.github/design/ble_lights.md`. Verified there against the Lightcycle Morph
(CD06) and Solarcycle Morph (CF06).

## GATT layout

**Observed on a Solarcycle Morph desk light, model CD06** (serial `ABC-EU-…`;
the lamp advertises its serial as its BLE name). It differs from the published
notes in two ways worth knowing:

Characteristics are spread over **three** services, not one:

| Service | Characteristics |
|---|---|
| `2dd10010-…` | `2dd10011` auth, `2dd10013` RSSI |
| `2dd10020-…` | `2dd10021` attribute write |
| `2dd1fff0-…` | `2dd11000`, `01`, `04`, `05`, `06`, `07`, `08`, `09` |

The client therefore discovers by sweeping every service and matching on the
characteristic UUID, which is unique on its own.

| UUID | Flags (observed) | Format | Meaning |
|---|---|---|---|
| `2dd10011-…` | write-without-response, notify | framed messages | Authentication channel |
| `2dd10013-…` | read, notify | int8 | RSSI, readable **without** auth |
| `2dd10021-…` | write-without-response, notify | attribute TLV | Attribute writes (daylight mode) |
| `2dd11000-…` | read, write-without-response, notify | uint8 | Brightness 0–100 % (lamps without daylight) |
| `2dd11001-…` | read, write-without-response, notify | uint16 LE | Colour temperature, 2700–6500 K |
| `2dd11004-…` | read | — | Undocumented, not decoded |
| `2dd11005-…` | read, write-without-response, notify | uint8 | Power: 0 = off, 1 = on |
| `2dd11006-…` | read, write-without-response, notify | — | Runtime / schedule flags, not decoded |
| `2dd11007-…` | read, write-without-response, notify | — | Ambient sensor, not decoded |
| `2dd11008-…` | read, notify | bytes | Motion: any non-zero byte = detected |
| `2dd11009-…` | read, write-without-response, notify | uint16 LE | Brightness 100–1000 lm (CD06/CF06) |

The published notes say brightness, colour temperature and daylight-mode writes
must be **acknowledged** (`write-with-response`), because the lamp otherwise
discards them. That does not hold here: this lamp declares no `write` flag at
all, only `write-without-response`, and unacknowledged writes to power,
brightness and colour temperature **do take effect** — verified on hardware.
The client picks the mode from each characteristic's advertised flags rather
than assuming either, so models that do offer `write` still get acknowledged
writes.

Every characteristic except `2dd10013` (RSSI) returns `Operation Not Authorized`
for reads and notifications until the handshake below completes — confirmed on
hardware, as is the fact that they read and write normally afterwards.

Connecting is unreliable in a way that is worth expecting: BlueZ commonly
returns `le-connection-abort-by-local` for the first two or three attempts
before one succeeds, so the client retries with backoff rather than treating it
as fatal.

Separately, the lamp can reach a state where it keeps advertising at full signal
strength but refuses every connection, indefinitely — over a hundred attempts in
one observed stretch. **Removing its power for ten seconds clears it**, twice
reproduced. Nothing on the client side was found to help: connecting from the
cached record, rediscovering it, scanning during the connect and waiting for a
fresh advertisement were each tried and each failed while it was in that state.
The client therefore thins its retries out rather than hammering, and says in
the log what actually works.

Before writing brightness or colour temperature, write
`13 20 01 00 00` to `2dd10021-…` to leave daylight mode, then wait ~200 ms.
There is no way to read the current mode back, so the plugin re-asserts it on a
TTL (see `MANUAL_MODE_TTL_MS`).

## Message framing on the auth channel

Every write and notification on `2dd10011-…` is a fragment:

```
first fragment:  [0x80 | (total - 1)] [type byte] [payload…]
later fragments: [fragment index]     [payload…]
```

Capacity is 20 bytes per fragment — the MyDyson app's assumption, which we copy
rather than trusting the negotiated MTU.

## Authentication

The lamp ignores every control write until the handshake completes. Two paths
exist; this plugin implements only the second.

**Fresh pairing** (once, needs the physical Flash button and the Dyson cloud)
produces a long-term key. Message types `0x04`, `0x05`, `0x09`, `0x0D`, `0x01`,
`0x02`, `0x03`, with cloud calls to `/v1/lec/<serial>/{auth,verify,provision,ltk}`.

**LTK re-auth** (every connect, fully offline) is what the plugin runs:

```
→ 0x0A  request product info
← 0x0B  product info
→ 0x06  account GUID(16) ‖ 00 00 ‖ seal(nonce)          82 bytes
← 0x07  00 00 ‖ IV(16) ‖ ct(32) ‖ MAC(32)?
→ 0x08  00 00 ‖ seal(challenge)                          66 bytes
← 0x26  connection established
```

`challenge` is the second 16-byte block of the decrypted `ct`; the first block
is our own nonce echoed back.

### Crypto

Dyson's own notes call this AES-GCM. It is not. The key is derived from the LTK
with HKDF-SHA256 (empty salt, info `USER_AUTH_AES\0\0\0`, first 16 bytes), and
`seal(x)` is unpadded AES-128-CBC followed by HMAC-SHA256 over the ciphertext —
encrypt-then-MAC, with one key used for both:

```
seal(x) = IV(16) ‖ AES-128-CBC(key, IV, x) ‖ HMAC-SHA256(key, ciphertext)
```

`test/crypto.test.ts` pins this against vectors generated from the Python
reference implementation.

## Obtaining the LTK

If the lamp is already registered in the MyDyson app, no button press is
needed — `GET /v1/lec/<serial>/ltk` returns it, authenticated with a normal
account bearer token plus the header `X-Dyson-ApiAuthCode: 80541406` (a
well-known constant that the endpoint accepts in place of a session code).
`dyson-morph-pair` does this.

## Brightness is not a setpoint

The lamp adjusts its own brightness to track daylight, using its configured
location and the time of day: ask for 100% and it may settle at 88%. That is the
lamp working as intended, and it is indistinguishable from a command that was
dropped in transit.

Anything that verifies brightness by reading it back will therefore fight the
lamp. This client checks only power, which has an unambiguous outcome, and
treats brightness and colour temperature as fire-and-forget.

Writing `13 20 01 00 00` to `2dd10021-…` is documented as leaving daylight mode
so explicit values are accepted. Whether that also stops the tracking described
above, and whether brightness writes land without it, is **not established** —
the mode cannot be read back, so there is nothing to observe. Measurements on
2026-09-18 did not settle it either: every trial ran with daylight mode already
off, which is the condition the question is not about.

## Writes must be spaced apart

A write arriving immediately behind another is discarded, and since these
characteristics are write-without-response, nothing reports it. Measured on a
CF06 at -54 dBm, eight trials per arm, each aimed at the far end of the range so
every trial was decisive:

| spacing | colour temperature landed |
| --- | --- |
| none (back to back) | 1 of 8 |
| 100 ms | 8 of 8 |

The drop takes whichever write is *second*, whichever field that is — brightness
was dropped in the one back-to-back trial where colour temperature survived. It
is not specific to colour temperature, and it is not the daylight mode above.

This is the ordinary path rather than an edge case: HomeKit sets brightness and
colour temperature together whenever a scene is applied, and the client's
debouncer keys on the characteristic, so the two land in the queue at the same
instant. The client therefore paces control writes (`MIN_WRITE_GAP_MS`, 150 ms,
a margin over the 100 ms that tested clean). Auth-channel fragments are exempt:
they are written back to back by design and have never shown the problem.

Two things follow for anyone measuring this lamp. Asking for the value it
already holds cannot distinguish a landed write from a dropped one, so trials
have to aim somewhere else. And a single run is not evidence — the failure is
probabilistic, and short runs produced two different plausible-looking mechanisms
before eight-trial arms separated them.

## Open questions

- `2dd11004-…`, `2dd11006-…` and `2dd11007-…` are not decoded.
- Whether `ensureManualMode` is needed at all is still open; it has to be tested
  with daylight mode actually **on**.
- An orphaned BlueZ connection presents as a handshake timeout, not as a failed
  connect: the next client connects on attempt 1 and then waits out
  `REAUTH_PAYLOAD_B`. Only an explicit `bluetoothctl disconnect` clears it.
  Worth ruling out before reading a stuck lamp as the refuse-all state above.
- Daylight mode is write-only; the plugin cannot report whether it is active.
- Only the `0x2013` attribute is known for `2dd10021-…`.
