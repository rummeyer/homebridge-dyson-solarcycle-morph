/**
 * Decides what to resend when the lamp did not end up where it was asked to.
 *
 * Deliberately narrow. Checking every value cost more than it was worth: each
 * check is a read on a link that is not always there, and a mid-range
 * brightness that lands slightly off is something the user fixes with one
 * movement of the slider without ever noticing why.
 *
 * What is left is power. It is the one command with an unambiguous outcome, and
 * a lamp that stays lit after being switched off is the failure nobody can work
 * around.
 *
 * Brightness cannot be checked at all on this lamp, not even at the extremes:
 * it tracks daylight by location and time, so asking for 100% and finding 88%
 * is the lamp working correctly. That is indistinguishable from a dropped
 * command, and resending would fight the adjustment the user wants.
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

export type Correction = { field: 'on'; value: boolean };

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
export function planReconciliation(wanted: LampValues, actual: LampValues): Plan {
  const corrections: Correction[] = [];
  const missed: string[] = [];

  if (wanted.on !== undefined && actual.on !== undefined && actual.on !== wanted.on) {
    corrections.push({ field: 'on', value: wanted.on });
    missed.push(`power (wanted ${wanted.on ? 'on' : 'off'}, lamp is ${actual.on ? 'on' : 'off'})`);
  }

  return { corrections, missed };
}
