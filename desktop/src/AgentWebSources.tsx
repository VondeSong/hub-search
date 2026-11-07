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
  if(!sources.length)return null;
  return <details className="agent-citation"><summary>网页来源 · {sources.length}</summary>
    <p className="agent-note">这些链接用于追溯网页信息，尚未保存 Hub 原文快照。工具返回的来源可能是搜索命中或页面片段，不代表已完整读取。无匹配记录也不代表未访问，旧记录或批量操作可能缺少来源信息。</p>
    <ul>{sources.map((source,index)=>{const href=publicWebHref(source.url);return <li key={index}>{href ? <a href={href} target="_blank" rel="noreferrer">{source.title}</a>:<span>{source.title}（链接不可用）</span>}<small> · {source.provenance==="providerResult"?"联网工具返回的来源":source.provenance==="providerAccess"?"Codex 有网页访问记录":"引用链接（无可匹配的联网记录）"}</small></li>;})}</ul>
  </details>;
}
