<p align="center">
  <img src="https://raw.githubusercontent.com/rummeyer/homebridge-dyson-solarcycle-morph/main/docs/icon.png" width="100" height="100" alt="">
</p>

<h1 align="center">homebridge-dyson-solarcycle-morph</h1>

<p align="center">
  Control your <b>Dyson Solarcycle Morph</b> from the Apple Home app &mdash; over Bluetooth, with no cloud in the loop.
</p>

<p align="center">
  <a href="https://github.com/rummeyer/homebridge-dyson-solarcycle-morph/releases"><img src="https://img.shields.io/github/v/release/rummeyer/homebridge-dyson-solarcycle-morph?label=release" alt="Release"></a>
  <a href="https://github.com/rummeyer/homebridge-dyson-solarcycle-morph/blob/main/LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Licence"></a>
  <img src="https://img.shields.io/badge/homebridge-1.8%20%7C%202.x-purple" alt="Homebridge 1.8 or 2.x">
  <img src="https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-green" alt="Node 22, 24 or 26">
</p>

---

## What you get

Your lamp appears in the Home app as a **light**, with the controls Apple
provides for one and nothing else on it — so the tile turns the lamp on when you
tap it, the way a light should:

- **On and off**
- **Brightness**
- **Colour temperature**, across the lamp's full 2700–6500 K range
- **Siri**: *"Hey Siri, turn on the desk light"*, *"Hey Siri, set the desk light to 50%"*

**Beside it sits a second accessory, `<name> Switches`,** holding everything
that is a switch. The three modes that otherwise live only on the lamp's base or
in the MyDyson app — each one automatable, and each showing what the lamp is
really doing rather than what was last asked of it:

| switch | what it does |
| --- | --- |
| **Daylight** | shifts colour temperature through the day, warm in the evening and cool at midday |
| **Auto Brightness** | trims the level to suit the room as the light around it changes |
| **Movement** | lights when it sees movement, goes out once the room has been still |

On the same accessory, the lamp's three preset modes — **Study**, **Relax** and
**Precision** — as switches that apply a set of values and spring back, the way a
scene does. They are what the buttons in the MyDyson app do, and the lamp allows
only one at a time.

| preset | where it puts the lamp |
| --- | --- |
| Study | 4741 K, fairly bright |
| Relax | 2900 K, dim and warm |
| Precision | 4600 K, full output |

**It follows the lamp, not just the other way round.** Press a button on the
base, change something in the MyDyson app, or let the lamp end daylight tracking
by itself, and the Home app keeps up — usually within a second. A lamp that is
out of range says so, rather than showing you the last thing it knew.

**After setup nothing leaves your home.** The lamp has no Wi-Fi at all: the
plugin talks to it over Bluetooth, and the one cloud request — fetching the
lamp's key — happens once, during pairing.

## Before you start

| | |
|---|---|
| **Lamp** | Dyson Solarcycle Morph or Lightcycle Morph, added to your MyDyson account |
| **Homebridge** | 2.0.0 or newer, on Linux |
| **Node.js** | 22.18, 24 or 26 |
| **Range** | The Homebridge host must be within Bluetooth range of the lamp, and stay there — these lamps have no Wi-Fi, so there is no cloud fallback |

**The lamp must already be in the MyDyson app.** This is not a formality. The
lamp ignores every command until it is handed a key that only Dyson can issue,
against the account the lamp is registered to — there is no way to read it from
the device. If the lamp is not on your account, pairing returns a 404 and there
is nothing the plugin can do about it.

**Linux only.** macOS and Windows will not work, for Bluetooth reasons that are
not worth going into here. A Raspberry Pi running Homebridge is the usual home
for it.

## Step 1 — Install the plugin

In the Homebridge UI, go to **Plugins**, search for
`homebridge-dyson-solarcycle-morph` and choose **Install**.

## Step 2 — Give it a child bridge

In the plugin's **⋮** menu, choose **Bridge Settings** and turn the child bridge
on.

This is worth doing. Bluetooth links drop and reconnect; in a child bridge that
churn stays in its own process instead of unsettling your other accessories.

## Step 3 — Connect your MyDyson account

Open the plugin's **Settings**. The page walks through it:

1. **Enter your MyDyson email, password and country.** The country picks the
   Dyson server and the language its requests use.
2. **Request code**, then type the code Dyson emails you and press **Submit**.
   The page then shows *✓ Authorised*, with when and how many devices your
   account holds.
3. **Find my lights.** This lists the lights on your account and scans for their
   Bluetooth addresses. Press **Add and pair** next to yours.
4. **Forget password** once you are done, then **Save**.

Restart Homebridge when the page says so.

## Step 4 — Add the lamp to the Home app

The child bridge has its own QR code, under **Bridge Settings**. Scan it in the
Home app the same way you paired Homebridge itself. Two accessories turn up: the
lamp, and `<name> Switches` beside it. Put them in whichever rooms suit you —
they are independent as far as the Home app is concerned.

## Using it

**Turning it on, dimming it, changing the colour** — all the usual Home app
controls, and Siri.

**The three switches can be automated like anything else.** A few that people
tend to want:

- Movement on when you leave for work, off when you get home
- Daylight on in the morning, so the lamp cools towards midday and warms again by evening on its own
- Auto Brightness off when you sit down to watch a film

**Brightness will not always land exactly where you put it.** The lamp eases
towards a new level rather than jumping, and with Auto Brightness on it keeps
adjusting to suit the room. Asking for 100% and seeing 88% is the lamp doing its
job — turn Auto Brightness off if you would rather it stayed put.

**Setting a brightness or a colour temperature ends daylight tracking**, and
the Daylight switch turns itself off when you do. That is the lamp's own behaviour, not something
the plugin decides. Flip the switch back on to resume.

**The three mode switches work while the lamp is off**, though the lamp itself
will not have them until it is lit — it takes none of the three while it is off.
So a switch flipped on a dark lamp stays where you put it and is written the
moment the lamp comes on, whether you switch it on from the Home app, from the
MyDyson app or at the lamp. Turning Movement on last thing at night therefore
does what you meant by it. Nothing is kept over a restart: a plugin starting up
takes all three from the lamp, which is the only thing that knows what it is
really doing.

**Changes made at the lamp appear in the Home app**, usually straight away.

**Out of range, the lamp shows as *No Response*** rather than the last thing it
knew, and commands fail rather than being quietly dropped. It comes back on its
own once the link does.

## Settings

Everything except the lights is optional.

| Setting | |
|---|---|
| **Name** | What the plugin is called in the Homebridge log |
| **Lights → Name** | What the lamp is called in the Home app |
| **Lights → BLE MAC address** | Filled in by the scan |
| **Lights → Serial number** | Filled in by the scan. Identifies the accessory, so changing it creates a new one |
| **Lights → Latitude**, **Longitude** | Where the lamp stands, in decimal degrees. Optional; set both or neither |
| **Lights → Year of birth** | Turns on the lamp's age adjustment. Optional |
| **Lights → Apply the age adjustment** | The lamp's own switch for it. On by default |
| **Lights → Day starts at** | Optional. Replaces the real sunrise, as `HH:MM` |
| **Lights → Day ends at** | Optional. Replaces the real sunset |
| **Lights → Expose daylight tracking** | The Daylight switch. On by default |
| **Lights → Expose auto brightness** | The Auto Brightness switch. On by default |
| **Lights → Expose movement mode** | The Movement switch. On by default |
| **Lights → Expose the preset modes** | The Study, Relax and Precision switches. On by default |
| **Bluetooth adapter** | Only needed if the host has more than one, e.g. `hci1` |

Turning all four switches off leaves the lamp on its own: there is then nothing
for the second accessory to hold, so it is not created, and an existing one is
removed.

### The config block

The settings page writes this for you. It is worth knowing the shape anyway, for
editing `config.json` by hand and for reading what the UI produced:

```json
{
  "platform": "DysonSolarcycleMorph",
  "name": "Dyson Solarcycle Morph",
  "lights": [
    {
      "name": "Desk",
      "mac": "AA:BB:CC:DD:EE:FF",
      "serial": "E5T-EU-6DYYJX5E",
      "latitude": 48.7784,
      "longitude": 9.18,
      "yearOfBirth": 1985,
      "ageAdjust": true,
      "daylightSwitch": true,
      "autoBrightnessSwitch": true,
      "movementSwitch": true,
      "presetSwitches": true
    }
  ],
  "dysonAccount": { "email": "you@example.com", "country": "DE" },
  "adapter": "hci0"
}
```

`platform` is how Homebridge finds the plugin, and each light needs a `name`, a
`mac` and a `serial`. Everything else can be left out; the switches then take
the defaults below, and the location and year of birth are simply not touched on
the lamp. The example above shows every key at once, which no real config needs.

| Key | Type | Default | |
|---|---|---|---|
| `platform` | string | — | Must be `DysonSolarcycleMorph` |
| `name` | string | `Dyson Solarcycle Morph` | The log prefix. The settings page insists on it |
| `lights[].name` | string | — | The name in the Home app |
| `lights[].mac` | string | — | `AA:BB:CC:DD:EE:FF` |
| `lights[].serial` | string | — | The accessory's identity; changing it makes a new accessory |
| `lights[].latitude` | number | unset | Decimal degrees, -90 to 90 |
| `lights[].longitude` | number | unset | Decimal degrees, -180 to 180 |
| `lights[].yearOfBirth` | integer | unset | 1900 to this year |
| `lights[].ageAdjust` | boolean | `true` | Only read when `yearOfBirth` is set |
| `lights[].dayStart` | string | | `HH:MM`, end after start. Only read when `customDay` is on |
| `lights[].dayEnd` | string | | |
| `lights[].customDay` | boolean | `false` | Puts `dayStart`/`dayEnd` in the lamp; off, they are ignored |
| `lights[].daylightSwitch` | boolean | `true` | |
| `lights[].autoBrightnessSwitch` | boolean | `true` | |
| `lights[].movementSwitch` | boolean | `true` | |
| `lights[].presetSwitches` | boolean | `true` | Adds three switches, not one |
| `dysonAccount.email` | string | unset | Used by the settings page, never by the plugin |
| `dysonAccount.country` | string | `GB` | Two letters |
| `dysonAccount.password` | string | unset | Only while authorising; **Forget password** clears it |
| `adapter` | string | system default | e.g. `hci1` |

**A light with something wrong with it is skipped, and the rest still load** —
the message names the entry and the key. Three combinations are refused rather
than half-applied, because half of any of them would quietly do the wrong thing:

- `latitude` without `longitude`, or the other way round. A lamp told only its
  latitude would put itself on the Greenwich meridian and track the wrong sunset
  all year.
- `ageAdjust` without `yearOfBirth`. There would be nothing to adjust for.
- `customDay` on without both `dayStart` and `dayEnd`. With it off, the times are
  not checked at all, since they are not used.

**No key for the lamp appears here.** Pairing puts it in the plugin's storage
directory instead — see [What is stored, and where](#what-is-stored-and-where).
A `lights[].ltk` and `lights[].accountId` pair is accepted to override what is
stored, which exists for migrating an older setup; supply both or neither.

### Where the lamp is

Daylight tracking follows sunrise and sunset, and the lamp works those out from
its coordinates. The MyDyson app sets them once, from the GPS of the phone the
lamp was set up on, and never asks again — so a lamp added through the app
already knows, and one that has moved house still believes it is at the old
address.

> **A lamp that does not know what time it is will not keep a location.** It
> answers the write with a success status and keeps the factory coordinates,
> and daylight tracking cannot run — the lamp says so only through a small LED
> at its daylight button. The lamp loses its clock whenever it loses power, so
> one switched off at the wall overnight wakes up in that state every morning.
>
> **The plugin sets the lamp's clock on every connection, so this is handled.**
> A lamp fresh off the mains takes its coordinates and starts tracking daylight
> without the MyDyson app being involved.
>
> This took two days to find, and for most of it the evidence pointed at a
> set-up gate that had to be lifted in the app — a lamp only ever accepted a
> location *after* the app had been near it. The app was not unlocking
> anything. It sets the clock at the start of every session, so everything that
> happened afterwards worked. `0x2005` and the daylight-saving rules, which
> this plugin had been writing all along, describe a *time zone* and never say
> what time it is; without the time, a latitude cannot be turned into a
> sunrise, and the lamp has no use for one.

The two fields exist to set the coordinates without the app, and to correct them
afterwards. Leave them empty and the plugin does not touch what the lamp holds —
it still reads them on connecting and puts them in the debug log, which is the
way to find out what the app put there:

```
Lamp AA:BB:CC:DD:EE:FF places itself at 48.77840, 9.18000
```

Fill them in and it writes yours whenever the lamp disagrees, and says so:

```
Location of AA:BB:CC:DD:EE:FF set to 48.77840, 9.18000 (was 50.11090, 8.68210)
```

**Use my current location** on the settings page fills both fields in for every
light. It asks your browser first, which only answers on a page served over
HTTPS — the Homebridge UI is usually plain HTTP, and then the coordinates are
looked up instead from the address this machine reaches the internet from,
through [ipwho.is](https://ipwho.is) or [geojs.io](https://geojs.io). That is
accurate to the nearest town, which is all a sunrise needs, and wrong if the
connection goes out through a VPN. Nothing is sent to either service: they read
the public address the request arrives from, which is what every site this
machine contacts already sees. Check what it filled in before saving.

### A day of your own

Daylight tracking follows the real sunrise and sunset by default. Two optional
fields replace that with a day you choose, and a switch decides whether they
are used:

```json
"dayStart": "07:30",
"dayEnd": "22:00",
"customDay": true
```

With `customDay` off, which is the default, the times are ignored and can stay
filled in for later. On the settings page the switch is **Use this day**, and it
appears once either time is filled in.

The lamp keeps its warm-to-cool-to-warm shape and fits it between those two
times instead of the sun's, and falls back to a softer, warmer baseline once the
day is over. It is the same pair the MyDyson app offers as *Sunrise* and
*Sunset*. With the switch on, both are needed and the end has to come after the
start — the lamp stores two plain minute counts and has no way to express a day
that runs past midnight. Leave the switch off and the sun decides.

The effect is immediate and visible: setting the end to a time already past
drops the lamp to its baseline within a second, and putting the real one back
brings it straight up again.

**There is no way back to automatic from here.** Turning the switch off stops
the plugin correcting the lamp, but whatever day was last written stays in it. The
lamp may recompute the times from its location on its own — that is untested —
and the MyDyson app certainly can. Until that is settled, treat setting a day as
something the app has to undo.

### And what time it is there

Coordinates alone are not enough: turning a place into an hour needs a clock, so
the lamp holds an offset from UTC and the rules for when the local clock jumps.
The MyDyson app writes both on every connection, and so does this plugin, only
when the lamp disagrees:

```
UTC offset of AA:BB:CC:DD:EE:FF set to 2 (was 1)
```

**There is nothing to configure.** Both come from the time zone of the machine
Homebridge runs on, which knows them exactly and knows them without asking the
network — worth having, since they go in while reconnecting. A time zone whose
clock changes on a pattern the lamp has no way of being told is left alone
rather than guessed at; the common European and British rules are exact.

A lamp that will not take the offset says so in the log and keeps its own, the
same way it does with the location.

### Is it actually tracking?

The Daylight switch does not answer that. The lamp accepts the mode, never
reports it back off, and then does nothing at all if it has no location to work
from. What answers it is the day the lamp has worked out, which appears on every
connection:

```
AA:BB:CC:DD:EE:FF puts today's daylight between 07:04 and 19:30
```

A lamp with no location has no day, and says so:

```
AA:BB:CC:DD:EE:FF has worked out no sunrise or sunset, which means it holds no
location. Daylight tracking cannot run until one is set
```

### Age adjustment

The lamp can trim the brightness of its **Study and Relax modes** to suit the
eyes of whoever mainly uses it, which it works out from a birth year. In the
MyDyson app's words: *"Light requirements change as a person ages. You can add a
birth year for the main intended user, and the brightness of Study mode and
Relax mode will automatically adjust."*

Two things have to be true for it to do anything, and the plugin handles both:
the lamp has to hold the year, and its age-adjustment switch has to be on. Set
**Year of birth** and the plugin writes it and turns the switch on; turn **Apply
the age adjustment** off to leave the year in place and stop the lamp acting on
it. Leave the year empty and neither setting is touched.

The lamp stores a year and nothing else — no day, no month — and it is the one
setting on this lamp kept encrypted, under a key derived from your lamp's own
long-term key. It also keeps it to the Dyson account that set it, which the app
explains as *"for privacy reasons, age adjust is only available to this light's
owner"*. If a different account got there first the plugin says so and changes
nothing:

```
The age adjustment on AA:BB:CC:DD:EE:FF was set by a different Dyson account
and only that account can change it.
```

Clearing the year altogether is not something the plugin does; the MyDyson app's
own age-adjustment screen has a remove option for that.


## If something goes wrong

**The lamp shows as *No Response*.** There is no Bluetooth link at that moment.
The plugin keeps trying; it usually sorts itself out.

**It never connects at all, however long you leave it.** Unplug the lamp for ten
seconds. Its Bluetooth can get into a state where it looks perfectly healthy but
refuses every connection, and a power cycle is the only thing that clears it.
The plugin will pick the lamp up again by itself afterwards.

**It connects, drops, reconnects, over and over.** Usually either the lamp is too
far from the Homebridge host, or something nearby is using the same airwaves —
Wi-Fi especially. [Reading the signal](#reading-the-signal) below shows which.

**It says the lamp is not paired yet.** No key is stored for that serial. Open
the plugin's settings and authorise your account again, and check the serial
matches the lamp exactly — that is what the key is filed under.

**Pairing returns a 404.** The lamp is not on that Dyson account. It has to be
added in the MyDyson app first; there is no way round this.

**A few failed attempts at startup are normal.** Connecting to this lamp works
about two times in three whatever anyone does, so the plugin simply tries again.
Only a cycle that never succeeds is worth looking at.

## Under the hood

Not needed to use the plugin, but useful when something looks odd.

### Reading the signal

Once a minute the log carries a line like:

```
Signal from F0:… : -73 dBm average, -80 to -67
```

The **average** answers one question: is the lamp too far away. Around −60 dBm is
comfortable, −75 workable, −85 will not hold.

The **spread** answers a different one. A lamp that is not moving cannot swing by
20 dB on its own, so a wide spread means something else is using the band. So do
frequent `Lost connection` lines, and `Connected … on attempt 3 of 4`, which
means collisions where connections are established.

On a Raspberry Pi, Wi-Fi and Bluetooth share one chip and often one antenna, so
an active Wi-Fi link is the first thing to rule out — particularly on channel 1,
which sits directly on a Bluetooth advertising channel. If the host is on
Ethernet anyway, `sudo nmcli radio wifi off` settles it. Zigbee is worth checking
next: channels 15, 20 and 25 sit in the gaps between Wi-Fi 1, 6 and 11.

Moving the host closer is worth more than any of it. One measured move took a
link from −76 dBm with two drops an hour to −50 dBm with none.

### Why switching off is double-checked

Commands to this lamp are unacknowledged: the plugin sends one and the lamp says
nothing back, so a command can be lost with nothing to show for it. Power is
therefore read back shortly after and resent if it did not take — a lamp still
lit after being switched off is the one failure nobody can work around.

Brightness and colour temperature are deliberately *not* checked, because the
lamp moves them itself and a correction would fight it.

### What is stored, and where

The lamp's key and your account session go into the plugin's own storage
directory, not into `config.json`. The file you can open in the Homebridge UI —
and paste into a support thread — holds nothing sensitive.

Your password is only needed to exchange a code for a session. **Forget
password** removes it afterwards; the lamp keeps working, because its key does
not expire.

### Setting up without the Homebridge UI

`dyson-morph-pair` does the same pairing from a terminal. See
[CONTRIBUTING.md](CONTRIBUTING.md).

### Rarer errors

**`PayloadB failed HMAC verification`.** The stored key is wrong or corrupted.
Pair the lamp again.

**`Not authorized` from D-Bus.** Only on distributions that restrict BlueZ
access — Debian and Raspberry Pi OS already allow it. If yours does not, create
`/etc/dbus-1/system.d/node-ble.conf` with a policy for the user Homebridge runs
as, then restart `dbus`. There is an example in
[the node-ble documentation](https://github.com/chrvadala/node-ble#provide-permissions).

## For developers

The protocol, including where a real lamp disagreed with the published notes, is
written up in [docs/PROTOCOL.md](docs/PROTOCOL.md). Building, testing and
releasing are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

The BLE protocol was reverse-engineered from the MyDyson Android app by
**S-Termi** and documented in
[cmgrayb/hass-dyson](https://github.com/cmgrayb/hass-dyson). This plugin is an
independent TypeScript implementation, cross-checked against that reference.

Not affiliated with or endorsed by Dyson.

## Licence

MIT — see [LICENSE](LICENSE).
