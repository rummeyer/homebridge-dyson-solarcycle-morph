# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The lamp's Auto and movement switches reach HomeKit.** Auto brightness, where
  the lamp trims its own output to keep the room level, and movement mode, where
  it lights on movement and goes out once the room is still, are both switches
  now. They show the true state and follow the buttons on the lamp itself. Turn
  either off per light with `autoBrightnessSwitch` and `movementSwitch`.

## [0.3.0] — 2026-09-18

### Added

- Daylight tracking is a switch. It reports what the lamp is actually doing,
  following the button on the lamp's base and the MyDyson app as well as
  HomeKit, and it can be turned on and off. Setting a colour temperature ends
  the tracking, which is the lamp's own behaviour, and the switch follows that
  too. Turn it off per light with `daylightSwitch`.

### Fixed

- A write arriving immediately behind another was discarded, silently. HomeKit
  sets brightness and colour temperature together whenever a scene is applied,
  and the second of the two was being lost: on a CF06, colour temperature
  reached its target in 1 of 8 attempts written back to back, and 8 of 8 when
  spaced 100 ms apart. Control writes are now paced.
- The lamp is no longer taken out of daylight mode before every brightness and
  colour-temperature write. It never needed to be — values land while the lamp
  is tracking — and the write that was supposed to do it was never a valid
  command in the first place. Brightness changes now leave daylight tracking
  running; colour-temperature changes still end it, which is the lamp's doing.

## [0.2.2] — 2026-09-17

### Added

- The log carries signal strength: on the line reported when the lamp connects,
  once a minute as an average with its range, and on the line reported when a
  connection drops. The **range** is what shows interference — a lamp that is
  not moving cannot swing by 20 dB on its own — while the average only says
  whether it is too far away.
- Connecting on a later attempt is reported, since repeated attempts mean
  collisions where connections are established.

### Fixed

- A lamp switched on at the device itself now reaches HomeKit. Subscribing to a
  characteristic fails intermittently, which was caught and ignored, leaving
  that value silent for the rest of the session. Subscriptions are retried, a
  failure that sticks is warned about, and a slow poll backs them up.

### Changed

- The README is written for someone setting the plugin up, rather than for
  someone reading the source.

## [0.2.1] — 2026-09-17

### Changed

- The settings page shows the auth code field alongside the request and submit
  buttons, rather than revealing it once a code has been requested. Someone who
  already has a code in their inbox can type it straight in, and the step no
  longer looks incomplete.
- Clearing the password no longer prints a notice explaining that the field is
  now empty, next to the field that is now empty.

## [0.2.0] — 2026-09-17

Identical in content to 0.1.0. Published from CI rather than from a developer's
machine, which is the point of it: it exercises the release path end to end so
the first version that matters is not also the first time it runs.

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
- Reconnect with backoff, state followed through notifications, and the lamp
  reported as unreachable in HomeKit while there is no link.
- Power commands are checked and resent if they did not land. Brightness and
  colour temperature are not: the lamp ramps and trims them itself, so a reading
  that differs from the request is usually the lamp working.

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
