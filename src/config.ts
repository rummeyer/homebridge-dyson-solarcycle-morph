import type { PlatformConfig } from 'homebridge' with { 'resolution-mode': 'import' };

/** One lamp, as configured in Homebridge's config.json. */
export interface LightConfig {
  /** Display name in HomeKit. */
  name: string;
  /** BLE MAC, e.g. `AA:BB:CC:DD:EE:FF`. */
  mac: string;
  /** Lamp serial. Used as the HomeKit accessory identity, so it must be stable. */
  serial: string;
  /** Long-term key (hex) from `dyson-morph-pair`. */
  ltk: string;
  /** Dyson account GUID the LTK was issued to. */
  accountId: string;
  /** Expose the built-in motion sensor as a separate HomeKit service. */
  motionSensor?: boolean;
}

export interface MorphPlatformConfig extends PlatformConfig {
  lights?: LightConfig[];
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
  if (!light.ltk || !/^[0-9a-fA-F]+$/.test(light.ltk) || light.ltk.length % 2 !== 0) {
    problems.push(`${where}.ltk must be an even-length hex string — run dyson-morph-pair to obtain it`);
  }
  if (!light.accountId || !/^[0-9a-fA-F-]{36}$/.test(light.accountId)) {
    problems.push(`${where}.accountId must be a Dyson account UUID — run dyson-morph-pair to obtain it`);
  }
  return problems;
}
