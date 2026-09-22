import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTimeOfDay, validateLightConfig } from '../src/config.ts';

const lamp = { name: 'Desk', mac: 'AA:BB:CC:DD:EE:FF', serial: 'ABC-123' };

test('a time of day reads as minutes past midnight', () => {
  assert.equal(parseTimeOfDay('00:00'), 0);
  assert.equal(parseTimeOfDay('08:00'), 480);
  assert.equal(parseTimeOfDay('8:00'), 480, 'a single-digit hour is still a time');
  assert.equal(parseTimeOfDay('18:00'), 1080);
  assert.equal(parseTimeOfDay('23:59'), 1439);
  assert.equal(parseTimeOfDay(' 07:30 '), 450, 'surrounding space is not an error');
});

test('what is not a time of day is refused', () => {
  for (const value of ['24:00', '08:60', '8', '0800', '08:0', 'eight', '', '08:00:00', '-1:00']) {
    assert.equal(parseTimeOfDay(value), undefined, `${JSON.stringify(value)} is not a time`);
  }
});

test('a day needs both ends', () => {
  assert.deepEqual(validateLightConfig({ ...lamp, dayStart: '08:00', dayEnd: '18:00' }, 0), []);
  assert.match(
    validateLightConfig({ ...lamp, dayStart: '08:00' }, 0).join(' '),
    /only one of dayStart\/dayEnd/,
  );
  assert.match(
    validateLightConfig({ ...lamp, dayEnd: '18:00' }, 0).join(' '),
    /only one of dayStart\/dayEnd/,
  );
});

test('a day that ends before it starts is refused', () => {
  // The lamp holds two minute counts and has no way to say "past midnight", so
  // this would quietly become a day of negative length.
  assert.match(
    validateLightConfig({ ...lamp, dayStart: '18:00', dayEnd: '08:00' }, 0).join(' '),
    /dayEnd must come after dayStart/,
  );
  assert.match(
    validateLightConfig({ ...lamp, dayStart: '08:00', dayEnd: '08:00' }, 0).join(' '),
    /dayEnd must come after dayStart/,
  );
});

test('a day that is not a time says so, naming the field', () => {
  const problems = validateLightConfig({ ...lamp, dayStart: 'morning', dayEnd: '18:00' }, 0).join(' ');
  assert.match(problems, /dayStart must be a time of day like 08:00/);
  assert.match(problems, /"morning"/);
});

test('leaving the day out is not a problem', () => {
  assert.deepEqual(validateLightConfig(lamp, 0), []);
});
