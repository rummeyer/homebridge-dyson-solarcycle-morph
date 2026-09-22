/**
 * Keeps mode changes made to an off lamp, until it is switched on.
 *
 * Daylight tracking, auto brightness and movement mode are only taken by a lamp
 * that is lit. Written to one that is off they are dropped without a word, and
 * the lamp goes on reporting the old value — so a switch flipped in the Home
 * app springs back a moment later, which reads as the plugin having failed.
 *
 * So a change made while the lamp is off is kept here rather than written. The
 * switch shows what was asked for, what the lamp says about that mode is
 * disregarded while it can only contradict it, and the value goes out for real
 * the moment the lamp lights.
 *
 * Deliberately not written down anywhere: a restarted plugin takes its state
 * from the lamp, which is the only thing that knows what it is really doing.
 */

/** The lamp's three mode switches — the ones an off lamp will not take. */
export type ModeField = 'daylight' | 'autoBrightness' | 'movement';

export class PendingModes {
  private readonly wanted = new Map<ModeField, boolean>();

  /** Note that `field` is to be `value` once the lamp is on. */
  hold(field: ModeField, value: boolean): void {
    this.wanted.set(field, value);
  }

  /** How many modes are waiting to be written. */
  get size(): number {
    return this.wanted.size;
  }

  /**
   * Drop what the lamp says about a mode that is still waiting to be written.
   *
   * Such a report is the old value by definition: nothing has gone out yet, so
   * the lamp is telling us what it was already doing, and publishing it would
   * undo the switch the user has just flipped.
   *
   * A report that agrees with what is waiting is the exception. However the
   * lamp came to be in that mode — the app, the button on its base — there is
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
  take(): [ModeField, boolean][] {
    const entries = [...this.wanted];
    this.wanted.clear();
    return entries;
  }
}
