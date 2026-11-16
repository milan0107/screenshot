import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRect, computeFramePlacement } from '../src/shared/geometry.js';

test('normalizes a drag in any direction', () => {
  assert.deepEqual(normalizeRect({x: 30, y: 50}, {x: 10, y: 20}),
    {left: 10, top: 20, right: 30, bottom: 50, width: 20, height: 30});
});

test('maps visible content into screenshot source and output destination', () => {
  assert.deepEqual(computeFramePlacement({
    selection: {left: 20, top: 100, right: 220, bottom: 900},
    scrollLeft: 0, scrollTop: 500,
    viewport: {left: 10, top: 50, width: 300, height: 300},
    scaleX: 2, scaleY: 2
  }), {sx: 60, sy: 100, sw: 400, sh: 600, dx: 0, dy: 800, dw: 400, dh: 600});
});
