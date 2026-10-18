/**
 * Keeps settings made to an off lamp, until it is switched on.
 *
 * Daylight tracking, auto brightness and movement mode are only taken by a lamp
 * that is lit. Written to one that is off they are dropped without a word, and
 * the lamp goes on reporting the old value — so a switch flipped in the Home
 * app springs back a moment later, which reads as the plugin having failed.
 *
 * The colour temperature is the opposite case: an off lamp takes it, and
 * switches itself on to show it. Adaptive Lighting in the Home app sends one
 * every few minutes, lamp on or off, so written straight away it would light
 * the lamp again and again, unasked.
 *
 * So a change made while the lamp is off is kept here rather than written. The
 * Home app shows what was asked for, what the lamp says about that setting is
 * disregarded while it can only contradict it, and the value goes out for real
 * the moment the lamp lights.
 *
 * Deliberately not written down anywhere: a restarted plugin takes its state
 * from the lamp, which is the only thing that knows what it is really doing.
 */

/** What an off lamp will not take as it should, and what each is. */
export interface HeldValues {
  daylight: boolean;
  autoBrightness: boolean;
  movement: boolean;
  /** Colour temperature, in kelvin. */
  kelvin: number;
}

/** The lamp's three mode switches. */
export type ModeField = 'daylight' | 'autoBrightness' | 'movement';

export type HeldField = keyof HeldValues;

/** One setting waiting for the lamp to light: its name and its value. */
export type Held = { [K in HeldField]: [K, HeldValues[K]] }[HeldField];

export class PendingSettings {
  private readonly wanted = new Map<HeldField, HeldValues[HeldField]>();

  /** Note that `field` is to be `value` once the lamp is on. */
  hold(...[field, value]: Held): void {
    this.wanted.set(field, value);
  }

  /** How many settings are waiting to be written. */
  get size(): number {
    return this.wanted.size;
  }

  /**
   * Drop what the lamp says about a setting that is still waiting to be written.
   *
   * Such a report is the old value by definition: nothing has gone out yet, so
   * the lamp is telling us what it was already doing, and publishing it would
   * undo the change the user has just made.
   *
   * A report that agrees with what is waiting is the exception. However the
   * lamp came to be there — the app, the button on its base — there is
   * nothing left to write, so the hold is released and the value passes.
   */
  filter<T extends Record<string, unknown>>(patch: T): Partial<T> {
    const kept: Record<string, unknown> = { ...patch };
    for (const [field, value] of this.wanted) {
      if (!(field in kept)) {
        continue;
      }
      if (kept[field] === value) {
        this.wanted.delete(field);
        continue;
      }
      delete kept[field];
    }
    return kept as Partial<T>;
  }

  /** Take everything waiting, to be written now. */
  take(): Held[] {
    const entries = [...this.wanted] as Held[];
    this.wanted.clear();
    return entries;
  }
}
