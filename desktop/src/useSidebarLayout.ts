import { userProfileStorage } from "./UserProfileStorage";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { loadSidebarMode, type SidebarMode } from "./WorkspaceChrome";

const SIDEBAR_WIDTH_KEY = "hub.sidebar.context-width-v1";
const LIBRARY_SIDEBAR_WIDTH_KEY = "hub.library-browse.navigation-width-v1";
const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 380;

function clampSidebarWidth(value: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

function loadSidebarWidth(key: string) {
  const fallback = key === LIBRARY_SIDEBAR_WIDTH_KEY ? 248 : DEFAULT_SIDEBAR_WIDTH;
  try {
    const stored = Number(userProfileStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : fallback;
  } catch {
    return fallback;
  }
}

export function useSidebarLayout(view?: string) {
  const widthKey = view === "libraries" ? LIBRARY_SIDEBAR_WIDTH_KEY : SIDEBAR_WIDTH_KEY;
  const [mode, setMode] = useState(loadSidebarMode);
  const [narrow, setNarrow] = useState(() => window.matchMedia?.("(max-width: 1000px)").matches ?? false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth(widthKey));
  const sidebarWidthRef = useRef(sidebarWidth);
  useLayoutEffect(() => {
    const width = loadSidebarWidth(widthKey);
    sidebarWidthRef.current = width;
    setSidebarWidth(width);
  }, [widthKey]);
  const expandedMode = useRef<SidebarMode>(mode === "focus" ? "compact" : mode);
  useEffect(() => { sidebarWidthRef.current = sidebarWidth; }, [sidebarWidth]);
  const persistSidebarWidth = useCallback((next: number) => {
    const width = clampSidebarWidth(next);
    sidebarWidthRef.current = width;
    setSidebarWidth(width);
    try { userProfileStorage.setItem(widthKey, String(width)); } catch { /* session only */ }
  }, [widthKey]);
  const resizeSidebar = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidthRef.current;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    document.body.classList.add("resizing-context-sidebar");
    const move = (moveEvent: PointerEvent) => {
      const next = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      sidebarWidthRef.current = next;
      setSidebarWidth(next);
    };
    const finish = () => {
      document.body.classList.remove("resizing-context-sidebar");
      persistSidebarWidth(sidebarWidthRef.current);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [persistSidebarWidth]);
  const resizeSidebarWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next = sidebarWidthRef.current;
    if (event.key === "ArrowLeft") next -= event.shiftKey ? 24 : 8;
    else if (event.key === "ArrowRight") next += event.shiftKey ? 24 : 8;
    else if (event.key === "Home") next = MIN_SIDEBAR_WIDTH;
    else if (event.key === "End") next = MAX_SIDEBAR_WIDTH;
    else if (event.key === "Enter") next = widthKey === LIBRARY_SIDEBAR_WIDTH_KEY ? 248 : DEFAULT_SIDEBAR_WIDTH;
    else return;
    event.preventDefault();
    persistSidebarWidth(next);
  }, [persistSidebarWidth]);
  const changeMode = useCallback((next: SidebarMode) => {
    setMode(next); setDrawerOpen(false);
    if (next !== "focus") expandedMode.current = next;
    try { userProfileStorage.setItem("hub.sidebar.mode", next); } catch { /* session only */ }
  }, []);
  const togglePanel = () => {
    if (narrow) setDrawerOpen(open => !open);
    else changeMode(mode === "focus" ? expandedMode.current : "focus");
  };
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 1000px)");
    if (!query) return;
    const resize = () => { setNarrow(query.matches); setDrawerOpen(false); };
    query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, []);
  useEffect(() => setDrawerOpen(false), [view]);
  useEffect(() => {
    if (!drawerOpen || !narrow) return;
    const selector = view === "tasks" ? ".task-module-sidebar" : view === "flashcards" ? ".flashcards-decks" : ".desktop-sidebar";
    const panel = document.querySelector<HTMLElement>(`.unified-shell ${selector}`);
    const triggers = Array.from(document.querySelectorAll<HTMLElement>(".workspace-panel-toggle"));
    const trigger = triggers.find(element => element.getClientRects().length > 0) ?? triggers[0];
    const frame = requestAnimationFrame(() => panel?.querySelector<HTMLElement>("button,input,select,[tabindex='0']")?.focus());
    const dismiss = (event: PointerEvent) => {
      if (!panel?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) setDrawerOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); setDrawerOpen(false); trigger?.focus(); }
    };
    const focus = (event: FocusEvent) => {
      if (!panel?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) setDrawerOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", focus);
    window.addEventListener("keydown", key, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("focusin", focus); window.removeEventListener("keydown", key, true); };
  }, [drawerOpen, narrow, view]);
  return {
    mode, changeMode, drawerOpen, togglePanel,
    panelExpanded: narrow ? drawerOpen : mode !== "focus",
    collapsePanel: () => narrow ? setDrawerOpen(false) : changeMode("focus"),
    sidebarWidth,
    sidebarWidthMin: MIN_SIDEBAR_WIDTH,
    sidebarWidthMax: MAX_SIDEBAR_WIDTH,
    resizeSidebar,
    resizeSidebarWithKeyboard,
    resetSidebarWidth: () => persistSidebarWidth(widthKey === LIBRARY_SIDEBAR_WIDTH_KEY ? 248 : DEFAULT_SIDEBAR_WIDTH),
  };
}
