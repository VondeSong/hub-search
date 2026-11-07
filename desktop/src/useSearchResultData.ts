import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { SearchResult } from "./SearchTypes";
import { useLocalSearch } from "./useLocalSearch";

/** Publish result order and its selected position atomically. A transient wrong
 * source would unmount the open assistant even if a later render corrected it. */
export function useSearchResultData({ selectionActive = true, ...options }: Omit<Parameters<typeof useLocalSearch>[0], "publishResults"> & { selectionActive?: boolean }) {
  const [{ results, selectedIndex }, setData] = useState<{ results: SearchResult[]; selectedIndex: number }>({ results: [], selectedIndex: -1 });
  const setSelectedIndex: Dispatch<SetStateAction<number>> = useCallback(value => {
    setData(current => ({ ...current, selectedIndex: typeof value === "function" ? value(current.selectedIndex) : value }));
  }, []);
  const publishResults = useCallback((next: SearchResult[], keepSelection: boolean) => {
    setData(current => {
      if (!selectionActive) return { ...current, results: next };
      const selected = keepSelection ? current.results[current.selectedIndex] : undefined;
      const preserved = selected ? next.findIndex(result => result.libraryId === selected.libraryId && result.entityKey === selected.entityKey && result.id === selected.id) : -1;
      return { results: next, selectedIndex: preserved >= 0 ? preserved : 0 };
    });
  }, [selectionActive]);
  const query = useLocalSearch({ ...options, publishResults });
  return { ...query, results, selectedIndex, setSelectedIndex };
}
