import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScrollTargets } from '../src/shared/segments.js';

test('covers selection with a partial final segment', () => {
  assert.deepEqual(buildScrollTargets({selectionTop: 100, selectionBottom: 850,
    viewportHeight: 300, maxScrollTop: 1200}), [100, 400, 550]);
});

test('clamps targets near the end and removes duplicates', () => {
  assert.deepEqual(buildScrollTargets({selectionTop: 900, selectionBottom: 1300,
    viewportHeight: 300, maxScrollTop: 1000}), [900, 1000]);
});

test('uses only the first target when the selection is shorter than the viewport', () => {
  assert.deepEqual(buildScrollTargets({selectionTop: 100, selectionBottom: 200,
    viewportHeight: 300, maxScrollTop: 1200}), [100]);
});

test('uses only the clamped first target for a short selection near the page bottom', () => {
  assert.deepEqual(buildScrollTargets({selectionTop: 1150, selectionBottom: 1200,
    viewportHeight: 300, maxScrollTop: 1000}), [1000]);
});

test('rejects empty and inverted selections', () => {
  assert.throws(() => buildScrollTargets({selectionTop: 100, selectionBottom: 100,
    viewportHeight: 300, maxScrollTop: 1200}), RangeError);
  assert.throws(() => buildScrollTargets({selectionTop: 200, selectionBottom: 100,
    viewportHeight: 300, maxScrollTop: 1200}), RangeError);
});

test('rejects non-positive viewport heights', () => {
  assert.throws(() => buildScrollTargets({selectionTop: 100, selectionBottom: 200,
    viewportHeight: 0, maxScrollTop: 1200}), RangeError);
  assert.throws(() => buildScrollTargets({selectionTop: 100, selectionBottom: 200,
    viewportHeight: -1, maxScrollTop: 1200}), RangeError);
});

test('rejects negative max scroll positions', () => {
  assert.throws(() => buildScrollTargets({selectionTop: 100, selectionBottom: 200,
    viewportHeight: 300, maxScrollTop: -1}), RangeError);
});

test('rejects non-finite inputs', () => {
  const valid = {selectionTop: 100, selectionBottom: 200,
    viewportHeight: 300, maxScrollTop: 1200};
  for (const key of Object.keys(valid)) {
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.throws(() => buildScrollTargets({...valid, [key]: value}), RangeError);
    }
  }
});
