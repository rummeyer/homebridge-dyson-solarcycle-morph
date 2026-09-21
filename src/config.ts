import type { PlatformConfig } from 'homebridge';

/** One lamp, as configured in Homebridge's config.json. */
export interface LightConfig {
  /** Display name in HomeKit. */
  name: string;
  /** BLE MAC, e.g. `AA:BB:CC:DD:EE:FF`. */
  mac: string;
  /** Lamp serial. Used as the HomeKit accessory identity, so it must be stable. */
  serial: string;
  /**
   * Long-term key (hex). Normally absent: pairing stores it outside the config
   * so the key is not kept in a file the UI displays. Set it here only to
   * override the stored value, e.g. when migrating an existing setup.
   */
  ltk?: string;
  /** Dyson account GUID the LTK was issued to. Stored alongside the key. */
  accountId?: string;
  /**
   * Expose daylight tracking as a switch. On by default: it is the lamp's
   * defining feature and there is no other way to turn it back on from HomeKit
   * once setting a colour temperature has ended it.
   */
  daylightSwitch?: boolean;
  /**
   * Expose the lamp's "Auto" brightness as a switch. On by default: it is a
   * mode the lamp has and HomeKit would otherwise neither see nor reach.
   */
  autoBrightnessSwitch?: boolean;
  /** Expose movement-triggered lighting as a switch. On by default. */
  movementSwitch?: boolean;
  /**
   * Expose the lamp's preset modes as switches. On by default.
   */
  presetSwitches?: boolean;
  /**
   * Where the lamp is, in decimal degrees. Both or neither.
   *
   * The lamp works out sunrise and sunset from these, which is what daylight
   * tracking follows. The MyDyson app sets them from the phone's GPS when the
   * lamp is first configured, so an existing lamp already has them; these exist
   * to set them without the app, and to correct them after a move.
   */
  latitude?: number;
  longitude?: number;
  /**
   * Birth year of the main intended user, for the lamp's age adjustment.
   *
   * The lamp trims the brightness of its Study and Relax modes to suit older
   * eyes. It stores the year only — no day, no month — encrypted, and keeps it
   * to the Dyson account that set it. Leave this out and the plugin does not go
   * near the setting.
   */
  yearOfBirth?: number;
  /**
   * Whether the lamp applies the age adjustment. Only consulted when
   * {@link yearOfBirth} is set, and on by default when it is: a year with the
   * adjustment off does nothing at all.
   */
  ageAdjust?: boolean;
}

/** The oldest year the MyDyson app will offer, and so the oldest accepted here. */
export const EARLIEST_YEAR_OF_BIRTH = 1900;

/**
 * Whether any switch at all is wanted for this lamp.
 *
 * The switches live on an accessory of their own, so with every one of them
 * turned off there is nothing for that accessory to hold and it is not
 * registered at all.
 */
export function hasSwitches(light: LightConfig): boolean {
  return (
    light.daylightSwitch !== false ||
    light.autoBrightnessSwitch !== false ||
    light.movementSwitch !== false ||
    light.presetSwitches !== false
  );
}

/** A lamp whose credentials are known, from the config or the credential store. */
export type ResolvedLightConfig = LightConfig & { ltk: string; accountId: string };

/**
 * MyDyson credentials, owned by the settings page.
 *
 * The plugin itself never reads these: they exist so the settings page can
 * remember who to authorise as between visits. The password is only needed
 * while exchanging a code for a token, and the page offers to clear it after.
 */
export interface DysonAccountConfig {
  email?: string;
  password?: string;
  country?: string;
}

export interface MorphPlatformConfig extends PlatformConfig {
  /** Homebridge uses this as the log prefix for everything this plugin says. */
  name?: string;
  lights?: LightConfig[];
  dysonAccount?: DysonAccountConfig;
  /** HCI adapter to use, e.g. `hci0`. Defaults to the system default adapter. */
  adapter?: string;
}

/**
 * Validate one configured lamp.
 *
 * @returns A list of human-readable problems; empty means the entry is usable.
 */
export function validateLightConfig(light: Partial<LightConfig>, index: number): string[] {
  const problems: string[] = [];
  const where = `lights[${index}]`;

  if (!light.name?.trim()) {
    problems.push(`${where}.name is required`);
  }
  if (!light.mac || !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(light.mac)) {
    problems.push(`${where}.mac must look like AA:BB:CC:DD:EE:FF (got ${JSON.stringify(light.mac)})`);
  }
  if (!light.serial?.trim()) {
    problems.push(`${where}.serial is required`);
  }
  // Credentials are optional here — they normally come from the credential
  // store. Only validate what was actually supplied; a missing pair is reported
  // later, once the store has been consulted.
  if (light.ltk !== undefined && (!/^[0-9a-fA-F]+$/.test(light.ltk) || light.ltk.length % 2 !== 0)) {
    problems.push(`${where}.ltk must be an even-length hex string`);
  }
  if (light.accountId !== undefined && !/^[0-9a-fA-F-]{36}$/.test(light.accountId)) {
    problems.push(`${where}.accountId must be a Dyson account UUID`);
  }
  if ((light.ltk === undefined) !== (light.accountId === undefined)) {
    problems.push(`${where} sets only one of ltk/accountId — supply both to override the stored credentials, or neither`);
  }
  // A lamp told only its latitude would place itself on the Greenwich meridian
  // and track the wrong sunset all year, so half a location is refused rather
  // than half-applied.
  if ((light.latitude === undefined) !== (light.longitude === undefined)) {
    problems.push(`${where} sets only one of latitude/longitude — supply both, or neither`);
  }
  if (light.yearOfBirth !== undefined) {
    const thisYear = new Date().getFullYear();
    const year = light.yearOfBirth;
    if (!Number.isInteger(year) || year < EARLIEST_YEAR_OF_BIRTH || year > thisYear) {
      problems.push(
        `${where}.yearOfBirth must be a whole year between ${EARLIEST_YEAR_OF_BIRTH} and ${thisYear} ` +
          `(got ${JSON.stringify(light.yearOfBirth)})`,
      );
    }
  } else if (light.ageAdjust !== undefined) {
    problems.push(`${where} sets ageAdjust with no yearOfBirth — there is nothing to adjust for`);
  }
  for (const [field, limit] of [['latitude', 90], ['longitude', 180]] as const) {
    const value = light[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit)) {
      problems.push(`${where}.${field} must be a number between -${limit} and ${limit} (got ${JSON.stringify(value)})`);
    }
  }
  return problems;
}
