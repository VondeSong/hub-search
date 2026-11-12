"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Bookmark, ChevronRight, FileText, Hash, PanelLeft, Plus, Search, SlidersHorizontal, Sparkles, Star, Tags, X } from "lucide-react";
import { sourceMeta, type HubItem, type ItemKind, type SourceId } from "./data";
import { TagReviewCard } from "./TagAssistant";
import { ALIAS, IMPORT, TOPIC, tagExamples, tagIntents, type TagReviewModel, type TagTask } from "./tag-assistant";
import "./TagWorkspace.css";

const kinds: Record<ItemKind,string> = { note:"笔记", task:"任务", reading:"阅读", journal:"日志" };


type Rule = { tag:string; extra:string; exclude:string; match:"all"|"any"; expand:boolean; children?:boolean; kind:ItemKind|"" };
type Collection = { id:string; name:string; rule:Rule; sources:SourceId[]; query:string };
type TagGroup = { id:string; name:string; tags:string[] };
type Queue = "all"|"pending"|"history";
const initialRule:Rule = { tag:TOPIC, extra:"", exclude:"", match:"all", expand:true, children:true, kind:"" };
const queues = [["all","全部标签"],["pending","待处理"]] as const;
const storeKey = "hub-tag-workspace-v1";

// Keep slashes from flat sources as literal label text.
const nestedPath=(tag:string)=>tag.includes("/")&&tag.split("/").every(part=>part.trim().length>0);
function reason(item:HubItem, tag:string, expand:boolean, review:TagReviewModel, children=false) {
  if (!tag) return "";
  if (item.tags.includes(tag)) return "来源标签";
  if (review.supplement(item,tag)) return "Hub 补标";
  if (expand && review.aliasEnabled && tag===TOPIC && item.tags.includes(ALIAS)) return "已确认别名";
  if (children && item.source==="obsidian" && item.tags.some(t=>nestedPath(t)&&t.startsWith(tag+"/"))) return "来源子标签";
  return "";
}

export default function TagWorkspace({ review, reviewTarget, onOpenAssistant, initialTag, navigationOpen, navigationResizer, onToggleNavigation, renderIcon, sources, onSources, query, onQuery, notify, searchRef }: {
  review:TagReviewModel; reviewTarget:{id:string; time:number}|null; onOpenAssistant:(tag?:string,task?:TagTask)=>void; initialTag:string; navigationOpen:boolean; navigationResizer:ReactNode; onToggleNavigation:()=>void;
  renderIcon:(source:SourceId)=>ReactNode; sources:SourceId[]; onSources:(s:SourceId[])=>void;
  query:string; onQuery:(q:string)=>void; notify:(text:string)=>void; searchRef:Ref<HTMLInputElement>;
}) {
  const records = review.records;
  const tags = useMemo(()=>[...new Set(records.flatMap(i=>i.tags))].sort((a,b)=>a.localeCompare(b,"zh-CN")),[records]);
  const hierarchy = useMemo(()=>{
    const tree=new Map<string,string[]>();
    const native=new Set(records.filter(i=>i.source==="obsidian").flatMap(i=>i.tags.filter(nestedPath)));
    for (const tag of native) {
      const parts=tag.split("/");
      for (let i=0;i<parts.length;i++) {
        const parent=parts.slice(0,i).join("/"), path=parts.slice(0,i+1).join("/");
        const list=tree.get(parent)||[];
        if (!list.includes(path)) tree.set(parent,[...list,path]);
      }
    }
    const root=tree.get("")||[];
    const paths=new Set([...tree.values()].flat());
    tree.set("",[...new Set([...root,...tags.filter(t=>!paths.has(t))])].sort((a,b)=>a.localeCompare(b,"zh-CN")));
    return tree;
  },[records,tags]);
  const browseTags = [...new Set([...tags,...[...hierarchy.keys()].filter(Boolean)])];
  const [mode,setMode] = useState<"browse"|"manage">("browse");
  const [rule,setRule] = useState<Rule>(()=>({...initialRule,tag:initialTag==="all"?TOPIC:initialTag}));
  const [selected,setSelected] = useState("");
  const [tagSearch,setTagSearch] = useState("");
  const [locateQuery,setLocateQuery] = useState("");
  const [dialog,setDialog] = useState<"locate"|"group"|null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [queue,setQueue] = useState<Queue>("all");
  const [detail,setDetail] = useState(rule.tag || TOPIC);
  const [reviewFocus,setReviewFocus]=useState("");
  const reviewRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!reviewTarget)return;
    setMode("manage");setQueue("pending");setTagSearch("");setReviewFocus(reviewTarget.id);
  },[reviewTarget]);
  useEffect(()=>{if(reviewFocus)reviewRef.current?.scrollIntoView({block:"nearest"});},[reviewFocus,queue,mode,reviewTarget]);
  const [changes,setChanges] = useState<string[]>([]);
  const [checkedImport,setCheckedImport] = useState(false);
  const [groups,setGroups] = useState<TagGroup[]>([]);
  const [groupDraft,setGroupDraft] = useState<TagGroup>({id:"",name:"",tags:[]});
  const [pinned,setPinned] = useState<string[]>([TOPIC]);
  const [collections,setCollections] = useState<Collection[]>([]);
  const [collection,setCollection] = useState("");
  const [draft,setDraft] = useState<string|null>(null);
  const [ready,setReady] = useState(false);
  useEffect(()=>{
    try {
      const saved=JSON.parse(localStorage.getItem(storeKey)||"null");
      if (saved?.version===1) {
        if (Array.isArray(saved.pinned)) setPinned(saved.pinned.filter((t:unknown)=>typeof t==="string"));
        if (Array.isArray(saved.collections)) setCollections(saved.collections.filter((c:Collection)=>c && typeof c.id==="string" && typeof c.name==="string" && typeof c.query==="string" && Array.isArray(c.sources) && c.rule && ["tag","extra","exclude","kind"].every(k=>typeof c.rule[k as keyof Rule]==="string")));
        if (Array.isArray(saved.changes)) setChanges(saved.changes.filter((s:unknown)=>typeof s==="string"));
        if (Array.isArray(saved.groups)) setGroups(saved.groups.filter((g:TagGroup)=>g&&typeof g.id==="string"&&typeof g.name==="string"&&Array.isArray(g.tags)&&g.tags.every(t=>typeof t==="string")));
        setCheckedImport(saved.checkedImport===true);
      }
    } catch {}
    setReady(true);
  },[]);
  useEffect(()=>{ if(ready)try{localStorage.setItem(storeKey,JSON.stringify({...JSON.parse(localStorage.getItem(storeKey)||"{}"),version:1,pinned,collections,changes,checkedImport,groups}));}catch{} },[ready,pinned,collections,changes,checkedImport,groups]);
  useEffect(()=>{if(dialog&&!dialogRef.current?.open)dialogRef.current?.showModal();},[dialog]);
  const scope = records.filter(i=>!sources.length || sources.includes(i.source));
  const libraryOptions = [...new Set(records.map(i=>i.source))];
  const matchesTag=(tag:string,q:string)=>(tag+" "+review.description(tag)).toLowerCase().includes(q.trim().toLowerCase());
  const matchedTags = tags.filter(t=>matchesTag(t,tagSearch));
  const count = (tag:string, list=scope, expand=false, children=false)=>list.filter(i=>reason(i,tag,expand,review,children)).length;
  const wanted = [rule.tag,rule.extra].filter(Boolean);
  const needle = query.trim().toLowerCase();
  const list = scope.filter(i=>
    (!rule.kind || i.kind===rule.kind) &&
    (!needle || [i.title,i.excerpt,i.space,...i.tags].some(s=>s.toLowerCase().includes(needle))) &&
    (!rule.exclude || !reason(i,rule.exclude,rule.expand,review,rule.children)) &&
    (!wanted.length || (rule.match==="all" ? wanted.every(t=>reason(i,t,rule.expand,review,rule.children)) : wanted.some(t=>reason(i,t,rule.expand,review,rule.children))))
  );
  const current = list.find(i=>i.id===selected) || list[0];
  const activeCollection = collections.find(c=>c.id===collection && c.query===query && c.sources.join()===sources.join());
  const changeRule=(part:Partial<Rule>)=>{setRule(r=>({...r,...part}));setCollection("");setSelected("");};
  const closeDrawer=()=>{if(navigationOpen&&matchMedia("(max-width: 1099px)").matches)onToggleNavigation();};
  const selectTag=(tag:string)=>{changeRule({tag,extra:rule.extra===tag?"":rule.extra});closeDrawer();};
  const setSection=(next:Queue)=>{setQueue(next);setReviewFocus("");closeDrawer();};
  const recordChange=(message:string)=>{setChanges(old=>[message,...old].slice(0,50));notify(message);};
  const navTag = (tag:string,label=tag)=> <button key={tag} className="tagws-nav" aria-label={label===tag?undefined:"查看 #"+tag} aria-current={!activeCollection&&rule.tag===tag?"true":undefined} onClick={()=>selectTag(tag)}><Hash size={14}/><span>{label}</span><small>{count(tag,scope,rule.expand,rule.children)}</small></button>;
  const renderDirectory=(parent=""):ReactNode=>(hierarchy.get(parent)||[]).map(tag=>{
    const name=parent?tag.slice(parent.length+1):tag;
    return hierarchy.has(tag)?<details key={tag} open={rule.tag===tag||rule.tag.startsWith(tag+"/")||undefined}><summary>{name}<small>{count(tag,scope,rule.expand,true)}</small></summary><div className="tagws-tree">{navTag(tag,"查看 #"+tag)}{renderDirectory(tag)}</div></details>:navTag(tag,name);
  });
  const pendingCount=Number(!checkedImport)+review.suggestions.filter(s=>s.status==="pending").length;
  const reviewRows=matchedTags;
  const activeDetail=reviewRows.includes(detail)?detail:reviewRows[0];
  const activeRule=activeDetail?review.ruleFor(activeDetail):null;
  const historyCount=changes.length+review.suggestions.filter(s=>s.status!=="pending").length;
  const suggestions=review.suggestions.filter(s=>(queue==="history"?s.status!=="pending":s.status==="pending"||s.id===reviewFocus)
    && (!tagSearch || matchesTag(s.tag,tagSearch) || s.kind==="relation"&&matchesTag(s.other,tagSearch)));
  const openGroup=(group?:TagGroup)=>{setGroupDraft(group?{...group}:{id:"",name:"",tags:tags.includes(rule.tag)?[rule.tag]:[]});setLocateQuery("");setDialog("group");};
  const closeDialog=()=>dialogRef.current?.close();
  const searchingContent=mode==="browse";
  const searchLabel=searchingContent?(rule.tag?"在 #"+rule.tag+" 中找内容":"搜索标签下的内容"):"查找标签";
  return <section className="tagws" aria-label="标签工作区">
    <header className="tagws-searchbar">
      <label className="tagws-search"><Search size={17}/><input ref={searchRef} aria-label={searchLabel} placeholder={searchLabel+"…"} value={searchingContent?query:tagSearch}
        onChange={e=>searchingContent?onQuery(e.target.value):setTagSearch(e.target.value)}
        onKeyDown={e=>{if(e.key==="Escape"&&!searchingContent){e.stopPropagation();setTagSearch("");}}}/></label>
      <span className="tagws-note">{searchingContent?"筛选内容":"筛选标签名称与说明"}</span>
    </header>
    <header className="tagws-toolbar">
      <button className="tagws-icon" aria-label={navigationOpen?"隐藏标签导航":"打开标签导航"} aria-expanded={navigationOpen} aria-controls={navigationOpen?"hub-module-navigation":undefined} onClick={onToggleNavigation}><PanelLeft size={17}/></button>
      <div className="tagws-modes" role="group" aria-label="标签工作模式">
        <button aria-pressed={mode==="browse"} onClick={()=>setMode("browse")}><Tags size={15}/>浏览</button>
        <button aria-pressed={mode==="manage"} onClick={()=>{if(mode!=="manage"){setMode("manage");setQueue("all");setDetail(rule.tag||TOPIC);setReviewFocus("");}}}><SlidersHorizontal size={15}/>管理标签</button>
      </div>
      {!navigationOpen&&mode==="manage"&&<button className="tagws-control" onClick={()=>setSection(queue==="all"?"pending":"all")}>{queue==="all"?`待处理 · ${pendingCount}`:"全部标签"}</button>}
      <button className="tagws-control tagws-assistant-trigger" type="button" onClick={()=>onOpenAssistant((mode==='manage'?activeDetail:rule.tag)||undefined)}><Sparkles size={15}/>标签助手</button>
      <span className="tagws-note">示例数据 · 改动保存在此浏览器</span>
    </header>
    <div className="tagws-body">
      {navigationOpen&&<><aside className="tagws-navpane" id="hub-module-navigation" aria-label="标签导航">
        {mode==="manage"?queues.map(([id,label])=><button key={id} className="tagws-nav" aria-current={queue===id?"true":undefined} onClick={()=>setSection(id)}><span>{label}</span><small>{id==="all"?tags.length:pendingCount}</small></button>):
          <><button className="tagws-nav" aria-current={!rule.tag&&!activeCollection?"true":undefined} onClick={()=>selectTag("")}><Tags size={15}/><span>全部标签</span><small>{tags.length}</small></button>
            <button className="tagws-nav" onClick={()=>{setLocateQuery("");setDialog("locate");}}><Search size={14}/><span>定位标签</span></button>
            <p className="tagws-label">收藏</p>{pinned.some(t=>browseTags.includes(t))?pinned.filter(t=>browseTags.includes(t)).map(t=>navTag(t)):<p className="tagws-note">暂无收藏</p>}
            <div className="tagws-group-label"><span>我的分组</span><button className="tagws-icon" aria-label="新建标签分组" title="新建标签分组" onClick={()=>openGroup()}><Plus size={15}/></button></div>
            {groups.length?groups.map(group=><details key={group.id}><summary>{group.name}<small>{group.tags.length}</small></summary><div className="tagws-tree">{group.tags.map(t=>navTag(t))}<button className="tagws-nav tagws-note" onClick={()=>openGroup(group)}>编辑分组</button></div></details>):<p className="tagws-note">手动收纳标签</p>}
            <details className="tagws-directory"><summary>标签目录<small>{tags.length}</small></summary><p className="tagws-note tagws-tree-note">按来源标签展示，Obsidian 的斜杠表示层级。</p>{renderDirectory()}</details>
            <p className="tagws-label">智能集合</p>{collections.length?collections.map(c=><button className="tagws-nav" key={c.id} aria-current={activeCollection?.id===c.id?"true":undefined} onClick={()=>{setRule(c.rule);onSources(c.sources);onQuery(c.query);setSelected("");setCollection(c.id);closeDrawer();}}><Bookmark size={14}/><span>{c.name}</span></button>):<p className="tagws-note">保存的筛选会出现在这里</p>}
          </>}
      </aside>{navigationResizer}</>}
      <div className="tagws-content">
        <section className="tagws-list" aria-label={mode==="browse"?"标签内容":"整理清单"}>
          {mode==="browse"?<>
            <div className="tagws-heading"><div><h1>{activeCollection?.name || (rule.tag?"# "+rule.tag:"全部标签")}</h1><p>{review.description(rule.tag) || "按标签浏览跨库内容。"}</p></div>
              {rule.tag&&<button className="tagws-control" aria-pressed={pinned.includes(rule.tag)} onClick={()=>setPinned(old=>old.includes(rule.tag)?old.filter(t=>t!==rule.tag):[...old,rule.tag])}><Star size={14}/>{pinned.includes(rule.tag)?"已收藏":"收藏标签"}</button>}
            </div>
            <div className="tagws-controls">
              <select aria-label="标签资料库范围" value={sources.length>1?"multiple":sources[0]||""} onChange={e=>{onSources(e.target.value?[e.target.value as SourceId]:[]);setCollection("");}}><option value="">全部资料库</option>{sources.length>1&&<option value="multiple" disabled>已选 {sources.length} 个来源</option>}{libraryOptions.map(s=><option key={s} value={s}>{sourceMeta[s].name}</option>)}</select>
              <select aria-label="标签内容类型" value={rule.kind} onChange={e=>changeRule({kind:e.target.value as Rule["kind"]})}><option value="">全部类型</option>{Object.entries(kinds).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
              <button className="tagws-control" disabled={!list.length} onClick={()=>setDraft([rule.tag,rule.extra].filter(Boolean).join(" · ")||"跨库资料")}><Bookmark size={14}/>保存为集合</button>
            </div>
            {draft!==null&&<form className="tagws-controls tagws-save" onSubmit={e=>{e.preventDefault();const name=draft.trim();if(!name)return;const id=crypto.randomUUID();setCollections(old=>[...old,{id,name,rule:{...rule},sources:[...sources],query}]);setCollection(id);setDraft(null);notify("已保存智能集合："+name);}}>
              <input autoFocus aria-label="集合名称" value={draft} maxLength={48} required onChange={e=>setDraft(e.target.value)}/><button className="primary-button" type="submit">保存</button><button type="button" className="tagws-control" onClick={()=>setDraft(null)}>取消</button>
            </form>}
            <div className="tagws-pills" aria-label="当前筛选">{wanted.length>0&&<span>{wanted.map(t=>"#"+t).join(rule.match==="all"?" 且 ":" 或 ")}</span>}{rule.exclude&&<span>排除 #{rule.exclude}</span>}{rule.tag===TOPIC&&review.aliasEnabled&&<span>{rule.expand?"含已确认别名":"不展开别名"}</span>}</div>
            <details className="tagws-combine"><summary>组合筛选</summary><div className="tagws-controls">
              <select aria-label="匹配方式" value={rule.match} onChange={e=>changeRule({match:e.target.value as Rule["match"]})}><option value="all">同时满足</option><option value="any">满足任一</option></select>
              <select aria-label="添加标签" value={rule.extra} onChange={e=>changeRule({extra:e.target.value})}><option value="">添加标签…</option>{browseTags.filter(t=>t!==rule.tag).map(t=><option key={t}>{t}</option>)}</select>
              <select aria-label="排除标签" value={rule.exclude} onChange={e=>changeRule({exclude:e.target.value})}><option value="">排除标签…</option>{browseTags.map(t=><option key={t}>{t}</option>)}</select>
              <label><input type="checkbox" checked={rule.expand} onChange={e=>changeRule({expand:e.target.checked})}/>包含已确认别名</label>
            </div></details>
            {[...wanted,rule.exclude].some(t=>t&&hierarchy.has(t))&&<label className="tagws-children"><input type="checkbox" checked={!!rule.children} onChange={e=>changeRule({children:e.target.checked})}/>包含子标签</label>}
            <div className="tagws-results-meta" aria-live="polite"><span>{list.length} 条内容</span><div className="tagws-pills">{libraryOptions.map(s=>{const n=list.filter(i=>i.source===s).length;return n?<span key={s}>{sourceMeta[s].name} {n}</span>:null;})}</div></div>
            {list.length?list.map(item=><button key={item.id} className="tagws-result" aria-current={item.id===current?.id?"true":undefined} onClick={()=>setSelected(item.id)}>
              {renderIcon(item.source)}<span><strong>{item.title}</strong><small>{[sourceMeta[item.source].name,item.space,...new Set(wanted.map(t=>reason(item,t,rule.expand,review,rule.children)).filter(Boolean))].join(" · ")}</small></span><ChevronRight size={14}/></button>):<p className="tagws-empty">没有符合条件的内容。可以调整标签或资料库范围。</p>}
          </>:<>
            <div className="tagws-heading"><div><h1>{queue==="history"?"变更记录":queues.find(([id])=>id===queue)?.[1]}</h1><p>{queue==="pending"?"核对导入标记，或查看建议的依据和影响。":queue==="history"?"本浏览器中的标签管理操作。":"选择标签查看来源、用法和待处理问题。"}</p></div>
              <button className="tagws-control" onClick={()=>setSection(queue==="history"?"all":"history")}>{queue==="history"?"返回全部标签":`变更记录 · ${historyCount}`}</button>
            </div>
            {queue!=="all"&&<div className="tag-ai-queue">
              {queue==="pending"&&!checkedImport&&matchesTag(IMPORT,tagSearch)&&<article className="tag-ai-card">
                <header><strong>导入标记 · {IMPORT}</strong><small>需核对</small></header>
                <p>{tagExamples.find(i=>i.tags.includes(IMPORT))?.excerpt}</p>
                <footer><button className="tag-ai-button" onClick={()=>{setCheckedImport(true);recordChange("已核对导入样例："+IMPORT);}}>标记已核对</button></footer>
              </article>}
              {suggestions.map(item=><div key={item.id} ref={item.id===reviewFocus?reviewRef:undefined} className={item.id===reviewFocus?"tag-ai-current":undefined}><TagReviewCard item={item} model={review}/></div>)}
              {queue==="pending"&&!suggestions.length&&(checkedImport||!matchesTag(IMPORT,tagSearch))&&<p className="tagws-empty">当前没有待处理建议。</p>}
            </div>}
            {queue==="history"?changes.length?<ol className="tagws-history">{changes.map((s,i)=><li key={i}>{s}</li>)}</ol>:!historyCount&&<p className="tagws-empty">暂无变更。</p>:queue==="all"&& (
              reviewRows.length?<table className="tagws-table"><thead><tr><th>标签</th><th>内容</th><th className="tagws-source-col">来源</th><th>状态</th></tr></thead><tbody>
                {reviewRows.map(t=><tr key={t} data-selected={t===activeDetail}><td><button onClick={()=>{setDetail(t);setReviewFocus("");}} aria-current={t===activeDetail?"true":undefined}># {t}</button></td><td>{count(t)}</td><td className="tagws-source-col">{[...new Set(scope.filter(i=>reason(i,t,false,review)).map(i=>sourceMeta[i.source].name))].join("、")||"—"}</td><td>{t===IMPORT?(checkedImport?"已核对":"需核对"):t===ALIAS&&review.aliasEnabled?"已设别名":review.suggestions.some(s=>(s.tag===t||s.kind==="relation"&&s.other===t)&&s.status==="pending")?"有建议":"在用"}</td></tr>)}
              </tbody></table>:<p className="tagws-empty">当前没有符合条件的标签。</p>)}
          </>}
        </section>
        <aside className="tagws-detail" aria-label={mode==="browse"?"内容预览":"标签详情"}>
          {mode==="browse"?current?<article className="tagws-paper">
            <div className="tagws-byline">{renderIcon(current.source)}<span>{sourceMeta[current.source].name} / {current.space}</span></div>
            <h2>{current.title}</h2>
            {current.sections.length?current.sections.map((part,i)=>part.type==="h2"?<h3 key={i}>{part.text}</h3>:part.items?<ul key={i}>{part.items.map((line,j)=><li key={j}>{line}</li>)}</ul>:<p key={i}>{part.text}</p>):<p>{current.excerpt}</p>}
            <div className="tagws-pills">{current.tags.map(t=><button key={t} onClick={()=>selectTag(t)}>#{t}</button>)}{tags.filter(t=>review.supplement(current,t)).map(t=><span key={t}>#{t} · Hub 补标</span>)}</div>
          </article>:<p className="tagws-empty"><FileText size={17}/> 选择一条内容查看预览。</p>:
          queue!=="all"?<article className="tagws-paper"><h2>{queue==="pending"?"审核标签建议":"操作记录"}</h2><p>{queue==="pending"?"在建议中查看依据与影响。助手和标签页共用审核状态。":"可以撤销已应用到 Hub 的变更，或重新打开驳回的建议。"}</p><p className="tagws-note">采纳只作用于示例中的 Hub，原始资料库不变。</p></article>:
          activeDetail?<article className="tagws-paper">
            <h2># {activeDetail}</h2><p>{review.description(activeDetail)||"暂无标签说明。"}</p>
            <p className="tagws-note">当前来源范围 · {scope.filter(i=>i.tags.includes(activeDetail)).length} 条直接标记内容</p>
            {activeDetail===ALIAS&&review.aliasEnabled&&<p>已映射到「{TOPIC}」 · Hub 别名</p>}
            <section className="tag-ai-definition">
              <h3>定义与适用范围</h3>
              {activeRule?<dl><dt>应该使用</dt><dd>{activeRule.rule.include}</dd><dt>不应使用</dt><dd>{activeRule.rule.exclude||"未设置"}</dd><dt>资料库</dt><dd>{activeRule.libraries.join("、")} · 已确认 v{activeRule.version}</dd></dl>:<p className="tagws-note">可直接浏览。确认定义后，助手可据此查找漏标。</p>}
              <div className="tag-ai-actions">
                <button className="tag-ai-button" disabled={!review.ready} onClick={()=>{setReviewFocus(review.manualDefinition(activeDetail));setTagSearch("");setQueue("pending");}}>编辑定义</button>
                {tagIntents.map(([intent,label])=><button className="tag-ai-button" key={intent} onClick={()=>onOpenAssistant(activeDetail,{intent,tag:activeDetail})}>{label}</button>)}
              </div>
            </section>
            {activeDetail===IMPORT&&checkedImport&&<button className="tag-ai-button" onClick={()=>{setCheckedImport(false);recordChange("重新核对导入样例："+IMPORT);}}>重新核对导入标记</button>}
          </article>:<p className="tagws-empty">当前没有标签可查看。</p>}
        </aside>
      </div>
    </div>
    {dialog&&<dialog className="tagws-dialog" ref={dialogRef} onClose={()=>setDialog(null)} aria-labelledby="tagws-dialog-title">
      <header><h2 id="tagws-dialog-title">{dialog==="locate"?"定位标签":groupDraft.id?"编辑分组":"新建标签分组"}</h2><button className="tagws-icon" aria-label="关闭" onClick={closeDialog}><X size={17}/></button></header>
      {dialog==="locate"?<>
        <label className="tagws-search"><Search size={15}/><input autoFocus aria-label="查找标签名称" placeholder="输入标签名称或路径…" value={locateQuery} onChange={e=>setLocateQuery(e.target.value)}/></label>
        <div className="tagws-options">{browseTags.filter(t=>matchesTag(t,locateQuery)).map(t=><button key={t} className="tagws-nav" onClick={()=>{selectTag(t);closeDialog();}}><Hash size={14}/><span>{t}</span><small>{count(t,scope,rule.expand,rule.children)}</small></button>)}{!browseTags.some(t=>matchesTag(t,locateQuery))&&<p className="tagws-empty">未找到标签。</p>}</div>
      </>:<form onSubmit={e=>{
        e.preventDefault();const name=groupDraft.name.trim();if(!name)return;
        const next={...groupDraft,id:groupDraft.id||crypto.randomUUID(),name};
        setGroups(old=>groupDraft.id?old.map(g=>g.id===next.id?next:g):[...old,next]);recordChange((groupDraft.id?"已更新标签分组：":"已创建标签分组：")+name);closeDialog();
      }}>
        <p className="tagws-note">分组只组织导航，原始标签名称保持不变。</p>
        <label className="tagws-group-name">分组名称<input autoFocus required maxLength={36} value={groupDraft.name} onChange={e=>setGroupDraft(g=>({...g,name:e.target.value}))}/></label>
        <label className="tagws-search"><Search size={15}/><input aria-label="筛选候选标签" placeholder="筛选候选标签…" value={locateQuery} onChange={e=>setLocateQuery(e.target.value)}/></label>
        <div className="tagws-options">{tags.filter(t=>matchesTag(t,locateQuery)).map(t=><label key={t} className="tagws-check"><input type="checkbox" checked={groupDraft.tags.includes(t)} onChange={e=>setGroupDraft(g=>({...g,tags:e.target.checked?[...g.tags,t]:g.tags.filter(tag=>tag!==t)}))}/><span>#{t}</span></label>)}</div>
        <footer><span className="tagws-note">已选 {groupDraft.tags.length} 个标签</span>{groupDraft.id&&<button type="button" className="tagws-control" onClick={()=>{setGroups(old=>old.filter(g=>g.id!==groupDraft.id));recordChange("已移除分组："+groupDraft.name);closeDialog();}}>移除分组</button>}<button className="primary-button" type="submit" disabled={!groupDraft.name.trim()}>保存分组</button></footer>
      </form>}
    </dialog>}
  </section>;
}
