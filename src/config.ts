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
  /** Expose the built-in motion sensor as a separate HomeKit service. */
  motionSensor?: boolean;
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
  return problems;
}
