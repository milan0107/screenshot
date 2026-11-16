export const MAX_EDGE = 30000;
export const MAX_PIXELS = 200_000_000;

export function validateOutput(width, height) {
  width = Math.round(width);
  height = Math.round(height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return {ok: false, reason: 'invalid'};
  if (width <= 0 || height <= 0) return {ok: false, reason: 'empty'};
  if (width > MAX_EDGE || height > MAX_EDGE) return {ok: false, reason: 'edge'};
  if (width * height > MAX_PIXELS) return {ok: false, reason: 'pixels'};
  return {ok: true, estimatedBytes: width * height * 4};
}
