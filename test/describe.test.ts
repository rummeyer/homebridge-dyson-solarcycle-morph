/**
 * The state line is how a change is watched from the log, so every field that
 * can change has to reach it. A mode missing from it logs a line identical to
 * the one before, which reads as a repeat rather than as the change it is —
 * that is how auto brightness and movement went unwatchable until 1.1.1.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { describeState } = await import(pathToFileURL(resolve('dist/dyson/lamp.js')).href);

const base = {
  on: true,
  brightness: 45,
  kelvin: 4432,
  daylight: false,
  autoBrightness: false,
  movement: false,
  preset: 'none' as const,
};

test('a lamp in no particular mode reads as just its values', () => {
  assert.equal(describeState(base), 'on, 45%, 4432K');
  assert.equal(describeState({ ...base, on: false }), 'off, 45%, 4432K');
});

test('every mode the lamp is in is named', () => {
  assert.equal(describeState({ ...base, daylight: true }), 'on, 45%, 4432K, daylight');
  assert.equal(describeState({ ...base, autoBrightness: true }), 'on, 45%, 4432K, auto');
  assert.equal(describeState({ ...base, movement: true }), 'on, 45%, 4432K, movement');
  assert.equal(describeState({ ...base, preset: 'study' }), 'on, 45%, 4432K, study');
});

test('no two states that differ produce the same line', () => {
  // The bug itself: with only daylight rendered, flipping auto or movement
  // logged a line character-for-character identical to the one before it.
  const states = [
    base,
    { ...base, daylight: true },
    { ...base, autoBrightness: true },
    { ...base, movement: true },
    { ...base, preset: 'relax' as const },
    { ...base, daylight: true, autoBrightness: true, movement: true },
  ];
  const lines = states.map(describeState);
  assert.equal(new Set(lines).size, states.length, `lines collide: ${lines.join(' | ')}`);
});

test('several modes at once are listed in a stable order', () => {
  assert.equal(
    describeState({ ...base, daylight: true, autoBrightness: true, movement: true, preset: 'precision' }),
    'on, 45%, 4432K, daylight, auto, movement, precision',
  );
});
