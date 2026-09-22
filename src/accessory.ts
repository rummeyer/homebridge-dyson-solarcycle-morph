import { describeError } from './errors.js';
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { parseTimeOfDay } from './config.js';
import type { ResolvedLightConfig } from './config.js';
import { DysonMorphLamp } from './dyson/lamp.js';
import { kelvinToMired, miredToKelvin, MAX_KELVIN, MIN_KELVIN, PRESETS } from './dyson/protocol.js';
import type { Preset } from './dyson/protocol.js';
import type { MorphPlatform } from './platform.js';

/**
 * How long a momentary switch stays on before springing back.
 *
 * Long enough that the Home app has drawn it as pressed, short enough that
 * nobody reads it as a state the lamp is in.
 */
const RELEASE_MS = 1_000;

/**
 * Every subtype this plugin has put a Switch service under.
 *
 * Needed to take them off the light accessory, where versions up to 1.0.2 put
 * them. A service on a cached accessory stays there until it is removed, so
 * without this they would show in both places at once.
 */
const SWITCH_SUBTYPES = ['daylight', 'auto', 'movement', ...Object.keys(PRESETS)];

/** The two accessories one lamp is made of. */
export interface MorphAccessories {
  /** The lamp itself, and nothing but the lamp. */
  light: PlatformAccessory;
  /** Every switch, on an accessory of its own. Absent when all are turned off. */
  switches?: PlatformAccessory;
}

/**
 * Bridges one lamp's BLE session to its HomeKit services.
 *
 * The lamp is two accessories: a light, and a box of switches beside it. One
 * BLE session drives both, which is the reason they are one class — the lamp
 * allows a single connection, so the switches cannot own one of their own.
 *
 * Writes are optimistic — HomeKit's 10-second characteristic timeout is shorter
 * than a BLE reconnect, so a command issued while the lamp is away would
 * otherwise surface as an error in the Home app. Instead we let the lamp's own
 * state events correct us once it comes back.
 */
export class MorphAccessory {
  private readonly lightbulb: Service;
  private daylight?: Service;
  private autoBrightness?: Service;
  private movement?: Service;
  private readonly presets = new Map<Preset, Service>();
  private readonly lamp: DysonMorphLamp;

  constructor(
    private readonly platform: MorphPlatform,
    accessories: MorphAccessories,
    private readonly config: ResolvedLightConfig,
  ) {
    const { Service, Characteristic } = this.platform.api.hap;

    this.lamp = new DysonMorphLamp({
      mac: config.mac,
      ltk: config.ltk,
      accountId: config.accountId,
      adapter: platform.config.adapter,
      // Both or neither: validation refuses half a location, so one of them
      // being present means the other is too.
      location:
        config.latitude !== undefined && config.longitude !== undefined
          ? { latitude: config.latitude, longitude: config.longitude }
          : undefined,
      // Both or neither again, and validation has already refused half a day,
      // so one of them being a time means the other is too.
      day:
        config.dayStart !== undefined && config.dayEnd !== undefined
          ? { start: parseTimeOfDay(config.dayStart)!, end: parseTimeOfDay(config.dayEnd)! }
          : undefined,
      // The switch only means anything next to a year, so the pair travels
      // together and defaults to on: setting a year and leaving the adjustment
      // off would be asking for nothing to happen.
      ageAdjust:
        config.yearOfBirth === undefined
          ? undefined
          : { yearOfBirth: config.yearOfBirth, enabled: config.ageAdjust !== false },
      log: platform.log,
    });

    this.describe(accessories.light, config.serial);
    if (accessories.switches) {
      // A serial of its own, so the two are not both claiming to be the same
      // piece of hardware.
      this.describe(accessories.switches, `${config.serial}-SWITCHES`);
    }

    // Removed in 1.0.0, but a service already on a cached accessory stays there
    // until it is taken off: not adding it any more is not the same as removing
    // it, and anyone who had it enabled would keep a sensor reading motion
    // forever.
    const staleMotion = accessories.light.getService(Service.MotionSensor);
    if (staleMotion) {
      accessories.light.removeService(staleMotion);
      this.platform.log.info(`Removed the motion sensor from ${config.name}; it never reported anything real`);
    }

    // The same applies to the switches, which sat here until 1.1.0.
    const moved = SWITCH_SUBTYPES.filter((subtype) => {
      const stale = accessories.light.getServiceById(Service.Switch, subtype);
      if (!stale) {
        return false;
      }
      accessories.light.removeService(stale);
      return true;
    }).length;
    if (moved > 0) {
      this.platform.log.info(
        `Took ${moved} switch${moved === 1 ? '' : 'es'} off ${config.name}; ` +
          `${moved === 1 ? 'it lives' : 'they live'} on their own accessory now`,
      );
    }

    this.lightbulb =
      accessories.light.getService(Service.Lightbulb) ?? accessories.light.addService(Service.Lightbulb, config.name);
    this.lightbulb.setCharacteristic(Characteristic.Name, config.name);

    this.lightbulb
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.live(() => this.lamp.getState().on))
      .onSet((value) => this.handleSet('power', () => this.lamp.setPower(value as boolean)));

    this.lightbulb
      .getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.live(() => this.lamp.getState().brightness))
      .onSet((value) => this.handleSet('brightness', () => this.lamp.setBrightness(value as number)));

    this.lightbulb
      .getCharacteristic(Characteristic.ColorTemperature)
      // HomeKit works in mireds, which run inverse to Kelvin.
      //
      // The value has to be brought inside the lamp's range before the range is
      // narrowed around it. A characteristic being created for the first time
      // starts at HAP's own default of 140 mireds — colder than this lamp goes —
      // and narrowing the bounds underneath it makes HAP object to a value it
      // picked itself. Setting it afterwards is too late; the complaint has
      // already been made. Only ever seen on a first run, because a restored
      // accessory brings a value that is already in range, which is why it hid
      // until the accessory cache was cleared.
      .updateValue(kelvinToMired(this.lamp.getState().kelvin))
      .setProps({ minValue: kelvinToMired(MAX_KELVIN), maxValue: kelvinToMired(MIN_KELVIN) })
      .onGet(() => this.live(() => kelvinToMired(this.lamp.getState().kelvin)))
      .onSet((value) => this.handleSet('colour temperature', () => this.lamp.setColorTemperature(miredToKelvin(value as number))));

    // Tell HomeKit the moment the link goes, rather than leaving it showing the
    // last value as though it were current.
    this.lamp.on('disconnected', () => this.markUnreachable());
    this.lamp.on('connected', () => {
      const state = this.lamp.getState();
      this.lightbulb.updateCharacteristic(Characteristic.On, state.on);
      this.lightbulb.updateCharacteristic(Characteristic.Brightness, state.brightness);
      this.lightbulb.updateCharacteristic(Characteristic.ColorTemperature, kelvinToMired(state.kelvin));
      this.daylight?.updateCharacteristic(Characteristic.On, state.daylight);
      this.autoBrightness?.updateCharacteristic(Characteristic.On, state.autoBrightness);
      this.movement?.updateCharacteristic(Characteristic.On, state.movement);
    });

    if (accessories.switches) {
      this.addSwitches(accessories.switches);
    }

    this.lamp.on('state', (state) => {
      this.lightbulb.updateCharacteristic(Characteristic.On, state.on);
      this.lightbulb.updateCharacteristic(Characteristic.Brightness, state.brightness);
      this.lightbulb.updateCharacteristic(Characteristic.ColorTemperature, kelvinToMired(state.kelvin));
      // Follows the lamp leaving daylight mode on its own, which it does as soon
      // as colour temperature is set by hand.
      this.daylight?.updateCharacteristic(Characteristic.On, state.daylight);
      this.autoBrightness?.updateCharacteristic(Characteristic.On, state.autoBrightness);
      this.movement?.updateCharacteristic(Characteristic.On, state.movement);
    });
  }

  /**
   * Put every enabled switch on the accessory that holds them.
   *
   * They were on the lamp's own accessory until 1.1.0, which left the Home app
   * showing the lamp as a stack of controls rather than as a light.
   */
  private addSwitches(accessory: PlatformAccessory): void {
    const { Service, Characteristic } = this.platform.api.hap;
    const wanted = new Set<string>();

    if (this.config.daylightSwitch !== false) {
      // A switch rather than a characteristic on the lightbulb: HomeKit renders
      // only the characteristics it knows, so a custom one would be invisible in
      // the Home app and reachable only from third-party clients.
      // By subtype, not by type: this accessory carries more than one Switch,
      // and a lookup by type alone would find whichever came first.
      this.daylight =
        accessory.getServiceById(Service.Switch, 'daylight') ??
        accessory.addService(Service.Switch, 'Daylight', 'daylight');
      wanted.add('daylight');
      this.name(accessory, this.daylight, 'Daylight');
      this.daylight
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.live(() => this.lamp.getState().daylight))
        // Reports the mode faithfully but cannot change it; see setDaylight.
        // The rejection is what makes the Home app put the switch back rather
        // than leave it showing a state the lamp is not in.
        .onSet((value) => this.handleSet('daylight mode', () => this.lamp.setDaylight(value as boolean)));
    }

    if (this.config.autoBrightnessSwitch !== false) {
      this.autoBrightness =
        accessory.getServiceById(Service.Switch, 'auto') ??
        accessory.addService(Service.Switch, 'Auto Brightness', 'auto');
      wanted.add('auto');
      this.name(accessory, this.autoBrightness, 'Auto Brightness');
      this.autoBrightness
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.live(() => this.lamp.getState().autoBrightness))
        .onSet((value) => this.handleSet('auto brightness', () => this.lamp.setAutoBrightness(value as boolean)));
    }

    if (this.config.movementSwitch !== false) {
      // Whether the lamp acts on what its sensor sees. Reading the sensor
      // itself is not possible; see docs/PROTOCOL.md.
      this.movement =
        accessory.getServiceById(Service.Switch, 'movement') ??
        accessory.addService(Service.Switch, 'Movement', 'movement');
      wanted.add('movement');
      this.name(accessory, this.movement, 'Movement');
      this.movement
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.live(() => this.lamp.getState().movement))
        .onSet((value) => this.handleSet('movement mode', () => this.lamp.setMovement(value as boolean)));
    }

    if (this.config.presetSwitches !== false) {
      // Momentary rather than stateful. The lamp does hold a preset and reports
      // which, but what these are for is applying a set of values — so pressing
      // one applies it and the switch springs back, the way a scene does.
      for (const preset of Object.keys(PRESETS) as Preset[]) {
        // "Preset" in the name, so a momentary one is not mistaken in a list
        // for the mode switches above it, which do hold a state.
        const label = `${preset[0]!.toUpperCase() + preset.slice(1)} Preset`;
        const service =
          accessory.getServiceById(Service.Switch, preset) ??
          accessory.addService(Service.Switch, label, preset);
        this.name(accessory, service, label);
        service
          .getCharacteristic(Characteristic.On)
          .onGet(() => false)
          .onSet(async (value) => {
            if (!value) {
              return;
            }
            await this.handleSet(`${label} preset`, () => this.lamp.setPreset(preset));
            this.release(service);
          });
        this.presets.set(preset, service);
        wanted.add(preset);
      }
    }

    // A switch turned off in the config has to come off the accessory, not
    // merely stop being added — the lesson of 1.0.1, where a service nobody
    // added any more stayed in the Home app for everyone who already had it.
    for (const subtype of SWITCH_SUBTYPES) {
      if (wanted.has(subtype)) {
        continue;
      }
      const unwanted = accessory.getServiceById(Service.Switch, subtype);
      if (unwanted) {
        accessory.removeService(unwanted);
        this.platform.log.info(`Removed the ${subtype} switch from ${this.config.name}; it is turned off in the config`);
      }
    }
  }

  async start(): Promise<void> {
    try {
      await this.lamp.start();
    } catch (error) {
      this.platform.log.error(`Could not start BLE session for ${this.config.name}: ${describeError(error)}`);
    }
  }

  async stop(): Promise<void> {
    await this.lamp.stop();
  }

  /**
   * Answer only while the lamp is actually reachable.
   *
   * Without this HomeKit keeps showing whatever was last known — a lamp that
   * has been unreachable for minutes still reads as on at 100%, which is worse
   * than saying nothing. Throwing a communication failure is how an accessory
   * reports itself as unavailable, and the Home app shows "No Response".
   */
  /**
   * Let a momentary switch spring back.
   *
   * HomeKit has no stateless switch that appears as one, so this is the usual
   * shape: report the press, then push the characteristic back to off shortly
   * after so it does not sit there claiming to be a state.
   */
  private release(service: Service): void {
    setTimeout(() => {
      service.updateCharacteristic(this.platform.api.hap.Characteristic.On, false);
    }, RELEASE_MS).unref();
  }

  /** Give an accessory its Dyson identity in the Home app's details. */
  private describe(accessory: PlatformAccessory, serial: string): void {
    const { Service, Characteristic } = this.platform.api.hap;
    (accessory.getService(Service.AccessoryInformation) ?? accessory.addService(Service.AccessoryInformation))
      .setCharacteristic(Characteristic.Manufacturer, 'Dyson')
      .setCharacteristic(Characteristic.Model, 'Solarcycle Morph')
      .setCharacteristic(Characteristic.SerialNumber, serial);
  }

  /**
   * Name a service so the Home app shows it, without undoing a rename.
   *
   * `Name` alone is not enough: Home reads `ConfiguredName`, and without it
   * every switch on an accessory shows under the accessory's own name — six
   * controls all called "Desk Light".
   *
   * The name is the plain label, "Daylight" rather than "Desk Daylight": these
   * sit on an accessory that is already named after the lamp, and the Home app
   * shows them under it, so repeating the lamp's name only made every switch
   * too long to read in a list.
   *
   * `ConfiguredName` is also what the Home app writes when someone renames a
   * switch, and Homebridge keeps that value in its accessory cache and restores
   * it on the next start. Writing it unconditionally therefore put the
   * generated name back every time Homebridge restarted, which is why a rename
   * never stuck. So it is written only while the switch still carries a name
   * this plugin generated, and left alone from the moment someone changes it.
   */
  private name(accessory: PlatformAccessory, service: Service, label: string): void {
    const { Characteristic } = this.platform.api.hap;
    const generated = (accessory.context.generatedNames ??= {}) as Record<string, string>;
    const key = service.subtype ?? label;

    // HAP does not count ConfiguredName among a Switch's optional
    // characteristics, so asking for one the service does not have yet warns
    // about it. Declaring it first keeps a first run quiet. The guard is not
    // decoration: declaring is a bare push that HAP also writes to the accessory
    // cache, so doing it on every restart would grow that file without end.
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    const current = service.getCharacteristic(Characteristic.ConfiguredName).value;

    service.setCharacteristic(Characteristic.Name, label);

    // Every name this plugin has ever generated for this switch. `label` is the
    // current scheme and the prefixed form is what 1.2.2 and earlier produced —
    // both have to count as "not renamed", or dropping the prefix would read as
    // a rename on every accessory upgrading from an older version and freeze
    // them all on the old names. A recorded name covers a lamp since renamed in
    // the config, whose switches carry neither form.
    const ours = new Set([label, `${this.config.name} ${label}`, generated[key]]);

    if (!current || ours.has(current as string)) {
      service.setCharacteristic(Characteristic.ConfiguredName, label);
      generated[key] = label;
      return;
    }

    // Keep the record in step, so a switch renamed by hand is not later mistaken
    // for one still carrying a name this plugin gave it.
    delete generated[key];
  }

  private live<T>(read: () => T): T {
    if (!this.lamp.isConnected()) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return read();
  }

  /** Push "No Response" to every characteristic at once. */
  private markUnreachable(): void {
    const { Characteristic } = this.platform.api.hap;
    const error = new Error(`${this.config.name} is not reachable over Bluetooth`);
    for (const characteristic of [Characteristic.On, Characteristic.Brightness, Characteristic.ColorTemperature]) {
      this.lightbulb.updateCharacteristic(characteristic, error);
    }
    this.daylight?.updateCharacteristic(Characteristic.On, error);
    this.autoBrightness?.updateCharacteristic(Characteristic.On, error);
    this.movement?.updateCharacteristic(Characteristic.On, error);
  }

  /**
   * Apply a write, reporting failure to HomeKit rather than swallowing it.
   *
   * A command that cannot be delivered is not retried later, so the Home app
   * has to say so — otherwise it shows the new value as though it had taken
   * effect and the user has no way to tell that nothing happened.
   */
  private async handleSet(what: string, apply: () => Promise<void>): Promise<CharacteristicValue | void> {
    try {
      await apply();
    } catch (error) {
      this.platform.log.warn(`Setting ${what} on ${this.config.name} failed: ${describeError(error)}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
}

