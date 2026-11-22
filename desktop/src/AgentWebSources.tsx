import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Globe, Search, X } from "lucide-react";
import { useModalFocus } from "./useModalFocus";

export type WebSource = {url:string;title:string;provenance:"providerAccess"|"providerResult"|"modelReference"};
export function publicWebHref(value?:string|null):string|undefined {
  if(!value || value.length>4096 || value.trim()!==value || /[\x00-\x1f\x7f]/.test(value))return;
  try {
    const url=new URL(value),host=url.hostname;
    if(url.protocol!=="https:" || url.username || url.password || (url.port && url.port!=="443") || !host.includes(".") || host.endsWith(".") || /(?:\.localhost|\.local|\.internal)$/.test(host) || /^[\d.]+$/.test(host) || host.includes(":"))return;
    return url.href;
  } catch {return;}
}
export function AgentWebSources({sources}:{sources:WebSource[]}) {
  const [open,setOpen]=useState(false);
  const [query,setQuery]=useState("");
  const trigger=useRef<HTMLButtonElement>(null);
  const panel=useRef<HTMLElement>(null);
  const close=()=>setOpen(false);
  useModalFocus({active:open,containerRef:panel,onDismiss:close});
  if(!sources.length)return null;
  const term=query.trim().toLocaleLowerCase();
  const matches=sources.filter(source=>source.title.toLocaleLowerCase().includes(term)||source.url.toLocaleLowerCase().includes(term));
  return <>
    <button ref={trigger} type="button" className="agent-web-sources-trigger" aria-haspopup="dialog" onClick={()=>{setQuery("");setOpen(true);}}><Globe size={13} aria-hidden="true"/>{sources.length} 个来源</button>
    {open&&createPortal(<div className="agent-reference-overlay" onClick={event=>{if(event.target===event.currentTarget)close();}}>
      <section ref={panel} role="dialog" aria-modal="true" aria-label={`网页追溯来源 (${sources.length})`} tabIndex={-1} className="agent-reference-modal">
        <header><strong><Globe size={15} aria-hidden="true"/>网页追溯来源 ({sources.length})</strong><button type="button" aria-label="关闭网页追溯来源" onClick={close}><X size={16}/></button></header>
        <label className="agent-web-source-search"><Search size={14} aria-hidden="true"/><input type="search" aria-label="筛选引用来源" placeholder="筛选引用来源…" value={query} onChange={event=>setQuery(event.target.value)} data-modal-initial-focus/></label>
        <div className="agent-reference-modal-body">
          <ul className="agent-web-source-list">{matches.map((source,index)=>{
            const href=publicWebHref(source.url);
            const host=href ? new URL(href).hostname.replace(/^www\./,"") : "";
            const label=source.provenance==="providerResult"?"联网工具返回的来源":source.provenance==="providerAccess"?"Codex 有网页访问记录":"引用链接（无可匹配的联网记录）";
            const content=<><i aria-hidden="true">{host.slice(0,2).toUpperCase()||"?"}</i><span><strong>{source.title}</strong><code>{href?.replace(/^https:\/\//,"")??"链接不可用"}</code><small>{label}</small></span>{href&&<ExternalLink size={14} aria-hidden="true"/>}</>;
            return <li key={index}>{href?<a href={href} target="_blank" rel="noreferrer" title={href}>{content}</a>:<div>{content}</div>}</li>;
          })}</ul>
          {!matches.length&&<p className="agent-note" role="status">未找到匹配来源。</p>}
          <p className="agent-note">网页链接尚未保存 Hub 原文快照。工具返回的来源可能是搜索命中或页面片段。</p>
        </div>
      </section>
    </div>,trigger.current?.closest(".agent-panel")??document.body)}
  </>;
}
