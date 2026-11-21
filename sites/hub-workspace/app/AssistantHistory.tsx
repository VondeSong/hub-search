"use client";
import { useId, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowLeft, Check, ChevronRight, MessageCircle, MoreHorizontal, Pin, PinOff, Search, Trash2, X } from 'lucide-react';
import type { HistoryItem } from './AssistantChrome';

export type HistoryChange = 'pin' | 'archive' | 'delete';
export function historyGroup(item: HistoryItem, now = Date.now()) {
  if (item.pinned) return '已固定';
  if (!item.updatedAt) return '更早';
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const recent = new Date(today); recent.setDate(recent.getDate() - 30);
  return item.updatedAt >= today.getTime() ? '今天' : item.updatedAt >= recent.getTime() ? '过去 30 天' : '更早';
}
const historyTimestamp = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function AssistantHistory({ history, currentId, disabled, onSelect, onChange, onClose }: {
  history: HistoryItem[]; currentId: string; disabled: boolean; onSelect: (id: string) => void; onChange: (id: string, change: HistoryChange) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState(''), [searching, setSearching] = useState(false), [archived, setArchived] = useState(false);
  const [actions, setActions] = useState<string | null>(null), [limit, setLimit] = useState(20);
  const searchButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLElement>(null);
  const historyId = useId();

  function showArchived(next: boolean) {
    setArchived(next);
    setActions(null);
    setLimit(20);
    setQuery('');
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }

  function closeSearch() { setQuery(''); setSearching(false); searchButton.current?.focus(); }
  const keyword = query.trim().toLowerCase();
  const rows = history.filter(item => item.archived === archived && (item.blocked ? '来源不可用' : item.title).toLowerCase().includes(keyword)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const empty = keyword
    ? { icon: Search, title: '没有找到匹配的对话', hint: '换个标题关键词试试。' }
    : archived
      ? { icon: Archive, title: '还没有已归档的对话', hint: '通过对话的更多菜单归档后，可在这里恢复。' }
      : { icon: MessageCircle, title: '还没有历史对话', hint: '发送一条消息后，可在这里找回对话。' };
  return <section className="ha-menu ha-header-menu ha-history" aria-label="对话历史">
    <header className="ha-menu-heading ha-history-heading">{archived && <button type="button" aria-label="返回对话历史" onClick={() => showArchived(false)}><ArrowLeft size={16}/></button>}<strong ref={heading} tabIndex={-1}>{archived ? '已归档的对话' : '对话历史'}</strong><div className="ha-history-heading-actions"><button ref={searchButton} type="button" className="ha-icon" aria-label="搜索对话标题" aria-expanded={searching} onClick={() => searching ? closeSearch() : setSearching(true)}><Search size={17}/></button><button type="button" className="ha-icon" aria-label="关闭对话历史" onClick={onClose}><X size={17}/></button></div></header>
    {searching && <div className="ha-history-filter"><label><Search size={15}/><input autoFocus type="search" aria-label="搜索对话" placeholder="搜索对话标题…" value={query} maxLength={200} onChange={event => { setQuery(event.target.value); setLimit(20); }} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); closeSearch(); } }}/></label><button type="button" className="ha-icon" aria-label="收起历史搜索" onClick={closeSearch}><X size={15}/></button></div>}
    {!rows.length && <div className="ha-history-empty" role="status">
      <empty.icon size={18} aria-hidden="true"/>
      <div><p>{empty.title}</p><small>{empty.hint}</small></div>
    </div>}
    {['已固定', '今天', '过去 30 天', '更早'].map(group => {
      const items = rows.slice(0, limit).filter(item => historyGroup(item) === group);
      return !!items.length && <section key={group} aria-label={group}><h3 className="ha-menu-subtitle">{group}</h3>{items.map(item => {
        const title = item.blocked ? '来源不可用' : item.title;
        const isCurrent = item.id === currentId;
        const metadataId = historyId + '-' + item.id;
        const updatedAt = new Date(item.updatedAt ?? NaN);
        const timestamp = Number.isFinite(updatedAt.getTime()) ? updatedAt : null;
        return <div className="ha-history-row" key={item.id}>
          <button type="button" className="ha-history-open" aria-label={'打开对话 ' + title} aria-describedby={metadataId} title={title} disabled={disabled || item.blocked} aria-current={isCurrent ? 'true' : undefined} onClick={() => { onSelect(item.id); onClose(); }}>
            {(item.pinned && !archived) ? <Pin size={16} aria-hidden="true"/> : <MessageCircle size={16} aria-hidden="true"/>}
            <span className="ha-history-copy">
              <span className="ha-history-title">{title}</span>
              <span className="ha-history-meta" id={metadataId}>
                {timestamp ? <time dateTime={timestamp.toISOString()}>{historyTimestamp.format(timestamp)}</time> : '时间未知'}
                {!item.blocked && <> · {item.messageCount} 条消息</>}
              </span>
            </span>
            {isCurrent && <Check size={14} aria-hidden="true"/>}
          </button>
          <button type="button" className="ha-icon" aria-label={'更多对话操作 ' + title} aria-haspopup="menu" aria-expanded={actions === item.id} disabled={disabled} onClick={() => setActions(value => value === item.id ? null : item.id)}><MoreHorizontal size={17}/></button>
          {actions === item.id && <div className="ha-history-action-menu" role="menu" aria-label={title + '的操作'} onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setActions(null); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus(); return; }
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
          }}>{!archived && <button type="button" role="menuitem" autoFocus aria-label={(item.pinned ? '取消置顶：' : '置顶：') + title} onClick={() => { onChange(item.id, 'pin'); setActions(null); }}>{item.pinned ? <PinOff size={16}/> : <Pin size={16}/>}<span>{item.pinned ? '取消置顶' : '置顶对话'}</span></button>}<button type="button" role="menuitem" aria-label={(archived ? '恢复对话：' : '归档对话：') + title} onClick={() => { onChange(item.id, 'archive'); setActions(null); }}>{archived ? <ArchiveRestore size={16}/> : <Archive size={16}/>}<span>{archived ? '恢复到对话历史' : '归档对话'}</span></button><button type="button" role="menuitem" className="ha-delete" aria-label={'删除对话：' + title} onClick={() => { onChange(item.id, 'delete'); setActions(null); }}><Trash2 size={16}/><span>删除对话</span></button></div>}
        </div>;
      })}</section>;
    })}
    {rows.length > limit && <button type="button" className="ha-menu-choice" onClick={() => setLimit(value => value + 20)}>加载更多对话<ChevronRight size={15}/></button>}
    {!archived && <button type="button" className="ha-menu-choice ha-history-footer" aria-label="查看已归档对话" onClick={() => showArchived(true)}><Archive size={16}/><span>已归档的对话</span><ChevronRight size={14}/></button>}
  </section>;
}
