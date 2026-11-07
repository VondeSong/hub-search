import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { LibrarySummary } from "./SearchTypes";
import type { useLibraryManagement } from "./LibraryManagement";
import type { showOperationStatus as OperationNotifier } from "./useOperationStatus";

type Options = {
  ready: boolean; spaces: LibrarySummary[]; activeSpaces: LibrarySummary[];
  selectedLibraryIds: string[] | null; documentCount: number | undefined;
  libraryManagement: ReturnType<typeof useLibraryManagement>;
  reloadSpaces: () => Promise<unknown>; refreshStatus: () => Promise<unknown> | void;
  setError: Dispatch<SetStateAction<string>>; showOperationStatus: typeof OperationNotifier;
};

/** Owns sync submission and the once-per-session empty-index bootstrap. */
export function useWorkspaceIndexing({ ready, spaces, activeSpaces, selectedLibraryIds, documentCount, libraryManagement, reloadSpaces, refreshStatus, setError, showOperationStatus }: Options) {
  const [syncing, setSyncing] = useState(false);
  const inFlight = useRef(false);
  const initialIndexStarted = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const refreshIndex = useCallback(async () => {
    if (spaces.length === 0 || inFlight.current) return;
    inFlight.current = true;
    setSyncing(true); setError("");
    try {
      const scope = selectedLibraryIds === null ? spaces : activeSpaces;
      const eligible = scope.filter(space => space.connected && !["paused", "pausing", "cancelled", "removing", "removed"].includes(libraryManagement.libraries[space.id]?.state || ""));
      const accepted = await Promise.allSettled(eligible.map(space => libraryManagement.act(space.id, "sync")));
      if (!active.current) return;
      await reloadSpaces();
      if (!active.current) return;
      await refreshStatus();
      if (!active.current) return;
      const started = accepted.filter(item => item.status === "fulfilled").length;
      showOperationStatus(started ? `已提交 ${started} 个资料库同步请求，后台分别处理` : "没有提交同步请求；暂停的资料库需先继续", started ? "success" : "working");
    } catch (reason) { if (active.current) setError(String(reason)); }
    finally { inFlight.current = false; if (active.current) setSyncing(false); }
  }, [activeSpaces, refreshStatus, reloadSpaces, selectedLibraryIds, spaces, libraryManagement.libraries, libraryManagement.act, setError, showOperationStatus]);

  useEffect(() => {
    if (!ready || syncing || initialIndexStarted.current || documentCount !== 0 || !spaces.some(space => space.connected)) return;
    initialIndexStarted.current = true;
    void refreshIndex();
  }, [documentCount, ready, refreshIndex, spaces, syncing]);
  return { syncing, refreshIndex };
}
