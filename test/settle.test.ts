import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SettleWindow } from '../src/dyson/settle.ts';

/** A clock the test moves by hand, so nothing has to wait. */
function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test('a field is held after being commanded, then released', () => {
  const time = clock();
  const settle = new SettleWindow(1000, time.now);

  assert.equal(settle.isHeld('brightness'), false, 'nothing is held to begin with');
  settle.hold('brightness');
  assert.equal(settle.isHeld('brightness'), true);

  time.advance(999);
  assert.equal(settle.isHeld('brightness'), true, 'still within the window');
  time.advance(1);
  assert.equal(settle.isHeld('brightness'), false, 'released once it passes');
});

test('holding one field leaves the others alone', () => {
  const time = clock();
  const settle = new SettleWindow(1000, time.now);
  settle.hold('brightness');
  assert.equal(settle.isHeld('kelvin'), false);
  assert.equal(settle.isHeld('on'), false);
});

test('commanding again extends the window', () => {
  const time = clock();
  const settle = new SettleWindow(1000, time.now);
  settle.hold('brightness');
  time.advance(800);
  settle.hold('brightness');
  time.advance(800);
  assert.equal(settle.isHeld('brightness'), true, 'the later command restarted the window');
});

test('filter keeps only what is not settling', () => {
  const time = clock();
  const settle = new SettleWindow(1000, time.now);
  settle.hold('brightness');

  // The lamp reports its ramp while also reporting a power change; only the
  // ramp is the echo of our own command.
  assert.deepEqual(settle.filter({ brightness: 62, on: true }), { on: true });

  time.advance(1001);
  assert.deepEqual(settle.filter({ brightness: 62, on: true }), { brightness: 62, on: true });
});

test('filter passes everything through when nothing is held', () => {
  const settle = new SettleWindow(1000, clock().now);
  assert.deepEqual(settle.filter({ brightness: 10, kelvin: 2700 }), { brightness: 10, kelvin: 2700 });
});

test('filter keeps falsy values rather than dropping them', () => {
  const settle = new SettleWindow(1000, clock().now);
  // `on: false` and `brightness: 0` are meaningful, not absent.
  assert.deepEqual(settle.filter({ on: false, brightness: 0 }), { on: false, brightness: 0 });
});

test('clear releases everything at once', () => {
  const time = clock();
  const settle = new SettleWindow(1000, time.now);
  settle.hold('brightness');
  settle.hold('kelvin');
  settle.clear();
  assert.equal(settle.isHeld('brightness'), false);
  assert.equal(settle.isHeld('kelvin'), false);
});
