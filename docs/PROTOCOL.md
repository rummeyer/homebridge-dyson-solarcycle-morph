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

Brightness and colour temperature can be written straight out; nothing has to be
sent first. See [Daylight mode](#daylight-mode) for why the earlier notes said
otherwise.

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

## The attribute channel

`2dd10021-…` is a small protocol of its own, and the only part of this lamp that
acknowledges a write. Three message types, carrying the standard fragment
framing (`0x80` header, then the type):

| type | direction | meaning |
| --- | --- | --- |
| `0x93` | → lamp | set an attribute |
| `0x94` | ← lamp | write accepted (`attribute(2) || status`, `00` is success) |
| `0x97` | ← lamp | an attribute changed |

The body is `attribute(2) || length(2) || value`, all little-endian. Daylight
mode is attribute `0x2013`, one byte, so turning it on is
`80 93 13 20 01 00 01` and off is the same with a trailing `00`.

Earlier notes here gave `13 20 01 00 00` as the thing to write for daylight mode.
That is the body with its type stripped — a `0x97` report, recorded as though it
were a command. Written bare the lamp ignores it, silently, which is how it came
to be believed to work: setting brightness or colour temperature by hand ends
daylight mode by itself, so the write appeared to do something it never did.

**The MyDyson app uses nothing else.** `2dd11001`, `2dd11005` and `2dd11009` do
not appear anywhere in it; every control goes through this channel. The direct
characteristics this client writes to are real and they work, but they are
write-without-response, which is why a dropped command here is invisible and why
reconciliation exists at all.

### Attributes

From the app's own table (`vc0/a.java`) and the calls that use them, with the
value shape each one takes. Only daylight mode is decoded with confidence; the
rest are listed as a map for later.

| attribute | shape | known as |
| --- | --- | --- |
| `0x2013` | 1 byte, bool | daylight tracking |
| `0x2006` `0x2014` `0x2015` `0x2017` `0x2018` `0x2023` `0x2024` | 2 bytes | numeric; brightness and colour temperature are among these |
| `0x2009` `0x200a` `0x200b` `0x201b` `0x201c` `0x2026` `0x2029` `0x2032` | 1 byte, bool | — |
| `0x2028` | 4 bytes | — |
| `0x201a` | 64 bytes | — |

The app also carries light presets (`SYNCHRONISED`, `STUDY`, `RELAX`,
`PRECISION`), each its own attribute, each written as a 1-byte `01`.

## Daylight mode

Measured on 2026-09-18 against a CF06.

**Writes land while daylight mode is on.** Colour temperature reached its target
in 8 of 8 trials with daylight mode active and nothing sent beforehand, and
brightness behaves the same way. Nothing has to be disabled first.

**Any manual write ends the tracking**, and the lamp announces it. Setting either
brightness or colour temperature does it, which is the lamp's own rule, not a
side effect worth relying on — though it does mean daylight mode can be left
without the attribute channel, by writing back the values already showing.

**The mode is observable.** `2dd10021-…` reports every change, in both
directions, whether it came from the app, the lamp's own button, or the lamp
deciding for itself. It cannot be *read*: there is no `read` flag, so a client
that connects while tracking is already on has no way to ask. Colour temperature
moving when nobody asked for it is the tell, and the only one — with daylight
mode off, nothing but a write moves it.

Leaving daylight mode makes the lamp restore the manual brightness and colour
temperature it held before, which are not the tracked values on display. With
tracking on, the drift is visible: colour temperature moved 5280 K to 5296 K over
two minutes, brightness dithering within about 3 lm.

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
- An orphaned BlueZ connection presents as a handshake timeout, not as a failed
  connect: the next client connects on attempt 1 and then waits out
  `REAUTH_PAYLOAD_B`. Only an explicit `bluetoothctl disconnect` clears it.
  Worth ruling out before reading a stuck lamp as the refuse-all state above.
- Which attributes carry brightness and colour temperature, among the seven
  two-byte ones above. Worth settling: the attribute channel acknowledges its
  writes, and these characteristics do not.
