# homebridge-dyson-solarcycle-morph

Homebridge plugin for the **Dyson Solarcycle Morph** and **Lightcycle Morph**
task lights (model CD06).

These lamps have no Wi-Fi. Everything goes over Bluetooth LE, so the machine
running Homebridge has to be within Bluetooth range of the lamp — there is no
cloud path to fall back on.

Exposes a HomeKit lightbulb with on/off, brightness and colour temperature
(2700–6500 K), plus the lamp's built-in motion sensor if you want it.

## Before you start

**Your lamp must already be registered in the MyDyson app, on the account you
are going to log in with.** This is not optional and it is worth explaining why,
because it is the one thing that can stop you dead.

The lamp ignores every command until a challenge-response handshake proves you
hold its *long-term key* (LTK). That key is issued by Dyson, tied to the account
the lamp is registered to, and there is no way to derive it from the device
itself. Pairing here fetches it once from the Dyson cloud. If the lamp is not on
your account, the endpoint returns 404 and there is nothing this plugin can do.

The only other way to get an LTK is Dyson's "fresh pairing" handshake, which
needs a physical button press on the lamp *and* a working cloud session — this
plugin does not implement it. So: open the MyDyson app, make sure the lamp is
there, then continue.

Everything after pairing is local. The plugin never touches the network again.

## Requirements

- A Linux host with BlueZ — a Raspberry Pi running Homebridge is the usual case.
  This uses [`node-ble`](https://github.com/chrvadala/node-ble), which talks to
  BlueZ over D-Bus, so **macOS and Windows will not work**.
- Node.js 20.19+ / 22.12+ / 24+.
- Homebridge 2.x.

Developed and verified against a Solarcycle Morph desk light on Raspberry Pi OS
Bookworm, BlueZ 5.66, Homebridge 2.4.

## 1. Find the lamp

```sh
sudo bluetoothctl --timeout 15 scan le
```

Look for a device whose name is a Dyson serial, something like
`ABC-EU-XXXXXXXX`. **The lamp advertises its serial number as its Bluetooth
name**, so this one command gives you both values you need:

```sh
bluetoothctl info AA:BB:CC:DD:EE:FF
```

```
Device AA:BB:CC:DD:EE:FF (random)
        Name: ABC-EU-XXXXXXXX          ← serial number
        UUID: Vendor specific    (2dd10010-1c37-452d-8979-d1b4a787d0a4)
```

That `2dd10010` service UUID confirms it is a Dyson light speaking the protocol
this plugin implements.

## 2. Install

```sh
sudo npm install -g homebridge-dyson-solarcycle-morph
```

On a Homebridge installation managed by `hb-service` (the official Raspberry Pi
image and apt package), plugins live in the Homebridge storage directory rather
than in npm's global prefix. Install it there instead:

```sh
cd /var/lib/homebridge
sudo -u homebridge /opt/homebridge/bin/npm install homebridge-dyson-solarcycle-morph
```

Installing into the wrong prefix is a quiet failure: npm reports success and
Homebridge never sees the plugin.

## 3. Pair, in the Homebridge UI

Open the plugin's settings. The page walks through three things:

1. **Scan for lights.** Finds nearby Dyson lights and adds them to the
   configuration, filling in the address and serial number for you. You can skip
   this and type them by hand if you already did step 1.
2. **Authorise your MyDyson account.** Enter your email, password and country,
   request a code, and enter the code Dyson emails you.
3. **Check the result.** Paired lights are listed with the date they were
   authorised, and can be un-paired again.

Save the configuration and restart Homebridge.

**The key never enters `config.json`.** It is written to the plugin's own
storage directory, so the file you can open in the UI — and paste into a support
thread — contains nothing sensitive.

### Without the Homebridge UI

`dyson-morph-pair` does the same thing from a terminal:

```sh
dyson-morph-pair --serial ABC-EU-XXXXXXXX --country DE
```

Pass `--storage` if your Homebridge storage directory is not `~/.homebridge`,
and `--debug` to see every request and response.

**Run it in a real terminal.** It reads from stdin interactively, so launching
it from an editor, an agent or a CI shell prints the prompts but never receives
your answers — every field arrives empty and Dyson rejects the login with a
misleading `401 Unable to authenticate user`.

## 4. Configure

Scanning writes this for you; by hand it looks like:

```json
{
  "platform": "DysonSolarcycleMorph",
  "lights": [
    {
      "name": "Desk Light",
      "mac": "AA:BB:CC:DD:EE:FF",
      "serial": "ABC-EU-XXXXXXXX",
      "motionSensor": true
    }
  ]
}
```

| Field | |
|---|---|
| `name` | What the lamp is called in HomeKit. |
| `mac` | BLE address from the scan. |
| `serial` | Identifies the accessory to HomeKit and keys its stored credentials. |
| `motionSensor` | Expose the lamp's motion detector as a HomeKit sensor. Default `false`. |

Credentials are not configured here. For an unattended setup you may still set
`ltk` and `accountId` explicitly, and they then take precedence over anything
stored — supply both or neither.

**Running it as a child bridge is recommended.** Bluetooth links drop and
reconnect; in a child bridge that churn stays isolated from your other
accessories. In the Homebridge UI it is one toggle under the plugin's settings.

## Troubleshooting

**`le-connection-abort-by-local` a few times at startup.** Expected. BlueZ
commonly aborts the first two or three attempts before one sticks. The plugin
retries with backoff (2 s, 5 s, 15 s, 30 s, then 60 s) and normally connects
within a minute. Only worry if it never succeeds.

**It connects, drops after a few seconds, and reconnects, over and over.**
Usually the radio link, not the software. The plugin logs the signal strength
when it connects and warns below about −80 dBm; at that level BLE hits its
supervision timeout and the link dies. Check it directly with:

```sh
sudo bluetoothctl info AA:BB:CC:DD:EE:FF | grep RSSI
```

−60 dBm is comfortable, −75 is workable, −85 will not hold. Move the lamp or the
Homebridge host closer to each other, or put a Bluetooth adapter nearer the lamp.

**It keeps failing with `le-connection-abort-by-local` and never connects.**
The lamp's Bluetooth stack can reach a state where it advertises normally — a
scan finds it, at a good signal strength — but refuses every connection.
**Disconnecting the lamp from power for ten seconds clears it**, reliably, and
nothing on the Homebridge side does. The plugin keeps retrying and thins the
attempts out to five minutes apart, so it will pick the lamp up again by itself
once you have done that.

**Everything reports `Operation Not Authorized`.** The handshake did not
complete. Look for `Handshake with … complete` in the log.

**`… is not paired yet`.** No key is stored for that serial. Open the plugin's
settings in the Homebridge UI and authorise your account there. Check the serial
matches the lamp exactly — it is what the stored key is filed under.

**`PayloadB failed HMAC verification`.** The stored LTK is wrong or corrupted.
Re-run `dyson-morph-pair`.

**404 when fetching the LTK.** The lamp is not registered to that Dyson account.
See *Before you start*.

**`Not authorized` from D-Bus, or nothing connects at all.** Only relevant if
your distribution restricts BlueZ access — Debian Bookworm and Raspberry Pi OS
already allow it for all users, so this is usually *not* your problem. If it is,
create `/etc/dbus-1/system.d/node-ble.conf`, replacing `homebridge` with the
user Homebridge runs as, then `sudo systemctl restart dbus`:

```xml
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="homebridge">
    <allow own="org.bluez"/>
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
```

**The Home app shows the lamp as "No Response".** There is no Bluetooth link
right now. Commands are not queued while that is the case: they fail, so you
know they did not happen. The plugin reconnects on its own and reads the lamp's
real state when it does.

**The brightness I set is not exactly what the lamp shows.** Expected. The lamp
ramps towards a value rather than jumping, and trims it to track daylight from
its location and the time. Only power is checked and resent, because it is the
only value whose outcome is unambiguous — see
[docs/PROTOCOL.md](docs/PROTOCOL.md).

**Daylight mode changed at the lamp is not reflected.** The lamp lets you write
that setting but not read it back, so the plugin cannot know. It re-asserts
manual mode before writes to keep control predictable.

### Inspecting the lamp yourself

`tools/ble-probe.js` dumps every service, characteristic, flag and notification,
with no build step and no plugin install:

```sh
npm install node-ble
node tools/ble-probe.js AA:BB:CC:DD:EE:FF
```

Useful for checking a model this plugin has not been tried against.

## Protocol

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the GATT layout, the message
framing and the handshake, including where a real lamp disagreed with the
published notes.

Reverse-engineered from the MyDyson Android app by S-Termi and documented in
[cmgrayb/hass-dyson](https://github.com/cmgrayb/hass-dyson). This plugin is an
independent TypeScript implementation, cross-checked against that reference with
`npm test`.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the build, how to try a change on
real hardware, and how releases are published.

Not affiliated with or endorsed by Dyson.

## License

MIT — see [LICENSE](LICENSE).
