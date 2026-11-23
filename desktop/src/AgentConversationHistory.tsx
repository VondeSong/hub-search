import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, ArrowLeft, Check, ChevronDown, ChevronRight, Cloud, MessageCircle, MoreHorizontal, Pin, PinOff, Plus, Search, Settings2, Trash2, X } from "lucide-react";
import { conversationDate, conversationTime, conversationTitle, groupConversations, type HistoryChange, type WorkSummary } from "./AgentConversationHistoryData";
import "./AgentConversationHistory.css";

export type { HistoryChange, WorkSummary } from "./AgentConversationHistoryData";

export type CloudHistoryThread = {
  id: string;
  title: string;
  updated: number;
  archived?: boolean;
  preview?: string;
  status?: string;
  matches?: boolean | number | null;
};

export type CloudHistoryProps = {
  configured: boolean;
  loading: boolean;
  error: string;
  management: boolean;
  resultQuery?: string;
  threads: CloudHistoryThread[];
  activeThreadId?: string;
  pendingThreadId?: string;
  onOpenThread: (threadId: string) => void;
  onNewThread: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onFilterChange?: (filter: "all" | "cloud") => void;
};

export function cloudThreadMatchesQuery(
  thread: CloudHistoryThread,
  normalizedQuery: string,
  options: { management: boolean; resultQuery?: string },
): boolean {
  if (!normalizedQuery) return true;
  const serverMatchesQuery = options.management
    && options.resultQuery !== undefined
    && options.resultQuery.trim().toLowerCase() === normalizedQuery;
  if (serverMatchesQuery && (typeof thread.matches === "boolean" || typeof thread.matches === "number")) {
    return Boolean(thread.matches);
  }
  return thread.title.toLowerCase().includes(normalizedQuery)
    || Boolean(thread.preview?.toLowerCase().includes(normalizedQuery));
}

type Props = {
  works: WorkSummary[];
  currentId?: string;
  disabled: boolean;
  more: boolean;
  loading: boolean;
  error: string;
  states: Record<string, string>;
  onOpen: (work: WorkSummary) => void;
  onChange: (work: WorkSummary, change: HistoryChange) => Promise<void>;
  onMore: () => void;
  onClose: () => void;
  onRetry?: () => void;
  query?: string;
  archived?: boolean;
  onQueryChange?: (value: string) => void;
  onArchivedChange?: (value: boolean) => void;
  // The host owns outer navigation, pagination and complete-history filtering.
  expanded?: boolean;
  onExpand?: () => void;
  onBack?: () => void;
  cloud?: CloudHistoryProps;
};
type Undo = { work: WorkSummary; change: HistoryChange; label: string };
type MixedHistoryItem = { kind: "local"; work: WorkSummary; time: number } | { kind: "cloud"; thread: CloudHistoryThread; time: number };
type MixedHistoryGroup = { key: "pinned" | "today" | "recent" | "earlier"; label: string; items: MixedHistoryItem[] };

function groupMixedHistory(works: WorkSummary[], threads: CloudHistoryThread[], now: number, archived: boolean): MixedHistoryGroup[] {
  const localGroups = groupConversations(works, now, archived);
  if (!threads.length) {
    return localGroups.map(group => ({
      key: group.key,
      label: group.label,
      items: group.works.map(work => ({ kind: "local", work, time: work.updatedAt ?? 0 })),
    }));
  }
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const recent = new Date(today);
  recent.setDate(recent.getDate() - 30);
  const buckets: MixedHistoryGroup[] = [
    { key: "pinned", label: "已固定", items: [] },
    { key: "today", label: "今天", items: [] },
    { key: "recent", label: "过去 30 天", items: [] },
    { key: "earlier", label: "更早", items: [] },
  ];
  for (const group of localGroups) {
    const target = buckets.find(item => item.key === group.key)!;
    for (const work of group.works) target.items.push({ kind: "local", work, time: work.updatedAt ?? 0 });
  }
  const uniqueThreads = [...new Map(threads.map(thread => [thread.id, thread])).values()];
  for (const thread of uniqueThreads) {
    const updated = typeof thread.updated === "number" && thread.updated > 0 ? thread.updated : 0;
    const index = updated >= today.getTime() ? 1 : updated >= recent.getTime() ? 2 : 3;
    buckets[index].items.push({ kind: "cloud", thread, time: updated });
  }
  for (const bucket of buckets) {
    if (bucket.key === "pinned") continue;
    bucket.items.sort((a, b) => {
      const diff = b.time - a.time;
      if (diff !== 0) return diff;
      const aId = a.kind === "local" ? a.work.id : a.thread.id;
      const bId = b.kind === "local" ? b.work.id : b.thread.id;
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    });
  }
  return buckets.filter(bucket => bucket.items.length > 0);
}

export function AgentConversationHistory({ works, currentId, disabled, more, loading, error, states, onOpen, onChange, onMore, onClose, onRetry,
  query = "", archived = false, onQueryChange, onArchivedChange, expanded = false, onExpand, onBack, cloud }: Props) {
  const [undoEntries, setUndoEntries] = useState<Undo[]>([]);
  const [changing, setChanging] = useState(false);
  const [actionError, setActionError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(!!query);
  const [actionsId, setActionsId] = useState<string | null>(null);
  const [actionsPosition, setActionsPosition] = useState<CSSProperties>({});
  const [sourceFilter, setSourceFilter] = useState<"all" | "cloud">("all");
  const alive = useRef(true), mutation = useRef(false);
  const history = useRef<HTMLElement>(null), actions = useRef<HTMLDivElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null), searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const actionButtons = useRef(new Map<string, HTMLButtonElement>());
  const now = Date.now();
  const normalizedQuery = query.trim().toLowerCase();
  const visibleCloudThreads = cloud?.configured
    ? cloud.threads.filter(thread => Boolean(thread.archived) === archived
      && cloudThreadMatchesQuery(thread, normalizedQuery, { management: cloud.management, resultQuery: cloud.resultQuery }))
    : [];
  const showingCloudOnly = Boolean(cloud && sourceFilter === "cloud");
  const groups = showingCloudOnly
    ? groupMixedHistory([], visibleCloudThreads, now, archived)
    : groupMixedHistory(works, cloud?.configured ? visibleCloudThreads : [], now, archived);
  const selected = actionsId ? works.find(work => work.id === actionsId) : undefined;
  const searching = searchOpen || !!query;
  const changeSourceFilter = (next: "all" | "cloud") => {
    setSourceFilter(next);
    setActionsId(null);
    cloud?.onFilterChange?.(next);
  };

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const menu = history.current?.closest("details");
    if (!menu) return;
    const sync = () => { setMenuOpen(menu.open); if (!menu.open) setActionsId(null); };
    sync(); menu.addEventListener("toggle", sync);
    return () => menu.removeEventListener("toggle", sync);
  }, []);
  useEffect(() => { if (searching) searchInput.current?.focus(); }, [searching]);
  useEffect(() => { setActionsId(null); setActionError(""); }, [query, archived]);
  useEffect(() => {
    if (actionsId && !works.some(work => work.id === actionsId)) setActionsId(null);
  }, [works, actionsId]);

  const focusActionButton = (id: string) => {
    const button = actionButtons.current.get(id);
    if (button?.isConnected) button.focus({ preventScroll: true });
    else (searchInput.current || searchButton.current || closeButton.current)?.focus({ preventScroll: true });
  };
  const closeActions = (focus = false) => {
    const id = actionsId;
    setActionsId(null);
    if (focus && id) focusActionButton(id);
  };
  useLayoutEffect(() => {
    if (!actionsId) return;
    const trigger = actionButtons.current.get(actionsId), section = history.current, menu = actions.current;
    if (!trigger || !section || !menu) return;
    const position = () => {
      const box = section.getBoundingClientRect(), anchor = trigger.getBoundingClientRect();
      const width = menu.offsetWidth || 188, height = menu.offsetHeight || (archived ? 92 : 132);
      setActionsPosition({
        left: Math.max(4, Math.min(anchor.right - box.left - width, box.width - width - 4)),
        top: Math.max(4, Math.min(anchor.bottom - box.top + 4, box.height - height - 4)),
      });
    };
    position(); menu.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node) && !trigger.contains(event.target as Node)) setActionsId(null);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", position);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", position); };
  }, [actionsId, archived]);

  const update = async (work: WorkSummary, change: HistoryChange) => {
    if (disabled || mutation.current) return false;
    mutation.current = true; setChanging(true); setActionError("");
    try { await onChange(work, change); return true; }
    catch (reason) { if (alive.current) setActionError(String(reason)); return false; }
    finally { mutation.current = false; if (alive.current) setChanging(false); }
  };
  const changeHistory = async (work: WorkSummary, change: HistoryChange) => {
    const rows = [...history.current?.querySelectorAll<HTMLButtonElement>(".agent-history-open") || []];
    const current = rows.findIndex(button => button.dataset.workId === work.id);
    const next = rows[current + 1] || rows[current - 1];
    if (!await update(work, change) || !alive.current) return;
    setActionsId(null);
    if (change.deleted === true) {
      setUndoEntries(previous => [...previous, { work, change: { deleted: false }, label: "已删除对话" }]);
    } else if (change.archived !== undefined) {
      setUndoEntries(previous => [...previous, { work, change: { archived: !!work.archived }, label: change.archived ? "已归档对话" : "已恢复对话" }]);
    }
    setTimeout(() => {
      if (!alive.current) return;
      const menu = history.current?.closest("details");
      if (menu && !menu.open) return;
      if (change.pinned !== undefined) focusActionButton(work.id);
      else if (!menu && undoButton.current) undoButton.current.focus({ preventScroll: true });
      else if (next?.isConnected) next.focus({ preventScroll: true });
      else (searchInput.current || searchButton.current || closeButton.current)?.focus({ preventScroll: true });
    }, 0);
  };
  const undo = async () => {
    const entry = undoEntries[undoEntries.length - 1];
    if (!entry || !await update(entry.work, entry.change) || !alive.current) return;
    setUndoEntries(previous => previous.slice(0, -1));
    setTimeout(() => {
      if (!alive.current) return;
      const outer = history.current?.closest("details");
      const target = undoButton.current || (outer && !outer.open ? outer.querySelector<HTMLElement>("summary") : null)
        || searchInput.current || searchButton.current || closeButton.current;
      target?.focus({ preventScroll: true });
    }, 0);
  };
  const clearSearch = () => { onQueryChange?.(""); setSearchOpen(false); searchButton.current?.focus(); };
  const undoTarget = menuOpen ? null : history.current?.closest(".agent-panel");
  const undoNotice = undoEntries.length > 0 ? <div className={`agent-history-undo${undoTarget ? " agent-history-toast" : ""}`}>
    <span role="status">{undoEntries.length === 1 ? undoEntries[0].label
      : undoEntries.every(entry => entry.label === "已删除对话") ? `已删除 ${undoEntries.length} 段对话`
      : `已更新 ${undoEntries.length} 段对话`}</span>
    <button ref={undoButton} type="button" disabled={disabled || changing} onClick={() => void undo()}>撤销</button>
  </div> : null;

  return <section ref={history} className="agent-conversations agent-history-popover" aria-label={archived ? "已归档的对话" : "对话历史"} aria-busy={loading}
    onKeyDown={event => {
      if (event.key === "Escape" && actionsId) { event.preventDefault(); event.stopPropagation(); closeActions(true); }
    }}>
    <div className="agent-history-heading agent-history-toolbar">
      {archived && onArchivedChange ? <button type="button" aria-label="返回对话历史" title="返回对话历史" onClick={() => onArchivedChange(false)}><ArrowLeft size={17} /></button>
        : expanded && onBack && <button type="button" aria-label="返回对话菜单" onClick={onBack}><ArrowLeft size={17} /></button>}
      <strong>{archived ? "已归档的对话" : "对话历史"}</strong>
      {onQueryChange && <button ref={searchButton} type="button" aria-label="搜索对话标题和提问" title="搜索对话标题和提问" aria-expanded={searching} onClick={() => { setSearchOpen(true); onExpand?.(); searchInput.current?.focus(); }}><Search size={17} /></button>}
      <button ref={closeButton} type="button" aria-label="关闭对话历史" title="关闭对话历史" onClick={onClose}><X size={17} /></button>
    </div>
    {cloud && <div className="agent-history-source-tabs" role="group" aria-label="会话来源筛选">
      <button type="button" aria-pressed={sourceFilter === "all"} onClick={() => changeSourceFilter("all")}>
        全部{works.length + visibleCloudThreads.length > 0 ? ` (${works.length + visibleCloudThreads.length})` : ""}
      </button>
      <button type="button" aria-pressed={sourceFilter === "cloud"} title="查看个人云端与手机同步会话" onClick={() => changeSourceFilter("cloud")}>
        <Cloud size={12} aria-hidden="true" />
        <span>个人云端{cloud.configured ? ` (${visibleCloudThreads.length})` : ""}</span>
      </button>
    </div>}
    {showingCloudOnly && cloud && <div className="agent-history-cloud-bar">
      {cloud.configured && <button type="button" onClick={cloud.onNewThread}><Plus size={13} aria-hidden="true" /><span>新建云端对话</span></button>}
      <button type="button" onClick={cloud.onOpenSettings}><Settings2 size={13} aria-hidden="true" /><span>{cloud.configured ? "连接与设备" : "连接个人云端"}</span></button>
    </div>}
    {showingCloudOnly && cloud?.pendingThreadId && <div className="agent-history-cloud-pending">
      <button type="button" onClick={() => cloud.onOpenThread(cloud.pendingThreadId!)}>有一条待确认云端消息 · 返回原会话</button>
    </div>}
    {searching && onQueryChange && <div className="agent-history-search"><Search size={16} aria-hidden="true" />
      <input ref={searchInput} type="search" aria-label="搜索对话标题和提问" placeholder="搜索对话标题和提问…" value={query} maxLength={200} onChange={event => onQueryChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); clearSearch(); }
          if (event.key === "ArrowDown") { event.preventDefault(); history.current?.querySelector<HTMLButtonElement>(".agent-history-open:not(:disabled)")?.focus(); }
        }} />
      <button type="button" aria-label="收起历史搜索" title="收起搜索" onClick={clearSearch}><X size={15} /></button>
    </div>}
    <div className="agent-history-list" onScroll={() => { if (actionsId) setActionsId(null); }}>
      {showingCloudOnly && cloud ? <>
        {cloud.loading && !visibleCloudThreads.length && <p className="agent-history-notice" role="status">正在读取个人云端会话…</p>}
        {!cloud.loading && !cloud.configured && !cloud.error && <div className="agent-history-empty">
          <Cloud size={25} aria-hidden="true" />
          <p>尚未连接个人云端</p>
          <small>连接个人 VPS 后，手机与电脑同步的个人云端会话及桌面交接报告会显示在这里。</small>
          <button type="button" className="agent-history-cloud-cta" onClick={cloud.onOpenSettings}>连接个人云端</button>
        </div>}
        {!cloud.loading && cloud.configured && !cloud.error && !visibleCloudThreads.length && <div className="agent-history-empty">
          {archived ? <Archive size={25} aria-hidden="true" /> : <Cloud size={25} aria-hidden="true" />}
          <p>{query ? "没有找到匹配的云端对话" : archived ? "还没有已归档的云端对话" : "还没有个人云端对话"}</p>
          <small>{query ? "试试其他关键词" : archived ? "已归档的云端会话会保留在这里。" : "在手机端或此处新建云端对话，或把桌面分析报告发到个人云端后，会显示在这里。"}</small>
        </div>}
      </> : <>
        {loading && !works.length && !visibleCloudThreads.length && <p className="agent-history-notice" role="status">{query ? "正在搜索对话…" : "正在读取历史对话…"}</p>}
        {!loading && !error && !works.length && !visibleCloudThreads.length && <div className="agent-history-empty">
          {archived ? <Archive size={25} aria-hidden="true" /> : <MessageCircle size={25} aria-hidden="true" />}
          <p>{query ? "没有找到匹配的对话" : archived ? "还没有已归档的对话" : "还没有历史对话"}</p>
          <small>{query ? "试试其他关键词" : archived ? "归档的对话会保存在这里。" : "发送第一条消息后，会显示在这里。"}</small>
        </div>}
      </>}
      {groups.map(group => <section key={group.key} className="agent-history-group" aria-label={group.label}>
        <h3>{group.label}</h3>
        {group.items.map(item => {
          if (item.kind === "cloud") {
            const { thread } = item;
            const title = thread.title.replace(/\s+/g, " ").trim() || "未命名云端会话";
            const date = conversationDate(thread.updated);
            const activeCloud = cloud?.activeThreadId === thread.id;
            return <div className="agent-history-row is-cloud" key={`cloud:${thread.id}`} data-current={activeCloud || undefined}>
              <button type="button" className="agent-history-open agent-history-open-cloud" data-cloud-thread-id={thread.id}
                aria-label={`打开云端对话 ${title}`} aria-current={activeCloud ? "true" : undefined}
                title={`${title}\n${date} · 个人云端${thread.preview ? `\n${thread.preview}` : ""}`}
                disabled={changing} onClick={() => cloud?.onOpenThread(thread.id)}>
                <span className="agent-history-title agent-history-title-cloud"><Cloud size={12} aria-hidden="true" /><span>{title}</span></span>
                {activeCloud && <Check size={13} className="agent-history-current" aria-hidden="true" />}
                <span className="agent-history-meta-cloud">
                  <time title={date} dateTime={thread.updated && Number.isFinite(new Date(thread.updated).getTime()) ? new Date(thread.updated).toISOString() : undefined}>{conversationTime(thread.updated, now)}</time>
                  <span className="agent-history-cloud-origin">· 个人云端</span>
                </span>
              </button>
            </div>;
          }
          const { work } = item;
          const title = conversationTitle(work), date = conversationDate(work.updatedAt);
          return <div className="agent-history-row" key={work.id} data-current={!cloud?.activeThreadId && currentId === work.id || undefined} data-actions-open={actionsId === work.id || undefined}>
            <button type="button" className="agent-history-open" data-work-id={work.id} aria-label={`打开对话 ${title}`} aria-current={!cloud?.activeThreadId && currentId === work.id ? "true" : undefined}
              title={`${title}\n${date} · ${states[work.state] || work.state}${work.messageCount === undefined ? "" : ` · ${work.messageCount} 条消息`}`}
              disabled={disabled || changing} onClick={() => onOpen(work)}>
              <span className="agent-history-title">{title}</span>
              {!cloud?.activeThreadId && currentId === work.id && <Check size={13} className="agent-history-current" aria-hidden="true" />}
              <time title={date} dateTime={work.updatedAt && Number.isFinite(new Date(work.updatedAt).getTime()) ? new Date(work.updatedAt).toISOString() : undefined}>{conversationTime(work.updatedAt, now)}</time>
            </button>
            <span className="agent-history-actions"><button ref={button => { if (button) actionButtons.current.set(work.id, button); else actionButtons.current.delete(work.id); }} type="button"
              aria-label={`更多对话操作 ${title}`} title="更多操作" aria-haspopup="menu" aria-expanded={actionsId === work.id} disabled={disabled || changing}
              onClick={() => setActionsId(current => current === work.id ? null : work.id)}><MoreHorizontal size={17} /></button></span>
          </div>;
        })}
      </section>)}
      {!showingCloudOnly && more && <button className="agent-history-more" type="button" disabled={disabled || changing || loading} onClick={onMore}>
        <span>{loading ? "正在加载…" : error ? "重试加载更多对话" : "加载更多对话"}</span><ChevronDown size={15} aria-hidden="true" />
      </button>}
      {!showingCloudOnly && loading && !!works.length && !more && <p className="agent-history-notice" role="status">正在更新…</p>}
    </div>
    {showingCloudOnly && cloud?.error && <div className="agent-history-error"><p role="alert">{cloud.error}</p><button type="button" disabled={cloud.loading} onClick={cloud.onRefresh}>重新读取云端</button></div>}
    {!showingCloudOnly && (error || actionError) && <div className="agent-history-error"><p role="alert">{error || actionError}</p>{error && onRetry && <button type="button" disabled={changing || loading} onClick={onRetry}>重新读取历史</button>}</div>}
    {onArchivedChange && !archived && <div className="agent-history-footer"><button type="button" disabled={changing} onClick={() => { setActionsId(null); onArchivedChange(true); onExpand?.(); }}>
      <Archive size={16} aria-hidden="true" /><span>已归档的对话</span><ChevronRight size={14} aria-hidden="true" />
    </button></div>}
    {undoTarget && undoNotice ? createPortal(undoNotice, undoTarget) : undoNotice}
    {selected && <div ref={actions} className="agent-history-action-menu" role="menu" aria-label={`${conversationTitle(selected)}的操作`} style={actionsPosition}
      onBlur={event => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)
          && !actionButtons.current.get(selected.id)?.contains(event.relatedTarget)) setActionsId(null);
      }}
      onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      {!archived && <button type="button" role="menuitem" disabled={disabled || changing} aria-label={`${selected.pinned ? "取消置顶" : "置顶对话"} ${conversationTitle(selected)}`}
        onClick={() => void changeHistory(selected, { pinned: !selected.pinned })}>{selected.pinned ? <PinOff size={16} /> : <Pin size={16} />}<span>{selected.pinned ? "取消置顶" : "置顶对话"}</span></button>}
      <button type="button" role="menuitem" disabled={disabled || changing} aria-label={`${archived ? "恢复对话" : "归档对话"} ${conversationTitle(selected)}`}
        onClick={() => void changeHistory(selected, { archived: !archived })}>{archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}<span>{archived ? "恢复到对话历史" : "归档对话"}</span></button>
      <div className="agent-history-menu-divider" />
      <button type="button" role="menuitem" className="agent-history-delete" disabled={disabled || changing} aria-label={`删除对话 ${conversationTitle(selected)}`}
        onClick={() => void changeHistory(selected, { deleted: true })}><Trash2 size={16} /><span>删除对话</span></button>
    </div>}
  </section>;
}
