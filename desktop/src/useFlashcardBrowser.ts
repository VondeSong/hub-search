import { useCallback, useEffect, useRef, useState } from "react";
import { loadFlashcardPage, loadFlashcardSelection, type FlashcardPage, type FlashcardScope } from "./FlashcardQueries";
import { FLASHCARD_STAGE_LABELS, type FlashcardStage } from "./FlashcardWorkspacePresentation";

const stages = Object.keys(FLASHCARD_STAGE_LABELS) as FlashcardStage[];
const emptyPage = (): FlashcardPage => ({ items: [], total: 0, matchedTotal: 0, scopeTotal: 0, revision: "0", asOf: 0, tags: [], customFieldKeys: [], stageCounts: { new: 0, due: 0, learning: 0, mastered: 0, suspended: 0 } });
type Browser = { page: FlashcardPage; columns: Partial<Record<FlashcardStage, FlashcardPage>> };

export function useFlashcardBrowser(scope: FlashcardScope, layout: "linear" | "grid" | "column", enabled: boolean, onError: (error: string) => void) {
  const key = JSON.stringify([scope, layout, enabled]);
  const owner = useRef({ key, generation: 0, mounted: true });
  if (owner.current.key !== key) { owner.current.key = key; owner.current.generation++; }
  const config = useRef({ scope, layout, enabled, onError });
  config.current = { scope, layout, enabled, onError };
  const [state, setState] = useState<Browser>(() => ({ page: emptyPage(), columns: {} }));
  const latest = useRef(state); latest.current = state;
  const pending = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const size = (mode: typeof layout) => mode === "grid" ? 12 : mode === "column" ? 24 : 60;

  const refresh = useCallback(async () => {
    const { scope, layout, enabled } = config.current;
    if (!enabled) return;
    const generation = ++owner.current.generation;
    const current = () => owner.current.mounted && owner.current.generation === generation;
    setBusy(true);
    setSelectionBusy(false);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const page = await loadFlashcardPage(scope, 0, size(layout), null, null, true);
          if (!current()) return;
          const columns: Browser["columns"] = {};
          if (layout === "column") {
            for (const stage of stages) {
              if (!current()) return;
              columns[stage] = await loadFlashcardPage({ ...scope, query: { ...scope.query, columnStage: stage } }, 0, size(layout), page.revision, page.asOf);
            }
          }
          if (current()) setState({ page, columns });
          return;
        } catch (error) {
          if (attempt === 0 && String(error).includes("FLASHCARD_LIST_CHANGED") && current()) continue;
          throw error;
        }
      }
    } catch (error) { if (current()) config.current.onError(String(error)); }
    finally { if (current()) setBusy(false); }
  }, []);

  useEffect(() => {
    owner.current.mounted = true;
    setState({ page: emptyPage(), columns: {} });
    setBusy(false); setSelectionBusy(false);
    void refresh();
    return () => { owner.current.generation++; };
  }, [key, refresh]);
  useEffect(() => () => { owner.current.mounted = false; owner.current.generation++; }, []);

  const more = useCallback(async (stage?: FlashcardStage) => {
    const { scope, layout, enabled } = config.current;
    if (!enabled) return;
    const generation = owner.current.generation;
    const current = () => owner.current.mounted && owner.current.generation === generation;
    const token = `${generation}:${stage ?? "page"}`;
    if (pending.current.has(token)) return;
    const previous = stage ? latest.current.columns[stage] : latest.current.page;
    if (!previous || previous.items.length >= previous.total) return;
    pending.current.add(token);
    try {
      const page = await loadFlashcardPage(stage ? { ...scope, query: { ...scope.query, columnStage: stage } } : scope, previous.items.length, size(layout), previous.revision, previous.asOf);
      if (!page.items.length && previous.items.length < page.total) throw new Error("闪卡列表分页未完成，请刷新重试");
      if (current()) setState(state => stage
        ? { ...state, columns: { ...state.columns, [stage]: { ...page, items: [...previous.items, ...page.items] } } }
        : { ...state, page: { ...state.page, ...page, items: [...previous.items, ...page.items] } });
    } catch (error) {
      if (!current()) return;
      if (String(error).includes("FLASHCARD_LIST_CHANGED")) await refresh();
      else config.current.onError(String(error));
    } finally { pending.current.delete(token); }
  }, [refresh]);

  const selectAll = useCallback(async (): Promise<string[] | null> => {
    const generation = owner.current.generation;
    const current = () => owner.current.mounted && owner.current.generation === generation;
    setSelectionBusy(true);
    try {
      const page = latest.current.page;
      const ids = await loadFlashcardSelection(config.current.scope, page.revision, page.asOf, current);
      return current() ? ids : null;
    } catch (error) {
      if (current()) {
        config.current.onError(String(error));
        if (String(error).includes("FLASHCARD_LIST_CHANGED")) await refresh();
      }
      return null;
    } finally { if (current()) setSelectionBusy(false); }
  }, [refresh]);

  return { ...state, busy, selectionBusy, refresh, more, selectAll };
}
