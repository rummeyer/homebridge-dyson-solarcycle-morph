/**
 * The lamp's clock, worked out from the machine the plugin runs on.
 *
 * Daylight tracking needs two things the lamp cannot discover for itself: where
 * it is, and what the time is there. The first comes from the configuration.
 * The second is already known to the Homebridge host — it has a time zone, and
 * that zone carries both the current offset and the dates the local clock jumps
 * — so nothing here asks the network, which matters because these values are
 * written while reconnecting, exactly when the network may not be up yet.
 *
 * The MyDyson app gets the same two from the phone: the offset from its own
 * time zone, and the rules from a Dyson cloud endpoint keyed by the zone's name
 * (`nd0/e.java`, `pj0/b.java`). The lamp cannot tell the difference.
 */

/** Minutes east of UTC at an instant. Injectable so tests need not move the machine. */
export type OffsetAt = (instant: Date) => number;

const hostOffset: OffsetAt = (instant) => -instant.getTimezoneOffset();

/** Days scanned when looking for the two clock changes in a year. */
const DAYS_IN_YEAR = 366;

/**
 * The offset the lamp wants in `0x2005`, which is **hours.minutes**.
 *
 * Not decimal hours: the app takes the offset in hours and rebuilds it as the
 * whole part plus the fraction times 0.6 (`nd0/e.java`), so half past five is
 * `5.30` rather than `5.5`. A whole-hour zone reads the same either way, which
 * is why the encoding stayed hidden until the app was read closely.
 */
export function utcOffset(now = new Date(), offsetAt: OffsetAt = hostOffset): number {
  const minutes = offsetAt(now);
  const sign = minutes < 0 ? -1 : 1;
  const magnitude = Math.abs(minutes);
  return sign * (Math.trunc(magnitude / 60) + (magnitude % 60) / 100);
}

interface Transition {
  /** When the clock changes. */
  at: number;
  /** Minutes east of UTC before and after it. */
  before: number;
  after: number;
}

/**
 * The eight bytes the lamp wants in `0x201d`, or nothing when the zone's rules
 * cannot be stated in the form it takes.
 *
 * Silence is deliberate. Only one rule number is known for certain — `2`, the
 * last given weekday of a month, read back from a lamp holding the EU rule —
 * and a zone that changes its clock on some other pattern would need a number
 * this project has never seen. Writing a guess would leave the lamp tracking
 * daylight against rules nobody has checked, which is worse than leaving the
 * ones it already has.
 */
export function daylightSavingRules(
  now = new Date(),
  offsetAt: OffsetAt = hostOffset,
): Buffer | undefined {
  const changes = transitions(now.getUTCFullYear(), offsetAt);
  if (changes.length !== 2) {
    // No daylight saving at all, or a zone that changes more than twice.
    return undefined;
  }

  // Which is which by direction, not by date: south of the equator the clock
  // goes forward in the second half of the year.
  const start = changes.find((change) => change.after > change.before);
  const end = changes.find((change) => change.after < change.before);
  if (!start || !end) {
    return undefined;
  }

  const from = describe(start);
  const to = describe(end);
  const adjustment = start.after - start.before;
  if (!from || !to || adjustment < 0 || adjustment > 0xff) {
    return undefined;
  }

  return Buffer.from([
    pack(from.rule, from.month),
    0, // The date, unused while the rule names a weekday rather than a day.
    from.minutes,
    adjustment,
    pack(to.rule, to.month),
    0,
    to.minutes,
    pack(to.weekday, from.weekday),
  ]);
}

interface Rule {
  rule: number;
  month: number;
  minutes: number;
  weekday: number;
}

/**
 * State one clock change the way the lamp does.
 *
 * The moment is named in the wall time that was running just before it — the
 * European change is "02:00 on the last Sunday in March", which is 01:00 UTC
 * read in the offset still in force. Reading it in the new offset would name
 * the hour the clock jumped to instead.
 */
function describe(change: Transition): Rule | undefined {
  const wall = new Date(change.at + change.before * 60_000);
  const month = wall.getUTCMonth() + 1;
  const lastOfMonth = new Date(Date.UTC(wall.getUTCFullYear(), month, 0)).getUTCDate();
  if (wall.getUTCDate() <= lastOfMonth - 7) {
    // Not the last such weekday of the month, so not a rule we can name.
    return undefined;
  }
  const minutes = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  if (minutes > 0xff) {
    return undefined;
  }
  return {
    rule: 2,
    month,
    minutes,
    // Sunday is 7 here, not 0: the lamp's own EU rule ends in `77`.
    weekday: wall.getUTCDay() === 0 ? 7 : wall.getUTCDay(),
  };
}

/** Two nibbles in one byte, as `bm0/c.java`'s `a()` builds them. */
function pack(high: number, low: number): number {
  return ((high & 0x0f) << 4) | (low & 0x0f);
}

/**
 * Every clock change in a year, found by walking it a day at a time and then
 * halving the day that differs down to the minute.
 *
 * A day-wide sweep is enough to find a change, and the halving costs a handful
 * of lookups to place it exactly. Done once per connection on a value that only
 * moves twice a year, so nothing here is worth caching.
 */
function transitions(year: number, offsetAt: OffsetAt): Transition[] {
  const found: Transition[] = [];
  let previous = new Date(Date.UTC(year, 0, 1));
  for (let day = 1; day < DAYS_IN_YEAR; day++) {
    const current = new Date(Date.UTC(year, 0, 1 + day));
    if (offsetAt(current) !== offsetAt(previous)) {
      let low = previous.getTime();
      let high = current.getTime();
      while (high - low > 60_000) {
        const middle = Math.floor((low + high) / 2 / 60_000) * 60_000;
        if (offsetAt(new Date(middle)) === offsetAt(previous)) {
          low = middle;
        } else {
          high = middle;
        }
      }
      found.push({ at: high, before: offsetAt(new Date(low)), after: offsetAt(new Date(high)) });
    }
    previous = current;
  }
  return found;
}
