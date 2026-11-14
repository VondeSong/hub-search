import { TaskPlanningPanel } from "./TaskPlanningPanel";
import { loadPlanningRecords, removePlanningDay, planningEligible, taskIdentity, type PlanningRequest, type PlanningRecord, type PlanningMode } from "./TaskPlanning";
import { writeResultDragData } from "./ResultActions";
import { userProfileStorage } from "./UserProfileStorage";
import { resolveTaskResult, taskSearchResult } from "./TaskWorkspaceResult";
import { TaskPreviewPane } from "./TaskPreviewPane";
import { usePreviewLinkCopy } from "./usePreviewLinkCopy";
import "./TaskSyncResume.css";
import { resultLinkRequest } from "./ResultActions";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  ArrowUpRight,
  ArrowUpDown,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  Eye,
  History,
  LayoutList,
  Link2,
  ListFilter,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  ShieldCheck,
  Sparkles,
  CalendarCheck,
  Table2,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { useExternalLinkOpener } from "./useExternalLinkOpener";
import type { OperationTone } from "./useOperationStatus";
import { useUnifiedTasks } from "./UnifiedTaskData";
import { TaskStatusControl, TaskStatusNotice } from "./TaskStatusControl";
export type { UnifiedTaskDashboard } from "./UnifiedTaskData";
import { useWorkspaceSession, useWorkspaceScroll } from "./useWorkspaceSession";
import { runtimeCapabilities } from "./RuntimePlatform";
import { WorkspaceFilterSummary } from "./WorkspaceFilterSummary";
import {
  filterCollapsedTaskDescendants,
  filterAndSortTasks,
  filterTasksByLibraries,
  taskCollectionKey,
  taskCollections,
  groupTasksByProvider,
  summarizeTasks,
  restoreTaskStatusFilter,
  type TaskSort,
  type TaskSourceFilter as SourceFilter,
  type TaskStatusFilter as StatusFilter,
  type UnifiedTask,
} from "./TaskWorkspacePresentation";

export type { UnifiedTask } from "./TaskWorkspacePresentation";

type TaskSyncPreview = {
  craftUnlinked: number;
  didaUnlinked: number;
  linked: number;
  exactTitleCandidates: number;
  libraries: Array<{ libraryId: string; name: string }>;
  safeToEnable: boolean;
  message: string;
};

type TaskSyncCapabilities = {
  craftConnected: boolean;
  craftWriteAvailable: boolean;
  didaConnected: boolean;
  didaWriteTools: string[];
  missingDidaWriteTools: string[];
  readyForControlledSync: boolean;
  message: string;
};

type TaskSyncRunSummary = {
  createdInDida: number;
  createdInCraft: number;
  updatedInDida: number;
  updatedInCraft: number;
  deletedInDida: number;
  deletedInCraft: number;
  conflicts: number;
  pausedProjects: number;
  failed: number;
  message: string;
};

type TaskSyncLogEntry = {
  id: number;
  occurredAt: number;
  title: string;
  action: "scan" | "create" | "update" | "delete" | "conflict" | "error";
  sourceProvider: string;
  targetProvider: string;
  status: "success" | "review" | "failed";
  detail: string;
};

type TaskSyncLogRun = {
  id: number;
  startedAt: number;
  completedAt: number;
  fullReconcile: boolean;
  status: "running" | "completed" | "completed_with_errors" | "interrupted";
  summary: string;
  entries: TaskSyncLogEntry[];
};

type Props = {
  libraries?: LibrarySummary[];
  selectedLibraryIds?: string[] | null;
  onClearLibraryScope?: () => void;
  desktopSidebarVisible: boolean;
  onToggleDesktopSidebar?: () => void;
  onCountChange?: (count: number) => void;
  onStatusMessage?: (message: string, tone?: OperationTone, duration?: number) => void;
  onOpenResult?: (result: SearchResult, source?: "result" | "preview") => void;
};

type TaskViewMode = "list" | "board" | "table";
type TaskDensity = "compact" | "comfortable" | "spacious";
type TaskColorMode = "none" | "status" | "source" | "sync";
type TaskSavedView = {
  id: string;
  name: string;
  viewMode: TaskViewMode;
  statusFilter: StatusFilter;
  sourceFilter: SourceFilter;
  tableProperties: Record<TaskTableProperty, boolean>;
  density: TaskDensity;
  sort: TaskSort;
  sortAscending: boolean;
  colorMode: TaskColorMode;
};
type TaskTableProperty = "source" | "library" | "document" | "start" | "due" | "sync";
type ConflictResolution = "craft_wins" | "dida_wins" | "merge" | "unlink" | "remove_from_dida" | "keep_current_binding" | "use_managed_source";

const TASK_VIEW_STORAGE_KEY = "hub.tasks.database-view.v2";
const TASK_SAVED_VIEWS_STORAGE_KEY = "hub.tasks.saved-views.v1";
const TASK_ACTIVE_VIEW_STORAGE_KEY = "hub.tasks.active-view.v1";
const TASK_COLLAPSE_STORAGE_KEY = "hub.tasks.collapsed-parent-tasks.v2";
const LEGACY_TASK_COLLAPSE_STORAGE_KEY = "hub.tasks.collapsed-projects";
const DEFAULT_TASK_TABLE_PROPERTIES: Record<TaskTableProperty, boolean> = {
  source: true,
  library: false,
  document: false,
  start: true,
  due: true,
  sync: true,
};

function loadTaskViewPreferences(): {
  viewMode: TaskViewMode;
  statusFilter: StatusFilter;
  sourceFilter: SourceFilter;
  tableProperties: Record<TaskTableProperty, boolean>;
  density: TaskDensity;
  sort: TaskSort;
  sortAscending: boolean;
  colorMode: TaskColorMode;
} {
  const fallback = {
    viewMode: "list" as TaskViewMode,
    statusFilter: "open" as StatusFilter,
    sourceFilter: "all" as SourceFilter,
    tableProperties: DEFAULT_TASK_TABLE_PROPERTIES,
    density: "comfortable" as TaskDensity,
    sort: "default" as TaskSort,
    sortAscending: true,
    colorMode: "none" as TaskColorMode,
  };
  try {
    const stored = userProfileStorage.getItem(TASK_VIEW_STORAGE_KEY);
    if (!stored) {
      const legacyView = userProfileStorage.getItem("hub.tasks.view-mode");
      return { ...fallback, viewMode: legacyView === "board" || legacyView === "table" ? legacyView : "list" };
    }
    const parsed = JSON.parse(stored) as Partial<typeof fallback>;
    return {
      viewMode: parsed.viewMode === "board" || parsed.viewMode === "table" ? parsed.viewMode : "list",
      statusFilter: restoreTaskStatusFilter(parsed.statusFilter),
      sourceFilter: parsed.sourceFilter === "craft" || parsed.sourceFilter === "dida365" || parsed.sourceFilter === "obsidian" ? parsed.sourceFilter : "all",
      tableProperties: { ...DEFAULT_TASK_TABLE_PROPERTIES, ...(parsed.tableProperties ?? {}) },
      density: parsed.density === "compact" || parsed.density === "spacious" ? parsed.density : "comfortable",
      sort: parsed.sort === "title" || parsed.sort === "due" || parsed.sort === "updated" ? parsed.sort : "default",
      sortAscending: typeof parsed.sortAscending === "boolean" ? parsed.sortAscending : true,
      colorMode: parsed.colorMode === "status" || parsed.colorMode === "source" || parsed.colorMode === "sync" ? parsed.colorMode : "none",
    };
  } catch {
    return fallback;
  }
}

function loadTaskSavedViews(preferences: ReturnType<typeof loadTaskViewPreferences>): TaskSavedView[] {
  try {
    const stored = JSON.parse(userProfileStorage.getItem(TASK_SAVED_VIEWS_STORAGE_KEY) ?? "[]") as TaskSavedView[];
    if (Array.isArray(stored) && stored.length > 0) return stored.map((view) => ({
      ...preferences,
      ...view,
      tableProperties: { ...DEFAULT_TASK_TABLE_PROPERTIES, ...(view.tableProperties ?? {}) },
    }));
  } catch { /* use the compatible defaults below */ }
  return ([ ["list", "列表"], ["board", "看板"], ["table", "表格"] ] as const).map(([viewMode, name]) => ({
    id: `default-${viewMode}`,
    name,
    ...preferences,
    viewMode,
  }));
}

function providerLabel(provider: UnifiedTask["provider"]): string {
  if (provider === "dida365") return "滴答清单";
  if (provider === "obsidian") return "Obsidian";
  return "Craft";
}

function syncProviderLabel(provider: string): string {
  if (provider === "dida365") return "滴答清单";
  if (provider === "craft") return "Craft";
  if (provider === "craft+dida365") return "Craft 与滴答清单";
  return provider;
}

function syncActionLabel(action: TaskSyncLogEntry["action"]): string {
  if (action === "scan") return "核对";
  if (action === "create") return "新建";
  if (action === "update") return "更新";
  if (action === "delete") return "删除";
  if (action === "conflict") return "冲突";
  return "失败";
}

function syncTimeLabel(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function shortSourceId(value?: string): string {
  if (!value) return "未知 ID";
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function identityChoiceNote(resolution?: ConflictResolution): string {
  if (resolution === "use_managed_source") return "切换到滴答来源链接指向的 Craft 任务；不会覆盖正文，如内容不同会继续要求确认。";
  if (resolution === "keep_current_binding") return "保留当前绑定，仅修正滴答中的来源链接；不会覆盖两端正文。";
  if (resolution === "remove_from_dida") return "保留 Craft，从滴答删除当前任务及同一 Craft 来源的副本，并永久停止再次导出。";
  if (resolution === "unlink") return "两端任务都保留并永久停止关联；不会在下次同步时从 Craft 重新创建。";
  return "请选择要保留的任务对应关系。";
}

function dueLabel(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function scheduleLabel(start?: string, due?: string, isAllDay = false): string {
  if (isAllDay) {
    if (!start) return dueLabel(due);
    const startDate = dueLabel(start);
    const dueDate = dueLabel(due);
    return dueDate && dueDate !== startDate ? `${startDate} – ${dueDate}` : startDate;
  }
  const format = (value: string, withDate: boolean) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value.slice(0, 16).replace("T", " ");
    return new Intl.DateTimeFormat("zh-CN", {
      ...(withDate ? { month: "numeric", day: "numeric" } : {}),
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date);
  };
  if (!start) return dueLabel(due);
  if (!due || due === start) return format(start, true);
  return `${format(start, true)} – ${format(due, true)}`;
}

function taskConditionalColor(task: UnifiedTask, mode: TaskColorMode): string {
  if (mode === "status" && task.status === "abandoned") return "";
  if (mode === "status") return task.completed ? "task-color-green" : "task-color-yellow";
  if (mode === "source") return `task-color-${task.provider}`;
  if (mode === "sync") return task.syncState === "conflict" || task.syncState === "paused"
    ? "task-color-red"
    : task.syncState === "linked" ? "task-color-green" : "task-color-gray";
  return "";
}

function taskTitleContent(title: string, onOpenLink: (href: string) => void): ReactNode {
  const markdownLink = /\[([^\]]+)\]\s*\((https?:\/\/[^\s)]+)\)/gi;
  const content: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = markdownLink.exec(title)) !== null) {
    if (match.index > cursor) content.push(title.slice(cursor, match.index));
    const href = match[2];
    content.push(<a key={`${match.index}:${href}`} href={href} title={href} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onOpenLink(href); }}>{match[1]}</a>);
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return title;
  if (cursor < title.length) content.push(title.slice(cursor));
  return content;
}

export function TaskWorkspace({
  libraries = [],
  selectedLibraryIds = null,
  onClearLibraryScope,
  desktopSidebarVisible,
  onToggleDesktopSidebar,
  onCountChange,
  onStatusMessage,
  onOpenResult,
}: Props) {
  useEffect(() => { setPlanning(null); }, [selectedLibraryIds]);
  const initialViewPreferences = useMemo(loadTaskViewPreferences, []);
  const initialTaskViews = useMemo(() => loadTaskSavedViews(initialViewPreferences), [initialViewPreferences]);
  const { dashboard, loading, error: taskDataError, refresh, setTaskCompleted, taskBusyIds, taskStatusTargets } = useUnifiedTasks();
  const [planning, setPlanning] = useState<PlanningRequest | null>(null);
  const [todayOnly, setTodayOnly] = useState(false);
  const [planningRecords, setPlanningRecords] = useState<PlanningRecord[]>(() => { try { return loadPlanningRecords(); } catch { return []; } });
  const planningDay = new Date().toLocaleDateString("sv-SE");
  const planningRecord = (t: UnifiedTask) => planningRecords.find(r => r.identity === taskIdentity(t));
  const refreshPlanningRecords = () => { try { setPlanningRecords(loadPlanningRecords()); } catch (e) { onStatusMessage?.(String(e), "error"); } };
  const [localError, setError] = useState("");
  const error = localError || taskDataError;
  const openExternalLink = useExternalLinkOpener({ showStatus: onStatusMessage, setError });
  const [query, setQuery] = useWorkspaceSession("tasks.query", "");
  const [collectionKey, setCollectionKey] = useWorkspaceSession("tasks.collection", "");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialViewPreferences.statusFilter);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(initialViewPreferences.sourceFilter);
  const [viewMode, setViewMode] = useState<TaskViewMode>(initialViewPreferences.viewMode);
  const [tableProperties, setTableProperties] = useState<Record<TaskTableProperty, boolean>>(initialViewPreferences.tableProperties);
  const [taskDensity, setTaskDensity] = useState<TaskDensity>(initialViewPreferences.density);
  const [taskSort, setTaskSort] = useState<TaskSort>(initialViewPreferences.sort);
  const [taskSortAscending, setTaskSortAscending] = useState(initialViewPreferences.sortAscending);
  const [taskColorMode, setTaskColorMode] = useState<TaskColorMode>(initialViewPreferences.colorMode);
  const [taskViews, setTaskViews] = useState<TaskSavedView[]>(initialTaskViews);
  const [activeTaskViewId, setActiveTaskViewId] = useState(() => {
    const stored = userProfileStorage.getItem(TASK_ACTIVE_VIEW_STORAGE_KEY);
    return initialTaskViews.some((view) => view.id === stored) ? stored! : initialTaskViews.find((view) => view.viewMode === initialViewPreferences.viewMode)?.id ?? initialTaskViews[0].id;
  });
  const [queryToolsOpen, setQueryToolsOpen] = useState(false);
  const [databaseSearchOpen, setDatabaseSearchOpen] = useState(false);
  const [taskStatsOpen, setTaskStatsOpen] = useState(false);
  const [renamingTaskViewId, setRenamingTaskViewId] = useState<string | null>(null);
  const queryToolsRef = useRef<HTMLDivElement>(null);
  const queryToolsButtonRef = useRef<HTMLButtonElement>(null);
  const propertyMenuRef = useRef<HTMLDetailsElement>(null);
  const [syncPreview, setSyncPreview] = useState<TaskSyncPreview | null>(null);
  const [previewingSync, setPreviewingSync] = useState(false);
  const [syncCapabilities, setSyncCapabilities] = useState<TaskSyncCapabilities | null>(null);
  const [checkingCapabilities, setCheckingCapabilities] = useState(false);
  const [selectedSyncLibrary, setSelectedSyncLibrary] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [backgroundSyncing, setBackgroundSyncing] = useState(false);
  const [fullSyncing, setFullSyncing] = useState(false);
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [syncLogOpen, setSyncLogOpen] = useState(false);
  const [syncLogs, setSyncLogs] = useState<TaskSyncLogRun[]>([]);
  const [selectedSyncLogId, setSelectedSyncLogId] = useState<number | null>(null);
  const [syncLogLoading, setSyncLogLoading] = useState(false);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [savingBackgroundInterval, setSavingBackgroundInterval] = useState(false);
  const [conflictChoices, setConflictChoices] = useState<Record<number, ConflictResolution>>({});
  const [previewEnabled,setPreviewEnabled]=useState(true);
  const [selectedTask, setSelectedTask] = useWorkspaceSession<UnifiedTask | null>("tasks.selection", null);
  const [previewPinned, setPreviewPinned] = useState(false);
  useEffect(() => { if (!selectedTask) setPreviewPinned(false); }, [selectedTask]);
  const [previewHistory, setPreviewHistory] = useState<{ entries: UnifiedTask[]; index: number }>(() => ({
    entries: selectedTask ? [selectedTask] : [], index: selectedTask ? 0 : -1,
  }));
  const selectTaskPreview = useCallback((task: UnifiedTask) => {
    setPlanning(null);
    setPreviewEnabled(true);
    if (previewPinned) return;
    setSelectedTask(task);
    setPreviewHistory(current => {
      if (current.entries[current.index]?.id === task.id) return current;
      const entries = [...current.entries.slice(0, current.index + 1), task].slice(-50);
      return { entries, index: entries.length - 1 };
    });
  }, [previewPinned, setSelectedTask]);
  const navigateTaskPreview = useCallback((direction: -1 | 1) => {
    const index = previewHistory.index + direction;
    const entry = previewHistory.entries[index];
    if (!entry) return;
    setPreviewHistory(current => ({ ...current, index }));
    setSelectedTask(dashboard.tasks.find(task => task.id === entry.id) ?? entry);
  }, [dashboard.tasks, previewHistory, setSelectedTask]);
  const showPreviewStatus = useCallback((text: string, tone?: OperationTone, duration?: number) => {
    onStatusMessage?.(text, tone, duration);
  }, [onStatusMessage]);
  const changeTaskStatus = useCallback((task: UnifiedTask, completed: boolean) => {
    void setTaskCompleted(task, completed);
  }, [setTaskCompleted]);
  const retryTaskStatus = useCallback((task: UnifiedTask) => {
    void setTaskCompleted(task, task.statusMutation?.targetStatus === "completed");
  }, [setTaskCompleted]);
  const mobilePreviewHistoryPushed = useRef(Boolean(runtimeCapabilities.mobile && window.history.state?.hubTaskPreview));

  useEffect(() => {
    if (!runtimeCapabilities.mobile) return;
    const closeAfterBack = (event: PopStateEvent) => {
      if (mobilePreviewHistoryPushed.current && !event.state?.hubTaskPreview) {
        mobilePreviewHistoryPushed.current = false;
        setSelectedTask(null);
      }
    };
    window.addEventListener("popstate", closeAfterBack);
    return () => window.removeEventListener("popstate", closeAfterBack);
  }, [setSelectedTask]);

  useEffect(() => {
    if (!runtimeCapabilities.mobile) return;
    if (selectedTask && !mobilePreviewHistoryPushed.current) {
      window.history.pushState({ ...(window.history.state ?? {}), hubTaskPreview: true }, "");
      mobilePreviewHistoryPushed.current = true;
    } else if (!selectedTask && mobilePreviewHistoryPushed.current) {
      mobilePreviewHistoryPushed.current = false;
      if (window.history.state?.hubTaskPreview) window.history.back();
    }
  }, [selectedTask]);
  const [openingTaskId, setOpeningTaskId] = useState<string | null>(null);
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(() => {
    try {
      const stored = JSON.parse(
        userProfileStorage.getItem(TASK_COLLAPSE_STORAGE_KEY)
          ?? userProfileStorage.getItem(LEGACY_TASK_COLLAPSE_STORAGE_KEY)
          ?? "[]",
      ) as unknown;
      return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  });
  const { ref: listRef, onScroll: rememberScroll } = useWorkspaceScroll("tasks.list", !loading);
  const syncMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Use the click phase rather than pointerdown. WebView2 renders native
    // select popups outside the normal element tree; closing on pointerdown
    // can unmount the filter before its change event is committed.
    const closeTransientTaskMenus = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!queryToolsRef.current?.contains(target) && !queryToolsButtonRef.current?.contains(target) && !(runtimeCapabilities.mobile && target instanceof Element && target.closest(".task-view-toolbar"))) setQueryToolsOpen(false);
      if (propertyMenuRef.current?.open && !propertyMenuRef.current.contains(target)) propertyMenuRef.current.open = false;
      if (!syncMenuRef.current?.contains(target)) setSyncMenuOpen(false);
    };
    document.addEventListener("click", closeTransientTaskMenus);
    return () => document.removeEventListener("click", closeTransientTaskMenus);
  }, []);
  const conflictReviews = useMemo(
    () => dashboard.syncReviews.filter((review) => review.action === "conflict" && review.status === "review"),
    [dashboard.syncReviews],
  );
  const identityConflictReviews = useMemo(
    () => conflictReviews.filter((review) => review.conflictType === "identity"),
    [conflictReviews],
  );
  const contentConflictReviews = useMemo(
    () => conflictReviews.filter((review) => review.conflictType !== "identity"),
    [conflictReviews],
  );
  const pendingConflictReviews = useMemo(
    () => dashboard.syncReviews.filter((review) => review.action === "conflict" && review.status !== "review"),
    [dashboard.syncReviews],
  );
  const selectedSyncLog = useMemo(
    () => syncLogs.find((run) => run.id === selectedSyncLogId) ?? syncLogs[0] ?? null,
    [selectedSyncLogId, syncLogs],
  );

  useEffect(() => {
    const activeIds = new Set(conflictReviews.map((review) => review.id));
    setConflictChoices((current) => Object.fromEntries(
      Object.entries(current).filter(([id]) => activeIds.has(Number(id))),
    ) as Record<number, ConflictResolution>);
    if (conflictReviews.length === 0) setConflictDialogOpen(false);
  }, [conflictReviews]);

  const load = useCallback(async () => {
    setError("");
    await refresh();
  }, [refresh]);

  useEffect(() => {
    if (!loading) onCountChange?.(dashboard.open);
  }, [dashboard.open, loading, onCountChange]);
  useEffect(() => {
    if (taskDataError) onStatusMessage?.(`任务读取失败：${taskDataError}`);
  }, [taskDataError, onStatusMessage]);

  useEffect(() => {
    if (loading) return;
    setSelectedTask((current) => {
      if (!current) return current;
      const refreshed = dashboard.tasks.find((task) => task.id === current.id && task.provider === current.provider);
      if (!refreshed) return null;
      return JSON.stringify(refreshed) === JSON.stringify(current) ? current : refreshed;
    });
  }, [dashboard.tasks, loading, setSelectedTask]);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void listen<{ status?: string; success?: boolean; failed?: number; message?: string }>("task-sync-updated", (event) => {
      const payload = event.payload;
      if (payload.status === "running") {
        setBackgroundSyncing(true);
        onStatusMessage?.("正在后台同步任务…", "working", 0);
      } else if (payload.success) {
        setBackgroundSyncing(false);
        onStatusMessage?.(payload.message || "后台任务同步完成", "success", 4_000);
      } else {
        setBackgroundSyncing(false);
        onStatusMessage?.(payload.message || `后台任务同步完成，${payload.failed || 1} 项需要处理`, "warning", 8_000);
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [onStatusMessage]);

  const selectedResult = useMemo<SearchResult | null>(
    () => selectedTask ? taskSearchResult(selectedTask) : null,
    [selectedTask],
  );

  const openPreviewLink = useCallback((href?: string) => {
    if (!href || !selectedTask) return;
    if (selectedTask.provider === "dida365" && !/^https?:\/\//i.test(href)) {
      void invoke("open_dida_attachment", { spaceId: selectedTask.libraryId, documentId: selectedTask.documentId, source: href });
    } else if (/^https?:\/\//i.test(href)) {
      void openExternalLink(href);
    }
  }, [openExternalLink, selectedTask]);

  const previewLink = usePreviewLinkCopy(setError);
  const openTaskSource = useCallback(async (task: UnifiedTask, source: "result" | "preview" = "result") => {
    setOpeningTaskId(task.id);
    try {
      onOpenResult?.(await resolveTaskResult(task), source);
    } catch (reason) {
      const message = String(reason);
      setError(message);
      onStatusMessage?.(`打开失败 · ${message}`);
    } finally {
      setOpeningTaskId(null);
    }
  }, [onOpenResult, onStatusMessage]);

  const previewSync = useCallback(async () => {
    setPreviewingSync(true);
    try {
      const preview = await invoke<TaskSyncPreview>("preview_task_sync");
      setSyncPreview(preview);
      setSelectedSyncLibrary((current) => preview.libraries.some((library) => library.libraryId === current)
        ? current : preview.libraries[0]?.libraryId ?? "");
    } catch (reason) {
      onStatusMessage?.(`同步预览失败：${String(reason)}`);
    } finally {
      setPreviewingSync(false);
    }
  }, [onStatusMessage]);

  const runSync = useCallback(async (fullReconcile = false) => {
    setSyncing(true);
    setFullSyncing(fullReconcile);
    setError("");
    onStatusMessage?.(fullReconcile ? "正在完整核对任务…" : "正在同步任务…", "working", 0);
    try {
      const result = await invoke<TaskSyncRunSummary>("run_task_sync", { fullReconcile });
      onStatusMessage?.(result.message, result.failed > 0 ? "warning" : "success", result.failed > 0 ? 8_000 : 4_000);
      await load();
    } catch (reason) {
      const message = String(reason);
      if (message.includes("任务同步正在进行")) {
        onStatusMessage?.("任务正在后台同步，请等待完成", "working", 0);
      } else {
        onStatusMessage?.(`任务同步失败：${message}`, "error", 8_000);
      }
    } finally {
      setSyncing(false);
      setFullSyncing(false);
    }
  }, [load, onStatusMessage]);

  const dismissPendingConflictReviews = useCallback(async () => {
    if (!window.confirm("清除这些未完成的冲突重试提示？\n\n这只会撤销已保留的重试规则，不会恢复、修改或删除 Craft 与滴答中的任务。")) return;
    setSyncing(true);
    setError("");
    try {
      const message = await invoke<string>("dismiss_task_sync_conflicts", {
        eventIds: pendingConflictReviews.map((review) => review.id),
      });
      onStatusMessage?.(message);
      await load();
    } catch (reason) {
      const message = String(reason);
      setError(message);
      onStatusMessage?.(`清除冲突提示失败：${message}`);
    } finally {
      setSyncing(false);
    }
  }, [load, onStatusMessage, pendingConflictReviews]);

  const removeSelectedTaskFromDida = useCallback(async () => {
    if (!selectedTask || selectedTask.provider !== "craft") return;
    if (!window.confirm(`保留 Craft 任务“${selectedTask.title}”，并从滴答删除当前任务及同一 Craft 来源的副本？\n\n该 Craft 任务以后不会再次同步到滴答。`)) return;
    setSyncing(true);
    setError("");
    try {
      await invoke<string>("exclude_task_from_dida", { hubTaskId: selectedTask.id });
      const result = await invoke<TaskSyncRunSummary>("run_task_sync", { fullReconcile: false });
      onStatusMessage?.(result.message);
      setSelectedTask(null);
      await load();
    } catch (reason) {
      const message = String(reason);
      setError(message);
      onStatusMessage?.(`从滴答移除任务失败：${message}`);
    } finally {
      setSyncing(false);
    }
  }, [load, onStatusMessage, selectedTask]);

  const resumeSelectedCraftSync = useCallback(async () => {
    if (!selectedTask || selectedTask.provider !== "craft" || selectedTask.syncState !== "paused") return;
    setSyncing(true);
    let resumed = false;
    try {
      const message = await invoke<string>("resume_craft_task_sync", {
        libraryId: selectedTask.libraryId,
        sourceId: selectedTask.sourceId,
      });
      resumed = true;
      onStatusMessage?.(message, "success", 8_000);
      if (dashboard.syncEnabled) {
        onStatusMessage?.("已恢复规则，正在同步 Craft 与滴答任务…", "working", 0);
        const result = await invoke<TaskSyncRunSummary>("run_task_sync", { fullReconcile: false });
        onStatusMessage?.(result.message, result.failed ? "warning" : "success", 8_000);
      } else {
        onStatusMessage?.(`${message}。请先启用任务同步。`, "warning", 8_000);
      }
    } catch (reason) {
      onStatusMessage?.(`${resumed ? "同步规则已恢复，但本轮同步失败" : "恢复同步失败"}：${String(reason)}`, "error", 8_000);
    } finally {
      await load();
      setSyncing(false);
    }
  }, [dashboard.syncEnabled, load, onStatusMessage, selectedTask]);

  const openSyncLog = useCallback(async () => {
    setSyncLogOpen(true);
    setSyncLogLoading(true);
    try {
      const logs = await invoke<TaskSyncLogRun[]>("list_task_sync_logs", { limit: 30 });
      setSyncLogs(logs);
      setSelectedSyncLogId((current) => logs.some((run) => run.id === current) ? current : logs[0]?.id ?? null);
    } catch (reason) {
      onStatusMessage?.(`同步日志读取失败：${String(reason)}`);
    } finally {
      setSyncLogLoading(false);
    }
  }, [onStatusMessage]);

  const updateBackgroundSyncInterval = useCallback(async (minutes: number) => {
    setSavingBackgroundInterval(true);
    try {
      await invoke("update_task_background_sync_interval", { minutes });
      await load();
      onStatusMessage?.(minutes > 0
        ? `任务后台同步已设为每 ${minutes} 分钟；Hub 在窗口或托盘运行时都会执行`
        : "任务后台同步已关闭，仍可随时手动同步");
    } catch (reason) {
      onStatusMessage?.(`保存后台同步频率失败：${String(reason)}`);
    } finally {
      setSavingBackgroundInterval(false);
    }
  }, [load, onStatusMessage]);

  const enableAndRunSync = useCallback(async () => {
    if (!selectedSyncLibrary) {
      onStatusMessage?.("请先连接滴答账户");
      return;
    }
    setSyncing(true);
    try {
      await invoke("configure_task_sync", {
        enabled: true,
        didaLibraryId: selectedSyncLibrary,
      });
      setSyncPreview(null);
      const result = await invoke<TaskSyncRunSummary>("run_task_sync");
      onStatusMessage?.(result.message);
      await load();
    } catch (reason) {
      onStatusMessage?.(`启用任务同步失败：${String(reason)}`);
    } finally {
      setSyncing(false);
    }
  }, [load, onStatusMessage, selectedSyncLibrary]);

  const inspectCapabilities = useCallback(async () => {
    setCheckingCapabilities(true);
    try {
      setSyncCapabilities(await invoke<TaskSyncCapabilities>("inspect_task_sync_capabilities"));
    } catch (reason) {
      onStatusMessage?.(`同步能力检查失败：${String(reason)}`);
    } finally {
      setCheckingCapabilities(false);
    }
  }, [onStatusMessage]);

  const applyTaskConflictChoices = useCallback(async () => {
    if (conflictReviews.some((review) => !conflictChoices[review.id])) return;
    // The choices are already complete at this point. Close immediately and
    // keep the sync running in the background; the badge remains available for
    // reopening the read-only progress view.
    setConflictDialogOpen(false);
    setSyncing(true);
    try {
      const synchronized = conflictReviews.filter((review) => conflictChoices[review.id] !== "unlink");
      const unlinked = conflictReviews.filter((review) => conflictChoices[review.id] === "unlink");
      for (const review of synchronized) {
        await invoke<string>("resolve_task_sync_conflict", {
          eventId: review.id,
          resolution: conflictChoices[review.id],
        });
      }
      let syncMessage = "";
      if (synchronized.length > 0) {
        const result = await invoke<TaskSyncRunSummary>("run_task_sync", { fullReconcile: false });
        syncMessage = result.message;
      }
      // Unlink after the single sync pass so these tasks cannot be recreated by
      // the same run while the other selected resolutions are being applied.
      for (const review of unlinked) {
        await invoke<string>("resolve_task_sync_conflict", { eventId: review.id, resolution: "unlink" });
      }
      onStatusMessage?.(`已一次处理 ${conflictReviews.length} 项同步冲突${syncMessage ? `；${syncMessage}` : ""}`);
      setConflictDialogOpen(false);
      setConflictChoices({});
      await load();
    } catch (reason) {
      onStatusMessage?.(`任务冲突处理失败：${String(reason)}`);
    } finally {
      setSyncing(false);
    }
  }, [conflictChoices, conflictReviews, load, onStatusMessage]);

  const scopedTasks = useMemo(() => filterTasksByLibraries(dashboard.tasks, selectedLibraryIds), [dashboard.tasks, selectedLibraryIds]);
  const collections = useMemo(() => taskCollections(scopedTasks), [scopedTasks]);
  const activeCollection = collections.find(group => group.key === collectionKey);
  const collectionTasks = useMemo(() => collectionKey ? scopedTasks.filter(task => taskCollectionKey(task) === collectionKey) : scopedTasks, [collectionKey, scopedTasks]);
  useEffect(() => {
    if (!loading && selectedTask && !collectionTasks.some(task => task.id === selectedTask.id && task.provider === selectedTask.provider)) setSelectedTask(null);
  }, [loading, collectionTasks, selectedTask, setSelectedTask]);
  const visibleTasks = useMemo(() => {
    return filterAndSortTasks(todayOnly ? collectionTasks.filter(t => planningEligible(t) && planningRecord(t)?.day === planningDay) : collectionTasks, {
      query,
      status: statusFilter,
      source: sourceFilter,
      sort: taskSort,
      ascending: taskSortAscending,
    });
  }, [collectionTasks, query, sourceFilter, statusFilter, taskSort, taskSortAscending, todayOnly, planningRecords, planningDay]);
  const visibleTaskStats = useMemo(() => summarizeTasks(visibleTasks), [visibleTasks]);
  function beginPlanning(mode: PlanningMode, task?: UnifiedTask, key?: string) {
    const project = key || collectionKey || (task || selectedTask ? taskCollectionKey((task || selectedTask)!) : "");
    const tasks = mode === "task" ? task ? [task] : selectedTask ? [selectedTask] : [] : mode === "project" ? scopedTasks.filter(t => taskCollectionKey(t) === project) : visibleTasks;
    if (mode === "project" && !project) { onStatusMessage?.("请先选择项目或清单，再梳理项目。"); return; }
    if (!tasks.some(planningEligible)) { onStatusMessage?.("当前范围没有可分析的未完成行动，请选择原任务。"); return; }
    if (mode === "project") { setCollectionKey(project); setSourceFilter("all"); setStatusFilter("all"); setQuery(""); setTodayOnly(false); }
    setPlanning({ id: crypto.randomUUID(), mode, tasks, label: mode === "task" ? tasks[0].title : mode === "project" ? `${tasks[0].libraryName} / ${tasks[0].documentTitle}` : `当前列表 · ${activeCollection?.name || "全部项目与清单"}${sourceFilter !== "all" ? " · " + providerLabel(sourceFilter) : ""}${query ? " · 搜索：" + query : ""}${todayOnly ? " · 今日计划" : ""}` });
  }


  const previousFilters = useRef([query, sourceFilter, statusFilter, selectedLibraryIds, collectionKey]);
  useEffect(() => {
    const next = [query, sourceFilter, statusFilter, selectedLibraryIds, collectionKey];
    if (next.some((value, index) => value !== previousFilters.current[index])) listRef.current?.scrollTo({ top: 0 });
    previousFilters.current = next;
  }, [query, sourceFilter, statusFilter, selectedLibraryIds, collectionKey]);
  const resetFilters = () => { setQuery(""); setStatusFilter("open"); setSourceFilter("all"); setCollectionKey(""); setTodayOnly(false); };

  useEffect(() => {
    userProfileStorage.setItem(TASK_VIEW_STORAGE_KEY, JSON.stringify({
      viewMode,
      statusFilter,
      sourceFilter,
      tableProperties,
      density: taskDensity,
      sort: taskSort,
      sortAscending: taskSortAscending,
      colorMode: taskColorMode,
    }));
  }, [sourceFilter, statusFilter, tableProperties, taskColorMode, taskDensity, taskSort, taskSortAscending, viewMode]);

  const toggleTableProperty = useCallback((property: TaskTableProperty) => {
    setTableProperties((current) => ({ ...current, [property]: !current[property] }));
  }, []);

  const applyTaskView = useCallback((view: TaskSavedView) => {
    setActiveTaskViewId(view.id);
    setViewMode(view.viewMode);
    setStatusFilter(view.statusFilter);
    setSourceFilter(view.sourceFilter);
    setTableProperties(view.tableProperties);
    setTaskDensity(view.density);
    setTaskSort(view.sort);
    setTaskSortAscending(view.sortAscending);
    setTaskColorMode(view.colorMode);
    userProfileStorage.setItem(TASK_ACTIVE_VIEW_STORAGE_KEY, view.id);
  }, []);

  const addTaskView = useCallback(() => {
    const view: TaskSavedView = { id: `view-${Date.now().toString(36)}`, name: "新视图", viewMode: "table", statusFilter, sourceFilter, tableProperties, density: taskDensity, sort: taskSort, sortAscending: taskSortAscending, colorMode: taskColorMode };
    setTaskViews((current) => [...current, view]);
    applyTaskView(view);
  }, [applyTaskView, sourceFilter, statusFilter, tableProperties, taskColorMode, taskDensity, taskSort, taskSortAscending]);

  const updateActiveTaskView = useCallback((patch: Partial<TaskSavedView>) => {
    setTaskViews((current) => current.map((view) => view.id === activeTaskViewId ? { ...view, ...patch } : view));
  }, [activeTaskViewId]);

  const duplicateActiveTaskView = useCallback(() => {
    const active = taskViews.find((view) => view.id === activeTaskViewId);
    if (!active) return;
    const copy = { ...active, id: `view-${Date.now().toString(36)}`, name: `${active.name} 副本` };
    setTaskViews((current) => [...current, copy]);
    applyTaskView(copy);
  }, [activeTaskViewId, applyTaskView, taskViews]);

  const deleteActiveTaskView = useCallback(() => {
    if (taskViews.length <= 1) return;
    const next = taskViews.filter((view) => view.id !== activeTaskViewId);
    setTaskViews(next);
    applyTaskView(next[0]);
  }, [activeTaskViewId, applyTaskView, taskViews]);

  useEffect(() => {
    setTaskViews((current) => current.map((view) => view.id === activeTaskViewId ? {
      ...view, viewMode, statusFilter, sourceFilter, tableProperties, density: taskDensity,
      sort: taskSort, sortAscending: taskSortAscending, colorMode: taskColorMode,
    } : view));
  }, [activeTaskViewId, sourceFilter, statusFilter, tableProperties, taskColorMode, taskDensity, taskSort, taskSortAscending, viewMode]);

  useEffect(() => {
    userProfileStorage.setItem(TASK_SAVED_VIEWS_STORAGE_KEY, JSON.stringify(taskViews));
  }, [taskViews]);

  useEffect(() => {
    userProfileStorage.setItem(TASK_COLLAPSE_STORAGE_KEY, JSON.stringify([...collapsedTaskIds]));
  }, [collapsedTaskIds]);

  const toggleTaskCollapsed = useCallback((taskId: string) => {
    setCollapsedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const markdownTaskParentIds = useMemo(() => {
    const parents = new Map<string, string>();
    const taskIdBySource = new Map<string, string>();
    for (const task of dashboard.tasks) {
      taskIdBySource.set(`${task.provider}:${task.libraryId}:${task.sourceId}`, task.id);
    }
    for (const task of dashboard.tasks) {
      if (!task.parentTaskId) continue;
      const parentId = taskIdBySource.get(`${task.provider}:${task.libraryId}:${task.parentTaskId}`);
      if (parentId) parents.set(task.id, parentId);
    }
    let currentDocumentKey = "";
    let stack: UnifiedTask[] = [];
    for (const task of dashboard.tasks) {
      const isMarkdownTask = (task.provider === "obsidian" || task.provider === "craft")
        && task.sourceId.includes(":line:");
      if (!isMarkdownTask) {
        currentDocumentKey = "";
        stack = [];
        continue;
      }
      const documentKey = `${task.provider}:${task.libraryId}:${task.documentId}`;
      if (documentKey !== currentDocumentKey) {
        currentDocumentKey = documentKey;
        stack = [];
      }
      while (stack.length > 0 && stack[stack.length - 1].depth >= task.depth) stack.pop();
      if (!parents.has(task.id) && task.depth > 0 && stack.length > 0) parents.set(task.id, stack[stack.length - 1].id);
      stack.push(task);
    }
    return parents;
  }, [dashboard.tasks]);

  const visibleMarkdownParentIds = useMemo(() => {
    const visibleIds = new Set(visibleTasks.map((task) => task.id));
    const parents = new Map<string, string>();
    for (const task of visibleTasks) {
      let parentId = markdownTaskParentIds.get(task.id);
      while (parentId && !visibleIds.has(parentId)) parentId = markdownTaskParentIds.get(parentId);
      if (parentId) parents.set(task.id, parentId);
    }
    return parents;
  }, [markdownTaskParentIds, visibleTasks]);

  const displayTaskDepths = useMemo(() => {
    const depths = new Map<string, number>();
    for (const task of visibleTasks) {
      if (!markdownTaskParentIds.has(task.id)) {
        depths.set(task.id, task.provider === "craft" ? 0 : task.depth);
        continue;
      }
      let depth = 0;
      let parentId = visibleMarkdownParentIds.get(task.id);
      while (parentId) {
        depth += 1;
        parentId = visibleMarkdownParentIds.get(parentId);
      }
      depths.set(task.id, depth);
    }
    return depths;
  }, [markdownTaskParentIds, visibleMarkdownParentIds, visibleTasks]);

  const taskIdsWithChildren = useMemo(() => {
    if (query.trim()) return new Set<string>();
    const parentIds = new Set(visibleMarkdownParentIds.values());
    for (let index = 0; index < visibleTasks.length - 1; index += 1) {
      if (visibleTasks[index].isProject && visibleTasks[index + 1].depth > visibleTasks[index].depth) {
        parentIds.add(visibleTasks[index].id);
      }
    }
    return parentIds;
  }, [query, visibleMarkdownParentIds, visibleTasks]);

  const hierarchicalTasks = useMemo(() => filterCollapsedTaskDescendants(visibleTasks, {
    collapsedTaskIds,
    parentIds: visibleMarkdownParentIds,
    taskIdsWithChildren,
    query,
  }), [collapsedTaskIds, query, taskIdsWithChildren, visibleMarkdownParentIds, visibleTasks]);


  const scopeStats = summarizeTasks(scopedTasks);
  const sourceCounts: Record<SourceFilter, number> = { all: scopeStats.total, craft: scopeStats.craft, dida365: scopeStats.dida365, obsidian: scopeStats.obsidian };

  const sourceOptions: Array<{ id: SourceFilter; label: string }> = [
    { id: "all", label: "全部" },
    { id: "dida365", label: "滴答清单" },
    { id: "craft", label: "Craft" },
    { id: "obsidian", label: "Obsidian" },
  ];
  const backgroundSyncLabel = dashboard.backgroundSyncIntervalMinutes > 0
    ? `每 ${dashboard.backgroundSyncIntervalMinutes} 分钟`
    : "仅手动";
  const syncActive = syncing || backgroundSyncing || dashboard.lastSyncStatus === "running";
  const syncTriggerLabel = syncActive
    ? fullSyncing ? "完整核对中" : "同步中"
    : loading ? "正在刷新任务" : dashboard.syncEnabled ? backgroundSyncLabel : "同步未启用";
  const lastSyncHasIssues = dashboard.lastSyncStatus === "completed_with_errors"
    || dashboard.lastSyncStatus === "failed"
    || dashboard.lastSyncStatus === "interrupted";
  const lastSyncLabel = dashboard.lastSyncAt
    ? dashboard.lastSyncStatus === "running"
      ? `同步正在进行 · ${syncTimeLabel(dashboard.lastSyncAt)}`
      : dashboard.lastSyncStatus === "completed"
      ? `上次成功同步 ${syncTimeLabel(dashboard.lastSyncAt)}`
      : dashboard.lastSyncStatus === "completed_with_errors"
        ? `部分任务状态可能未更新 · ${dashboard.lastSyncFailed || 1} 项异常 · ${syncTimeLabel(dashboard.lastSyncAt)}`
        : dashboard.lastSyncStatus === "interrupted"
          ? `上次同步中断 · ${syncTimeLabel(dashboard.lastSyncAt)}`
          : `上次同步失败，当前显示本地记录 · ${syncTimeLabel(dashboard.lastSyncAt)}`
    : "尚无同步记录";
  const boardGroups = useMemo(() => groupTasksByProvider(visibleTasks)
    .filter((group) => sourceFilter === "all" || group.provider === sourceFilter), [sourceFilter, visibleTasks]);
  const activeTaskView = taskViews.find((view) => view.id === activeTaskViewId) ?? taskViews[0];
  const taskDisclosure = (task: UnifiedTask, placement: "list" | "table") => taskIdsWithChildren.has(task.id) && (
    <button
      type="button"
      className={`task-disclosure task-${placement}-disclosure ${collapsedTaskIds.has(task.id) ? "collapsed" : "expanded"}`}
      title={collapsedTaskIds.has(task.id) ? "展开子任务" : "折叠子任务"}
      aria-label={`${collapsedTaskIds.has(task.id) ? "展开" : "折叠"}${task.title}的子任务`}
      aria-expanded={!collapsedTaskIds.has(task.id)}
      onClick={(event) => {
        event.stopPropagation();
        toggleTaskCollapsed(task.id);
      }}
    >
      {collapsedTaskIds.has(task.id) ? <ChevronRight size={18} strokeWidth={2.2} /> : <ChevronDown size={18} strokeWidth={2.2} />}
    </button>
  );
  const viewSettingsPanel = <div className="task-property-popover task-view-tab-popover">
    <input className="task-view-name-input" value={activeTaskView?.name ?? ""} onChange={(event) => updateActiveTaskView({ name: event.target.value })} onBlur={(event) => { if (!event.target.value.trim()) updateActiveTaskView({ name: "未命名视图" }); }} aria-label="视图名称" />
    <div className="task-property-section-title">布局</div>
    <div className="task-view-layout-options">
      {([ ["list", "列表", LayoutList], ["board", "看板", Columns3], ["table", "表格", Table2] ] as const).map(([mode, label, Icon]) => <button type="button" key={mode} className={viewMode === mode ? "selected" : ""} onClick={() => setViewMode(mode)}><Icon size={15} /><span>{label}</span>{viewMode === mode && <CheckCircle2 size={14} />}</button>)}
    </div>
    <label className="task-view-filter"><span>内容密度</span><select aria-label="任务密度" value={taskDensity} onChange={event => setTaskDensity(event.target.value as TaskDensity)}><option value="compact">紧凑</option><option value="comfortable">标准</option><option value="spacious">宽松</option></select></label>
    <div className="task-property-section-title">显示属性</div>
    {([ ["source", "来源"], ["library", "资料库"], ["document", "所在文档 / 清单"], ["start", "开始日"], ["due", "到期日"], ["sync", "打开链接"] ] as Array<[TaskTableProperty, string]>).map(([property, label]) => <label key={property}><input type="checkbox" checked={tableProperties[property]} onChange={() => toggleTableProperty(property)} /><span>{label}</span></label>)}
    <div className="task-property-section-title">条件颜色</div>
    <label className="task-view-filter"><span>突出显示</span><select value={taskColorMode} onChange={(event) => setTaskColorMode(event.target.value as TaskColorMode)}><option value="none">关闭</option><option value="status">按完成状态</option><option value="source">按来源</option><option value="sync">按同步状态</option></select></label>
    <div className="task-view-management-actions">
      <button type="button" onClick={duplicateActiveTaskView}><Copy size={13} />复制视图</button>
      <button type="button" className="danger" disabled={taskViews.length <= 1} onClick={deleteActiveTaskView}><Trash2 size={13} />删除视图</button>
    </div>
  </div>;

  return (
    <div className="task-module-layout">
      <aside className="task-module-sidebar" aria-label="任务导航">
        <header><strong>任务</strong><span>{scopeStats.total}</span></header>
        <section aria-label="任务项目与清单"><h2>项目与清单</h2><button aria-current={!collectionKey ? "page" : undefined} onClick={() => setCollectionKey("")}><ListFilter size={15} /><span>全部项目与清单</span><small>{scopeStats.total}</small></button>{collections.map(group => <div className="task-planning-project" key={group.key}><button aria-current={collectionKey === group.key ? "page" : undefined} onClick={() => setCollectionKey(group.key)} title={`${group.name} · ${group.library}`}><span>{group.name}<em>{group.library}</em></span><small>{group.count}</small></button><button className="task-planning-project-action" aria-label={`梳理项目：${group.library} / ${group.name}`} onClick={() => beginPlanning("project", undefined, group.key)}><Sparkles size={14}/></button></div>)}</section>
        {!loading && !collections.length && <p>当前资料库没有任务</p>}
      </aside>
    <section className="task-workspace">
      {runtimeCapabilities.mobile && <div className="mobile-page-intro"><h1>任务</h1><p>查看行动，接着往下做。</p></div>}
      {runtimeCapabilities.mobile && <div className="mobile-task-controls"><label><Search size={18} aria-hidden="true"/><input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.target.value)}/></label><button type="button" ref={queryToolsButtonRef} aria-label="筛选与视图" aria-expanded={queryToolsOpen} onClick={() => setQueryToolsOpen(open => !open)}><ListFilter size={20}/></button></div>}
      <header className="task-workspace-header">
        <div className="task-source-chips">
          {!desktopSidebarVisible && onToggleDesktopSidebar && (
            <button className="task-icon-button" onClick={onToggleDesktopSidebar} title="显示侧边栏">
              <PanelLeft size={18} />
            </button>
          )}
          {sourceOptions.map((source) => (
            <button
              key={source.id}
              className={`task-source-chip ${source.id} ${sourceFilter === source.id ? "active" : ""}`}
              onClick={() => setSourceFilter(source.id)}
            >
              {source.id !== "all" && <i />}
              <span>{source.label}</span>
              <strong>{sourceCounts[source.id]}</strong>
            </button>
          ))}
        </div>
        <div className="task-header-tools">
          {conflictReviews.length > 0 && <button className="task-conflict-indicator" onClick={() => setConflictDialogOpen(true)} title="集中处理同步冲突">
            <AlertTriangle size={15} />
            <span>同步冲突</span>
            <strong>{conflictReviews.length}</strong>
          </button>}
          <div className="task-sync-menu" ref={syncMenuRef}>
            <button
              className={`task-sync-menu-trigger ${syncMenuOpen ? "active" : ""} ${syncActive ? "syncing" : ""}`}
              onClick={() => setSyncMenuOpen((open) => !open)}
              title="同步状态与设置"
              aria-label={`同步状态：${syncTriggerLabel}`}
              aria-expanded={syncMenuOpen}
              aria-busy={syncActive}
            >
              <RefreshCw size={15} />
              {syncActive && <span className="task-sync-activity-dot" aria-hidden="true" />}
            </button>
            {syncMenuOpen && <div className="task-sync-popover" role="dialog" aria-label="同步设置">
              <header>
                <span className={syncActive ? "working" : dashboard.syncEnabled && dashboard.backgroundSyncIntervalMinutes > 0 ? lastSyncHasIssues ? "warning" : "enabled" : "manual"} />
                <div>
                  <strong>{syncActive ? "正在同步任务" : dashboard.syncEnabled && dashboard.backgroundSyncIntervalMinutes > 0
                    ? lastSyncHasIssues ? "后台同步已开启 · 最近有异常" : "后台同步已开启"
                    : "后台同步未运行"}</strong>
                  <small>{syncActive
                    ? "正在核对两端变化，完成后会自动刷新任务状态"
                    : dashboard.syncEnabled
                    ? dashboard.backgroundSyncIntervalMinutes > 0 ? `${backgroundSyncLabel} · Hub 在窗口或托盘运行时执行` : "仅在手动触发时同步"
                    : "请先启用 Craft 与滴答双向同步"}</small>
                </div>
              </header>
              <p className="task-sync-destination">新任务默认进入收件箱。移动到任意清单后保持关联，新增子任务跟随父任务所在清单。</p>
              <label className="task-sync-frequency">
                <span><Timer size={14} />后台频率</span>
                <select
                  value={dashboard.backgroundSyncIntervalMinutes}
                  disabled={!dashboard.syncEnabled || savingBackgroundInterval}
                  onChange={(event) => void updateBackgroundSyncInterval(Number(event.target.value))}
                >
                  <option value={0}>关闭</option>
                  <option value={5}>每 5 分钟</option>
                  <option value={15}>每 15 分钟</option>
                  <option value={30}>每 30 分钟</option>
                  <option value={60}>每 1 小时</option>
                  <option value={120}>每 2 小时</option>
                </select>
              </label>
              <div className="task-sync-popover-actions">
                <button onClick={() => { setSyncMenuOpen(false); void (dashboard.syncEnabled ? runSync(false) : load()); }} disabled={loading || syncActive}>
                  <RefreshCw size={14} />
                  <span>{dashboard.syncEnabled ? "立即同步" : "刷新任务"}</span>
                </button>
                {dashboard.syncEnabled && <button onClick={() => { setSyncMenuOpen(false); void runSync(true); }} disabled={loading || syncActive}>
                  <ScanSearch size={14} />
                  <span>完整核对</span>
                </button>}
                <button onClick={() => { setSyncMenuOpen(false); void openSyncLog(); }}>
                  <History size={14} />
                  <span>同步日志</span>
                </button>
              </div>
              <footer className={`${lastSyncHasIssues ? "warning" : ""} ${syncActive ? "syncing" : ""}`}>
                {syncActive ? <span className="task-sync-running-status">
                  <i aria-hidden="true" />
                  <strong>{fullSyncing ? "正在完整核对" : "正在同步任务"}</strong>
                  <time>{dashboard.lastSyncAt ? syncTimeLabel(dashboard.lastSyncAt) : "请稍候"}</time>
                </span> : lastSyncLabel}
              </footer>
            </div>}
          </div>
        </div>
      </header>

      {syncPreview && <div className="task-sync-preview task-sync-setup">
        <div><strong>同步启用预览</strong><span>默认：收件箱</span><span>Craft 待同步到滴答 {syncPreview.craftUnlinked}</span><span>独立滴答任务 {syncPreview.didaUnlinked}（不创建到 Craft）</span><span>双向已关联 {syncPreview.linked}</span><span>同名待确认 {syncPreview.exactTitleCandidates}</span></div>
        <p>{syncPreview.message}</p>
        {syncPreview.libraries.length > 1 && <select aria-label="滴答账户" value={selectedSyncLibrary} onChange={(event) => setSelectedSyncLibrary(event.target.value)} disabled={syncing}>
          {syncPreview.libraries.map((library) => <option key={library.libraryId} value={library.libraryId}>{library.name}</option>)}
        </select>}
        <button className="task-sync-enable" onClick={() => void enableAndRunSync()} disabled={!syncPreview.safeToEnable || !selectedSyncLibrary || syncing}>{syncing ? "同步中…" : "启用并同步"}</button>
        <button onClick={() => setSyncPreview(null)}>关闭</button>
      </div>}

      {syncCapabilities && <div className={`task-sync-preview task-capabilities ${syncCapabilities.readyForControlledSync ? "ready" : "not-ready"}`}>
        <div>
          <strong>写入能力</strong>
          <span>Craft {syncCapabilities.craftWriteAvailable ? "已就绪" : syncCapabilities.craftConnected ? "缺少写入权限" : "未连接"}</span>
          <span>滴答 {syncCapabilities.missingDidaWriteTools.length === 0 && syncCapabilities.didaConnected ? "已就绪" : "缺少写入工具"}</span>
        </div>
        <p>{syncCapabilities.message}</p>
        <button onClick={() => setSyncCapabilities(null)}>关闭</button>
      </div>}

      {pendingConflictReviews.length > 0 && <div className="task-sync-review">
        <div>
          <strong>{pendingConflictReviews.length} 项冲突规则尚未完成</strong>
          <span>{pendingConflictReviews.slice(0, 3).map((review) => `“${review.title}”`).join("、")}{pendingConflictReviews.length > 3 ? " 等" : ""}</span>
          <small>{pendingConflictReviews.some((review) => review.status === "failed") ? "上次写入未完成，已保留所选规则，可以安全重试。" : "所选规则正在等待写入两端。"}</small>
        </div>
        <button disabled={syncing} onClick={() => void dismissPendingConflictReviews()}>清除提示</button>
        <button disabled={syncing} onClick={() => void runSync(false)}>重试同步</button>
      </div>}

      {conflictDialogOpen && <div className="task-conflict-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConflictDialogOpen(false); }}>
        <section className="task-conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="task-conflict-title">
          <header>
            <div><AlertTriangle size={19} /><span><strong id="task-conflict-title">{identityConflictReviews.length > 0 ? "修复任务关联" : "处理内容冲突"}</strong><small>{identityConflictReviews.length > 0 ? "滴答中的 Craft 来源链接与当前绑定不一致；修复前已暂停这些任务的自动写入和删除" : "合并会去重相同正文和图片；标题、状态和日期采用修改较新的一端"}</small></span></div>
            <button onClick={() => setConflictDialogOpen(false)} aria-label="关闭"><X size={18} /></button>
          </header>
          <div className="task-conflict-bulk-actions">
            <span>共 {conflictReviews.length} 项{identityConflictReviews.length > 0 && <> · 关联异常 {identityConflictReviews.length} 项需逐项确认</>}</span>
            {contentConflictReviews.length > 0 && <>
              <button disabled={syncing} onClick={() => setConflictChoices((current) => ({ ...current, ...Object.fromEntries(contentConflictReviews.map((review) => [review.id, "craft_wins"])) }))}>内容全部保留 Craft</button>
              <button disabled={syncing} onClick={() => setConflictChoices((current) => ({ ...current, ...Object.fromEntries(contentConflictReviews.map((review) => [review.id, "dida_wins"])) }))}>内容全部保留滴答</button>
              <button className="merge" disabled={syncing || contentConflictReviews.some((review) => !review.mergeAllowed)} title={contentConflictReviews.some((review) => !review.mergeAllowed) ? "项目任务不能自动合并单值属性" : "全部采用去重合并"} onClick={() => setConflictChoices((current) => ({ ...current, ...Object.fromEntries(contentConflictReviews.map((review) => [review.id, "merge"])) }))}>内容全部合并</button>
            </>}
            {identityConflictReviews.length > 0 && <button className="danger" disabled={syncing} title="保留 Craft，并清理滴答中的当前任务及同来源副本" onClick={() => setConflictChoices((current) => ({ ...current, ...Object.fromEntries(identityConflictReviews.map((review) => [review.id, "remove_from_dida"])) }))}>关联异常全部从滴答移除</button>}
          </div>
          <div className="task-conflict-list">
            {conflictReviews.map((review) => review.conflictType === "identity" ? <article className="identity" key={review.id}>
              <div className="task-conflict-summary">
                <div className="task-conflict-title-row"><strong>{review.title}</strong><span>关联异常</span></div>
                <p>同一条滴答任务指向了两个不同的 Craft 任务，请确认后续应使用哪一个。</p>
                <div className="task-identity-comparison">
                  <div className="current">
                    <span>当前绑定</span>
                    <strong>{review.boundCraftTitle || review.title}</strong>
                    <small>{review.boundCraftDocumentTitle || "Craft 文档未知"}{review.boundCraftModifiedAt ? ` · 修改于 ${syncTimeLabel(review.boundCraftModifiedAt)}` : ""}</small>
                    <code title={review.boundCraftSourceId}>{shortSourceId(review.boundCraftSourceId)}</code>
                  </div>
                  <ArrowRight size={16} aria-hidden="true" />
                  <div className={`managed ${review.managedCraftState || "missing"}`}>
                    <span>滴答记录的来源</span>
                    <strong>{review.managedCraftTitle || (review.managedCraftState === "missing" ? "来源任务已不存在" : "Craft 任务")}</strong>
                    <small>{review.managedCraftState === "linked_elsewhere" ? "已绑定到另一条滴答任务，不能自动改绑" : review.managedCraftState === "missing" ? "本地和 Craft 清单中均未找到该任务" : `${review.managedCraftDocumentTitle || "Craft 文档未知"}${review.managedCraftModifiedAt ? ` · 修改于 ${syncTimeLabel(review.managedCraftModifiedAt)}` : ""}`}</small>
                    <code title={review.managedCraftSourceId}>{shortSourceId(review.managedCraftSourceId)}</code>
                  </div>
                </div>
              </div>
              <div className="task-conflict-decision">
                <div className="task-conflict-options" role="group" aria-label={`${review.title}的关联修复方式`}>
                  <button className={conflictChoices[review.id] === "keep_current_binding" ? "selected" : ""} disabled={syncing} onClick={() => setConflictChoices((current) => ({ ...current, [review.id]: "keep_current_binding" }))}>保留当前绑定</button>
                  <button className={conflictChoices[review.id] === "use_managed_source" ? "selected" : ""} disabled={syncing || review.managedCraftState !== "available"} title={review.managedCraftState === "missing" ? "来源任务已经不存在，无法改绑" : review.managedCraftState === "linked_elsewhere" ? "来源任务已绑定另一条滴答任务，无法自动改绑" : undefined} onClick={() => setConflictChoices((current) => ({ ...current, [review.id]: "use_managed_source" }))}>改绑到来源任务</button>
                  <button className={`danger ${conflictChoices[review.id] === "remove_from_dida" ? "selected" : ""}`} disabled={syncing} onClick={() => setConflictChoices((current) => ({ ...current, [review.id]: "remove_from_dida" }))}>从滴答移除</button>
                  <button className={conflictChoices[review.id] === "unlink" ? "selected" : ""} disabled={syncing} onClick={() => setConflictChoices((current) => ({ ...current, [review.id]: "unlink" }))}>两端保留并停止关联</button>
                </div>
                <small className="task-conflict-choice-note">{identityChoiceNote(conflictChoices[review.id])}</small>
              </div>
            </article> : <article key={review.id}>
              <div><strong>{review.title}</strong><small>{review.message}</small></div>
              <div className="task-conflict-options" role="group" aria-label={`${review.title}的内容冲突处理方式`}>
                {(["craft_wins", "dida_wins", "merge", "remove_from_dida", "unlink"] as const).map((resolution) => <button key={resolution} className={`${conflictChoices[review.id] === resolution ? "selected" : ""} ${resolution === "remove_from_dida" ? "danger" : ""}`} disabled={syncing || (resolution === "merge" && !review.mergeAllowed)} title={resolution === "merge" && !review.mergeAllowed ? "项目任务没有可安全自动合并的双端详情" : undefined} onClick={() => setConflictChoices((current) => ({ ...current, [review.id]: resolution }))}>{resolution === "craft_wins" ? "保留 Craft" : resolution === "dida_wins" ? "保留滴答" : resolution === "merge" ? "合并两端" : resolution === "remove_from_dida" ? "保留 Craft，移除滴答" : "两端保留并停止关联"}</button>)}
              </div>
            </article>)}
          </div>
          <footer>
            <span>已选择 {conflictReviews.filter((review) => conflictChoices[review.id]).length} / {conflictReviews.length}</span>
            <button onClick={() => setConflictDialogOpen(false)}>关闭</button>
            <button className="primary" onClick={() => void applyTaskConflictChoices()} disabled={syncing || conflictReviews.some((review) => !conflictChoices[review.id])}>{syncing ? "正在修复并同步…" : identityConflictReviews.length > 0 ? `修复 ${conflictReviews.length} 项并同步` : "确认选择并同步"}</button>
          </footer>
        </section>
      </div>}

      {syncLogOpen && <div className="task-conflict-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSyncLogOpen(false); }}>
        <section className="task-sync-log-dialog" role="dialog" aria-modal="true" aria-labelledby="task-sync-log-title">
          <header>
            <div><History size={19} /><span><strong id="task-sync-log-title">同步日志</strong><small>保留最近 50 次同步，可查看实际写入两端的每一项动作</small></span></div>
            <button onClick={() => setSyncLogOpen(false)} aria-label="关闭"><X size={18} /></button>
          </header>
          {syncLogLoading ? <div className="task-sync-log-empty">正在读取同步日志…</div> : syncLogs.length === 0 ? <div className="task-sync-log-empty">还没有同步记录。完成一次同步后会在这里显示。</div> : <div className="task-sync-log-layout">
            <aside>
              {syncLogs.map((run) => <button key={run.id} className={selectedSyncLog?.id === run.id ? "selected" : ""} onClick={() => setSelectedSyncLogId(run.id)}>
                <span>{syncTimeLabel(run.completedAt)}</span>
                <small>{run.fullReconcile ? "完整核对" : "立即同步"} · {run.status === "completed" ? "完成" : run.status === "running" ? "进行中" : run.status === "interrupted" ? "已中断" : "有失败"}</small>
              </button>)}
            </aside>
            {selectedSyncLog && <main>
              <div className="task-sync-log-summary">
                <strong>{selectedSyncLog.fullReconcile ? "完整核对" : "立即同步"}</strong>
                <time>{syncTimeLabel(selectedSyncLog.startedAt)}</time>
                <p>{selectedSyncLog.summary}</p>
              </div>
              <div className="task-sync-log-entries">
                {selectedSyncLog.entries.map((entry) => <article key={entry.id} className={entry.status}>
                  <span className={`task-sync-log-action ${entry.action}`}>{syncActionLabel(entry.action)}</span>
                  <div>
                    <strong>{entry.title}</strong>
                    {(entry.sourceProvider || entry.targetProvider) && <small>{syncProviderLabel(entry.sourceProvider)}{entry.targetProvider ? ` → ${syncProviderLabel(entry.targetProvider)}` : ""}</small>}
                    <p>{entry.detail}</p>
                  </div>
                  <time>{syncTimeLabel(entry.occurredAt)}</time>
                </article>)}
              </div>
            </main>}
          </div>}
        </section>
      </div>}

      <div className="task-view-toolbar">
        <div className="task-view-switch" aria-label="任务视图">
          {taskViews.map((view) => {
            const ViewIcon = view.viewMode === "list" ? LayoutList : view.viewMode === "board" ? Columns3 : Table2;
            if (renamingTaskViewId === view.id) return <label key={view.id} className="task-view-rename-tab"><ViewIcon size={15} /><input autoFocus value={view.name} onChange={(event) => setTaskViews((current) => current.map((item) => item.id === view.id ? { ...item, name: event.target.value } : item))} onBlur={() => { if (!view.name.trim()) setTaskViews((current) => current.map((item) => item.id === view.id ? { ...item, name: "未命名视图" } : item)); setRenamingTaskViewId(null); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setRenamingTaskViewId(null); event.currentTarget.blur(); } }} aria-label="重命名视图" /></label>;
            if (view.id === activeTaskViewId) return <details key={view.id} className="task-view-tab-menu" ref={propertyMenuRef}><summary title={`配置视图“${view.name}”`}><ViewIcon size={15} /><span>{view.name}</span><ChevronDown size={13} /></summary>{viewSettingsPanel}</details>;
            return <button key={view.id} onClick={() => applyTaskView(view)} title={`打开视图“${view.name}”`}><ViewIcon size={15} /><span>{view.name}</span></button>;
          })}
          <button className="task-add-view" onClick={addTaskView} title="新建本地任务视图" aria-label="新建视图"><Plus size={16} /></button>
        </div>
        <div className="task-secondary-actions">
          <div className="task-tool-popover-wrap">
            <button className={taskStatsOpen ? "active" : ""} onClick={() => setTaskStatsOpen((open) => !open)} title="任务统计" aria-label="任务统计"><BarChart3 size={17} /></button>
            {taskStatsOpen && <div className="task-stats-popover"><header><strong>任务统计</strong><small>当前筛选结果</small></header><div><article><strong>{visibleTaskStats.total}</strong><span>任务</span></article><article><strong>{visibleTaskStats.open}</strong><span>待完成</span></article><article><strong>{visibleTaskStats.completed}</strong><span>已完成</span></article><article><strong>{visibleTaskStats.abandoned}</strong><span>已放弃</span></article><article><strong>{visibleTaskStats.linked}</strong><span>已关联</span></article></div><footer>项目容器 {visibleTaskStats.projects}（不计入行动） · 同一任务可有多个来源 · Craft {visibleTaskStats.craft} · 滴答 {visibleTaskStats.dida365} · Obsidian {visibleTaskStats.obsidian}</footer></div>}
          </div>
          <button onClick={() => void load()} disabled={loading} title="刷新本地任务数据" aria-label="刷新"><RefreshCw className={loading ? "spin" : ""} size={17} /></button>
          <button ref={runtimeCapabilities.mobile ? undefined : queryToolsButtonRef} className={queryToolsOpen || statusFilter !== "all" || sourceFilter !== "all" ? "active" : ""} onClick={() => setQueryToolsOpen((open) => !open)} title={queryToolsOpen ? "隐藏排序和筛选" : "显示排序和筛选"} aria-label="排序和筛选" aria-pressed={statusFilter !== "all" || sourceFilter !== "all"}><ListFilter size={18} /></button>
          {databaseSearchOpen ? <label className="task-toolbar-search"><Search size={14} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" /><button onClick={() => { setDatabaseSearchOpen(false); setQuery(""); }} title="关闭搜索" aria-label="关闭搜索"><X size={13} /></button></label> : <button onClick={() => setDatabaseSearchOpen(true)} title="搜索任务" aria-label="搜索任务"><Search size={17} /></button>}
          <details className="workspace-secondary-menu" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary aria-label="更多同步工具" title="更多同步工具">•••</summary><div>
            <button onClick={() => void inspectCapabilities()} disabled={checkingCapabilities}><ShieldCheck size={16} />检查同步能力</button>
            <button onClick={() => void previewSync()} disabled={previewingSync}><Eye size={16} />同步预览</button>
          </div></details>
          <button aria-label="切换预览侧栏" className={previewEnabled?"active":""} title="预览侧栏" aria-pressed={previewEnabled} onClick={()=>setPreviewEnabled(!previewEnabled)}><PanelRight size={18}/></button>
        </div>
      </div>

      <label className="task-collection-picker"><span>项目与清单</span><select aria-label="任务项目与清单" value={collectionKey} onChange={event => setCollectionKey(event.target.value)}><option value="">全部项目与清单</option>{collectionKey && !activeCollection && <option value={collectionKey}>所选清单不在当前范围</option>}{collections.map(group => <option key={group.key} value={group.key}>{group.name} · {group.library} ({group.count})</option>)}</select></label>
      {queryToolsOpen && <div className="task-query-tools" ref={queryToolsRef}>
        <div><span><ArrowUpDown size={14} />排序</span><select value={taskSort} onChange={(event) => setTaskSort(event.target.value as TaskSort)}><option value="default">默认顺序</option><option value="updated">更新时间</option><option value="due">到期日期</option><option value="title">任务名称</option></select><button disabled={taskSort === "default"} onClick={() => setTaskSortAscending((ascending) => !ascending)}><ArrowUpDown size={14} />{taskSortAscending ? "升序" : "降序"}</button></div>
        <div><span><ListFilter size={14} />筛选</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}><option value="all">全部状态</option><option value="open">待完成</option><option value="completed">已完成</option><option value="abandoned">已放弃</option></select><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}>{sourceOptions.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</select></div>
      </div>}

      <WorkspaceFilterSummary filters={[
        ...(collectionKey ? [{ label: `清单：${activeCollection?.name ?? "不在当前范围"}`, clear: () => setCollectionKey("") }] : []),
        ...(query ? [{ label: `搜索：${query}`, clear: () => setQuery("") }] : []),
        ...(statusFilter !== "all" ? [{ label: statusFilter === "open" ? "待完成" : statusFilter === "abandoned" ? "已放弃" : "已完成", clear: () => setStatusFilter("all") }] : []),
        ...(sourceFilter !== "all" ? [{ label: sourceOptions.find(source => source.id === sourceFilter)!.label, clear: () => setSourceFilter("all") }] : []),
      ]} onReset={resetFilters} />
      <div className="task-planning-toolbar" aria-label="任务 AI 操作"><span><Sparkles size={14}/>围绕原任务分析</span><button onClick={() => beginPlanning("today")}><CalendarCheck size={14}/>安排今天</button><button onClick={() => beginPlanning("project")}>梳理项目</button><button disabled={!selectedTask || !planningEligible(selectedTask)} onClick={() => beginPlanning("task")}>推进任务</button><button aria-pressed={todayOnly} onClick={() => setTodayOnly(v => !v)}>今日计划 {scopedTasks.filter(t => planningEligible(t) && planningRecord(t)?.day === planningDay).length}</button></div>
      <div className={`task-workspace-body ${planning || selectedTask && previewEnabled ? "has-preview" : ""}`}>
      <div className={`task-workspace-list ${viewMode} density-${taskDensity}`} ref={listRef} onScroll={rememberScroll}>
        {error && <div className="task-empty error">{error}</div>}
        {!error && loading && dashboard.tasks.length === 0 && <div className="task-empty">正在读取任务…</div>}
        {!error && !loading && visibleTasks.length === 0 && <div className="task-empty">当前范围内没有符合条件的任务 <button onClick={resetFilters}>清除筛选</button>{selectedLibraryIds !== null && onClearLibraryScope && <button onClick={onClearLibraryScope}>查看全部资料库</button>}</div>}
        {viewMode === "list" && hierarchicalTasks.map((task) => (
          <article className={`task-row ${taskConditionalColor(task, taskColorMode)} ${task.completed ? "completed" : ""} ${task.isProject ? "project" : ""} ${selectedTask?.id === task.id ? "selected" : ""}`} key={`${task.id}:${task.provider}`} style={{ "--task-depth": Math.min(displayTaskDepths.get(task.id) ?? task.depth, 4) } as CSSProperties} draggable onDragStart={event=>writeResultDragData(event.dataTransfer,taskSearchResult(task))} onClick={() => selectTaskPreview(task)}>
            <span className="task-state"><TaskStatusControl task={task} busy={taskBusyIds.has(task.id)} pendingStatus={taskStatusTargets.get(task.id)} onChange={changeTaskStatus}/></span>
            <div className="task-row-main">
              {taskDisclosure(task, "list")}
              <div className="task-row-title">{taskTitleContent(task.title, (href) => void openExternalLink(href))}</div>
              {planningRecord(task)?.day === planningDay && <small className="task-planning-mark">今日计划</small>}
              {planningRecord(task)?.note && <small className="task-planning-mark">有 AI 建议</small>}
              <TaskStatusNotice task={task} onRetry={retryTaskStatus}/>
              {task.isProject && <span className="task-project-badge">项目</span>}
              {task.syncState === "linked" && <span className="task-linked" title="已双向关联"><Link2 size={13} /></span>}
              {task.syncState === "conflict" && <span className="task-unlinked" title="两端均有修改，等待处理">冲突</span>}
              {task.syncState === "paused" && <span className="task-paused" title="已停止同步到滴答；可在任务预览中恢复">已暂停</span>}
            </div>
            <button className="task-planning-row-action" aria-label={`分析任务：${task.title}`} disabled={!planningEligible(task)} onClick={e => { e.stopPropagation(); beginPlanning("task", task); }}><Sparkles size={14}/><span>分析</span></button>
            <span className={`task-provider ${task.provider}`} title={`${task.libraryName}${task.documentTitle && task.provider !== "dida365" ? ` / ${task.documentTitle}` : ""}`}>{providerLabel(task.provider)}</span>
            {(task.startAt || task.dueAt) && <time title={scheduleLabel(task.startAt, task.dueAt, task.isAllDay)}>{scheduleLabel(task.startAt, task.dueAt, task.isAllDay)}</time>}
          </article>
        ))}
        {viewMode === "table" && visibleTasks.length > 0 && <div className="task-table-wrap">
          <table className="task-database-table">
            <thead><tr><th className="task-check-column">状态</th><th className="task-title-column">任务名称</th>{tableProperties.source && <th>来源</th>}{tableProperties.library && <th>资料库</th>}{tableProperties.document && <th>所在文档 / 清单</th>}{tableProperties.start && <th>开始日</th>}{tableProperties.due && <th>到期日</th>}{tableProperties.sync && <th>打开</th>}</tr></thead>
            <tbody>{hierarchicalTasks.map((task) => <tr className={`${taskConditionalColor(task, taskColorMode)} ${task.completed ? "completed" : ""} ${selectedTask?.id === task.id ? "selected" : ""}`} key={`${task.id}:${task.provider}`} draggable onDragStart={event=>writeResultDragData(event.dataTransfer,taskSearchResult(task))} onClick={() => selectTaskPreview(task)}>
              <td className="task-table-state"><TaskStatusControl task={task} busy={taskBusyIds.has(task.id)} pendingStatus={taskStatusTargets.get(task.id)} onChange={changeTaskStatus}/><TaskStatusNotice task={task} onRetry={retryTaskStatus}/></td>
              <td className="task-table-title" style={{ "--task-depth": Math.min(displayTaskDepths.get(task.id) ?? task.depth, 4) } as CSSProperties}>{taskDisclosure(task, "table")}{taskTitleContent(task.title, (href) => void openExternalLink(href))}{task.isProject && <span className="task-project-badge">项目</span>}</td>
              {tableProperties.source && <td><span className={`task-provider ${task.provider}`}>{providerLabel(task.provider)}</span></td>}
              {tableProperties.library && <td>{task.libraryName}</td>}
              {tableProperties.document && <td>{task.documentTitle || "—"}</td>}
              {tableProperties.start && <td>{task.startAt ? dueLabel(task.startAt) : "—"}</td>}
              {tableProperties.due && <td>{task.dueAt ? dueLabel(task.dueAt) : "—"}</td>}
              {tableProperties.sync && <td><button type="button" className="task-open-text-link" disabled={openingTaskId === task.id} title={`打开“${task.title}”`} onClick={(event) => { event.stopPropagation(); void openTaskSource(task); }}>{openingTaskId === task.id ? "解析中…" : `打开${providerLabel(task.provider)}`}</button></td>}
            </tr>)}</tbody>
          </table>
        </div>}
        {viewMode === "board" && visibleTasks.length > 0 && <div className="task-board">
          {boardGroups.map((group) => <section className={`task-board-column ${group.provider}`} key={group.provider}>
            <header title="按主要预览来源分栏；关联任务只展示一次"><span><i />{group.label} · 主来源</span><small>{group.tasks.length}</small></header>
            <div>{group.tasks.map((task) => <article className={`${taskConditionalColor(task, taskColorMode)} ${task.completed ? "completed" : ""} ${selectedTask?.id === task.id ? "selected" : ""}`} key={`${task.id}:${task.provider}`} draggable onDragStart={event=>writeResultDragData(event.dataTransfer,taskSearchResult(task))} onClick={() => selectTaskPreview(task)}>
              <div className="task-board-card-title"><TaskStatusControl task={task} busy={taskBusyIds.has(task.id)} pendingStatus={taskStatusTargets.get(task.id)} onChange={changeTaskStatus}/><strong>{taskTitleContent(task.title, (href) => void openExternalLink(href))}</strong><TaskStatusNotice task={task} onRetry={retryTaskStatus}/></div>
              {Object.values(tableProperties).some(Boolean) && <footer className="task-board-properties">
                <div>
                  {tableProperties.source && <span className={`task-provider ${task.provider}`}>{providerLabel(task.provider)}</span>}
                  {tableProperties.library && <span title={task.libraryName}>{task.libraryName || "—"}</span>}
                  {tableProperties.document && task.documentTitle && <span title={task.provider === "dida365" ? `所在清单：${task.documentTitle}` : task.documentTitle}>{task.documentTitle}</span>}
                  {tableProperties.start && task.startAt && <time title="开始日">开始 {dueLabel(task.startAt)}</time>}
                  {tableProperties.due && task.dueAt && <time title="到期日">到期 {dueLabel(task.dueAt)}</time>}
                </div>
                {tableProperties.sync && <button type="button" className="task-board-open-link" disabled={openingTaskId === task.id} title={`打开“${task.title}”`} aria-label={`打开${task.title}`} onClick={(event) => { event.stopPropagation(); void openTaskSource(task); }}><ArrowUpRight className={openingTaskId === task.id ? "spin" : ""} size={15} /></button>}
              </footer>}
            </article>)}</div>
          </section>)}
        </div>}
      </div>
      {planning ? <TaskPlanningPanel key={planning.id} request={planning} onClose={() => setPlanning(null)} onSaved={refreshPlanningRecords} onTask={task => { setPreviewPinned(false); setPlanning(null); setCollectionKey(taskCollectionKey(task)); setSourceFilter("all"); setStatusFilter("all"); setQuery(""); setTodayOnly(false); setSelectedTask(task); setPreviewEnabled(true); }} /> : previewEnabled && selectedTask && selectedResult && <TaskPreviewPane
          selected={selectedResult} libraries={libraries}
          copiedResultId={previewLink.copiedKey === selectedTask.id ? selectedResult.id : ""}
          onCopyLink={() => previewLink.copy(selectedTask.id, async () => invoke<string>("result_link", resultLinkRequest(await resolveTaskResult(selectedTask))))}
          onOpenSource={() => void openTaskSource(selectedTask, "preview")} onOpenLink={openPreviewLink}
          onClose={() => { setPreviewPinned(false); setSelectedTask(null); }} onStatus={showPreviewStatus}
          canGoBack={previewHistory.index > 0} canGoForward={previewHistory.index < previewHistory.entries.length - 1}
          previewPinned={previewPinned} onNavigate={navigateTaskPreview} onTogglePinned={() => setPreviewPinned(value => !value)}
          toolbarActions={selectedTask.provider === "craft" && (selectedTask.syncState === "linked" || selectedTask.syncState === "conflict") && <details className="preview-more-menu" key={selectedTask.id} onKeyDown={event => {
            if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
          }}>
            <summary title="更多预览操作" aria-label="更多预览操作"><MoreHorizontal size={18}/></summary>
            <div><button className="danger" disabled={syncing} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); void removeSelectedTaskFromDida(); }}>保留 Craft，移除滴答</button></div>
          </details>}
          contentBefore={<><div className="task-planning-detail"><button disabled={!planningEligible(selectedTask)} onClick={() => beginPlanning("task", selectedTask)}><Sparkles size={14}/>分析并推进这条任务</button><button onClick={() => setPlanning({ id: crypto.randomUUID(), mode: "task", label: selectedTask.title, tasks: [selectedTask], historyOnly: true })}>查看来源操作记录</button>{planningRecord(selectedTask)?.day === planningDay && <button onClick={() => void removePlanningDay(selectedTask).then(refreshPlanningRecords).catch(e => onStatusMessage?.(String(e), "error"))}>移出今日计划</button>}{planningRecord(selectedTask)?.note && <section><h3>Hub 建议笔记</h3><p>{planningRecord(selectedTask)?.note}</p></section>}</div>{selectedTask.provider === "craft" && selectedTask.syncState === "paused" && <div className="task-sync-resume">
              <div><strong>{selectedTask.isProject ? "这个项目已停止同步到滴答" : "这个任务已停止同步到滴答"}</strong>
                <p>{selectedTask.isProject ? "之前保存了停止同步规则。恢复后，缺少的项目父任务会进入收件箱；现有子任务的关联和所在清单会保留。" : "之前保存了停止同步规则。恢复后保留现有关联；尚未关联的任务会进入收件箱。"}</p>
              </div>
              <button disabled={syncing || backgroundSyncing} onClick={() => void resumeSelectedCraftSync()}>恢复同步到滴答</button>
            </div>}</>}/>}
      </div>
    </section>
    </div>
  );
}
