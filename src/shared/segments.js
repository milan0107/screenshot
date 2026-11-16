export function buildScrollTargets({selectionTop, selectionBottom, viewportHeight, maxScrollTop}) {
  if (![selectionTop, selectionBottom, viewportHeight, maxScrollTop].every(Number.isFinite)
    || selectionBottom <= selectionTop || viewportHeight <= 0 || maxScrollTop < 0) {
    throw new RangeError('Invalid capture range');
  }
  const first = Math.min(Math.max(0, selectionTop), maxScrollTop);
  const last = Math.min(Math.max(0, selectionBottom - viewportHeight), maxScrollTop);
  if (last <= first) return [first];
  const targets = [first];
  for (let top = first + viewportHeight; top < last; top += viewportHeight) targets.push(top);
  targets.push(last);
  return [...new Set(targets)];
}
