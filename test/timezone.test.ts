import assert from 'node:assert/strict';
import { test } from 'node:test';

import { daylightSavingRules, utcOffset } from '../src/dyson/timezone.ts';
import type { OffsetAt } from '../src/dyson/timezone.ts';

/**
 * Minutes east of UTC in a named zone, so a test can stand anywhere on earth
 * without moving the machine it runs on.
 */
function zone(name: string): OffsetAt {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: name, timeZoneName: 'longOffset' });
  return (instant) => {
    const printed = format.formatToParts(instant).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(printed);
    if (!match) {
      return 0; // "GMT" on its own.
    }
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === '-' ? -minutes : minutes;
  };
}

const summer = new Date('2026-07-01T12:00:00Z');
const winter = new Date('2026-01-15T12:00:00Z');

test('the offset is hours.minutes, not decimal hours', () => {
  // Half past five reads 5.30, which is the app's own encoding and the reason
  // this is not simply minutes / 60.
  assert.equal(utcOffset(summer, zone('Asia/Kolkata')), 5.3);
  assert.equal(utcOffset(summer, zone('Europe/Berlin')), 2);
  assert.equal(utcOffset(winter, zone('Europe/Berlin')), 1);
  assert.equal(utcOffset(summer, zone('Europe/London')), 1);
  assert.equal(utcOffset(winter, zone('UTC')), 0);
});

test('a negative offset keeps its sign on both parts', () => {
  assert.equal(utcOffset(winter, zone('America/New_York')), -5);
  // Newfoundland is three and a half hours behind, so -3.30 rather than -3.5.
  assert.equal(utcOffset(winter, zone('America/St_Johns')), -3.3);
});

test('the EU rules come out as the bytes the lamp itself holds', () => {
  // Read from a CF06 on 2026-09-22 and recorded in docs/PROTOCOL.md: last
  // Sunday in March at 02:00, plus 60 minutes, last Sunday in October at 03:00.
  assert.deepEqual(
    daylightSavingRules(summer, zone('Europe/Berlin')),
    Buffer.from('2300783c2a00b477', 'hex'),
  );
});

test('the rules are the same whichever side of the change they are asked from', () => {
  assert.deepEqual(
    daylightSavingRules(winter, zone('Europe/Berlin')),
    daylightSavingRules(summer, zone('Europe/Berlin')),
  );
});

test('a zone that does not change its clock gets no rules at all', () => {
  // Rather than eight bytes of zeroes, which the lamp would take as a rule.
  assert.equal(daylightSavingRules(summer, zone('UTC')), undefined);
  assert.equal(daylightSavingRules(summer, zone('Asia/Kolkata')), undefined);
});

test('a zone whose rule this cannot name is left alone', () => {
  // Both of these change on the *first* or *second* given weekday of a month,
  // and the numbers standing for those have never been read back from a lamp.
  // Only "last" is known, so these get nothing rather than a guess.
  assert.equal(daylightSavingRules(summer, zone('America/New_York')), undefined);
  assert.equal(daylightSavingRules(summer, zone('Australia/Sydney')), undefined);
});

test('start and end are told apart by direction, not by date', () => {
  // South of the equator the clock goes forward in the second half of the year,
  // so the earlier change of the two is the one that ends daylight saving. No
  // real zone both does this and changes on a last weekday, so this is Berlin's
  // own dates with the two directions swapped.
  const berlin = zone('Europe/Berlin');
  const southern: OffsetAt = (instant) => (berlin(instant) === 120 ? 60 : 120);

  const rules = daylightSavingRules(summer, southern);
  assert.ok(rules);
  // Forward in October at 02:00, back in March at 03:00 — the mirror of the
  // EU rule, and proof that neither was picked for coming first in the year.
  assert.equal(rules.toString('hex'), '2a00783c2300b477');
});
