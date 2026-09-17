# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-17

First release. Verified end to end against a Solarcycle Morph desk light
(model CD06) on Raspberry Pi OS Bookworm, BlueZ 5.66, Homebridge 2.4.

### Added

- A settings page in the Homebridge UI that scans for nearby lights, authorises
  a MyDyson account and pairs them, replacing the need to run anything by hand.
- Credentials are stored in the plugin's storage directory rather than in
  `config.json`, so the file the UI displays holds nothing sensitive. Setting
  `ltk` and `accountId` in the config still works and takes precedence.
- Signal strength is logged on connect, with a warning below −80 dBm — the point
  where BLE supervision timeouts make a link drop repeatedly.

- HomeKit lightbulb with on/off, brightness and colour temperature (2700–6500 K).
- Optional motion sensor from the lamp's built-in detector.
- Offline LTK re-authentication, run on every connect. No network access after
  pairing.
- `dyson-morph-pair`, the same flow from a terminal, for setups without the
  Homebridge UI.
- `tools/ble-probe.js`, a standalone GATT dump for inspecting a lamp without
  installing the plugin.
- Reconnect with backoff, and a keepalive poll that keeps the BLE link up.

### Requirements

- Homebridge 2.x. The plugin is ESM, matching Homebridge 2's own module format.

### Notes on the protocol

Probing real hardware contradicted the published protocol notes in two places,
both handled here rather than assumed away:

- Characteristics are spread across three GATT services, not gathered under one.
  Discovery sweeps every service and matches on characteristic UUID.
- Acknowledged writes are described as mandatory, but this lamp advertises no
  `write` flag at all and unacknowledged writes do take effect. The write mode
  is taken from each characteristic's advertised flags.

See [docs/PROTOCOL.md](docs/PROTOCOL.md).
