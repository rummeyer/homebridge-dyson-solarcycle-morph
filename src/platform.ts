import { describeError } from './errors.js';
import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  MatterAccessory,
  PlatformAccessory,
} from 'homebridge';

import { MorphAccessory } from './accessory.js';
import { hasSwitches, validateLightConfig, type LightConfig, type MorphPlatformConfig, type ResolvedLightConfig } from './config.js';
import { CredentialStore } from './dyson/credentials.js';
import { matterKey } from './matter.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * Registers each configured lamp's HomeKit accessories and owns their lifecycle.
 *
 * A lamp is two accessories: the light itself, and a second one carrying every
 * switch. Keeping them apart is what lets the Home app draw the lamp as a light
 * you tap to turn on, rather than a folder of six controls.
 */
export class MorphPlatform implements DynamicPlatformPlugin {
  /** Accessories restored from Homebridge's cache, keyed by UUID. */
  private readonly cached = new Map<string, PlatformAccessory>();
  /** Matter accessories restored from Homebridge's cache, keyed by UUID. */
  private readonly cachedMatter = new Map<string, MatterAccessory>();
  private readonly lamps: MorphAccessory[] = [];
  readonly credentials: CredentialStore;

  constructor(
    public readonly log: Logger,
    public readonly config: MorphPlatformConfig,
    public readonly api: API,
  ) {
    this.credentials = new CredentialStore(api.user.storagePath(), PLUGIN_NAME);
    this.api.on('didFinishLaunching', () => void this.discoverDevices());
    this.api.on('shutdown', () => {
      void Promise.all(this.lamps.map((lamp) => lamp.stop()));
    });
  }

  /** Homebridge replays cached accessories here before `didFinishLaunching`. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  /** The same for Matter accessories, on a bridge that has Matter turned on. */
  configureMatterAccessory(accessory: MatterAccessory): void {
    this.cachedMatter.set(accessory.UUID, accessory);
  }

  /**
   * Whether this bridge publishes over Matter.
   *
   * Only Homebridge 2 knows Matter at all, and only for a bridge where it has
   * been turned on, so both are asked before anything relies on it.
   */
  private matterEnabled(): boolean {
    return typeof this.api.isMatterEnabled === 'function' && this.api.isMatterEnabled() && this.api.matter !== undefined;
  }

  private async discoverDevices(): Promise<void> {
    const lights = this.config.lights ?? [];
    if (lights.length === 0) {
      this.log.warn('No lights configured — nothing to do. Add a "lights" entry to config.json.');
      return;
    }

    const configured = new Set<string>();
    const configuredMatter = new Set<string>();

    for (const [index, light] of lights.entries()) {
      const problems = validateLightConfig(light, index);
      if (problems.length > 0) {
        for (const problem of problems) {
          this.log.error(`Ignoring invalid light config: ${problem}`);
        }
        continue;
      }

      const resolved = await this.resolveCredentials(light);
      if (!resolved) {
        continue;
      }

      // Asked for but not possible falls back to HAP, so the light does not
      // vanish from the Home app because a setting elsewhere is missing.
      const onMatter = light.matter === true && this.matterEnabled();
      if (light.matter === true && !onMatter) {
        this.log.warn(
          `${light.name} is set to use Matter, but Matter is not turned on for this bridge, so it stays on HomeKit. ` +
            "Turn Matter on in this plugin's bridge settings in the Homebridge UI (Homebridge 2 needed), then restart.",
        );
      }

      // Keyed on the serial so renaming a lamp does not orphan its accessory.
      // The light keeps the key it has always had, so an existing accessory —
      // and every automation and room already pointing at it — survives.
      // On Matter it is not adopted, and so pruned below like any other.
      const lightAccessory = onMatter ? undefined : this.adopt(`${PLUGIN_NAME}:${light.serial}`, light.name, light);
      if (lightAccessory) {
        configured.add(lightAccessory.UUID);
      }

      const switchAccessory = hasSwitches(light)
        ? this.adopt(`${PLUGIN_NAME}:${light.serial}:switches`, `${light.name} Switches`, light)
        : undefined;
      if (switchAccessory) {
        configured.add(switchAccessory.UUID);
      }

      const lamp = new MorphAccessory(this, { light: lightAccessory, switches: switchAccessory }, resolved);
      this.lamps.push(lamp);
      if (onMatter) {
        configuredMatter.add(this.api.matter!.uuid.generate(matterKey(light.serial)));
      }

      // Setting the accessories up writes to their context — which names the
      // switches carry the ones this plugin generated, so a rename in the Home
      // app can be told apart from one it put there itself. That only survives
      // a restart if Homebridge is asked to save it.
      this.api.updatePlatformAccessories(
        [lightAccessory, switchAccessory].filter((accessory) => accessory !== undefined),
      );

      void lamp.start();
    }

    this.pruneStaleAccessories(configured);
    this.pruneStaleMatterAccessories(configuredMatter);
  }

  /**
   * Restore an accessory from Homebridge's cache, or register a new one.
   *
   * @param key Stable identity for this accessory; the UUID is derived from it.
   */
  private adopt(key: string, name: string, light: LightConfig): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(key);

    const cached = this.cached.get(uuid);
    if (cached) {
      cached.displayName = name;
      cached.context.light = light satisfies LightConfig;
      this.api.updatePlatformAccessories([cached]);
      this.log.info(`Restoring ${name} (${light.mac})`);
      return cached;
    }

    const accessory = new this.api.platformAccessory(name, uuid);
    accessory.context.light = light satisfies LightConfig;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.log.info(`Adding ${name} (${light.mac})`);
    return accessory;
  }

  /**
   * Fill in a lamp's credentials from the store when the config omits them.
   *
   * Config wins when it supplies both, so an existing setup keeps working and
   * an override is always possible; otherwise the pairing done in the custom UI
   * is what counts.
   */
  private async resolveCredentials(light: LightConfig): Promise<ResolvedLightConfig | undefined> {
    if (light.ltk && light.accountId) {
      return { ...light, ltk: light.ltk, accountId: light.accountId };
    }
    try {
      const stored = await this.credentials.get(light.serial);
      if (stored) {
        return { ...light, ltk: stored.ltk, accountId: stored.accountId };
      }
    } catch (error) {
      this.log.error(`Could not read stored credentials for ${light.name}: ${describeError(error)}`);
      return undefined;
    }
    this.log.error(
      `${light.name} (${light.serial}) is not paired yet. Open this plugin's settings in the ` +
        'Homebridge UI and authorise your MyDyson account there.',
    );
    return undefined;
  }

  private pruneStaleAccessories(configured: Set<string>): void {
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

  /** Drop Matter lights whose lamp was removed, or moved back to HomeKit. */
  private pruneStaleMatterAccessories(configured: Set<string>): void {
    const stale = [...this.cachedMatter.values()].filter(({ UUID }) => !configured.has(UUID));
    if (stale.length === 0 || !this.api.matter) {
      return;
    }
    this.log.info(`Removing ${stale.length} Matter accessory/accessories no longer in config`);
    void this.api.matter
      .unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
      .catch((error: unknown) => this.log.warn(`Could not remove stale Matter accessories: ${describeError(error)}`));
  }
}
