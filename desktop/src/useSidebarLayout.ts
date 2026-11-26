import { userProfileStorage } from "./UserProfileStorage";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { loadSidebarMode, type SidebarMode } from "./WorkspaceChrome";

const SIDEBAR_WIDTH_KEY = "hub.sidebar.context-width-v1";
const READING_SIDEBAR_WIDTH_KEY = "hub.reading.navigation-width-v1";
const LIBRARY_SIDEBAR_WIDTH_KEY = "hub.library-browse.navigation-width-v1";
const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 380;
const DOCK_COLLAPSE_WINDOW_WIDTH = 1440;
const MULTI_COLUMN_VIEWS = new Set(["home", "favorites", "collections", "tasks", "insights", "libraries"]);

function readAgentDockLayout() {
  if (!document.body.classList.contains("agent-sidebar-open")) return "undocked";
  return window.innerWidth < DOCK_COLLAPSE_WINDOW_WIDTH ? "narrow" : "wide";
}

function subscribeToAgentDockLayout(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", notify);
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", notify);
  };
}

function clampSidebarWidth(value: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

const defaultWidth = (key: string) => key === READING_SIDEBAR_WIDTH_KEY ? 206 : key === LIBRARY_SIDEBAR_WIDTH_KEY ? 248 : DEFAULT_SIDEBAR_WIDTH;

function loadSidebarWidth(key: string) {
  const fallback = defaultWidth(key);
  try {
    const stored = Number(userProfileStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : fallback;
  } catch {
    return fallback;
  }
}

export function useSidebarLayout(view?: string) {
  const widthKey = view === "collections" ? READING_SIDEBAR_WIDTH_KEY : view === "libraries" ? LIBRARY_SIDEBAR_WIDTH_KEY : SIDEBAR_WIDTH_KEY;
  const [savedMode, setSavedMode] = useState(loadSidebarMode);
  const dockLayout = useSyncExternalStore(subscribeToAgentDockLayout, readAgentDockLayout);
  const agentDocked = dockLayout !== "undocked";
  const [dockOverride, setDockOverride] = useState(false);
  const autoCollapsed = !dockOverride && agentDocked && (dockLayout === "narrow" || MULTI_COLUMN_VIEWS.has(view ?? ""));
  const mode = autoCollapsed ? "focus" : savedMode;
  const [narrow, setNarrow] = useState(() => window.matchMedia?.("(max-width: 1000px)").matches ?? false);
  const [drawer, setDrawer] = useState<"global" | "reading" | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth(widthKey));
  const sidebarWidthRef = useRef(sidebarWidth);
  useLayoutEffect(() => {
    const width = loadSidebarWidth(widthKey);
    sidebarWidthRef.current = width;
    setSidebarWidth(width);
  }, [widthKey]);
  useEffect(() => { if (!agentDocked) setDockOverride(false); }, [agentDocked]);
  useEffect(() => { if (autoCollapsed) setDrawer(null); }, [autoCollapsed]);
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
    else if (event.key === "Enter") next = defaultWidth(widthKey);
    else return;
    event.preventDefault();
    persistSidebarWidth(next);
  }, [persistSidebarWidth, widthKey]);
  const changeMode = useCallback((next: SidebarMode) => {
    if (agentDocked) setDockOverride(true);
    setSavedMode(next); setDrawer(null);
    try { userProfileStorage.setItem("hub.sidebar.mode", next); } catch { /* session only */ }
  }, [agentDocked]);
  const toggleNavigation = useCallback((target: "global" | "reading") => {
    if (narrow) {
      if (agentDocked) setDockOverride(true);
      setDrawer(open => open === target ? null : target);
    } else changeMode(mode === "focus" ? "standard" : "focus");
  }, [agentDocked, changeMode, mode, narrow]);
  const togglePanel = useCallback(() => toggleNavigation("global"), [toggleNavigation]);
  const toggleReadingPanel = useCallback(() => toggleNavigation("reading"), [toggleNavigation]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === "\\") {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.closest(".shortcut-setting-control")) return;
        event.preventDefault();
        togglePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePanel]);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 1000px)");
    if (!query) return;
    const resize = () => { setNarrow(query.matches); setDrawer(null); };
    query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, []);
  useEffect(() => setDrawer(null), [view]);
  useEffect(() => {
    if (!drawer || !narrow) return;
    const selector = drawer === "global" ? ":scope > .desktop-sidebar" : ".reading-context-navigation";
    const panel = document.querySelector(".unified-shell")?.querySelector<HTMLElement>(selector);
    const active = document.activeElement;
    const trigger = active instanceof HTMLElement && active !== document.body
      ? active
      : document.querySelector<HTMLElement>(drawer === "global" ? ".workspace-mode-cycle, .footer-restore-btn" : ".collection-header .workspace-panel-toggle");
    const frame = requestAnimationFrame(() => panel?.querySelector<HTMLElement>("button,input,select,[tabindex='0']")?.focus());
    const dismiss = (event: PointerEvent) => {
      if (!panel?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) setDrawer(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); setDrawer(null); trigger?.focus(); }
    };
    const focus = (event: FocusEvent) => {
      if (!panel?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) setDrawer(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", focus);
    window.addEventListener("keydown", key, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("focusin", focus); window.removeEventListener("keydown", key, true); };
  }, [drawer, narrow]);
  return {
    mode, drawerOpen: drawer === "global", togglePanel,
    panelExpanded: narrow ? drawer === "global" : mode !== "focus",
    readingPanelExpanded: narrow ? drawer === "reading" : mode !== "focus",
    toggleReadingPanel,
    collapsePanel: () => narrow ? setDrawer(null) : changeMode("focus"),
    sidebarWidth,
    sidebarWidthMin: MIN_SIDEBAR_WIDTH,
    sidebarWidthMax: MAX_SIDEBAR_WIDTH,
    resizeSidebar,
    resizeSidebarWithKeyboard,
    resetSidebarWidth: () => persistSidebarWidth(defaultWidth(widthKey)),
  };
}
