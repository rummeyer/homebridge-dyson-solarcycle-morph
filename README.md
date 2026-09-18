<h1 align="center">homebridge-dyson-solarcycle-morph</h1>

<p align="center">
  Control your <b>Dyson Solarcycle Morph</b> from the Apple Home app &mdash; over Bluetooth, with no cloud in the loop.
</p>

<p align="center">
  <a href="https://github.com/rummeyer/homebridge-dyson-solarcycle-morph/releases"><img src="https://img.shields.io/github/v/release/rummeyer/homebridge-dyson-solarcycle-morph?label=release" alt="Release"></a>
  <a href="https://github.com/rummeyer/homebridge-dyson-solarcycle-morph/blob/main/LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Licence"></a>
  <img src="https://img.shields.io/badge/homebridge-%E2%89%A5%202.0.0-purple" alt="Homebridge 2.0.0+">
  <img src="https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-green" alt="Node 22, 24 or 26">
</p>

---

## What you get

Your lamp appears in the Home app as a **light**, with the controls Apple provides for one:

- **On and off**
- **Brightness**
- **Colour temperature**, across the lamp's full 2700–6500 K range
- **Motion**, from the lamp's own sensor, as a separate sensor you can automate on
- **Siri**: *"Hey Siri, turn on the desk light"*, *"Hey Siri, set the desk light to 50%"*

After setup nothing leaves your home. The lamp has no Wi-Fi at all: the plugin
talks to it over Bluetooth, and the one cloud request — fetching the lamp's key —
happens once, during pairing.

## Before you start

| | |
|---|---|
| **Lamp** | Dyson Solarcycle Morph or Lightcycle Morph, added to your MyDyson account |
| **Homebridge** | 2.0.0 or newer, on Linux |
| **Node.js** | 22.18, 24 or 26 |
| **Range** | The Homebridge host must be within Bluetooth range of the lamp |

**The lamp must already be in the MyDyson app.** This is not a formality. The
lamp ignores every command until it is handed a key that only Dyson can issue,
against the account the lamp is registered to — there is no way to read it from
the device. If the lamp is not on your account, pairing returns a 404 and there
is nothing the plugin can do about it.

**Linux only.** The plugin talks to BlueZ over D-Bus, so macOS and Windows will
not work. A Raspberry Pi running Homebridge is the usual home for it.

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

### What is stored, and where

The lamp's key and your account session go into the plugin's own storage
directory, not into `config.json`. The file you can open in the Homebridge UI —
and paste into a support thread — holds nothing sensitive.

Your password is only needed to exchange a code for a session. **Forget
password** removes it afterwards; the lamp keeps working, because its key does
not expire.

## Step 4 — Add the lamp to the Home app

The child bridge has its own QR code, under **Bridge Settings**. Scan it in the
Home app the same way you paired Homebridge itself.

## Everyday use

**Brightness will not always land exactly where you put it.** The lamp ramps
towards a value rather than jumping, and trims it to track daylight from its
location and the time of day. Asking for 100% and seeing 88% is the lamp working
as designed.

**Changes made at the lamp show up in the Home app**, usually at once and at
worst within a minute.

**When the lamp is out of reach**, the Home app shows it as *No Response* rather
than the last value it knew, and commands fail instead of being silently queued.
The plugin reconnects on its own and reads the lamp's real state when it does.

**Switching off is checked.** Control commands are unacknowledged, so one can be
dropped in transit. Power is read back shortly after and resent if it did not
take — a lamp still lit after being switched off is the one failure nobody can
work around. Brightness and colour temperature are deliberately not checked,
because the lamp adjusts them itself and a correction would fight it.

## Settings

Everything except the lights is optional.

| Setting | |
|---|---|
| **Name** | What the plugin is called in the Homebridge log |
| **Lights → Name** | What the lamp is called in the Home app |
| **Lights → BLE MAC address** | Filled in by the scan |
| **Lights → Serial number** | Filled in by the scan. Identifies the accessory, so changing it creates a new one |
| **Lights → Expose the motion sensor** | Adds the lamp's motion detector as a HomeKit sensor |
| **Bluetooth adapter** | Only needed if the host has more than one, e.g. `hci1` |

## If something goes wrong

**The lamp shows as *No Response*.** There is no Bluetooth link at that moment.
The plugin keeps reconnecting; if it does not recover, read on.

**The log repeats `le-connection-abort-by-local` and never connects.** The lamp's
Bluetooth stack can reach a state where it advertises perfectly well — a scan
finds it, at a good signal strength — but refuses every connection.
**Disconnecting the lamp from power for ten seconds clears it**, reliably.
Nothing on the Homebridge side does. The plugin thins its attempts out to five
minutes apart, so it will pick the lamp up again by itself once you have.

**It connects, drops, reconnects, over and over.** Look at the signal line in the
log:

```
Signal from F0:… : -73 dBm average, -80 to -67
```

The **average** answers one question — is the lamp too far away. Around −60 dBm
is comfortable, −75 workable, −85 will not hold.

The **spread** answers a different one. A lamp that is not moving cannot swing by
20 dB on its own, so a wide spread means something else is using the band. So do
frequent `Lost connection` lines, and `Connected … on attempt 3 of 4`, which
means collisions where connections are established.

On a Raspberry Pi, Wi-Fi and Bluetooth share one chip and often one antenna, so
an active Wi-Fi link is the first thing to rule out — particularly on channel 1,
which sits directly on a Bluetooth advertising channel. If the host is on
Ethernet anyway, `sudo nmcli radio wifi off` settles it. Zigbee is worth checking
next: channels 15, 20 and 25 sit in the gaps between Wi-Fi 1, 6 and 11.

**`… is not paired yet`.** No key is stored for that serial. Open the plugin's
settings and authorise your account. Check the serial matches the lamp exactly —
it is what the key is filed under.

**`PayloadB failed HMAC verification`.** The stored key is wrong or corrupted.
Pair the lamp again.

**404 when fetching the key.** The lamp is not registered to that Dyson account.
See *Before you start*.

**`Not authorized` from D-Bus.** Only on distributions that restrict BlueZ
access — Debian and Raspberry Pi OS already allow it. If yours does not, create
`/etc/dbus-1/system.d/node-ble.conf` with a policy for the user Homebridge runs
as, then restart `dbus`. There is an example in
[the node-ble documentation](https://github.com/chrvadala/node-ble#provide-permissions).

## Good to know

**Bluetooth only.** These lamps have no Wi-Fi, so the Homebridge host has to be
within range. There is no cloud fallback when it is not.

**A few failed attempts at startup are normal.** Connecting to this lamp
succeeds roughly two times in three, whatever you do, so the plugin simply tries
several times in quick succession. Only a cycle that never succeeds is worth
looking at.

**The lamp's three modes appear as switches.** Auto brightness, where the lamp
trims its own output to keep the room level, and movement mode, where it lights
on movement and goes out once the room has been still, sit alongside the
daylight one. All three show what the lamp is actually doing and follow the
buttons on its base. Turn any of them off per light.

**Daylight tracking appears as its own switch.** It shows what the lamp is
actually doing, following the button on the lamp's base and the MyDyson app as
well as HomeKit. Setting a colour temperature ends the tracking — that is the
lamp's own behaviour, not the plugin's — so the switch turns itself off when you
do. Turn it off per light with `daylightSwitch` if you would rather not have it.

**Setup without the Homebridge UI.** `dyson-morph-pair` does the same pairing
from a terminal. See [CONTRIBUTING.md](CONTRIBUTING.md).

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
