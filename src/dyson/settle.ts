/**
 * Suppresses the lamp's own reports while it moves to a value just commanded.
 *
 * The Morph ramps smoothly rather than jumping: told to go from 50% to 100% it
 * climbs in steps, notifying each one. Published as they arrive, those steps
 * overwrite what the user just set, so the slider drifts away under their
 * finger and settles wherever the last notification landed.
 *
 * Reports are therefore ignored per field for a short window after commanding
 * it, so a commanded value stays put. Once the window passes the lamp is
 * followed again, which is what keeps changes made at the lamp itself visible.
 */
export class SettleWindow {
  private readonly until = new Map<string, number>();
  private readonly holdMs: number;
  private readonly now: () => number;

  /**
   * @param holdMs How long to disregard reports about a field after commanding it.
   * @param now Injectable clock, so the behaviour can be tested without waiting.
   */
  constructor(holdMs: number, now: () => number = Date.now) {
    this.holdMs = holdMs;
    this.now = now;
  }

  /** Note that `field` was just commanded; its ramp is about to be reported. */
  hold(field: string): void {
    this.until.set(field, this.now() + this.holdMs);
  }

  /** Whether reports about `field` are still being disregarded. */
  isHeld(field: string): boolean {
    const until = this.until.get(field);
    if (until === undefined) {
      return false;
    }
    if (this.now() >= until) {
      this.until.delete(field);
      return false;
    }
    return true;
  }

  /** Drop the fields of `patch` that are still settling. */
  filter<T extends Record<string, unknown>>(patch: T): Partial<T> {
    const kept: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (!this.isHeld(field)) {
        kept[field] = value;
      }
    }
    return kept as Partial<T>;
  }

  /** Forget every window, e.g. when the connection is rebuilt. */
  clear(): void {
    this.until.clear();
  }
}
