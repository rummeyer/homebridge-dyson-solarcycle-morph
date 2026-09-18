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
| `2dd11006-…` | read, write-without-response, notify | uint8 | Auto brightness: 0 = off, 1 = on |
| `2dd11007-…` | read, write-without-response, notify | uint8 | Movement mode: 0 = off, 1 = on |
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

The lamp moves brightness by itself: ask for 100% and it may settle at 88%. That
is the lamp working as intended, and it is indistinguishable from a command that
was dropped in transit.

Two separate things do it, and neither is daylight mode. Auto brightness
(`2dd11006`) trims the output to hold the room at a steady level — measured
drift of 800 lm to 871 lm over two minutes with daylight mode off — and the lamp
ramps towards any new value rather than jumping to it. Daylight mode moves
colour temperature, not brightness.

Anything that verifies brightness by reading it back will therefore fight the
lamp. This client checks only power, which has an unambiguous outcome, and
treats brightness and colour temperature as fire-and-forget.

## The attribute channel

`2dd10021-…` is a small protocol of its own, and the only part of this lamp that
acknowledges a write. Three message types, carrying the standard fragment
framing (`0x80` header, then the type):

| type | direction | body |
| --- | --- | --- |
| `0x90` | → lamp | `attribute(2)` — ask for a value |
| `0x91` | ← lamp | `attribute(2) \|\| status \|\| length(2) \|\| value` |
| `0x93` | → lamp | `attribute(2) \|\| length(2) \|\| value` — set it |
| `0x94` | ← lamp | `attribute(2) \|\| status` — write accepted (`00`) |
| `0x97` | ← lamp | `attribute(2) \|\| length(2) \|\| value` — it changed |

Everything is little-endian. Note that a reply to `0x90` carries a status byte
where a `0x97` report does not, so the value sits one byte further along: decode
them with the same offsets and a switch reads as its own opposite.

Daylight mode is attribute `0x2013`, one byte. Turning it on is
`80 93 13 20 01 00 01`, off is the same with a trailing `00`, and asking is
`80 90 13 20`.

Earlier notes here gave `13 20 01 00 00` as the thing to write for daylight mode.
That is the body with its type stripped — a `0x97` report, recorded as though it
were a command. Written bare the lamp ignores it, silently, which is how it came
to be believed to work: setting brightness or colour temperature by hand ends
daylight mode by itself, so the write appeared to do something it never did.

The light's own values do not live here. Reading every attribute from `0x2000`
to `0x2040` on a CF06 found none holding its brightness or colour temperature:
this channel carries settings, bounds and flags, while brightness, colour
temperature and the mode switches are plain characteristics on `2dd1fff0`. Those
are write-without-response, so a dropped command there is invisible, and that is
why reconciliation and write pacing exist.

### Attributes

From the app's own table (`vc0/a.java`) and the calls that use them, with the
value shape each one takes. Only daylight mode is decoded with confidence; the
rest are listed as a map for later.

Read from a CF06 on 2026-09-18, with the lamp at 120 lm / 4486 K. Only daylight
mode is decoded; the values are recorded because they are what the lamp actually
held, which is a better starting point than the shapes alone.

| attribute | value read | note |
| --- | --- | --- |
| `0x2013` | `0` | daylight tracking |
| `0x2006` | `300` | |
| `0x2007` | `30` | |
| `0x2014` | `424` | |
| `0x2015` | `1170` | plausibly a lumen bound |
| `0x2017` | `200` | plausibly a lumen bound |
| `0x2018` | `3000` | plausibly a colour-temperature bound |
| `0x2023` | `480` | |
| `0x2024` | `1080` | |
| `0x2009` `0x200b` `0x200d` `0x201c` `0x201e` `0x201f` `0x2021` `0x2026` `0x2029` `0x2032` | `0` | flags |
| `0x200a` `0x201b` | `1` | flags |
| `0x2003` `0x2004` | 8 bytes | doubles; `0x2003` and `0x2004` look like a latitude and longitude |
| `0x201d` | 8 bytes | |
| `0x2005` `0x2025` `0x2028` `0x2030` `0x2031` | 4 bytes | |
| `0x201a` | write-only, 64 bytes | |

Everything else in `0x2000`–`0x2040` returns nothing.

The app also carries light presets (`SYNCHRONISED`, `STUDY`, `RELAX`,
`PRECISION`), each its own attribute, each written as a 1-byte `01`.

## What the MyDyson app does

Most of this document's harder facts came from the Android app, and re-deriving
them is a slow job, so here is the map. Package `com.dyson.mobile.android`,
version 6.4.26360 from APKMirror as an `.apkm` bundle; `base.apk` inside it holds
the code, and all the BLE work is in `classes2.dex`. `jadx -d out --no-res
--no-debug-info base/classes2.dex` takes a couple of minutes. Names are
obfuscated and will differ between versions, so treat these as a starting point
rather than addresses.

| class | what it holds |
| --- | --- |
| `d50/e.java` | the attribute service and characteristic (`2DD10020`, `2DD10021`) |
| `d50/a.java` | the auth service and characteristic (`2DD10011`) |
| `b50/c.java` | which message types go to which characteristic |
| `vc0/a.java` | the light's attribute table — the ids in the section above |
| `he0/u.java` | the light machine's BLE interface, one method per operation |
| `he0/n0.java`, `he0/k0.java` | attribute write: `0x93`, and the `0x94` status check |
| `he0/a0.java`, `he0/x.java` | attribute read: `0x90` |
| `nd0/e.java` | `DELAY_BETWEEN_WRITING_MESSAGES_MILLS` |
| `com/dyson/mobile/android/light/control/e.java` | the light modes, with their colour temperature and brightness |

`b50/c.java` is the useful one for orientation: it routes each message type to a
characteristic, which is how the two channels separate.

- With a payload — `1, 2, 3, 6, 8, 14` to the auth channel; `48, 50, 66, 68, 80`
  to the attribute channel.
- Without one — `4` to the auth channel; `6, 10, 12, 64, 70, 81` to the
  attribute channel.

The attribute types this client uses (`0x90`, `0x93`) are not in those lists;
they are built directly in `he0`, which is why they were not found by guessing.

**Searching the app for a UUID string finds nothing**, and that is a trap worth
knowing about: `d50/g.java` builds them with
`String.format("2DD1%s-1C37-452D-8979-D1B4A787D0A4", "1006")`, so the full UUIDs
never appear in the binary. Believing the app did not use `2dd1fff0` at all cost
a day's worth of wrong turns here. Grep for the four-digit fragment instead.

`d50/g.java` is the table for that service: `1000`, `1001`, `1005`, `1006`,
`1007`, `1009`. The switches on the lamp's base are written straight to it —
`he0/u.java`'s `y(boolean)` for auto brightness and `M(boolean)` for movement
mode, both via `he0/b.java`, one byte each. The bindings say which is which:
`fd0/b0.java` calls `cVar.a.y(z)` from the auto-brightness screen and
`fd0/e1.java` calls `cVar.a.M(z)` from the movement one.

The app does not set brightness or colour temperature as values, though:
`he0/u.java`'s `U()` takes a *light mode* — `SYNCHRONISED`, `STUDY`, `RELAX`,
`PRECISION`, or a custom one, each carrying a colour temperature and a
brightness — and activates it by writing `01` to the attribute that names it.
`0x201a` (write-only, 64 bytes) is the obvious candidate for where a custom
mode's definition goes. Nothing there was decoded, and that path is no use for a
HomeKit slider in any case.

**The app spaces its writes**, 300 ms between messages in most places and 500 ms
in a few, which is the same problem this client solves with `MIN_WRITE_GAP_MS`.
Ours is 150 ms, measured; theirs is more conservative.

## Daylight mode

Measured on 2026-09-18 against a CF06.

**Writes land while daylight mode is on.** Colour temperature reached its target
in 8 of 8 trials with daylight mode active and nothing sent beforehand, and
brightness behaves the same way. Nothing has to be disabled first.

**Any manual write ends the tracking**, and the lamp announces it. Setting either
brightness or colour temperature does it, which is the lamp's own rule, not a
side effect worth relying on — though it does mean daylight mode can be left
without the attribute channel, by writing back the values already showing.

**The mode can be read and is reported.** `2dd10021-…` announces every change,
whether it came from the app, the lamp's own button, or the lamp deciding for
itself, and `0x90` asks for the current value outright — the characteristic has
no `read` flag, but the channel carries a request of its own.

Colour temperature moving when nobody asked for it also gives the mode away,
since nothing but a write moves it while tracking is off. The client keeps that
as a fallback for a lamp that does not answer the question. Brightness will not
do: it drifts on its own even with tracking off, climbing 800 lm to 871 lm over
two minutes in one measurement, which is the ambient sensor rather than daylight.

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

- `2dd11004-…` is read-only and not decoded.
- An orphaned BlueZ connection presents as a handshake timeout, not as a failed
  connect: the next client connects on attempt 1 and then waits out
  `REAUTH_PAYLOAD_B`. Only an explicit `bluetoothctl disconnect` clears it.
  Worth ruling out before reading a stuck lamp as the refuse-all state above.
- `0x201a`: write-only, 64 bytes, and the likely home of a custom light mode's
  definition. Decoding it would open up the lamp's preset modes, which are the
  one feature of the app this client has no answer to. Read `he0/u.java`'s `U()`
  and whatever `a.k()` maps a mode to before starting.
- What the rest of the attributes in the table mean. Reads are free and cannot
  disturb anything, so correlating them against changes made in the app is the
  cheap way in.

A note on method, learned the hard way here: writing a value and asking whether
the lamp looks right proves nothing when the lamp already held that value. Write
the *opposite* of what is showing, and see whether it changes. The lamp's Auto
switch was "confirmed" twice on attributes that turned out to have nothing to do
with it, on exactly that mistake.

Settled, and recorded so they are not asked again:

- The lamp's Auto and movement switches are `2dd11006` and `2dd11007`, not
  attributes. Nothing in `0x2000`–`0x2140` touches them.
- Brightness and colour temperature are **not** attributes, in either direction.
  Neither readable nor writable as one. The app writes them to the same
  characteristics this client does — `he0/h.java` sends a two-byte value to
  `2dd11001` and `2dd11009` through `he0/j0.java`, with no acknowledgement and
  no read-back — and it could not do otherwise, since both are
  write-without-response. There is no acknowledged route to them, which is why
  pacing and reconciliation are load-bearing rather than workarounds. The
  acknowledged attribute channel is for settings, and holds neither value.
- `13 20 01 00 00` is a message body without its type, not a command.
