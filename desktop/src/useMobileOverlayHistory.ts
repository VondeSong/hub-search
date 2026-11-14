import { useCallback, useEffect, useRef } from "react";

type Options = {
  enabled: boolean; filtersOpen: boolean; settingsOpen: boolean;
  captureOpen?: boolean; setCaptureOpen?: (open: boolean) => void;
  setFiltersOpen: (open: boolean) => void; setSettingsOpen: (open: boolean) => void;
  setPreviewOpen: (open: boolean) => void; setFlashcardsOpen: (open: boolean) => void;
  setSelectedTag: (tag: string) => void; consumeSearchBack: () => boolean;
};

/** One owner for temporary mobile history entries and their exit/popstate rules. */
export function useMobileOverlayHistory(options: Options) {
  const latest = useRef(options); latest.current = options;
  const entries = useRef({ flashcards: false, preview: false, filters: false, settings: false, closingFilters: false, closingSettings: false, capture: false, closingCapture: false });
  const route = useRef<(value: string) => void>(() => undefined);
  const bindRoute = useCallback((handler: (value: string) => void) => { route.current = handler; }, []);
  const push = useCallback((kind: "flashcards" | "preview", key: string) => {
    if (!latest.current.enabled || entries.current[kind]) return;
    window.history.pushState({ ...(window.history.state ?? {}), [key]: true }, "");
    entries.current[kind] = true;
  }, []);
  const openFlashcards = useCallback(() => {
    if(latest.current.enabled&&entries.current.preview){
      entries.current.preview=false;entries.current.flashcards=true;
      window.history.replaceState({...window.history.state,hubMobilePreview:false,hubFlashcards:true},"");
    }else push("flashcards", "hubFlashcards");
    latest.current.setFlashcardsOpen(true);
    latest.current.setFiltersOpen(false);
    latest.current.setPreviewOpen(false);
  }, [push]);
  const closeFlashcards = useCallback(() => {
    if (latest.current.enabled && entries.current.flashcards) window.history.back();
    else latest.current.setFlashcardsOpen(false);
  }, []);
  const openPreview = useCallback(() => {
    push("preview", "hubMobilePreview"); latest.current.setPreviewOpen(true);
  }, [push]);
  const closePreview = useCallback(() => {
    if (latest.current.enabled && entries.current.preview) window.history.back();
    else latest.current.setPreviewOpen(false);
  }, []);
  const openRouteFromPreview=useCallback((value:string)=>{
    if(!latest.current.enabled||!entries.current.preview)return false;
    entries.current.preview=false;window.history.replaceState({hubMobileRoute:value},"");
    latest.current.setPreviewOpen(false);route.current(value);return true;
  },[]);
  useEffect(() => {
    if (!options.enabled) return;
    if (!window.history.state?.hubMobileRoute) window.history.replaceState({ ...(window.history.state ?? {}), hubMobileRoute: "search" }, "");
    const pop = (event: PopStateEvent) => {
      const state = entries.current, current = latest.current;
      if (state.closingCapture) { state.closingCapture = false; return; }
      if (state.closingFilters) { state.closingFilters = false; return; }
      if (state.closingSettings) { state.closingSettings = false; return; }
      if (state.settings) { state.settings = false; current.setSettingsOpen(false); return; }
      if (state.capture) { state.capture = false; current.setCaptureOpen?.(false); return; }
      if (state.flashcards) { state.flashcards = false; current.setFlashcardsOpen(false); return; }
      if (state.preview) { state.preview = false; current.setPreviewOpen(false); return; }
      if (state.filters) { state.filters = false; current.setFiltersOpen(false); return; }
      if (current.consumeSearchBack()) return;
      route.current(event.state?.hubMobileRoute ?? "search");
      current.setSelectedTag(event.state?.hubMobileTag ?? "");
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [options.enabled]);
  useEffect(() => {
    if (!options.enabled) return;
    const state = entries.current;
    if (options.filtersOpen && !state.filters) {
      window.history.pushState({ ...(window.history.state ?? {}), hubMobileFilter: true }, ""); state.filters = true;
    } else if (!options.filtersOpen && state.filters) {
      state.filters = false;
      if (window.history.state?.hubMobileFilter) { state.closingFilters = true; window.history.back(); }
    }
  }, [options.enabled, options.filtersOpen]);
  useEffect(() => {
    if (!options.enabled) return;
    const state = entries.current;
    if (options.settingsOpen && !state.settings) {
      if (!window.history.state?.hubSettings) window.history.pushState({ ...(window.history.state ?? {}), hubSettings: true }, ""); state.settings = true;
    } else if (!options.settingsOpen && state.settings) {
      state.settings = false; state.closingSettings = true; window.history.back();
    }
  }, [options.enabled, options.settingsOpen]);
  useEffect(() => {
    if (!options.enabled) return;
    const state = entries.current;
    if (options.captureOpen && !state.capture) {
      window.history.pushState({ ...(window.history.state ?? {}), hubQuickCapture: true }, ""); state.capture = true;
    } else if (!options.captureOpen && state.capture) {
      state.capture = false;
      if (window.history.state?.hubQuickCapture) { state.closingCapture = true; window.history.back(); }
    }
  }, [options.enabled, options.captureOpen]);
  return { openFlashcards, closeFlashcards, openPreview, closePreview, bindRoute, openRouteFromPreview };
}
