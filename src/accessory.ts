import { describeError } from './errors.js';
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

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
 * Bridges one lamp's BLE session to its HomeKit services.
 *
 * Writes are optimistic — HomeKit's 10-second characteristic timeout is shorter
 * than a BLE reconnect, so a command issued while the lamp is away would
 * otherwise surface as an error in the Home app. Instead we let the lamp's own
 * state events correct us once it comes back.
 */
export class MorphAccessory {
  private readonly lightbulb: Service;
  private readonly daylight?: Service;
  private readonly autoBrightness?: Service;
  private readonly movement?: Service;
  private readonly presets = new Map<Preset, Service>();
  private readonly lamp: DysonMorphLamp;

  constructor(
    private readonly platform: MorphPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: ResolvedLightConfig,
  ) {
    const { Service, Characteristic } = this.platform.api.hap;

    this.lamp = new DysonMorphLamp({
      mac: config.mac,
      ltk: config.ltk,
      accountId: config.accountId,
      adapter: platform.config.adapter,
      log: platform.log,
    });

    (this.accessory.getService(Service.AccessoryInformation) ?? this.accessory.addService(Service.AccessoryInformation))
      .setCharacteristic(Characteristic.Manufacturer, 'Dyson')
      .setCharacteristic(Characteristic.Model, 'Solarcycle Morph')
      .setCharacteristic(Characteristic.SerialNumber, config.serial);

    // Removed in 1.0.0, but a service already on a cached accessory stays there
    // until it is taken off: not adding it any more is not the same as removing
    // it, and anyone who had it enabled would keep a sensor reading motion
    // forever.
    const staleMotion = this.accessory.getService(Service.MotionSensor);
    if (staleMotion) {
      this.accessory.removeService(staleMotion);
      this.platform.log.info(`Removed the motion sensor from ${config.name}; it never reported anything real`);
    }

    this.lightbulb =
      this.accessory.getService(Service.Lightbulb) ?? this.accessory.addService(Service.Lightbulb, config.name);
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

    if (config.daylightSwitch !== false) {
      // A switch rather than a characteristic on the lightbulb: HomeKit renders
      // only the characteristics it knows, so a custom one would be invisible in
      // the Home app and reachable only from third-party clients.
      // By subtype, not by type: this accessory carries more than one Switch,
      // and a lookup by type alone would find whichever came first.
      this.daylight =
        this.accessory.getServiceById(Service.Switch, 'daylight') ??
        this.accessory.addService(Service.Switch, `${config.name} Daylight`, 'daylight');
      this.name(this.daylight, 'Daylight');
      this.daylight
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.live(() => this.lamp.getState().daylight))
        // Reports the mode faithfully but cannot change it; see setDaylight.
        // The rejection is what makes the Home app put the switch back rather
        // than leave it showing a state the lamp is not in.
        .onSet((value) => this.handleSet('daylight mode', () => this.lamp.setDaylight(value as boolean)));
    }

    if (config.autoBrightnessSwitch !== false) {
      this.autoBrightness =
        this.accessory.getServiceById(Service.Switch, 'auto') ??
        this.accessory.addService(Service.Switch, `${config.name} Auto Brightness`, 'auto');
      this.name(this.autoBrightness, 'Auto Brightness');
      this.autoBrightness
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.live(() => this.lamp.getState().autoBrightness))
        .onSet((value) => this.handleSet('auto brightness', () => this.lamp.setAutoBrightness(value as boolean)));
    }

    if (config.movementSwitch !== false) {
      // Whether the lamp acts on what its sensor sees. Reading the sensor
      // itself is not possible; see docs/PROTOCOL.md.
      this.movement =
        this.accessory.getServiceById(Service.Switch, 'movement') ??
        this.accessory.addService(Service.Switch, `${config.name} Movement`, 'movement');
      this.name(this.movement, 'Movement');
      this.movement
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.live(() => this.lamp.getState().movement))
        .onSet((value) => this.handleSet('movement mode', () => this.lamp.setMovement(value as boolean)));
    }

    if (config.presetSwitches !== false) {
      // Momentary rather than stateful. The lamp does hold a preset and reports
      // which, but what these are for is applying a set of values — so pressing
      // one applies it and the switch springs back, the way a scene does.
      for (const preset of Object.keys(PRESETS) as Preset[]) {
        // "Preset" in the name, so a momentary one is not mistaken in a list
        // for the mode switches above it, which do hold a state.
        const label = `${preset[0]!.toUpperCase() + preset.slice(1)} Preset`;
        const service =
          this.accessory.getServiceById(Service.Switch, preset) ??
          this.accessory.addService(Service.Switch, `${config.name} ${label}`, preset);
        this.name(service, label);
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
      }
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

  /**
   * Name a service so the Home app shows it.
   *
   * `Name` alone is not enough: Home reads `ConfiguredName`, and without it
   * every switch on an accessory shows under the accessory's own name — six
   * controls all called "Desk Light".
   */
  private name(service: Service, label: string): void {
    const { Characteristic } = this.platform.api.hap;
    const full = `${this.config.name} ${label}`;
    service.setCharacteristic(Characteristic.Name, full);
    service.setCharacteristic(Characteristic.ConfiguredName, full);
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

