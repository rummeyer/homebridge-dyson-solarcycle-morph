import { describeError } from './errors.js';
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { ResolvedLightConfig } from './config.js';
import { DysonMorphLamp } from './dyson/lamp.js';
import { kelvinToMired, miredToKelvin, MAX_KELVIN, MIN_KELVIN } from './dyson/protocol.js';
import type { MorphPlatform } from './platform.js';

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
  private readonly motion?: Service;
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
    });

    if (config.motionSensor) {
      this.motion =
        this.accessory.getService(Service.MotionSensor) ??
        this.accessory.addService(Service.MotionSensor, `${config.name} Motion`);
      this.motion
        .getCharacteristic(Characteristic.MotionDetected)
        .onGet(() => this.live(() => this.motion?.getCharacteristic(Characteristic.MotionDetected).value ?? false));
      this.lamp.on('motion', (detected) => {
        this.motion?.updateCharacteristic(Characteristic.MotionDetected, detected);
      });
    }

    this.lamp.on('state', (state) => {
      this.lightbulb.updateCharacteristic(Characteristic.On, state.on);
      this.lightbulb.updateCharacteristic(Characteristic.Brightness, state.brightness);
      this.lightbulb.updateCharacteristic(Characteristic.ColorTemperature, kelvinToMired(state.kelvin));
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
    this.motion?.updateCharacteristic(Characteristic.MotionDetected, error);
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

