/**
 * Decides what to resend when the lamp did not end up where it was asked to.
 *
 * Separated from the BLE session because getting it wrong has physical
 * consequences: an earlier version compared brightness while the lamp was off,
 * where it reports zero lumens and so can never match — and writing brightness
 * switches the lamp back on, undoing the command the user had just given.
 */

/** Both what was asked for and what the lamp reports; fields may be unknown. */
export interface LampValues {
  on?: boolean;
  /** 0-100 %. */
  brightness?: number;
  kelvin?: number;
}

export interface Tolerances {
  /** Brightness difference, in percent, worth correcting. */
  brightness: number;
  /** Colour temperature difference, in Kelvin, worth correcting. */
  kelvin: number;
}

export type Correction =
  | { field: 'on'; value: boolean }
  | { field: 'brightness'; value: number }
  | { field: 'kelvin'; value: number };

export interface Plan {
  corrections: Correction[];
  /** Human-readable reasons, for the log. */
  missed: string[];
}

/**
 * Work out which values to resend.
 *
 * @param wanted What the user last asked for. Unknown fields are left alone.
 * @param actual What the lamp reports.
 */
export function planReconciliation(wanted: LampValues, actual: LampValues, tolerances: Tolerances): Plan {
  const corrections: Correction[] = [];
  const missed: string[] = [];

  if (wanted.on !== undefined && actual.on !== undefined && actual.on !== wanted.on) {
    corrections.push({ field: 'on', value: wanted.on });
    missed.push(`power (wanted ${wanted.on ? 'on' : 'off'}, lamp is ${actual.on ? 'on' : 'off'})`);
  }

  // Brightness and colour temperature only mean anything on a lit lamp. An off
  // lamp reports no output, which would look like every command was lost, and
  // correcting that would switch it on.
  const shouldBeLit = wanted.on ?? actual.on ?? false;
  if (!shouldBeLit) {
    return { corrections, missed };
  }

  if (
    wanted.brightness !== undefined &&
    actual.brightness !== undefined &&
    Math.abs(wanted.brightness - actual.brightness) > tolerances.brightness
  ) {
    corrections.push({ field: 'brightness', value: wanted.brightness });
    missed.push(`brightness (wanted ${wanted.brightness}%, lamp is ${actual.brightness}%)`);
  }

  if (
    wanted.kelvin !== undefined &&
    actual.kelvin !== undefined &&
    Math.abs(wanted.kelvin - actual.kelvin) > tolerances.kelvin
  ) {
    corrections.push({ field: 'kelvin', value: wanted.kelvin });
    missed.push(`colour temperature (wanted ${wanted.kelvin}K, lamp is ${actual.kelvin}K)`);
  }

  return { corrections, missed };
}
