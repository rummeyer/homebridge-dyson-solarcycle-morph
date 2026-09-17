# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-17

First release. Verified end to end against a Solarcycle Morph desk light
(model CD06) on Raspberry Pi OS Bookworm, BlueZ 5.66, Homebridge 2.4.

### Added

- HomeKit lightbulb with on/off, brightness and colour temperature (2700–6500 K).
- Optional motion sensor from the lamp's built-in detector.
- Offline LTK re-authentication, run on every connect. No network access after
  pairing.
- `dyson-morph-pair`, a one-time CLI that logs in to the Dyson cloud and fetches
  the lamp's long-term key.
- `tools/ble-probe.js`, a standalone GATT dump for inspecting a lamp without
  installing the plugin.
- Reconnect with backoff, and a keepalive poll that keeps the BLE link up.

### Notes on the protocol

Probing real hardware contradicted the published protocol notes in two places,
both handled here rather than assumed away:

- Characteristics are spread across three GATT services, not gathered under one.
  Discovery sweeps every service and matches on characteristic UUID.
- Acknowledged writes are described as mandatory, but this lamp advertises no
  `write` flag at all and unacknowledged writes do take effect. The write mode
  is taken from each characteristic's advertised flags.

See [docs/PROTOCOL.md](docs/PROTOCOL.md).
