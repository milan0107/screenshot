import {OUTPUT_FORMAT} from './protocol.js';

/** JPEG 有损编码质量，越高越清晰但体积越大。 */
export const JPEG_QUALITY = 0.92;

/** JPEG 不支持透明通道，画布底色使用不透明白色。 */
export const JPEG_BACKGROUND = '#ffffff';

export function isOutputFormat(value) {
  return value === OUTPUT_FORMAT.PNG || value === OUTPUT_FORMAT.JPEG;
}

/** 未知或缺失的格式一律回退到 PNG，避免生成扩展名与内容不符的文件。 */
export function normalizeOutputFormat(value) {
  return value === OUTPUT_FORMAT.JPEG ? OUTPUT_FORMAT.JPEG : OUTPUT_FORMAT.PNG;
}

export function mimeTypeFor(format) {
  return normalizeOutputFormat(format) === OUTPUT_FORMAT.JPEG ? 'image/jpeg' : 'image/png';
}

export function extensionFor(format) {
  return normalizeOutputFormat(format) === OUTPUT_FORMAT.JPEG ? 'jpg' : 'png';
}
