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

/**
 * 把「选区内容坐标」里的一帧映射到截图源矩形与输出目标矩形。
 *
 * - selection / scrollLeft / scrollTop 都是滚动内容坐标（CSS 像素）。
 * - viewport 是滚动表面在客户端坐标系里的完整可视区；visible 是它与浏览器窗口的
 *   交集（客户端坐标，省略时等于 viewport）——`captureVisibleTab` 只能截到 visible，
 *   所以源矩形必须夹在它里面，否则会被浏览器裁剪并连带缩放目标矩形。
 * - scaleX / scaleY 是截图像素与标签页视口 CSS 像素之比（bitmap / window.innerWidth），
 *   由离屏拼接按首帧位图实测：截的始终是整个标签页视口，不能用内部容器尺寸换算。
 */
export function computeFramePlacement({selection, scrollLeft, scrollTop, viewport, visible, scaleX, scaleY}) {
  const area = visible ?? {left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height};
  // visible 左上角对应的内容坐标
  const contentLeft = scrollLeft + (area.left - viewport.left);
  const contentTop = scrollTop + (area.top - viewport.top);
  const region = intersectRect(selection, {
    left: contentLeft, top: contentTop,
    right: contentLeft + area.width, bottom: contentTop + area.height
  });
  if (!region) return null;
  const round = Math.round;
  const width = region.width * scaleX;
  const height = region.height * scaleY;
  // 目的矩形的两条边分别取整，而不是「起点取整 + 宽度取整」：
  // 后者在非整数缩放比（如 125%）下会让相邻两帧的接缝差 1px，画布上出现白线。
  const dx = round((region.left - selection.left) * scaleX);
  const dy = round((region.top - selection.top) * scaleY);
  const dw = Math.max(1, round((region.right - selection.left) * scaleX) - dx);
  const dh = Math.max(1, round((region.bottom - selection.top) * scaleY) - dy);
  return {
    sx: round((area.left + (region.left - contentLeft)) * scaleX),
    sy: round((area.top + (region.top - contentTop)) * scaleY),
    sw: round(width), sh: round(height),
    dx,
    dy,
    dw, dh
  };
}

/** 滚动表面顶部相对 window 顶部的偏移；两者相同时为 0。 */
export function visibleTopInset(metrics) {
  const viewportTop = Number.isFinite(metrics?.viewport?.top) ? metrics.viewport.top : 0;
  const visibleTop = Number.isFinite(metrics?.visible?.top) ? metrics.visible.top : viewportTop;
  return visibleTop - viewportTop;
}
