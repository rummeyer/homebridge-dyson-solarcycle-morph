import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
} from 'homebridge' with { 'resolution-mode': 'import' };

import { MorphAccessory } from './accessory.js';
import { validateLightConfig, type LightConfig, type MorphPlatformConfig } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * Registers one HomeKit accessory per configured lamp and owns their lifecycle.
 */
export class MorphPlatform implements DynamicPlatformPlugin {
  /** Accessories restored from Homebridge's cache, keyed by UUID. */
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly lamps: MorphAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: MorphPlatformConfig,
    public readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => this.discoverDevices());
    this.api.on('shutdown', () => {
      void Promise.all(this.lamps.map((lamp) => lamp.stop()));
    });
  }

  /** Homebridge replays cached accessories here before `didFinishLaunching`. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private discoverDevices(): void {
    const lights = this.config.lights ?? [];
    if (lights.length === 0) {
      this.log.warn('No lights configured — nothing to do. Add a "lights" entry to config.json.');
      return;
    }

    const configured = new Set<string>();

    lights.forEach((light, index) => {
      const problems = validateLightConfig(light, index);
      if (problems.length > 0) {
        for (const problem of problems) {
          this.log.error(`Ignoring invalid light config: ${problem}`);
        }
        return;
      }

      // Keyed on the serial so renaming a lamp does not orphan its accessory.
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${light.serial}`);
      configured.add(uuid);

      let accessory = this.cached.get(uuid);
      if (accessory) {
        accessory.displayName = light.name;
        accessory.context.light = light satisfies LightConfig;
        this.api.updatePlatformAccessories([accessory]);
        this.log.info(`Restoring ${light.name} (${light.mac})`);
      } else {
        accessory = new this.api.platformAccessory(light.name, uuid);
        accessory.context.light = light satisfies LightConfig;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Adding ${light.name} (${light.mac})`);
      }

      const lamp = new MorphAccessory(this, accessory, light);
      this.lamps.push(lamp);
      void lamp.start();
    });

    // Drop accessories whose lamp was removed from config.json.
    const stale = [...this.cached.entries()].filter(([uuid]) => !configured.has(uuid));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} accessory/accessories no longer in config`);
      this.api.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        stale.map(([, accessory]) => accessory),
      );
    }
  }
}
