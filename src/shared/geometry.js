export function normalizeRect(a, b) {
  const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function intersectRect(a, b) {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
  return right <= left || bottom <= top ? null :
    { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function computeFramePlacement({selection, scrollLeft, scrollTop, viewport, scaleX, scaleY}) {
  const visible = intersectRect(selection, {
    left: scrollLeft, top: scrollTop,
    right: scrollLeft + viewport.width, bottom: scrollTop + viewport.height
  });
  if (!visible) return null;
  const round = Math.round;
  return {
    sx: round((viewport.left + visible.left - scrollLeft) * scaleX),
    sy: round((viewport.top + visible.top - scrollTop) * scaleY),
    sw: round(visible.width * scaleX), sh: round(visible.height * scaleY),
    dx: round((visible.left - selection.left) * scaleX),
    dy: round((visible.top - selection.top) * scaleY),
    dw: round(visible.width * scaleX), dh: round(visible.height * scaleY)
  };
}
