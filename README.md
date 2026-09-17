# homebridge-dyson-solarcycle-morph

Homebridge plugin for the **Dyson Solarcycle Morph** and **Lightcycle Morph**
task lights. These lamps have no Wi-Fi — they are Bluetooth LE only — so the
bridge must be within Bluetooth range of the lamp.

Exposes a HomeKit lightbulb with on/off, brightness and colour temperature
(2700–6500 K), and optionally the lamp's built-in motion sensor.

## Requirements

- A Linux host with BlueZ (a Raspberry Pi running Homebridge is the usual case).
  This plugin uses [`node-ble`](https://github.com/chrvadala/node-ble), which
  talks to BlueZ over D-Bus; it does **not** work on macOS or Windows.
- Node.js 20.19+ / 22.12+ / 24+.
- The lamp registered to your Dyson account in the MyDyson app.

## Setup

### 1. Install

```sh
sudo npm install -g homebridge-dyson-solarcycle-morph
```

### 2. Allow Homebridge to talk to BlueZ

`node-ble` needs D-Bus permission for the user Homebridge runs as. Create
`/etc/dbus-1/system.d/node-ble.conf`, replacing `homebridge` with that user:

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

Then `sudo systemctl restart dbus`.

### 3. Pair

Run once, on any machine with network access:

```sh
dyson-morph-pair
```

It asks for your Dyson email, password, a one-time code Dyson emails you, and
the lamp's serial and MAC address, then prints a config block to paste into
`config.json`. Find the MAC with `sudo bluetoothctl scan on` if you don't have it.

This is the only step that touches the internet. Afterwards the plugin runs
entirely offline.

### 4. Configure

```json
{
  "platforms": [
    {
      "platform": "DysonSolarcycleMorph",
      "lights": [
        {
          "name": "Desk Light",
          "mac": "AA:BB:CC:DD:EE:FF",
          "serial": "XXX-XX-XXXXXXXX",
          "ltk": "…",
          "accountId": "…",
          "motionSensor": false
        }
      ]
    }
  ]
}
```

The **long-term key is a device credential** — anyone holding it can control the
lamp within Bluetooth range. Keep `config.json` readable only by Homebridge.

## Troubleshooting

**Nothing happens when I toggle the light.** The lamp discards control writes
until the handshake completes. Check the Homebridge log for `Handshake with …
complete`. A `HMAC verification` error means the stored LTK is wrong — re-run
`dyson-morph-pair`.

**Connection keeps dropping.** BLE range is short and the Morph advertises
infrequently. The plugin reconnects with backoff (5 s, 15 s, 30 s, then 60 s).

**Inspecting the lamp directly.** `tools/ble-probe.js` dumps every service,
characteristic and notification without needing the plugin installed:

```sh
npm install node-ble
node tools/ble-probe.js AA:BB:CC:DD:EE:FF
```

## Protocol

See [docs/PROTOCOL.md](docs/PROTOCOL.md). The protocol was reverse-engineered by
S-Termi and documented in [cmgrayb/hass-dyson](https://github.com/cmgrayb/hass-dyson);
this plugin is an independent TypeScript implementation of it, cross-checked
against that reference with `npm test`.

## Development

```sh
npm install
npm run build
npm test
```

## License

MIT
