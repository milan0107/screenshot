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

test('clips a frame to the visible part of a partially visible surface', () => {
  const placement = computeFramePlacement({
    selection: {left: 0, top: 300, right: 400, bottom: 700},
    scrollLeft: 0, scrollTop: 200,
    viewport: {left: 10, top: -100, width: 400, height: 500},
    scaleX: 1, scaleY: 1
  });
  assert.deepEqual(placement, {sx: 10, sy: 0, sw: 400, sh: 400, dx: 0, dy: 0, dw: 400, dh: 400});
});

test('fractional scale keeps adjacent frame edges contiguous', () => {
  const selection = {left: 0, top: 0, right: 1000, bottom: 1826, width: 1000, height: 1826};
  const viewport = {left: 0, top: 0, width: 1000, height: 913};
  const frame = scrollTop => computeFramePlacement({
    selection, scrollLeft: 0, scrollTop, viewport, scaleX: 1, scaleY: 1.25
  });

  const first = frame(0);
  const second = frame(913);

  // 第一帧的底边必须正好等于第二帧的顶边；不能用「起点取整 + 高度取整」，
  // 否则 125% 缩放下每两帧之间会出现 1px 白线。
  assert.equal(first.dy + first.dh, second.dy);
  assert.equal(second.dy + second.dh, Math.round(selection.height * 1.25));
});
