"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Brain, ChevronDown, ChevronRight, X } from 'lucide-react';
import { changeMemoryState, createMemoryDemoState, memoryScopeLabel, memoryStorageKey, memoryUseLabel, readMemoryState, type MemoryAction, type MemoryContent, type MemoryEntry, type MemoryScope, type MemoryState, type MemoryUse } from './assistant-memory';
import './assistant-memory.css';

export function useAssistantMemory(notify: (message: string) => void) {
  const [state, setState] = useState<MemoryState>(createMemoryDemoState);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [undo, setUndo] = useState<MemoryState | null>(null);
  const writable = useRef(true);
  const notices = useRef(notify); notices.current = notify;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(memoryStorageKey);
      if (saved !== null) {
        const restored = readMemoryState(JSON.parse(saved));
        if (!restored) throw new Error('unknown memory snapshot');
        setState(restored);
      }
    } catch {
      writable.current = false;
      setError('已有记忆示例暂时无法读取，原记录已保留。');
    }
    setReady(true);
  }, []);
  function write(next: MemoryState): boolean {
    if (!ready || !writable.current) return false;
    try { localStorage.setItem(memoryStorageKey, JSON.stringify(next)); }
    catch { notices.current('浏览器未能保存记忆示例，当前内容未更改。'); return false; }
    setState(next); return true;
  }
  function act(action: MemoryAction, message: string) {
    const next = changeMemoryState(state, action);
    if (next === state || !write(next)) return false;
    setUndo(state); setFeedback(message); return true;
  }
  function undoLast() {
    if (!undo || !write(undo)) return;
    setUndo(null); setFeedback('已撤销上一步记忆操作');
  }
  return { state, ready, error, feedback, canEdit: ready && writable.current, act, undoLast, canUndo: !!undo };
}
export type AssistantMemoryModel = ReturnType<typeof useAssistantMemory>;

function actAndFocusFeedback(model: AssistantMemoryModel, action: MemoryAction, message: string, origin: HTMLElement | null) {
  const surface = origin?.closest('.ha-memory-manager, .ha-messages');
  const ok = model.act(action, message);
  if (ok) requestAnimationFrame(() => surface?.querySelector<HTMLButtonElement>('.ha-memory-feedback > button')?.focus({ preventScroll: true }));
  return ok;
}

export function MemoryFeedback({ model, disabled = false }: { model: AssistantMemoryModel; disabled?: boolean }) {
  if (!model.feedback) return null;
  return <div className="ha-memory-feedback" role="status"><span>{model.feedback}</span>{model.canUndo && <button type="button" disabled={disabled} onClick={event => { const button = event.currentTarget; const surface = button.closest('.ha-memory-manager, .ha-messages'); model.undoLast(); requestAnimationFrame(() => { if (button.isConnected) button.focus({ preventScroll: true }); else surface?.querySelector<HTMLElement>('.ha-memory-list summary, .ha-memory-proposal .ha-memory-actions button, .ha-memory-tabs button')?.focus({ preventScroll: true }); }); }}>撤销</button>}</div>;
}

function MemoryEditor({ item, confirmLabel, onSave, onCancel, disabled, onEditingChange }: {
  item: MemoryContent; confirmLabel: string; onSave: (draft: Pick<MemoryContent, 'title' | 'body' | 'use'>) => boolean; onCancel: () => void; disabled: boolean;
  onEditingChange?: (id: string, editing: boolean) => void;
}) {
  const [title, setTitle] = useState(item.title), [body, setBody] = useState(item.body), [use, setUse] = useState<MemoryUse>(item.use);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { bodyInput.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { onEditingChange?.(item.id, true); return () => onEditingChange?.(item.id, false); }, [item.id, onEditingChange]);
  function submit(event: FormEvent) { event.preventDefault(); if (title.trim() && body.trim()) onSave({ title: title.trim(), body: body.trim(), use }); }
  return <form className="ha-memory-editor" data-memory-editor onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <label>标题<input value={title} maxLength={90} required disabled={disabled} onChange={event => setTitle(event.target.value)}/></label>
    <label>记忆内容<textarea ref={bodyInput} value={body} maxLength={1800} rows={3} required disabled={disabled} onChange={event => setBody(event.target.value)}/></label>
    <label>使用方式<select value={use} disabled={disabled} onChange={event => setUse(event.target.value as MemoryUse)}><option value="relevant">相关时参考</option><option value="always">每次使用</option></select></label>
    <p>保存到：{memoryScopeLabel(item.scope)}</p>
    <div className="ha-memory-actions"><button type="submit" className="ha-memory-primary" disabled={disabled || !title.trim() || !body.trim()}>{confirmLabel}</button><button type="button" onClick={onCancel}>取消</button></div>
  </form>;
}

export function MemoryProposalCard({ item, model, disabled = false, onEditingChange }: { item: MemoryContent; model: AssistantMemoryModel; disabled?: boolean; onEditingChange?: (id: string, editing: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const card = useRef<HTMLElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useLayoutEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus({ preventScroll: true });
    wasEditing.current = editing;
  }, [editing]);
  const blocked = disabled || !model.canEdit;
  function cancelEdit() { setEditing(false); }
  return <section ref={card} className="ha-memory-proposal" aria-label="建议记住 · 示例">
    <div className="ha-memory-eyebrow"><Brain size={13} aria-hidden="true"/><span>历史待确认建议</span><small>示例</small></div>
    {!editing ? <>
      <p className="ha-memory-content">{item.body}</p>
      <p className="ha-memory-meta">保存到 {memoryScopeLabel(item.scope)} · {item.use === 'always' ? '每次使用' : '相关时参考'}</p>
      <p className="ha-memory-source">{item.source}</p>
      <div className="ha-memory-actions"><button type="button" className="ha-memory-primary" disabled={blocked} onClick={() => actAndFocusFeedback(model, { type: 'accept', id: item.id }, '已记住 · ' + memoryScopeLabel(item.scope) + '（示例）', card.current)}>记住</button><button ref={editButton} type="button" disabled={blocked} onClick={() => setEditing(true)}>编辑</button><button type="button" disabled={blocked} onClick={() => actAndFocusFeedback(model, { type: 'dismiss', id: item.id }, '已忽略这条记忆建议', card.current)}>忽略</button></div>
    </> : <MemoryEditor item={item} disabled={blocked} confirmLabel="确认并记住" onEditingChange={onEditingChange} onCancel={cancelEdit} onSave={draft => actAndFocusFeedback(model, { type: 'accept', id: item.id, ...draft }, '已记住 · ' + memoryScopeLabel(item.scope) + '（示例）', card.current)}/>}
  </section>;
}

function MemoryEntryCard({ entry, model, disabled, onEditingChange }: { entry: MemoryEntry; model: AssistantMemoryModel; disabled: boolean; onEditingChange: (id: string, editing: boolean) => void }) {
  const [editing, setEditing] = useState(false), [forgetting, setForgetting] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null), forgetButton = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDetailsElement>(null), cancelForgetButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useLayoutEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus({ preventScroll: true });
    wasEditing.current = editing;
  }, [editing]);
  useEffect(() => { if (forgetting) cancelForgetButton.current?.focus({ preventScroll: true }); }, [forgetting]);
  const blocked = disabled || !model.canEdit;
  function cancelEdit() { setEditing(false); }
  function cancelForget() { setForgetting(false); requestAnimationFrame(() => forgetButton.current?.focus({ preventScroll: true })); }
  return <details ref={card} className="ha-memory-entry" data-memory-state={entry.state}>
    <summary><span>{entry.title}</span>{entry.state === 'inactive' && <small>已停用</small>}<ChevronDown size={14} aria-hidden="true"/></summary>
    <div className="ha-memory-entry-body">
      {editing ? <MemoryEditor item={entry} disabled={blocked} confirmLabel="保存修改" onEditingChange={onEditingChange} onCancel={cancelEdit} onSave={draft => { if (draft.title === entry.title && draft.body === entry.body && draft.use === entry.use) { cancelEdit(); return true; } const ok = model.act({ type: 'edit', id: entry.id, ...draft }, '记忆示例已修改'); if (ok) cancelEdit(); return ok; }}/> : <>
        <p className="ha-memory-content">{entry.body}</p>
        <p className="ha-memory-meta">{memoryScopeLabel(entry.scope)} · {entry.use === 'always' ? '每次使用' : '相关时参考'}</p>
        <p className="ha-memory-source">{entry.source}</p>
        {!!entry.history?.length && <details className="ha-memory-history"><summary>修改记录 · {entry.history.length}</summary><ol>{[...entry.history].reverse().map((revision, index) => <li key={revision.at + '-' + index}><time>{new Date(revision.at).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })} · 示例修改</time><div><small>修改前 · {revision.before.use === 'always' ? '每次使用' : '相关时参考'}</small><strong>{revision.before.title}</strong><p>{revision.before.body}</p></div><div><small>修改后 · {revision.after.use === 'always' ? '每次使用' : '相关时参考'}</small><strong>{revision.after.title}</strong><p>{revision.after.body}</p></div></li>)}</ol>{entry.history.length === 20 && <p>显示最近 20 次修改。</p>}</details>}
        {!forgetting ? <div className="ha-memory-actions"><button ref={editButton} type="button" disabled={blocked} onClick={() => setEditing(true)}>编辑</button><button type="button" disabled={blocked} onClick={() => model.act({ type: 'toggle', id: entry.id }, entry.state === 'active' ? '已停用这条记忆示例' : '已重新启用这条记忆示例')}>{entry.state === 'active' ? '停用' : '重新启用'}</button><button ref={forgetButton} type="button" disabled={blocked} onClick={() => setForgetting(true)}>遗忘</button></div> : <div className="ha-memory-forget" role="group" aria-label="确认遗忘记忆" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelForget(); } }}><p>遗忘「{entry.title}」及其修改记录？这条示例将从记忆中移除。</p><div className="ha-memory-actions"><button type="button" disabled={blocked} className="ha-memory-danger" onClick={() => actAndFocusFeedback(model, { type: 'forget', id: entry.id }, '已遗忘这条记忆示例', card.current)}>确认遗忘</button><button ref={cancelForgetButton} type="button" onClick={cancelForget}>取消</button></div></div>}
      </>}
    </div>
  </details>;
}

export function AssistantMemoryManager({ model, enabled, scope, disabled, materialsOnly, onClose }: { model: AssistantMemoryModel; enabled: boolean; scope: string; disabled: boolean; materialsOnly: boolean; onClose: () => void }) {
  // Browsing this list never writes the conversation's scope or new-chat preference.
  const [browseScope, setBrowseScope] = useState<MemoryScope>(scope === 'hub' ? 'hub' : 'general');
  const [tab, setTab] = useState<'saved' | 'pending'>('saved');
  const [editingIds, setEditingIds] = useState<string[]>([]);
  const reportEditing = useCallback((id: string, editing: boolean) => setEditingIds(ids => editing ? ids.includes(id) ? ids : [...ids, id] : ids.includes(id) ? ids.filter(value => value !== id) : ids), []);
  const editing = editingIds.length > 0;
  const section = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const root = section.current;
    root?.querySelector<HTMLButtonElement>('[data-memory-close]')?.focus({ preventScroll: true });
    const handle = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape' && !(event.target instanceof Element && event.target.closest('[data-memory-editor], .ha-memory-forget'))) {
        event.preventDefault(); event.stopPropagation();
        const editor = root?.querySelector<HTMLTextAreaElement>('[data-memory-editor] textarea');
        if (editor) editor.focus({ preventScroll: true }); else close.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(root?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary') || []).filter(item => item.getClientRects().length > 0);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (!first) return;
      if (!root?.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handle, true);
    return () => document.removeEventListener('keydown', handle, true);
  }, []);
  const entries = model.state.entries.filter(item => item.scope === browseScope), proposals = model.state.proposals.filter(item => item.scope === browseScope);
  return <section ref={section} className="ha-menu ha-memory-manager" role="dialog" aria-modal="true" aria-labelledby="ha-memory-manager-title">
    <header className="ha-menu-heading"><strong id="ha-memory-manager-title">管理记忆</strong><button data-memory-close type="button" className="ha-icon" aria-label="关闭记忆管理" disabled={editing} onClick={onClose}><X size={17}/></button></header>
    <p className="ha-memory-demo-note">交互示例 · 不连接真实记忆</p>
    <div className="ha-memory-manager-controls"><label htmlFor="ha-memory-browse-scope">查看范围</label><select id="ha-memory-browse-scope" value={browseScope} disabled={editing} onChange={event => setBrowseScope(event.target.value as MemoryScope)}><option value="general">个人通用</option><option value="hub">Hub 开发</option></select></div>
    <div className="ha-memory-tabs" aria-label="记忆列表"><button type="button" aria-pressed={tab === 'saved'} disabled={editing} onClick={() => setTab('saved')}>已保存{tab === 'saved' && <small>{entries.length}</small>}</button><button type="button" aria-pressed={tab === 'pending'} disabled={editing} onClick={() => setTab('pending')}>待确认{proposals.length > 0 && <small>{proposals.length}</small>}</button></div>
    {editing && <p className="ha-memory-edit-notice" role="status">先保存或取消当前编辑，再切换范围或关闭。</p>}
    <div className="ha-memory-list">
      {!model.ready ? <p className="ha-memory-empty">正在读取记忆示例…</p> : model.error ? <p role="status">{model.error}</p> : tab === 'saved' ? entries.length ? entries.map(entry => <MemoryEntryCard key={entry.id} entry={entry} model={model} disabled={disabled} onEditingChange={reportEditing}/>) : <p className="ha-memory-empty">此范围还没有已保存的记忆。</p> : proposals.length ? proposals.map(item => <MemoryProposalCard key={item.id} item={item} model={model} disabled={disabled} onEditingChange={reportEditing}/>) : <p className="ha-memory-empty">此范围没有待确认的建议。</p>}
    </div>
    <MemoryFeedback model={model} disabled={disabled || editing}/>
    <footer className="ha-memory-manager-footer"><span>{materialsOnly ? '本轮不使用记忆（只用所选资料）' : '本对话记忆：' + memoryUseLabel(enabled, scope)}</span><small>查看其他范围不会更改本对话。</small></footer>
  </section>;
}

export function MemorySettings({ enabled, scope, blocked, materialsOnly, onChange }: { enabled: boolean; scope: string; blocked: boolean; materialsOnly: boolean; onChange: (enabled: boolean, scope: string) => void }) {
  return <section className="ha-memory-settings-section" aria-label="记忆">
    <h3>记忆</h3>
    <label className="ha-memory-switch"><span>使用已保存记忆</span><input type="checkbox" role="switch" checked={enabled} disabled={blocked || materialsOnly} onChange={event => onChange(event.target.checked, scope)}/></label>
    <label className="ha-memory-scope-setting"><span>范围</span><select aria-label="本对话的记忆范围" value={scope} disabled={blocked || materialsOnly} onChange={event => onChange(enabled, event.target.value)}><option value="general">个人通用</option><option value="hub">Hub 开发＋个人通用</option></select></label>
    <p>{materialsOnly ? '当前只用所选资料，本轮不使用记忆。' : enabled ? '新增记忆仍需确认。' : '开启后使用此范围。新增记忆仍需确认。'}</p>
  </section>;
}

export function MemoryManageLink({ onClick, pending }: { onClick: () => void; pending: number }) {
  return <button type="button" className="ha-memory-manage-link" onClick={onClick}><span>管理记忆{pending > 0 && <small>{pending} 条待确认</small>}</span><ChevronRight size={15} aria-hidden="true"/></button>;
}
