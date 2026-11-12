"use client";
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, FileText, Search, X } from 'lucide-react';
import type { AssistantContext } from './Assistant';
import type { PageInsertion } from './assistant-insert';
export function AssistantInsert({ body, source, catalog, currentPageId, allowed, onInsert, onClose }: {
  body: string; source: AssistantContext | null; catalog: AssistantContext[]; currentPageId?: string; allowed: (context: AssistantContext | null | undefined) => boolean;
  onInsert: (value: PageInsertion) => void | Promise<void>; onClose: () => void;
}) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<AssistantContext | null>(null), [text, setText] = useState(body), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), panel = useRef<HTMLDivElement>(null), operationId = useRef('assistant-' + Date.now().toString(36) + Math.random().toString(36).slice(2));
  const targets = catalog.filter(item => item.writable && allowed(item));
  const current = targets.find(item => item.id === currentPageId);
  const invalid = !allowed(source) || !!selected && (!targets.some(item => item.id === selected.id) || !allowed(selected));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    panel.current?.querySelector<HTMLElement>('input,button')?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!pending.current) onClose(); }
      if (event.key !== 'Tab') return;
      const nodes = [...panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input,textarea') || []]; const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keys, true);
    return () => { document.removeEventListener('keydown', keys, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  async function save() {
    if (!selected || invalid || pending.current || !text.trim()) return;
    pending.current = true; setSaving(true); setError('');
    try { await onInsert({ targetId: selected.id, expectedBody: selected.excerpt, body: text, sourceIds: source ? [source.id, ...(source.evidence || []).map(item => item.id)] : [], operationId: operationId.current }); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '插入未完成，请重试'); }
    finally { pending.current = false; setSaving(false); }
  }
  return <div className="ha-draft-backdrop"><div ref={panel} className="ha-draft-dialog" role="dialog" aria-modal="true" aria-labelledby="ha-insert-title">
    <header className="ha-draft-header"><div><span className="ha-draft-eyebrow">保存前确认</span><h2 id="ha-insert-title">插入页面</h2></div><button type="button" className="ha-icon" aria-label="关闭插入页面" disabled={saving} onClick={onClose}><X size={18}/></button></header>
    {invalid ? <div className="ha-draft-body"><p role="alert">来源或目标页面已不可用，暂时不能插入。</p></div> : !selected ? <div className="ha-draft-body"><button type="button" className="ha-insert-target" disabled={!current} onClick={() => { if (current) setSelected(current); }}><FileText size={18}/><span>插入当前页面<small>{current?.title || '当前页面不可写入，请搜索其他页面'}</small></span></button><label className="ha-resource-search"><Search size={16}/><input type="search" aria-label="搜索插入目标页面" placeholder="搜索页面标题或资料库" value={query} maxLength={200} onChange={event => setQuery(event.target.value)}/></label><div className="ha-insert-results">{targets.filter(item => (item.title + ' ' + item.libraryName).toLowerCase().includes(query.toLowerCase())).map(item => <button type="button" className="ha-insert-target" key={item.id} onClick={() => setSelected(item)}><FileText size={17}/><span>{item.title}<small>{item.libraryName || 'Hub'}</small></span></button>)}</div>{!targets.length && <p>暂无可写入页面。可以先新建笔记。</p>}</div> : <div className="ha-draft-body"><button type="button" className="ha-menu-back" disabled={saving} onClick={() => { setSelected(null); setError(''); }}><ArrowLeft size={15}/>重新选择页面</button><p>目标页面：<strong>{selected.title}</strong> · {selected.libraryName || 'Hub'}</p><details><summary>查看页面现有内容</summary><p className="ha-insert-existing">{selected.excerpt || '空页面'}</p></details><label htmlFor="ha-insert-body">待追加内容</label><textarea id="ha-insert-body" aria-label="待插入内容" maxLength={100000} value={text} disabled={saving} onChange={event => setText(event.target.value)}/><p>确认后追加到页面末尾，保留原有内容。仅保存到当前浏览器的原型。</p>{error && <p role="alert">{error}</p>}</div>}
    <footer className="ha-draft-footer"><button type="button" className="ha-secondary-button" disabled={saving} onClick={onClose}>取消</button><button type="button" className="ha-primary-button" disabled={!selected || invalid || saving || !text.trim()} onClick={() => void save()}><Check size={14}/>{saving ? '正在插入…' : '确认插入页面'}</button></footer>
  </div></div>;
}
