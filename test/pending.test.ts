import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PendingModes } from '../src/dyson/pending.ts';

test('nothing is held to begin with', () => {
  const pending = new PendingModes();
  assert.equal(pending.size, 0);
  assert.deepEqual(pending.take(), []);
});

test('a held mode is taken back out to be written', () => {
  const pending = new PendingModes();
  pending.hold('movement', true);
  assert.equal(pending.size, 1);
  assert.deepEqual(pending.take(), [['movement', true]]);
  assert.equal(pending.size, 0, 'taking empties it');
});

test('holding a mode twice keeps only the value asked for last', () => {
  const pending = new PendingModes();
  pending.hold('daylight', true);
  pending.hold('daylight', false);
  assert.deepEqual(pending.take(), [['daylight', false]]);
});

test('what the lamp says about a held mode is dropped', () => {
  const pending = new PendingModes();
  pending.hold('autoBrightness', true);

  // The lamp has not been told anything yet, so it is still reporting the mode
  // it was already in. Publishing that would put the switch back.
  assert.deepEqual(pending.filter({ autoBrightness: false, on: false }), { on: false });
  assert.equal(pending.size, 1, 'still waiting to be written');
});

test('a hold is released once the lamp reports the value anyway', () => {
  const pending = new PendingModes();
  pending.hold('daylight', true);

  // Someone pressed the button on the lamp's base. There is nothing left to
  // write, and the report is the truth.
  assert.deepEqual(pending.filter({ daylight: true }), { daylight: true });
  assert.equal(pending.size, 0);
});

test('modes that are not held pass through untouched', () => {
  const pending = new PendingModes();
  pending.hold('movement', true);
  assert.deepEqual(pending.filter({ daylight: false, autoBrightness: false, brightness: 0 }), {
    daylight: false,
    autoBrightness: false,
    brightness: 0,
  });
});

test('a report that says nothing about a held mode leaves it held', () => {
  const pending = new PendingModes();
  pending.hold('movement', false);
  assert.deepEqual(pending.filter({ on: true, kelvin: 2700 }), { on: true, kelvin: 2700 });
  assert.deepEqual(pending.take(), [['movement', false]]);
});

test('several modes can wait at once', () => {
  const pending = new PendingModes();
  pending.hold('daylight', true);
  pending.hold('autoBrightness', false);
  pending.hold('movement', true);
  assert.equal(pending.size, 3);
  assert.deepEqual(pending.filter({ daylight: false, autoBrightness: true, movement: false }), {});
  assert.deepEqual(pending.take(), [
    ['daylight', true],
    ['autoBrightness', false],
    ['movement', true],
  ]);
});
