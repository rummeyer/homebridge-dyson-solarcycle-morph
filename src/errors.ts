/**
 * Turn an unknown thrown value into something worth logging.
 *
 * A bare `message` hides the cause chain, which is where the useful part
 * usually is: the HTTP status Dyson refused with, or the D-Bus error under a
 * generic BlueZ failure.
 */
export function describeError(error: unknown, maxCauses = 2): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const parts = [error.message];
  let cause: unknown = error.cause;
  while (cause instanceof Error && parts.length <= maxCauses) {
    parts.push(`caused by ${cause.message}`);
    cause = cause.cause;
  }
  return parts.join(' — ');
}
