/**
 * Decides what to resend when the lamp did not end up where it was asked to.
 *
 * Deliberately narrow. Checking every value cost more than it was worth: each
 * check is a read on a link that is not always there, and a mid-range
 * brightness that lands slightly off is something the user fixes with one
 * movement of the slider without ever noticing why.
 *
 * What does matter is the commands people rely on being certain: on, off, and
 * the two ends of the brightness range. A lamp that stays lit after being
 * switched off is the failure nobody can work around.
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
  /** Brightness difference, in percent, worth correcting at the extremes. */
  brightness: number;
}

export type Correction = { field: 'on'; value: boolean } | { field: 'brightness'; value: number };

/**
 * Whether a brightness is one people depend on landing exactly.
 *
 * Fully off and fully bright carry meaning that a value in between does not:
 * they are asked for deliberately, and getting them wrong is noticed.
 */
function isCritical(brightness: number): boolean {
  return brightness <= 0 || brightness >= 100;
}

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

  // Brightness only means anything on a lit lamp. An off lamp reports no
  // output, which would look like every command was lost, and correcting that
  // would switch it on.
  const shouldBeLit = wanted.on ?? actual.on ?? false;
  if (
    shouldBeLit &&
    wanted.brightness !== undefined &&
    actual.brightness !== undefined &&
    isCritical(wanted.brightness) &&
    Math.abs(wanted.brightness - actual.brightness) > tolerances.brightness
  ) {
    corrections.push({ field: 'brightness', value: wanted.brightness });
    missed.push(`brightness (wanted ${wanted.brightness}%, lamp is ${actual.brightness}%)`);
  }

  // Colour temperature is never checked: it is always mid-range by nature, and
  // a small error is invisible next to the cost of another read.
  return { corrections, missed };
}
