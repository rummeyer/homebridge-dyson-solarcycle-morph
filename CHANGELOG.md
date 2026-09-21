# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] — 2026-09-21

### Changed

- **A PayPal funding link alongside GitHub Sponsors**, in `package.json` where
  npm and the Homebridge UI read it, and in `.github/FUNDING.yml` for the
  Sponsor button on the repository page. No behaviour changes.

## [1.3.0] — 2026-09-21

### Changed

- **The switches are named for what they do, without the lamp's name in front.**
  "Daylight" and "Auto Brightness" rather than "Desk Daylight" and "Desk Auto
  Brightness". They sit on an accessory already named after the lamp and the
  Home app shows them underneath it, so the prefix only repeated what was on
  the row above and pushed the part that distinguishes them out of view. A
  switch still carrying its old name is moved to the new one on the next start;
  a switch renamed by hand keeps the name it was given.

### Fixed

- **A first run no longer complains about the colour temperature.** Homebridge
  logged `supplied illegal value: number 140 exceeded minimum of 154` with a
  stack trace behind it. A colour temperature characteristic starts life at
  HAP's own default of 140 mireds, which is colder than this lamp goes, so
  narrowing the range around it left HAP objecting to a value it had picked
  itself. It is now given a value the lamp supports before the range is
  narrowed. Nothing was broken by it — HAP clamped the value — but it only ever
  appeared on a brand new install, because an accessory restored from the cache
  brings a value that is already in range.

- **A first run no longer warns once per switch about `ConfiguredName`.** HAP
  does not list it among the optional characteristics of a switch, so the plugin
  now says it is using it before it does. Same story: visible only when the
  switches are created rather than restored.

- **Renaming a switch in the Home app sticks.** The six switches are named when
  the plugin starts, and that name was written every single time — including
  over a name someone had given a switch themselves, which Homebridge had
  faithfully saved and restored. So a rename lasted until the next restart of
  the bridge and then quietly went back. The generated name is now written only
  while a switch still carries one, and a switch renamed in the Home app keeps
  its name from then on.

## [1.2.2] — 2026-09-21

### Fixed

- **The settings schema declares its required fields the way JSON Schema
  defines it.** `"required": true` sat on the individual fields, which the
  Homebridge UI has always accepted but which is not what the keyword means:
  in JSON Schema `required` belongs on the enclosing object and lists the names
  of the properties it requires. The plugin name is now listed on the schema
  itself, and a light's name, MAC address and serial on the light object. The
  same fields are required as before.

## [1.2.1] — 2026-09-21

### Changed

- **The two development probes under `tools/` are no longer published to npm.**
  They are scripts for poking at a lamp over Bluetooth during development, they
  are documented nowhere a user would look, and nothing in the plugin calls
  them. Shipping them only meant that a scan of the installed package found two
  environment variables being read — `DYSON_PLUGIN_DIR` and `DYSON_PERSIST_DIR`,
  both of them path overrides for running a probe against a checkout — with no
  context explaining why. They stay in the repository, where they belong.

## [1.2.0] — 2026-09-21

### Added

- **Homebridge 1.8 and later is supported**, alongside 2.x. Nothing in the
  plugin ever needed 2.x: it uses Lightbulb, Switch and their characteristics,
  all of which HAP-NodeJS has carried since long before the 1.8 line, and the
  whole source typechecks against Homebridge 1.11 without a single change.
  Requiring 2.0 was simply where development started, and it shut out everyone
  who has not migrated their bridge yet. A CI job now compiles against 1.x on
  every push, so the support is checked rather than claimed.
- The `supports-hap` keyword, which is how the Homebridge UI learns that this
  plugin publishes its accessories over HomeKit rather than Matter.

## [1.1.2] — 2026-09-21

### Changed

- **Reconnect attempts no longer thin out past a minute.** The backoff ran
  2s, 5s, 15s, 30s, 60s, 2min, 5min, so a lamp that came back during a five
  minute gap stayed missing from the Home app for the rest of it. The tail is
  gone: the gap grows to a minute and stays there. The long waits were there to
  give a lamp with a stuck Bluetooth stack some quiet, but that state only
  clears by pulling its power — no retry interval fixes it, while the slow
  notice affects every ordinary drop.

## [1.1.1] — 2026-09-19

### Fixed

- **The state line in the log now names every mode the lamp is in**, not just
  daylight tracking. A line is written when the state changes, so a mode missing
  from it produced a line identical to the one before — turning auto brightness
  or movement on read as a stray repeat rather than as the change it was, and
  hid exactly the switch someone was trying to watch. Auto brightness, movement
  and the active preset are named alongside daylight now.

## [1.1.0] — 2026-09-19

### Changed

- **A lamp is now two accessories: the light, and its switches beside it.** The
  light carries nothing but on/off, brightness and colour temperature, so the
  Home app draws it as a light you tap to turn on rather than as a folder of six
  controls. Everything that is a switch — Daylight, Auto Brightness, Movement
  and the three presets — moves to a second accessory called `<name> Switches`.

  The lamp keeps the identity it had, so its room, its name and every automation
  and scene pointing at the light itself survive. **Automations and scenes that
  used one of the switches have to be pointed at the new accessory**, which the
  Home app cannot do for you: to it, the old switch is simply gone.

  With all four switch settings turned off there is nothing for the second
  accessory to hold, so it is not created at all, and one left over from an
  earlier run is removed.

### Fixed

- A switch turned off in the settings is now taken off the accessory rather than
  merely no longer added, so it stops showing in the Home app. This was the same
  mistake 1.0.1 fixed for the motion sensor.

## [1.0.2] — 2026-09-18

### Changed

- The package calls the lamp a desk light, which is Dyson's own name for it,
  rather than a task light. This is the line npm and the Homebridge plugin
  search show.
- The README carries the lamp's icon.

## [1.0.1] — 2026-09-18

### Fixed

- The motion sensor removed in 1.0.0 stayed in the Home app for anyone who had
  it enabled. Not adding a service is not the same as removing one: it was
  already on the accessory, so it remained there, still reporting motion
  permanently. It is now taken off explicitly.

## [1.0.0] — 2026-09-18

Everything the lamp will tell us over Bluetooth is now in HomeKit, and the
protocol behind it is written down rather than inherited. Stable enough to call
it that.

### Added

- **The lamp's preset modes, as switches.** Study, Relax and Precision apply a
  set of values and spring back, the way a scene does. Turn them off per light
  with `presetSwitches`.

### Removed

- **The motion sensor.** It reported motion permanently. The characteristic it
  read holds a constant on this lamp — it never changed across the lamp being
  on, off, and movement mode being switched either way — so there was nothing
  behind it, and anything automated on it would have fired forever. The lamp's
  movement mode, which is what most people want it for, is a switch and works.

### Fixed

- Every switch showed in the Home app under the accessory's own name, so a lamp
  with three of them had three controls all called the same thing. They now
  carry their own names.

## [0.4.0] — 2026-09-18

### Added

- **The lamp's Auto and movement switches reach HomeKit.** Auto brightness, where
  the lamp trims its own output to keep the room level, and movement mode, where
  it lights on movement and goes out once the room is still, are both switches
  now. They show the true state and follow the buttons on the lamp itself. Turn
  either off per light with `autoBrightnessSwitch` and `movementSwitch`.

### Changed

- The README lists the three mode switches in one place, with the settings that
  turn each off and how the Movement switch differs from the motion sensor.

### Fixed

- The notes said the lamp trimmed brightness to track daylight from its location
  and the time of day. Daylight mode moves colour temperature; what moves
  brightness is auto brightness and the ramp towards a newly written value.

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
