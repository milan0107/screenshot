import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extensionFor, isOutputFormat, JPEG_QUALITY, mimeTypeFor, normalizeOutputFormat
} from '../src/shared/formats.js';
import {OUTPUT_FORMAT} from '../src/shared/protocol.js';

test('PNG 与 JPG 的 MIME 类型和扩展名映射正确', () => {
  assert.equal(mimeTypeFor(OUTPUT_FORMAT.PNG), 'image/png');
  assert.equal(mimeTypeFor(OUTPUT_FORMAT.JPEG), 'image/jpeg');
  assert.equal(extensionFor(OUTPUT_FORMAT.PNG), 'png');
  assert.equal(extensionFor(OUTPUT_FORMAT.JPEG), 'jpg');
});

test('未知或缺失的格式回退为 PNG', () => {
  for (const value of [undefined, null, '', 'webp', 'image/jpeg', 'JPG']) {
    assert.equal(normalizeOutputFormat(value), OUTPUT_FORMAT.PNG);
    assert.equal(mimeTypeFor(value), 'image/png');
    assert.equal(extensionFor(value), 'png');
  }
});

test('isOutputFormat 只接受协议声明的两种格式', () => {
  assert.equal(isOutputFormat('png'), true);
  assert.equal(isOutputFormat('jpeg'), true);
  assert.equal(isOutputFormat('jpg'), false);
  assert.equal(isOutputFormat(undefined), false);
});

test('JPEG 编码质量保持在有损但高保真的区间', () => {
  assert.ok(JPEG_QUALITY > 0.8 && JPEG_QUALITY < 1);
});
