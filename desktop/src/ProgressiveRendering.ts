export function progressiveSlice<T>(items: T[], visibleCount: number): T[] {
  return visibleCount >= items.length ? items : items.slice(0, Math.max(0, visibleCount));
}

export function nextProgressiveCount(current: number, total: number, pageSize: number): number {
  return Math.min(Math.max(0, total), Math.max(0, current) + Math.max(1, pageSize));
}
