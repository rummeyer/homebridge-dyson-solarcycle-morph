/**
 * Keeps consecutive writes far enough apart that the lamp accepts both.
 *
 * A write arriving immediately behind another is discarded, and the control
 * characteristics are write-without-response, so nothing reports it. Measured
 * on a CF06: brightness and colour temperature written back to back landed
 * colour temperature in 1 of 8 attempts; spacing them by 100 ms made it 8 of 8.
 * The drop always took whichever write came second, whichever field that was.
 *
 * HomeKit sets brightness and colour temperature together whenever a scene is
 * applied, so this is the ordinary path rather than an edge case.
 */
export class Pacer {
  private readonly gapMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private last = Number.NEGATIVE_INFINITY;

  /**
   * @param gapMs Minimum spacing between writes.
   * @param now Injectable clock, so the behaviour can be tested without waiting.
   * @param sleep Injectable delay, for the same reason.
   */
  constructor(
    gapMs: number,
    now: () => number = () => Date.now(),
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.gapMs = gapMs;
    this.now = now;
    this.sleep = sleep;
  }

  /**
   * Wait, if needed, until the gap since the previous write has elapsed.
   *
   * Call immediately before writing. The clock is taken after the wait rather
   * than before it, so a queue of writes spaces out at `gapMs` apiece instead
   * of all measuring from the same instant and going out together.
   */
  async pace(): Promise<void> {
    const since = this.now() - this.last;
    if (since < this.gapMs) {
      await this.sleep(this.gapMs - since);
    }
    this.last = this.now();
  }

  /**
   * Forget the previous write, so the next one goes out immediately.
   *
   * Used when the link has been rebuilt: the lamp has no memory of a write that
   * went to a connection that no longer exists, and making the first write of a
   * fresh session wait would only slow reconnection down.
   */
  reset(): void {
    this.last = Number.NEGATIVE_INFINITY;
  }
}
