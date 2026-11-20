export function buildScrollTargets({selectionTop, selectionBottom, viewportHeight, maxScrollTop, topInset = 0}) {
  if (![selectionTop, selectionBottom, viewportHeight, maxScrollTop, topInset].every(Number.isFinite)
    || selectionBottom <= selectionTop || viewportHeight <= 0 || maxScrollTop < 0) {
    throw new RangeError('Invalid capture range');
  }
  // topInset 是滚动表面可视区顶部相对 viewport.top 的偏移。内部容器被窗口
  // 裁掉顶部时，必须在更小的 scrollTop 上才能把选区起点对齐到可视区顶部。
  const first = Math.min(Math.max(0, selectionTop - topInset), maxScrollTop);
  const last = Math.min(Math.max(0, selectionBottom - topInset - viewportHeight), maxScrollTop);
  if (last <= first) return [first];
  const targets = [first];
  for (let top = first + viewportHeight; top < last; top += viewportHeight) targets.push(top);
  targets.push(last);
  return [...new Set(targets)];
}
