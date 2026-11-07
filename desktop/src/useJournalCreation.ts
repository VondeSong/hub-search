import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
type CreateJournalOutcome = { libraryId: string; libraryName: string; provider: string; action: string };
type SyncSummary = { indexed: number; skipped: number; deleted: number; failed: number };

export function useJournalCreation({ reloadSpaces, refreshStatus, setError }: { reloadSpaces: () => Promise<unknown>; refreshStatus: () => Promise<unknown> | void; setError: Dispatch<SetStateAction<string>> }) {
  const active = useRef(true), running = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
const [createJournalDate, setCreateJournalDate] = useState("");
const [creatingJournal, setCreatingJournal] = useState(false);

const createSelectedJournals = useCallback(async (libraryIds: string[]) => {
    if (!createJournalDate || !libraryIds.length || running.current) return;
    running.current = true;
    setCreatingJournal(true);
    setError("");
    try {
      const outcomes = await invoke<CreateJournalOutcome[]>("create_journals", {
        date: createJournalDate,
        libraryIds,
      });
      if (!active.current) return;
      setCreateJournalDate("");
      for (const outcome of outcomes) {
        await invoke<SyncSummary>("sync_library", { libraryId: outcome.libraryId });
        if (!active.current) return;
      }
      if (outcomes.length) {
        await reloadSpaces();
        if (!active.current) return;
        await refreshStatus();
      }
    } catch (reason) {
      if (active.current) setError(String(reason));
    } finally {
      running.current = false;
      if (active.current) setCreatingJournal(false);
    }
  }, [createJournalDate, refreshStatus, reloadSpaces, setError]);

return { createJournalDate, setCreateJournalDate, creatingJournal, createSelectedJournals };
}
