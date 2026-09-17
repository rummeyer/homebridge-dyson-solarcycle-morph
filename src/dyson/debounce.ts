/**
 * Coalesces rapid updates so only the value a control settles on is acted on.
 */
export class Debouncer {
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; supersede: () => void }>();

  private readonly delayMs: number;
  private readonly run: (task: () => Promise<void>, key: string) => Promise<unknown>;

  /**
   * @param delayMs How long a key must stay unchanged before its task runs.
   * @param run Executes the winning task, typically through a serialising
   * queue. The key is passed on so the queue can apply the same grouping.
   */
  constructor(delayMs: number, run: (task: () => Promise<void>, key: string) => Promise<unknown>) {
    this.delayMs = delayMs;
    this.run = run;
  }

  /**
   * Schedule `task` for `key`, replacing anything already waiting under it.
   *
   * A superseded call resolves immediately instead of waiting for the task that
   * replaced it. Callers here are HomeKit characteristic handlers, which have a
   * ten-second budget; holding every intermediate slider position open until the
   * final write lands would spend that budget to report a value that is already
   * stale. Callers update their own state optimistically, so nothing is lost.
   */
  schedule(key: string, task: () => Promise<void>): Promise<void> {
    this.pending.get(key)?.supersede();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        this.run(task, key).then(() => resolve(), reject);
      }, this.delayMs);
      this.pending.set(key, {
        timer,
        supersede: () => {
          clearTimeout(timer);
          this.pending.delete(key);
          resolve();
        },
      });
    });
  }

  /**
   * Whether a task is waiting under this key.
   *
   * Lets a running task notice that its own result is already obsolete, so it
   * can stop rather than act on a value the caller has moved past.
   */
  isPending(key: string): boolean {
    return this.pending.has(key);
  }

  /** Drop everything waiting, resolving the callers. Nothing is executed. */
  cancelAll(): void {
    for (const { supersede } of [...this.pending.values()]) {
      supersede();
    }
  }
}
