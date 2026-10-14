import { describeError } from './errors.js';
import type { API, Logger, MatterAccessory } from 'homebridge';

import type { ResolvedLightConfig } from './config.js';
import type { DysonMorphLamp, LampState } from './dyson/lamp.js';
import { estimateWatts } from './dyson/power.js';
import { kelvinToMired, miredToKelvin, MAX_KELVIN, MIN_KELVIN } from './dyson/protocol.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/** Matter's brightness runs 1-254; HomeKit's, and the lamp's here, 0-100 %. */
const MAX_LEVEL = 254;

export const levelToPercent = (level: number): number =>
  Math.round((Math.min(MAX_LEVEL, Math.max(0, level)) / MAX_LEVEL) * 100);

export const percentToLevel = (percent: number): number =>
  Math.max(1, Math.round((Math.min(100, Math.max(0, percent)) / 100) * MAX_LEVEL));

/** The identity of a lamp's Matter light, kept apart from its HAP accessory's. */
export const matterKey = (serial: string): string => `${PLUGIN_NAME}:${serial}:matter`;

/**
 * The light of one lamp, published over Matter instead of HAP.
 *
 * Matter for one reason: it is the only way the Home app shows a light's power
 * draw. HAP has no characteristic for it that Home displays, while a Matter
 * light carrying Electrical Power Measurement has its watts shown in its
 * settings (not on the tile). Checked on a test bridge on 2026-10-14. The
 * switches stay on HAP, since Matter has no plain switch the Home app shows as
 * one: an outlet stays an outlet, and a light switch does not appear at all.
 *
 * Writes go to the lamp the same way as from the HAP light, and the lamp's own
 * reports are pushed back, as are the watts worked out from them.
 */
export class MatterLight {
  private readonly uuid: string;
  private registered = false;
  /** What was last pushed, by cluster, so an unchanged value is not sent again. */
  private readonly sent = new Map<string, string>();

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly config: ResolvedLightConfig,
    private readonly lamp: DysonMorphLamp,
  ) {
    this.uuid = api.matter!.uuid.generate(matterKey(config.serial));
  }

  get UUID(): string {
    return this.uuid;
  }

  async register(): Promise<void> {
    const matter = this.api.matter!;
    const state = this.lamp.getState();
    const accessory: MatterAccessory = {
      UUID: this.uuid,
      displayName: this.config.name,
      deviceType: matter.deviceTypes.ColorTemperatureLight,
      serialNumber: this.config.serial,
      manufacturer: 'Dyson',
      model: 'Solarcycle Morph',
      context: {},
      clusters: {
        onOff: { onOff: state.on },
        levelControl: { currentLevel: percentToLevel(state.brightness), minLevel: 1, maxLevel: MAX_LEVEL },
        // Typed loosely on purpose: every one of these is mandatory for colour
        // temperature, and registration fails naming the first one missing, but
        // Homebridge's type knows only some of them and gives the bitmaps as
        // numbers where matter.js wants objects.
        colorControl: {
          colorMode: 2,
          enhancedColorMode: 2,
          options: {},
          numberOfPrimaries: 0,
          colorCapabilities: { colorTemperature: true },
          colorTemperatureMireds: kelvinToMired(state.kelvin),
          colorTempPhysicalMinMireds: kelvinToMired(MAX_KELVIN),
          colorTempPhysicalMaxMireds: kelvinToMired(MIN_KELVIN),
          coupleColorTempToLevelMinMireds: kelvinToMired(MAX_KELVIN),
          startUpColorTemperatureMireds: null,
        } as Record<string, unknown>,
        // Always present, since a device's clusters are fixed once registered
        // and the lamp says what model it is only once it has connected. Null
        // is Matter's "not measured", which is what a model without a table
        // keeps.
        electricalPowerMeasurement: { activePower: this.milliwatts(state) },
      },
      handlers: {
        onOff: {
          on: () => this.apply('power', () => this.lamp.setPower(true)),
          off: () => this.apply('power', () => this.lamp.setPower(false)),
          toggle: () => this.apply('power', () => this.lamp.setPower(!this.lamp.getState().on)),
        },
        levelControl: {
          moveToLevel: (request) => this.apply('brightness', () => this.lamp.setBrightness(levelToPercent(request.level))),
          // What the Home app sends from the slider: the level, lighting the
          // lamp first if it is off.
          moveToLevelWithOnOff: (request) =>
            this.apply('brightness', async () => {
              if (request.level === 0) {
                await this.lamp.setPower(false);
                return;
              }
              if (!this.lamp.getState().on) {
                await this.lamp.setPower(true);
              }
              await this.lamp.setBrightness(levelToPercent(request.level));
            }),
        },
        colorControl: {
          moveToColorTemperatureLogic: (request) =>
            this.apply('colour temperature', () =>
              this.lamp.setColorTemperature(miredToKelvin(request.colorTemperatureMireds)),
            ),
        },
      },
    };
    await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.registered = true;
  }

  /** Push the lamp's state, and the watts that go with it. */
  update(state: Readonly<LampState>): void {
    void this.push('onOff', { onOff: state.on });
    void this.push('levelControl', { currentLevel: percentToLevel(state.brightness) });
    void this.push('colorControl', { colorTemperatureMireds: kelvinToMired(state.kelvin) });
    void this.push('electricalPowerMeasurement', { activePower: this.milliwatts(state) });
  }

  /**
   * Say whether the lamp can be reached.
   *
   * A bridged Matter device has `reachable` for this, which is the closest
   * Matter comes to HAP's "No Response". The watts go to "not measured" with
   * it, since a lamp out of reach may as well be unplugged.
   */
  setReachable(reachable: boolean): void {
    void this.push('bridgedDeviceBasicInformation', { reachable });
    if (!reachable) {
      void this.push('electricalPowerMeasurement', { activePower: null });
    }
  }

  private milliwatts(state: Readonly<LampState>): number | null {
    const watts = estimateWatts(this.lamp.getProductInfo()?.productType, state);
    return watts === undefined ? null : Math.round(watts * 1000);
  }

  private async push(cluster: string, attributes: Record<string, unknown>): Promise<void> {
    if (!this.registered) {
      return;
    }
    const key = JSON.stringify(attributes);
    if (this.sent.get(cluster) === key) {
      return;
    }
    this.sent.set(cluster, key);
    try {
      await this.api.matter!.updateAccessoryState(this.uuid, cluster, attributes);
    } catch (error) {
      this.sent.delete(cluster);
      this.log.debug(`Could not update ${cluster} of ${this.config.name} over Matter: ${describeError(error)}`);
    }
  }

  /** Apply a command, logging a failure and passing it on so the controller hears of it. */
  private async apply(what: string, command: () => Promise<void>): Promise<void> {
    try {
      await command();
    } catch (error) {
      this.log.warn(`Setting ${what} on ${this.config.name} failed: ${describeError(error)}`);
      throw error;
    }
  }
}
