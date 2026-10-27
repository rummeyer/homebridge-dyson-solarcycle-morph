import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FIRST_PAUSE_MS, heardBetween, LONGEST_PAUSE_MS, recoverAdapter, ResetPacing } from '../src/dyson/adapter-health.ts';

/** A clock the test moves by hand, so nothing has to wait. */
function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test('an adapter hears when any device near it appears or changes its signal', () => {
  const before = new Map([['/org/bluez/hci0/dev_A', -60], ['/org/bluez/hci0/dev_B', -80]]);
  assert.equal(heardBetween(before, new Map(before)), false, 'the same values: stale, nothing heard');
  assert.equal(heardBetween(before, new Map([...before, ['/org/bluez/hci0/dev_B', -78]])), true, 'one changed');
  assert.equal(heardBetween(before, new Map([...before, ['/org/bluez/hci0/dev_C', -70]])), true, 'one new');
  assert.equal(heardBetween(new Map(), new Map()), false, 'nothing at all');
});

test('resets are kept apart, the pause doubling up to six hours, and start afresh once connected', () => {
  const time = clock();
  const pacing = new ResetPacing(time.now);
  assert.equal(pacing.due, true, 'the first is due at once');

  pacing.reset();
  assert.equal(pacing.due, false);
  time.advance(FIRST_PAUSE_MS);
  assert.equal(pacing.due, true, 'half an hour after the first');

  pacing.reset();
  time.advance(FIRST_PAUSE_MS);
  assert.equal(pacing.due, false, 'not half an hour after the second');
  time.advance(FIRST_PAUSE_MS);
  assert.equal(pacing.due, true, 'an hour after it');

  for (let i = 0; i < 10; i++) {
    pacing.reset();
    time.advance(LONGEST_PAUSE_MS);
  }
  assert.equal(pacing.due, true, 'never more than six hours');

  pacing.reset();
  pacing.connected();
  assert.equal(pacing.due, true, 'a connection made: the next trouble is looked at at once');
});

test('nothing is checked before enough failures, nor without a D-Bus connection', async () => {
  const log = { info() {}, warn() {}, debug() {} };
  assert.equal(await recoverAdapter({ adapter: 'hci9' }, 99, log), false, 'no bus');
  assert.equal(await recoverAdapter(undefined, 99, log), false, 'no adapter');
  const bus = { getProxyObject: () => assert.fail('the adapter is not asked before enough failures') };
  assert.equal(await recoverAdapter({ adapter: 'hci9', dbus: bus }, 2, log), false);
});
