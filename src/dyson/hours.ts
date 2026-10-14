/**
 * A rough count of how long a lamp has been lit.
 *
 * The lamp keeps no such count anywhere it exposes over Bluetooth: every
 * attribute from `0x2000` to `0x2040` and every readable characteristic were
 * compared between a lamp used since January and one lit for a few minutes,
 * and nothing differed by more than a handful. So the plugin counts for itself,
 * and can only count what it sees — time the lamp was on while Homebridge was
 * running and connected to it. Anything outside that is missing, never guessed.
 */
export class OperatingHours {
  private seconds: number;
  private readonly now: () => number;
  /** When the current lit stretch began, or undefined while it is not lit. */
  private litSince: number | undefined;

  /**
   * @param seconds What was counted before, from the store.
   * @param now Clock in milliseconds, replaceable for tests.
   */
  constructor(seconds: number, now: () => number = Date.now) {
    this.seconds = seconds;
    this.now = now;
  }

  /**
   * Say whether the lamp is lit as far as the plugin can tell.
   *
   * Pass false whenever the link is down as well as when the lamp is off: a
   * lamp out of reach may well be lit, but that is time nobody saw.
   */
  set(lit: boolean): void {
    const now = this.now();
    if (lit && this.litSince === undefined) {
      this.litSince = now;
    } else if (!lit && this.litSince !== undefined) {
      this.seconds += Math.max(0, now - this.litSince) / 1000;
      this.litSince = undefined;
    }
  }

  /** Seconds counted so far, the running stretch included. */
  total(): number {
    return this.litSince === undefined ? this.seconds : this.seconds + Math.max(0, this.now() - this.litSince) / 1000;
  }
}
