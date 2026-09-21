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
| `2dd11000-…` | read, write-without-response, notify | uint8 | Brightness as a percentage, but not of the lumen range — see below |
| `2dd11001-…` | read, write-without-response, notify | uint16 LE | Colour temperature, 2700–6500 K |
| `2dd11004-…` | read | 2 bytes | Read `42 00` on a CF06 and never seen to change; not decoded |
| `2dd11005-…` | read, write-without-response, notify | uint8 | Power: 0 = off, 1 = on |
| `2dd11006-…` | read, write-without-response, notify | uint8 | Auto brightness: 0 = off, 1 = on |
| `2dd11007-…` | read, write-without-response, notify | uint8 | Movement mode: 0 = off, 1 = on |
| `2dd11008-…` | read, notify | 8 bytes | Read `20 00 00 00 00 00 00 00` on a CF06 and never seen to change; **not motion**, whatever the older notes say |
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

`2dd11000` reports a percentage, and it is not a percentage of the lumen range
this client uses. Measured on a CF06: 496 lm read as 73, 900 lm read as 96. A
straight line through those two gives a negative minimum, so it is not linear in
lumens; it fits a perceptual curve on which 1000 lm is 100% and 100 lm about
11%, but two points do not settle a curve. This client writes lumens to
`2dd11009` and scales linearly for HomeKit, which is its own choice rather than
the lamp's.

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
value shape each one takes.

Read from a CF06 on 2026-09-18 with the lamp at 120 lm / 4486 K, and extended on
2026-09-21. The values are recorded because they are what the lamp actually
held, which is a better starting point than the shapes alone.

| attribute | value read | note |
| --- | --- | --- |
| `0x2013` | `0` | daylight tracking |
| `0x2026` | `0` | not auto brightness, despite the app's auto-brightness screen writing it; see below |
| `0x2003` | `48.6719` | **latitude**, double, little-endian |
| `0x2004` | `9.2807` | **longitude**, double, little-endian |
| `0x2005` | `2.0` | **UTC offset in hours**, `float`, little-endian |
| `0x201d` | `23 00 78 3c 2a 00 b4 77` | **daylight-saving rules**, 8 bytes |
| `0x201a` | 64 bytes | **year of birth**, encrypted |
| `0x2025` | `1768998955` | unix time, written whenever `0x201a` is |
| `0x201b` | `1` | **age adjustment on/off**, one byte |
| `0x2006` | `300` | |
| `0x2007` | `30` | |
| `0x2014` | `424` | |
| `0x2015` | `1170` | plausibly a lumen bound |
| `0x2017` | `200` | plausibly a lumen bound |
| `0x2018` | `3000` | plausibly a colour-temperature bound |
| `0x2023` | `480` | |
| `0x2024` | `1080` | |
| `0x201e` | `0` | **STUDY preset** |
| `0x201f` | `0` | **RELAX preset** |
| `0x2021` | `0` | **PRECISION preset** |
| `0x2009` `0x200b` `0x200d` `0x201c` `0x2029` `0x2032` | `0` | flags |
| `0x200a` | `1` | flag |
| `0x2028` `0x2030` `0x2031` | 4 bytes | |

Everything else in `0x2000`–`0x2040` returns nothing.

Three of those attributes are the lamp's preset modes; see
[Preset modes](#preset-modes).

### Where the lamp thinks it is

Daylight tracking needs sunrise and sunset, and the lamp works those out from a
latitude in `0x2003` and a longitude in `0x2004`. Both are IEEE-754 doubles
written little-endian: `pd0/b.java` and `pd0/c.java` build one with
`ByteBuffer.putDouble`, which is big-endian, and then reverse the array through
`bm0/c.java`'s `j()`.

```
0x2003  58 17 b7 d1 00 56 48 40   48.671899999999994
0x2004  71 f9 0f e9 b7 8f 22 40    9.280699999999998
```

Neither is exactly the tidy decimal it looks like — each sits one unit in the
last place below it — because the app writes whatever `Location.getLatitude()`
handed it, never a parsed string. Anything comparing coordinates has to allow a
tolerance or it will rewrite the lamp forever.

The app writes the two 300 ms apart (`md0/l.java`), where it spaces most other
messages by less.

**The app has exactly one source for them: the phone's GPS.** The city it
displays is produced afterwards by reverse-geocoding the coordinates through
Android's own `Geocoder` (`sc0/a.java`), taking the first non-empty of
thoroughfare, sub-locality, locality; the result is a `{ name, latitude,
longitude, countryCode }` record (`sc0/c.java`). There is no search in the other
direction — `getFromLocationName` appears nowhere in the APK — so a place name
is a label on coordinates the app already has, never a way to obtain them.

Two neighbours belong to the same setting. `0x2005` is the UTC offset in hours
as a little-endian `float` (`pd0/d.java`); `2.0` was read during German summer
time. `0x201d` carries the daylight-saving rules in eight bytes (`pd0/a.java`):
start rule and month packed into one byte, start date, start time in minutes,
the adjustment in minutes, then the same three for the end, and finally the two
days of the week packed together. The `23 00 78 3c 2a 00 b4 77` above is the EU
rule — last Sunday in March at 02:00, plus 60 minutes, last Sunday in October
at 03:00.

### Age adjustment

The lamp trims the brightness of two of its modes to suit older eyes. The app
says what it does, in
`machine552_configuration_ageAdjust_description`:

> Light requirements change as a person ages. You can add a birth year for the
> main intended user, and the brightness of Study mode and Relax mode will
> automatically adjust.

**Two attributes, and the switch is the one that decides.** `0x201b` is the
toggle at the top of the app's own section: `fd0/q1.java` binds it to
`age_adjust_toggle` in `layout_age_adjust.xml` and writes it straight to the
lamp from `onCheckedChanged`, and `he0/u.java`'s `T()` reads it back. A year
stored with the switch off changes nothing.

`0x201a` holds the year, and it stores a **year only** — the picker is labelled
`light_configurationYearOfBirth` and runs from 1900 to the current year
(`mr0/d.java`), with no day or month anywhere near it. It is 64 bytes,
encrypted, and the only setting on this lamp that is. Clearing it is writing a
year of zero, which is what the app's own remove dialog does (`bd0/d.java`).

The lamp keeps the setting to the account that wrote it. The app puts it
plainly:

> For privacy reasons, age adjust is only available to this light's owner.

**Writes to `0x201a` are refused now and then, and nothing explains which.** The
`0x94` acknowledgement carries status `1`, which `he0/k0.java` treats as a hard
failure ("Invalid write status"), and the value is not stored. Measured on a
CF06 on 2026-09-21, three or more trials per arm:

| varied | result |
| --- | --- |
| fragments 150 ms apart vs consecutive | no difference |
| `write-without-response` vs `write-with-response` | 3/3 accepted either way |
| age-adjustment switch off vs on | 3/3 accepted either way |
| standalone probe, consecutive fragments | 12/12 accepted |

The lamp advertises `write-without-response` and `notify` on this
characteristic and nothing else, so the write type is not really a choice. The
same bytes from the plugin were refused once and accepted once, which is the
shape this lamp's connects have too: no arrangement is reliable, and the answer
is repetition. This client writes an attribute up to three times, which the
acknowledgement makes possible rather than hopeful — without reading it, a
refused setting is indistinguishable from one that took.

Note also that the reply to `0x90` for this attribute is 64 bytes of value, so
71 bytes of message: four fragments. It is the only thing on this lamp that has
to be reassembled on the attribute channel, and reading only the first
notification sees a message that never completes.

The key is not the one the handshake uses. Both come from the same HKDF-SHA256
over the LTK, with the same empty salt and the same single expansion block
truncated to 16 bytes, but a different `info` string: `SENSITIVE_STATE\0` here
against `USER_AUTH_AES\0\0\0` for authentication (`q50/a.java`'s static
initialiser). The sealing is the protocol's usual encrypt-then-MAC — the same
`IV(16) || ciphertext || HMAC-SHA256(ciphertext)(32)` as PayloadA — over a
16-byte plaintext built by `je0/a.java`:

```
uint16 LE year || 14 zero bytes
```

Read back, the third byte of the plaintext is a status the app logs by name
(`bd0/c.java`): `0` the year is good, `1` "GUID comparison failed" — another
account set it — and `2` "age not set", both of which come with a year of zero.

Writing it also sets `0x2025` to the current unix time as a little-endian
`uint32` (`he0/u.java`'s `x()`), so the lamp knows when the answer was given.

Verified against a CF06 on 2026-09-21: the blob decrypted to year `1974` with
status `0` and a matching MAC, which is what the lamp had been told through the
app in January.

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
| `pd0/b.java`, `pd0/c.java` | latitude and longitude as little-endian doubles |
| `pd0/d.java`, `pd0/a.java` | the UTC offset, and the daylight-saving rules |
| `md0/i.java`, `md0/l.java` | where the app gets a location, and what it does with one |
| `sc0/a.java`, `sc0/c.java` | turning coordinates into the place name the app displays |
| `je0/a.java`, `bd0/f.java`, `bd0/c.java` | the year of birth: sealing it, reading it back, its status byte |
| `q50/a.java` | the `SENSITIVE_STATE` HKDF info, and where the LTK is kept |
| `t50/a.java`, `t50/b.java`, `t50/c.java` | the cipher, the HKDF, and encrypt-then-MAC |

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

It also drives the lamp through *light modes*: `he0/u.java`'s `U()` takes one —
`SYNCHRONISED`, `STUDY`, `RELAX`, `PRECISION`, or a custom one, each carrying a
colour temperature and a brightness — and activates it by writing `01` to the
attribute that names it, which `he0/a.java`'s `k()` supplies. See
[Preset modes](#preset-modes) for which attribute is which.

**The app spaces its writes**, 300 ms between messages in most places and 500 ms
in a few, which is the same problem this client solves with `MIN_WRITE_GAP_MS`.
Ours is 150 ms, measured; theirs is more conservative.

## The lamp's three modes

Daylight tracking, auto brightness and movement mode are the three switches on
the lamp's base. They are unrelated to each other and they live in two different
places, which is worth stating plainly because assuming otherwise cost a day
here: daylight mode is an *attribute*, the other two are *characteristics*.

| mode | where | what it does |
| --- | --- | --- |
| Daylight | attribute `0x2013` on `2dd10021` | moves colour temperature through the day |
| Auto brightness | characteristic `2dd11006`, 1 byte | trims brightness to hold the room level |
| Movement | characteristic `2dd11007`, 1 byte | lights on movement, goes out once still |

The two characteristics are the easy ones: read, write and notify, one byte,
`00` or `01`. Nothing else is needed — no handshake beyond the usual one, no
framing, no acknowledgement to wait for. `2dd11006` and `2dd11007` appear in
older notes as "runtime flags" and "ambient sensor", which is what sent this
project looking for them in the attribute channel for hours.

The app writes them through `he0/u.java`: `y(boolean)` for auto brightness,
`M(boolean)` for movement, both via `he0/b.java`. Which is which comes from the
bindings — `fd0/b0.java` calls `cVar.a.y(z)` from the auto-brightness screen,
`fd0/e1.java` calls `cVar.a.M(z)` from the movement one.

Auto brightness is why brightness drifts with nothing touching it: measured at
800 lm climbing to 871 lm over two minutes, with daylight mode off and colour
temperature static.

### Daylight mode in detail

The awkward one of the three, and the only one worth a section of its own.
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
two minutes in one measurement, which is auto brightness rather than daylight.

Leaving daylight mode makes the lamp restore the manual brightness and colour
temperature it held before, which are not the tracked values on display. With
tracking on, the drift is visible: colour temperature moved 5280 K to 5296 K over
two minutes, brightness dithering within about 3 lm.

## Preset modes

The app offers four: `SYNCHRONISED`, `STUDY`, `RELAX` and `PRECISION`. Three are
attributes, activated by writing `01`:

| preset | attribute | where it put a CF06 |
| --- | --- | --- |
| STUDY | `0x201e` | 4741 K, 503 lm |
| RELAX | `0x201f` | 2900 K, 251 lm |
| PRECISION | `0x2021` | 4600 K, 1000 lm |

`SYNCHRONISED` is not among them — `he0/a.java`'s `k()` returns `null` for it,
because it is daylight tracking under another name.

They behave better than anything else on this lamp. A write is acknowledged with
`0x94`, reported with `0x97`, and they are mutually exclusive: activating RELAX
while STUDY is on produces a second report saying STUDY is now off, without
being asked. Writing `00` clears a preset, and the lamp keeps the brightness and
colour temperature the preset left it at.

So a client can both set and follow these, which is more than can be said for
daylight mode. The lamp's own custom modes are a separate matter: they carry a
name and their own values, and where those are stored is not known — `0x201a`,
write-only and 64 bytes, is the obvious candidate.

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

- **Custom light modes.** The three built-in presets are decoded (above); a
  custom one carries a name and its own values, and where those live is not
  known. `0x201a` — write-only, 64 bytes — is the obvious candidate.
- **What the rest of the attributes mean.** The table above has what each one
  held on a CF06. Reads cost nothing and cannot disturb a setting, so changing
  something in the app and reading the table again is the cheap way in.
- **`2dd11004`.** Read-only, two bytes, `42 00`, unchanged across a day of
  poking. A revision or a capability word would both fit.
- **Where motion is reported, if anywhere.** `2dd11008` is named as motion in
  the published notes, and this client exposed it as a HomeKit sensor on that
  basis. It is not: it held `20 00 00 00 00 00 00 00` throughout the lamp being
  on, being off, and movement mode being switched both ways, notifying only once
  at subscribe. The app never reads it either. The sensor was removed rather
  than left reporting motion permanently.
- **`2dd11000`'s curve.** Two readings say it is not linear in lumens. A handful
  more across the range would settle what it is.

A note on method, learned the hard way here: writing a value and asking whether
the lamp looks right proves nothing when the lamp already held that value. Write
the *opposite* of what is showing, and see whether it changes. The lamp's Auto
switch was "confirmed" twice on attributes that turned out to have nothing to do
with it, on exactly that mistake.

Settled, and recorded so they are not asked again:

- The lamp's Auto and movement switches are `2dd11006` and `2dd11007`, not
  attributes. Nothing in `0x2000`–`0x2140` touches them.
- **A lamp that connects and then times out waiting for `REAUTH_PAYLOAD_B` is
  usually not a lamp problem.** An orphaned BlueZ connection — one left behind
  by a client that was killed rather than closed — presents exactly that way:
  the next client "connects" on attempt 1 because the link is already up, then
  waits out the handshake on a session the lamp considers taken.
  `bluetoothctl disconnect` clears it. Rule this out before reading it as the
  refuse-every-connection state, which needs the lamp's power removed instead.
- Brightness and colour temperature are **not** attributes, in either direction.
  Neither readable nor writable as one. The app writes them to the same
  characteristics this client does — `he0/h.java` sends a two-byte value to
  `2dd11001` and `2dd11009` through `he0/j0.java`, with no acknowledgement and
  no read-back — and it could not do otherwise, since both are
  write-without-response. There is no acknowledged route to them, which is why
  pacing and reconciliation are load-bearing rather than workarounds. The
  acknowledged attribute channel is for settings, and holds neither value.
- `13 20 01 00 00` is a message body without its type, not a command.
