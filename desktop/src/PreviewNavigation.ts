import type { SearchResult } from "./SearchTypes";

export type PreviewNavigationState = { entries: SearchResult[]; index: number };

export const EMPTY_PREVIEW_NAVIGATION: PreviewNavigationState = { entries: [], index: -1 };

export function pushPreviewNavigation(
  current: PreviewNavigationState,
  result: SearchResult,
  limit = 50,
): PreviewNavigationState {
  const active = current.entries[current.index];
  if (active?.entityKey === result.entityKey && active.id === result.id) return current;
  const entries = [...current.entries.slice(0, current.index + 1), result].slice(-Math.max(1, limit));
  return { entries, index: entries.length - 1 };
}

export function movePreviewNavigation(
  current: PreviewNavigationState,
  direction: -1 | 1,
): PreviewNavigationState {
  const index = Math.max(0, Math.min(current.entries.length - 1, current.index + direction));
  return index === current.index ? current : { ...current, index };
}
