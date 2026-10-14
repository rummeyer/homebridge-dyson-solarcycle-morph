import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OperatingHours } from '../src/dyson/hours.ts';

/** A clock that moves only when told to. */
function clock(start = 0): { now: () => number; advance: (seconds: number) => void } {
  let t = start;
  return { now: () => t, advance: (seconds) => (t += seconds * 1000) };
}

test('counts only while lit', () => {
  const c = clock();
  const hours = new OperatingHours(0, c.now);
  c.advance(100);
  hours.set(true);
  c.advance(60);
  hours.set(false);
  c.advance(100);
  assert.equal(hours.total(), 60);
});

test('carries on from what was stored', () => {
  const c = clock();
  const hours = new OperatingHours(3600, c.now);
  hours.set(true);
  c.advance(30);
  hours.set(false);
  assert.equal(hours.total(), 3630);
});

test('includes the stretch still running', () => {
  const c = clock();
  const hours = new OperatingHours(10, c.now);
  hours.set(true);
  c.advance(5);
  assert.equal(hours.total(), 15, 'so a periodic save while lit is not stuck at the last switch-off');
});

test('saying lit twice does not restart the stretch', () => {
  const c = clock();
  const hours = new OperatingHours(0, c.now);
  hours.set(true);
  c.advance(20);
  // Every state event repeats it, brightness changes included.
  hours.set(true);
  c.advance(20);
  hours.set(false);
  assert.equal(hours.total(), 40);
});

test('saying off twice adds nothing', () => {
  const c = clock();
  const hours = new OperatingHours(0, c.now);
  hours.set(false);
  c.advance(20);
  hours.set(false);
  assert.equal(hours.total(), 0);
});

test('a clock stepped backwards does not take hours away', () => {
  const c = clock(1_000_000);
  const hours = new OperatingHours(50, c.now);
  hours.set(true);
  c.advance(-500);
  assert.equal(hours.total(), 50);
  hours.set(false);
  assert.equal(hours.total(), 50);
});
