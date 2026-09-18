/**
 * Decides what to resend when the lamp did not end up where it was asked to.
 *
 * Only power is checked, because it is the only value with an unambiguous
 * outcome. The lamp ramps brightness towards a target, and trims it to suit the
 * room while auto brightness is on, so a reading that differs from the request
 * is usually the lamp working — indistinguishable from a dropped command, and
 * resending would fight it.
 *
 * Kept apart from the BLE session because being wrong here has physical
 * consequences: an earlier version compared brightness on an off lamp, which
 * reports zero lumens and so never matches, and the correction switched the
 * lamp back on.
 */

/** Both what was asked for and what the lamp reports; fields may be unknown. */
export interface LampValues {
  on?: boolean;
  /** 0-100 %. Carried for the log, never corrected. */
  brightness?: number;
  /** Kelvin. Carried for the log, never corrected. */
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
