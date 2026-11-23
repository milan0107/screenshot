export const MAX_EDGE = 30000;
export const MAX_PIXELS = 200_000_000;
/** chrome.tabs.sendMessage 的序列化上限约 64MB；dataURL 为 ASCII，留一半余量。 */
export const MAX_CLIPBOARD_DATA_URL_CHARS = 32 * 1024 * 1024;

export function validateOutput(width, height) {
  width = Math.round(width);
  height = Math.round(height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return {ok: false, reason: 'invalid'};
  if (width <= 0 || height <= 0) return {ok: false, reason: 'empty'};
  if (width > MAX_EDGE || height > MAX_EDGE) return {ok: false, reason: 'edge'};
  if (width * height > MAX_PIXELS) return {ok: false, reason: 'pixels'};
  return {ok: true, estimatedBytes: width * height * 4};
}
