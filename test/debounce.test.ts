import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Debouncer } from '../src/dyson/debounce.ts';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs tasks immediately, recording the order they ran in. */
function recorder() {
  const ran: string[] = [];
  const run = async (task: () => Promise<void>) => task();
  return { ran, run };
}

test('only the last value in a burst is written', async () => {
  const { ran, run } = recorder();
  const d = new Debouncer(20, run);

  const calls = ['a', 'b', 'c'].map((v) => d.schedule('key', async () => void ran.push(v)));
  await Promise.all(calls);
  await tick(60);

  assert.deepEqual(ran, ['c'], 'a and b were superseded');
});

test('superseded callers resolve without waiting for the winner', async () => {
  const { run } = recorder();
  const d = new Debouncer(500, run);

  const first = d.schedule('key', async () => {});
  d.schedule('key', async () => {});

  // Would take 500ms if the superseded call waited for the replacement.
  await Promise.race([first, tick(100).then(() => Promise.reject(new Error('first did not resolve early')))]);
});

test('different keys do not supersede each other', async () => {
  const { ran, run } = recorder();
  const d = new Debouncer(10, run);

  await Promise.all([
    d.schedule('brightness', async () => void ran.push('brightness')),
    d.schedule('colour', async () => void ran.push('colour')),
  ]);

  assert.deepEqual(ran.sort(), ['brightness', 'colour']);
});

test('a later burst still runs after an earlier one settled', async () => {
  const { ran, run } = recorder();
  const d = new Debouncer(10, run);

  await d.schedule('key', async () => void ran.push('first'));
  await d.schedule('key', async () => void ran.push('second'));

  assert.deepEqual(ran, ['first', 'second']);
});

test('a failing task rejects its caller', async () => {
  const d = new Debouncer(5, (task) => task());
  await assert.rejects(
    () => d.schedule('key', async () => {
      throw new Error('lamp went away');
    }),
    /lamp went away/,
  );
});

test('cancelAll resolves pending callers without running them', async () => {
  const { ran, run } = recorder();
  const d = new Debouncer(50, run);

  const call = d.schedule('key', async () => void ran.push('should not run'));
  d.cancelAll();
  await call;
  await tick(80);

  assert.deepEqual(ran, [], 'the cancelled task never ran');
});

test('tasks run through the supplied queue, not directly', async () => {
  const order: string[] = [];
  const d = new Debouncer(5, async (task) => {
    order.push('queue');
    await task();
  });
  await d.schedule('key', async () => void order.push('task'));
  assert.deepEqual(order, ['queue', 'task']);
});

test('a key with a task waiting reports as pending', async () => {
  const { run } = recorder();
  const d = new Debouncer(30, run);

  assert.equal(d.isPending('key'), false, 'nothing scheduled yet');
  const call = d.schedule('key', async () => {});
  assert.equal(d.isPending('key'), true, 'a task is waiting');
  assert.equal(d.isPending('other'), false, 'keys are independent');

  await call;
  await tick(60);
  assert.equal(d.isPending('key'), false, 'cleared once it has run');
});

test('a superseding schedule leaves the key pending', async () => {
  const { run } = recorder();
  const d = new Debouncer(30, run);
  void d.schedule('key', async () => {});
  void d.schedule('key', async () => {});
  // The replacement must not look like "nothing waiting" to a running task.
  assert.equal(d.isPending('key'), true);
  await tick(60);
});

test('cancelAll clears pending', async () => {
  const { run } = recorder();
  const d = new Debouncer(50, run);
  const call = d.schedule('key', async () => {});
  d.cancelAll();
  assert.equal(d.isPending('key'), false);
  await call;
});
