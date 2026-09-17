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
- Homebridge 1.8+ or 2.x.

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

## 3. Pair

```sh
dyson-morph-pair --serial ABC-EU-XXXXXXXX --mac AA:BB:CC:DD:EE:FF --country DE
```

It asks for your Dyson email, your password, and a one-time code Dyson emails
you. Then it prints a config block ready to paste.

**Run this in a real terminal.** It reads from stdin interactively, so launching
it from an editor, an agent or a CI shell prints the prompts but never receives
your answers — every field arrives empty and Dyson rejects the login with a
misleading `401 Unable to authenticate user`.

Add `--debug` to see every request and response. Passwords, tokens and keys are
redacted; your email address is not.

## 4. Configure

Paste the block into the `platforms` array of your `config.json`:

```json
{
  "platform": "DysonSolarcycleMorph",
  "lights": [
    {
      "name": "Desk Light",
      "mac": "AA:BB:CC:DD:EE:FF",
      "serial": "ABC-EU-XXXXXXXX",
      "ltk": "…",
      "accountId": "…",
      "motionSensor": true
    }
  ]
}
```

| Field | |
|---|---|
| `name` | What the lamp is called in HomeKit. |
| `mac` | BLE address from step 1. |
| `serial` | Identifies the accessory to HomeKit. Changing it creates a new one. |
| `ltk` | Long-term key from pairing. |
| `accountId` | Dyson account UUID from pairing. |
| `motionSensor` | Expose the lamp's motion detector as a HomeKit sensor. Default `false`. |

**Running it as a child bridge is recommended.** Bluetooth links drop and
reconnect; in a child bridge that churn stays isolated from your other
accessories. In the Homebridge UI it is one toggle under the plugin's settings.

**Treat the LTK like a password.** Anyone holding it can control the lamp from
within Bluetooth range. Keep `config.json` readable only by Homebridge.

## Troubleshooting

**`le-connection-abort-by-local` a few times at startup.** Expected. BlueZ
commonly aborts the first two or three attempts before one sticks. The plugin
retries with backoff (5 s, 15 s, 30 s, then 60 s) and normally connects within a
minute. Only worry if it never succeeds.

**Everything reports `Operation Not Authorized`.** The handshake did not
complete. Look for `Handshake with … complete` in the log.

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

**The lamp shows 0 % brightness while off.** It reports 0 lumens when off, which
maps to 0 %. Switching on restores the lamp's own last brightness and the next
poll picks it up.

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

```sh
npm install
npm run build
npm test
```

The test suite runs without a lamp: the handshake crypto is pinned against
vectors generated from the Python reference, and the plugin is loaded the way
Homebridge loads it.

Not affiliated with or endorsed by Dyson.

## License

MIT — see [LICENSE](LICENSE).
