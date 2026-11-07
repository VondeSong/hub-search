import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, ArrowLeft, Check, ChevronDown, ChevronRight, MessageCircle, MoreHorizontal, Pin, PinOff, Search, Trash2, X } from "lucide-react";
import { conversationDate, conversationTime, conversationTitle, groupConversations, type HistoryChange, type WorkSummary } from "./AgentConversationHistoryData";
import "./AgentConversationHistory.css";

export type { HistoryChange, WorkSummary } from "./AgentConversationHistoryData";

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
};
type Undo = { work: WorkSummary; change: HistoryChange; label: string };

export function AgentConversationHistory({ works, currentId, disabled, more, loading, error, states, onOpen, onChange, onMore, onClose, onRetry,
  query = "", archived = false, onQueryChange, onArchivedChange, expanded = false, onExpand, onBack }: Props) {
  const [undoEntries, setUndoEntries] = useState<Undo[]>([]);
  const [changing, setChanging] = useState(false);
  const [actionError, setActionError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(!!query);
  const [actionsId, setActionsId] = useState<string | null>(null);
  const [actionsPosition, setActionsPosition] = useState<CSSProperties>({});
  const alive = useRef(true), mutation = useRef(false);
  const history = useRef<HTMLElement>(null), actions = useRef<HTMLDivElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null), searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const actionButtons = useRef(new Map<string, HTMLButtonElement>());
  const now = Date.now();
  const groups = groupConversations(works, now, archived);
  const selected = actionsId ? works.find(work => work.id === actionsId) : undefined;
  const searching = searchOpen || !!query;

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
      {onQueryChange && <button ref={searchButton} type="button" aria-label="搜索对话标题" title="搜索对话标题" aria-expanded={searching} onClick={() => { setSearchOpen(true); onExpand?.(); searchInput.current?.focus(); }}><Search size={17} /></button>}
      <button ref={closeButton} type="button" aria-label="关闭对话历史" title="关闭对话历史" onClick={onClose}><X size={17} /></button>
    </div>
    {searching && onQueryChange && <div className="agent-history-search"><Search size={16} aria-hidden="true" />
      <input ref={searchInput} type="search" aria-label="搜索对话标题" placeholder="搜索对话标题…" value={query} maxLength={200} onChange={event => onQueryChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); clearSearch(); }
          if (event.key === "ArrowDown") { event.preventDefault(); history.current?.querySelector<HTMLButtonElement>(".agent-history-open:not(:disabled)")?.focus(); }
        }} />
      <button type="button" aria-label="收起历史搜索" title="收起搜索" onClick={clearSearch}><X size={15} /></button>
    </div>}
    <div className="agent-history-list" onScroll={() => { if (actionsId) setActionsId(null); }}>
      {loading && !works.length && <p className="agent-history-notice" role="status">{query ? "正在搜索对话…" : "正在读取历史对话…"}</p>}
      {!loading && !error && !works.length && <div className="agent-history-empty">
        {archived ? <Archive size={25} aria-hidden="true" /> : <MessageCircle size={25} aria-hidden="true" />}
        <p>{query ? "没有找到匹配的对话" : archived ? "还没有已归档的对话" : "还没有历史对话"}</p>
        <small>{query ? "试试其他标题关键词" : archived ? "归档的对话会保存在这里。" : "发送第一条消息后，会显示在这里。"}</small>
      </div>}
      {groups.map(group => <section key={group.key} className="agent-history-group" aria-label={group.label}>
        <h3>{group.label}</h3>
        {group.works.map(work => {
          const title = conversationTitle(work), date = conversationDate(work.updatedAt);
          return <div className="agent-history-row" key={work.id} data-current={currentId === work.id || undefined} data-actions-open={actionsId === work.id || undefined}>
            <button type="button" className="agent-history-open" data-work-id={work.id} aria-label={`打开对话 ${title}`} aria-current={currentId === work.id ? "true" : undefined}
              title={`${title}\n${date} · ${states[work.state] || work.state}${work.messageCount === undefined ? "" : ` · ${work.messageCount} 条消息`}`}
              disabled={disabled || changing} onClick={() => onOpen(work)}>
              <MessageCircle size={18} aria-hidden="true" />
              <span className="agent-history-title">{title}</span>
              {currentId === work.id && <Check size={13} className="agent-history-current" aria-hidden="true" />}
              <time title={date} dateTime={work.updatedAt && Number.isFinite(new Date(work.updatedAt).getTime()) ? new Date(work.updatedAt).toISOString() : undefined}>{conversationTime(work.updatedAt, now)}</time>
            </button>
            <span className="agent-history-actions"><button ref={button => { if (button) actionButtons.current.set(work.id, button); else actionButtons.current.delete(work.id); }} type="button"
              aria-label={`更多对话操作 ${title}`} title="更多操作" aria-haspopup="menu" aria-expanded={actionsId === work.id} disabled={disabled || changing}
              onClick={() => setActionsId(current => current === work.id ? null : work.id)}><MoreHorizontal size={17} /></button></span>
          </div>;
        })}
      </section>)}
      {more && <button className="agent-history-more" type="button" disabled={disabled || changing || loading} onClick={onMore}>
        <span>{loading ? "正在加载…" : error ? "重试加载更多对话" : "加载更多对话"}</span><ChevronDown size={15} aria-hidden="true" />
      </button>}
      {loading && !!works.length && !more && <p className="agent-history-notice" role="status">正在更新…</p>}
    </div>
    {(error || actionError) && <div className="agent-history-error"><p role="alert">{error || actionError}</p>{error && onRetry && <button type="button" disabled={changing || loading} onClick={onRetry}>重新读取历史</button>}</div>}
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
