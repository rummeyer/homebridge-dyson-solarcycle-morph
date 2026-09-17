/**
 * Serialises operations, dropping ones that are obsolete before they run.
 */

/** Resolves to `undefined` when the operation was dropped before running. */
export type QueuedResult<T> = Promise<T | undefined>;

interface Entry {
  key: string | undefined;
  cancel: () => void;
}

export class OperationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  /** Queued but not yet started, oldest first. */
  private waiting: Entry[] = [];

  /**
   * Run `task` after everything already queued.
   *
   * A `key` marks the operation as replaceable: queueing another under the same
   * key drops the earlier one, because it would only write a value that the
   * newer one is about to overwrite. Without a key the operation always runs.
   *
   * @returns what `task` returned, or `undefined` if it was dropped.
   */
  run<T>(task: () => Promise<T>, key?: string): QueuedResult<T> {
    if (key !== undefined) {
      for (const entry of this.waiting) {
        if (entry.key === key) {
          entry.cancel();
        }
      }
    }

    let cancelled = false;
    const entry: Entry = { key, cancel: () => { cancelled = true; } };
    this.waiting.push(entry);

    const result = this.tail.then(
      async () => {
        this.waiting = this.waiting.filter((e) => e !== entry);
        return cancelled ? undefined : task();
      },
      async () => {
        this.waiting = this.waiting.filter((e) => e !== entry);
        return cancelled ? undefined : task();
      },
    );
    // The chain must not stall on a failed operation, but the caller still sees
    // the rejection through `result`.
    this.tail = result.catch(() => {});
    return result;
  }

  /** How many operations are queued but not yet started. */
  get depth(): number {
    return this.waiting.length;
  }

  /** Drop everything queued but not yet started. Running work is unaffected. */
  cancelQueued(): void {
    for (const entry of this.waiting) {
      entry.cancel();
    }
  }
}
