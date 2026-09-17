import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OperationQueue } from '../src/dyson/queue.ts';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('operations run one at a time, in order', async () => {
  const q = new OperationQueue();
  const order: string[] = [];
  const slow = (name: string) => async () => {
    order.push(`${name}:start`);
    await tick(20);
    order.push(`${name}:end`);
  };

  await Promise.all([q.run(slow('a')), q.run(slow('b'))]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('a keyed operation drops the one it supersedes', async () => {
  const q = new OperationQueue();
  const ran: string[] = [];
  const record = (name: string) => async () => {
    await tick(15);
    ran.push(name);
  };

  // The first starts immediately; the next two queue under the same key, so the
  // middle one is dropped by the last.
  const first = q.run(record('blocker'));
  const superseded = q.run(record('old'), 'brightness');
  const winner = q.run(record('new'), 'brightness');

  await Promise.all([first, superseded, winner]);
  assert.deepEqual(ran, ['blocker', 'new']);
});

test('a dropped operation resolves to undefined', async () => {
  const q = new OperationQueue();
  q.run(async () => tick(15));
  const superseded = q.run(async () => 'old', 'k');
  const winner = q.run(async () => 'new', 'k');

  assert.equal(await superseded, undefined);
  assert.equal(await winner, 'new');
});

test('different keys do not supersede each other', async () => {
  const q = new OperationQueue();
  const ran: string[] = [];
  q.run(async () => tick(15));
  const a = q.run(async () => void ran.push('a'), 'a');
  const b = q.run(async () => void ran.push('b'), 'b');
  await Promise.all([a, b]);
  assert.deepEqual(ran, ['a', 'b']);
});

test('an unkeyed operation is never superseded', async () => {
  const q = new OperationQueue();
  const ran: string[] = [];
  q.run(async () => tick(15));
  const power = q.run(async () => void ran.push('power'));
  const first = q.run(async () => void ran.push('b1'), 'brightness');
  const second = q.run(async () => void ran.push('b2'), 'brightness');
  await Promise.all([power, first, second]);
  assert.deepEqual(ran, ['power', 'b2']);
});

test('a failing operation does not stall the queue', async () => {
  const q = new OperationQueue();
  const failed = q.run(async () => {
    throw new Error('lamp went away');
  });
  await assert.rejects(() => failed, /lamp went away/);
  assert.equal(await q.run(async () => 'after'), 'after');
});

test('depth counts only what has not started', async () => {
  const q = new OperationQueue();
  assert.equal(q.depth, 0);
  const running = q.run(async () => tick(30));
  const queued = q.run(async () => {});
  assert.ok(q.depth >= 1, 'the queued one is counted');
  await Promise.all([running, queued]);
  await tick(10);
  assert.equal(q.depth, 0);
});

test('cancelQueued drops what is waiting but not what is running', async () => {
  const q = new OperationQueue();
  const ran: string[] = [];
  const running = q.run(async () => {
    await tick(25);
    ran.push('running');
  });
  // Queueing only schedules a microtask, so nothing has actually started until
  // the event loop turns; without this, the first operation counts as waiting
  // too and is cancelled along with the rest.
  await tick(5);
  const waiting = q.run(async () => void ran.push('waiting'));

  q.cancelQueued();
  await Promise.all([running, waiting]);
  assert.deepEqual(ran, ['running'], 'the in-flight operation still completed');
});
