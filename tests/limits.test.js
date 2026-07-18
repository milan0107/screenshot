import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutput } from '../src/shared/limits.js';

test('rejects an oversized edge', () => assert.deepEqual(validateOutput(1000, 30001),
  {ok: false, reason: 'edge'}));
test('accepts a normal output', () => assert.deepEqual(validateOutput(2000, 10000),
  {ok: true, estimatedBytes: 80000000}));

test('accepts dimensions at the exact edge limit', () => assert.deepEqual(validateOutput(30000, 1),
  {ok: true, estimatedBytes: 120000}));

test('accepts an output at the exact pixel limit', () => assert.deepEqual(validateOutput(20000, 10000),
  {ok: true, estimatedBytes: 800000000}));

test('rejects an output over the pixel limit', () => assert.deepEqual(validateOutput(20000, 10001),
  {ok: false, reason: 'pixels'}));

test('rejects an empty output', () => assert.deepEqual(validateOutput(0, 100),
  {ok: false, reason: 'empty'}));

test('rounds fractional dimensions before validating pixel count', () =>
  assert.deepEqual(validateOutput(29999.6, 6666.5), {ok: false, reason: 'pixels'}));

test('uses rounded dimensions to estimate bytes', () =>
  assert.deepEqual(validateOutput(10.4, 20.6), {ok: true, estimatedBytes: 840}));

test('rejects non-finite dimensions', () => {
  assert.deepEqual(validateOutput(NaN, 100), {ok: false, reason: 'invalid'});
  assert.deepEqual(validateOutput(100, Infinity), {ok: false, reason: 'invalid'});
});
