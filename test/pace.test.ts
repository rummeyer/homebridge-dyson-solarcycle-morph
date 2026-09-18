import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pacer } from '../src/dyson/pace.ts';

/** A clock the test moves by hand, so nothing has to wait. */
function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** A `sleep` that advances the clock instead of waiting, recording each wait. */
function recorder(time: ReturnType<typeof clock>) {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      time.advance(ms);
    },
  };
}

test('the first write goes out without waiting', async () => {
  const time = clock();
  const delay = recorder(time);
  const pacer = new Pacer(150, time.now, delay.sleep);

  await pacer.pace();

  assert.deepEqual(delay.waits, [], 'nothing has been written yet, so nothing to wait behind');
});

test('a write arriving immediately behind another is held back', async () => {
  const time = clock();
  const delay = recorder(time);
  const pacer = new Pacer(150, time.now, delay.sleep);

  await pacer.pace();
  await pacer.pace();

  assert.deepEqual(delay.waits, [150], 'the second write waits the full gap');
});

test('a write that is already late enough is not delayed', async () => {
  const time = clock();
  const delay = recorder(time);
  const pacer = new Pacer(150, time.now, delay.sleep);

  await pacer.pace();
  time.advance(150);
  await pacer.pace();

  assert.deepEqual(delay.waits, [], 'the gap had already elapsed on its own');
});

test('only the remaining part of the gap is waited out', async () => {
  const time = clock();
  const delay = recorder(time);
  const pacer = new Pacer(150, time.now, delay.sleep);

  await pacer.pace();
  time.advance(40);
  await pacer.pace();

  assert.deepEqual(delay.waits, [110], '40ms had already passed');
});

test('a run of writes spaces out evenly rather than going out together', async () => {
  const time = clock();
  const delay = recorder(time);
  const pacer = new Pacer(150, time.now, delay.sleep);

  // What a HomeKit scene looks like: several writes queued at the same instant.
  await pacer.pace();
  await pacer.pace();
  await pacer.pace();
  await pacer.pace();

  assert.deepEqual(delay.waits, [150, 150, 150], 'each one waits behind the one before it');
});

test('a rebuilt link lets the next write go out immediately', async () => {
  const time = clock();
  const delay = recorder(time);
  const pacer = new Pacer(150, time.now, delay.sleep);

  await pacer.pace();
  // The lamp cannot be holding a write issued to a connection that is gone.
  pacer.reset();
  await pacer.pace();

  assert.deepEqual(delay.waits, [], 'reconnecting is not made to wait');
});
