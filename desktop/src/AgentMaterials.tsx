import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAgentPopover } from "./useAgentPopover";

export type NoteLocator = { kind: "note"; libraryId: string; documentId: string; pageId: string | null };
export type AgentMaterial = { locator: NoteLocator; title: string; path: string; libraryName: string; totalChars?:number };
type Page = { notes: AgentMaterial[]; total: number; nextOffset: number | null; snapshot: string };
export const materialKey = (note: NoteLocator) => JSON.stringify([note.libraryId, note.documentId, note.pageId]);

export function AgentMaterials({ anchor, anchorIncluded=true, selected, disabled, onChange, retained, libraryIds = [], removed = [], onRemove, onWithdraw, embedded=false, onDone }: { onDone?:()=>void; embedded?: boolean; anchor?: NoteLocator; anchorIncluded?:boolean; selected: AgentMaterial[]; disabled: boolean; onChange: (notes: AgentMaterial[]) => void; retained?: NoteLocator[]; libraryIds?: string[]; removed?: NoteLocator[]; onRemove?: (notes: NoteLocator[]) => void; onWithdraw?: () => void }) {
  const popover = useAgentPopover();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [composing, setComposing] = useState(false);
  const searchTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const alive = useRef(true), request = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  async function load(offset = 0) {
    if(searchTimer.current!==null){clearTimeout(searchTimer.current);searchTimer.current=null;}
    const ticket = ++request.current;
    setLoading(true); setError("");
    try {
      const value = await invoke<Page>("agent_investigation", { args: { action: "materials", query: { query: query.trim(), offset, limit: 20, ...(offset && page ? { expectedSnapshot: page.snapshot } : {}) } } });
      if (!value || !Array.isArray(value.notes) || typeof value.snapshot!=="string" || !Number.isSafeInteger(value.total)) throw new Error("笔记清单返回格式无效");
      if (alive.current && ticket === request.current) setPage(value);
    } catch (reason) { if (alive.current && ticket === request.current) { setError(String(reason)); setPage(null); } }
    finally { if (alive.current && ticket === request.current) setLoading(false); }
  }
  useEffect(()=>{if(embedded)void load();},[embedded]);
  useEffect(()=>{
    if(!query.trim() || composing || disabled)return;
    searchTimer.current=setTimeout(()=>void load(),300);
    return ()=>{if(searchTimer.current!==null)clearTimeout(searchTimer.current);};
  },[query,composing,disabled]);
  const content=<div className="agent-skill-menu agent-material-picker" aria-label="选择分析材料">
      {!embedded && <div className="agent-popover-header"><strong>一起分析的资料</strong><button type="button" onClick={()=>popover.close(true)} aria-label="关闭材料选择">关闭</button></div>}
      <p className="agent-note">选择要一起分析的笔记，随下一条消息发送。仅添加所选笔记，不授权整个资料库。</p>
      <div className="agent-material-search"><input aria-label="按标题或路径查找" placeholder="搜索笔记标题或路径" type="search" value={query} maxLength={200} disabled={disabled} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)} onChange={event => { request.current++; setQuery(event.target.value); setPage(null); setLoading(false);setError(""); }} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void load(); } }} /><button type="button" disabled={disabled || loading} onClick={() => void load()}>搜索</button></div>
      <div className="agent-material-results" aria-label="笔记列表" aria-busy={loading}>
      {!!selected.length && <details className="agent-material-selection"><summary>待添加 · {selected.length}</summary>
      {selected.map(note => <div className="agent-material-selected" key={materialKey(note.locator)}><span>{note.title} · {note.libraryName}</span><button type="button" disabled={disabled} aria-label={`移除材料 ${note.title}`} onClick={() => onChange(selected.filter(n => materialKey(n.locator) !== materialKey(note.locator)))}>移除</button></div>)}
      </details>}
      {!!removed.length && <p className="agent-note">待撤回 {removed.length} 份笔记。确认后停止读取，相关成果可能不可用；原文件和历史记录不删除。请先确认撤回，再发送追问。{selected.length>0?"请先移除待添加项，再确认撤回。":""}</p>}
      {onWithdraw && !!removed.length && <button type="button" disabled={disabled || !!selected.length} onClick={onWithdraw}>确认撤回所选授权（不启动分析）</button>}
      {error && <p role="alert">{error}。请重新查找。</p>}
      {loading && <p role="status">正在读取材料清单…</p>}
      {!page && !loading && !error && !query.trim() && <p className="agent-note">输入关键词，或点击搜索浏览笔记。</p>}
      {page && <p className="agent-note">{query.trim()?`找到 ${page.total} 份笔记`:`浏览笔记 · 共 ${page.total} 份`} · 本页 {page.notes.length} 份</p>}
      {page?.total===0 && <p className="agent-note">没有找到笔记，试试更短的标题或路径关键词。</p>}
      {page?.notes.map(note => {
        const primary = (anchor && anchorIncluded && materialKey(note.locator) === materialKey(anchor)) || libraryIds.includes(note.locator.libraryId) || retained?.some(n => n.libraryId===note.locator.libraryId && n.documentId===note.locator.documentId && (n.pageId===null || n.pageId===note.locator.pageId));
        const pendingRemoval = removed.some(n => materialKey(n)===materialKey(note.locator));
        const coversAnchor = anchor && anchorIncluded && note.locator.libraryId===anchor.libraryId && note.locator.documentId===anchor.documentId && (note.locator.pageId===null || note.locator.pageId===anchor.pageId);
        const canRemove = onRemove && !libraryIds.includes(note.locator.libraryId) && !coversAnchor && retained?.some(n=>materialKey(n)===materialKey(note.locator));
        const checked = (primary && !pendingRemoval) || selected.some(n => materialKey(n.locator) === materialKey(note.locator));
        return <div key={materialKey(note.locator)}><label className="agent-material-choice"><input type="checkbox" checked={checked} disabled={disabled || primary || (!checked && selected.length >= Math.min(31, 32 - ((retained?.length || 1)-removed.length)))} onChange={event => onChange(event.target.checked ? [...selected, note] : selected.filter(n => materialKey(n.locator) !== materialKey(note.locator)))} /><span><strong>{note.title}{pendingRemoval ? "（待撤回授权）" : primary ? "（已加入）" : selected.some(n=>materialKey(n.locator)===materialKey(note.locator)) ? "（待添加）" : ""}</strong><small>{note.libraryName} · {note.path}</small></span></label>{canRemove && <button type="button" disabled={disabled} aria-label={`${pendingRemoval ? "保留授权" : "撤回授权"} ${note.title}`} onClick={()=>onRemove(pendingRemoval ? removed.filter(n=>materialKey(n)!==materialKey(note.locator)) : [...removed,note.locator])}>{pendingRemoval ? "保留授权" : "撤回授权"}</button>}</div>;
      })}
      {page?.nextOffset != null && <button type="button" disabled={disabled || loading} onClick={() => void load(page.nextOffset!)}>下一页</button>}
      </div>
      <footer className="agent-material-footer"><span aria-live="polite">已选 {selected.length} 份<small>随下一条消息发送</small></span><button type="button" disabled={disabled || !!removed.length} onClick={()=>onDone ? onDone() : popover.close(true)}>完成选择</button></footer>
    </div>;
  return embedded ? <div className="agent-menu-embedded">{content}</div> : <details ref={popover.ref} className="agent-materials agent-popover" name="hub-agent-preference" onToggle={event=>{if(event.target===event.currentTarget && event.currentTarget.open && !page && !loading)void load();}}><summary>{retained?"材料范围":"材料"}{selected.length ? `（${retained?"待追加 "+selected.length:selected.length+1}）` : ""}{removed.length ? `（待撤回 ${removed.length}）` : ""}</summary>{content}</details>;
}
