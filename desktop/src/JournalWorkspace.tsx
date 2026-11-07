import { CalendarDays, CalendarRange, ChevronDown, ChevronLeft, ChevronRight, Copy, ExternalLink, List, ListFilter, Plus, Search, Settings2, Star, Table2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { journalEntryTitle } from "./JournalPresentation";
import { pageFavoriteKey } from "./PageFavorites";
import { cleanSearchSnippet } from "./ResultExcerpt";
import { journalDateKey, journalDateLabel } from "./SearchWorkspacePresentation";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { journalLayouts, journalMonthDays, localJournalDate, useJournalViews, type JournalLayout } from "./JournalViews";
import { useJournalPage } from "./useJournalPage";
import { JournalDailyStream } from "./JournalDailyStream";
import "./JournalDatabase.css";

const layoutIcons={stream:CalendarRange,calendar:CalendarDays,list:List,table:Table2};
const formatMonth=(month:string)=>`${Number(month.slice(0,4))}年${Number(month.slice(5))}月`;
const modifiedLabel=(result:SearchResult)=>result.modifiedAt?new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(result.modifiedAt<1e12?result.modifiedAt*1000:result.modifiedAt)):"—";
function entrySummary(result:SearchResult){return cleanSearchSnippet(result.snippet).replace(/<\/?[a-z][^>]*$/i, "").replace(/^\d{4}[-.]\d{2}[-.]\d{2}\s*/,"").trim();}

export type JournalWorkspaceProps={
  libraries:LibrarySummary[];scope:string[]|null;dataVersion:string;selectedDate:string;
  selectedKey?:string;onNavigateDate?:(date:string)=>void;onPreview:(result:SearchResult)=>void;
  onOpen:(result:SearchResult)=>void;onCreate?:(date:string)=>void;
  renderIcon:(result:SearchResult,name:string)=>ReactNode;favoriteIds?:Set<string>;onFavorite?:(result:SearchResult)=>void;
};
export function JournalWorkspace(props:JournalWorkspaceProps){
  const store=useJournalViews();
  if(!store)return null;
  return <JournalDatabase {...props} store={store}/>;
}
function JournalDatabase({libraries,scope,dataVersion,selectedDate,selectedKey,onNavigateDate,onPreview,onOpen,onCreate,renderIcon,favoriteIds,onFavorite,store}:JournalWorkspaceProps&{store:NonNullable<ReturnType<typeof useJournalViews>>}){
  const {view}=store;const today=localJournalDate();
  const page=useJournalPage(view,scope,dataVersion,view.layout!=="stream");
  const root=useRef<HTMLDivElement>(null),body=useRef<HTMLDivElement>(null),menu=useRef<HTMLDetailsElement>(null),saveInput=useRef<HTMLInputElement>(null);
  const [filters,setFilters]=useState(false),[saveMode,setSaveMode]=useState<"save"|"rename"|null>(null),[name,setName]=useState("");
  const [query,setQuery]=useState(view.query),[chosenDay,setChosenDay]=useState(""),[pickedKey,setPickedKey]=useState("");
  const [expandedDays,setExpandedDays]=useState<Set<string>>(new Set());
  const previousNavigation=useRef(selectedDate),sessionPosition=useRef(new Map<string,number>());
  const sessionKey=`${view.layout}:${view.month}:${view.period}:${view.day}:${view.query}:${JSON.stringify(view.libraries)}`;
  const previousSession=useRef(sessionKey),consumedAnchor=useRef("");
  useEffect(()=>{if(previousNavigation.current!==selectedDate){previousNavigation.current=selectedDate;if(selectedDate){store.navigate(selectedDate.length===7?`${selectedDate}-01`:selectedDate);if(view.layout==="calendar")setChosenDay(selectedDate.length===10?selectedDate:"");}}},[selectedDate]);
  useEffect(()=>{setChosenDay(view.layout==="calendar"&&selectedDate===store.anchor&&store.anchor.length===10?store.anchor:"");},[view.month,store.activeId]);
  useEffect(()=>{setQuery(view.query);},[view.query]);
  useEffect(()=>{if(query===view.query)return;const timer=setTimeout(()=>store.update({query}),220);return()=>clearTimeout(timer);},[query,view.query]);
  useEffect(()=>{if(saveMode)saveInput.current?.focus();},[saveMode]);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(menu.current?.open&&!menu.current.contains(event.target as Node))menu.current.open=false;};
    document.addEventListener("pointerdown",close);return()=>document.removeEventListener("pointerdown",close);
  },[]);
  useEffect(()=>{
    if(page.loading)return;
    const pane=body.current;if(!pane)return;
    if(previousSession.current!==sessionKey){pane.scrollTop=sessionPosition.current.get(sessionKey)||0;previousSession.current=sessionKey;}
    const pendingAnchor=store.anchor!==consumedAnchor.current?store.anchor:"";
    const target=pendingAnchor;
    if(target){
      const element=pane.querySelector<HTMLElement>(`[data-journal-day="${target}"]`);
      if(element){pane.scrollTop=Math.max(0,element.offsetTop-pane.offsetTop-12);consumedAnchor.current=store.anchor;}
    }
  },[page.loading,store.anchor,sessionKey]);
  const supported=libraries.filter(l=>(l.provider==="craft"||l.provider==="obsidian")&&(scope===null||scope.includes(l.id)));
  const taskLibraries=libraries.filter(l=>(l.provider==="craft"||l.provider==="obsidian"||l.provider==="dida365")&&(scope===null||scope.includes(l.id)));
  const canCreate=supported.some(l=>l.connected&&(view.libraries===null||view.libraries.includes(l.id)));
  const grouped=useMemo(()=>{
    const groups=new Map<string,SearchResult[]>();
    page.items.forEach(item=>{const date=journalDateKey(item);if(date){const values=groups.get(date)||[];values.push(item);groups.set(date,values);}});
    return groups;
  },[page.items]);
  const choose=(date:string)=>{setChosenDay(date);store.navigate(date);onNavigateDate?.(date);};
  const preview=(result:SearchResult)=>{if(page.loading)return;setPickedKey(result.entityKey);onPreview(result);};
  const selected=selectedKey||pickedKey;
  const closeMenu=()=>{if(menu.current){const wasOpen=menu.current.open;menu.current.open=false;if(wasOpen)menu.current.querySelector("summary")?.focus();}};
  const openSave=(mode:"save"|"rename",suggestion?:string)=>{closeMenu();setSaveMode(mode);setName(suggestion||(mode==="rename"?store.active?.name:journalLayouts[view.layout])||"");};
  const changeLayout=(layout:JournalLayout)=>{store.update({layout,...(layout!=="table"?{sort:"date" as const}:{})});setChosenDay("");closeMenu();};
  const moveMonth=(amount:number)=>{const days=journalMonthDays(view.month),date=new Date(`${days[0]}T12:00:00`);date.setMonth(date.getMonth()+amount);store.navigate(localJournalDate(date));store.update({period:"month",day:""});setChosenDay("");};
  const cards=(date:string,entries:SearchResult[],limit=4)=>{
    const expanded=expandedDays.has(date);const displayed=expanded?entries:entries.slice(0,limit);
    return <><div className="journal-day-cards">{displayed.map(result=><article key={result.entityKey} className={`journal-entry-card ${selected===result.entityKey?"is-selected":""}`}>
      <button className="journal-entry-open" disabled={page.loading} onClick={()=>preview(result)} aria-label={`预览 ${journalEntryTitle(result)} · ${result.libraryName}`} aria-pressed={selected===result.entityKey}>
        <span className="journal-entry-title">{renderIcon(result,result.libraryName)}<strong>{journalEntryTitle(result)}</strong></span>
        {view.summary&&entrySummary(result)!==journalEntryTitle(result)&&<span className="journal-entry-summary">{entrySummary(result)||"暂无摘要"}</span>}
        {(view.source||view.modified)&&<span className="journal-entry-meta">{view.source&&<span>{result.libraryName}</span>}{view.modified&&<span>更新于 {modifiedLabel(result)}</span>}</span>}
      </button>
      <div className="journal-entry-actions">{onFavorite&&<button aria-label={`${favoriteIds?.has(pageFavoriteKey(result))?"取消收藏":"收藏"} ${journalEntryTitle(result)}`} aria-pressed={favoriteIds?.has(pageFavoriteKey(result))||false} onClick={()=>onFavorite(result)}><Star size={14} fill={favoriteIds?.has(pageFavoriteKey(result))?"currentColor":"none"}/></button>}<button onClick={()=>onOpen(result)} aria-label={`在来源中打开 ${journalEntryTitle(result)}`}><ExternalLink size={14}/></button></div>
    </article>)}</div>{entries.length>limit&&<button className="journal-expand-day" aria-expanded={expanded} onClick={()=>setExpandedDays(current=>{const next=new Set(current);if(next.has(date))next.delete(date);else next.add(date);return next;})}>{expanded?"收起":"展开其余 "+(entries.length-limit)+" 篇"}</button>}</>;
  };
  const emptyDay=(date:string)=><div className="journal-empty-day"><span>{journalDateLabel(date)} · 暂无日志</span>{canCreate&&onCreate&&<button onClick={()=>onCreate(date)}><Plus size={14}/>写这一天</button>}</div>;
  const calendar=()=>{
    const dates=journalMonthDays(view.month,true);
    return <><div className="journal-db-calendar"><div className="journal-month-week">{["日","一","二","三","四","五","六"].map(d=><span key={d}>{d}</span>)}</div><div className="journal-month-grid">{dates.map(date=>{const entries=grouped.get(date)||[];return <section className={`journal-month-cell ${date.slice(0,7)!==view.month?"outside-month":""} ${date===today?"today":""} ${chosenDay===date?"selected":""}`} key={date}><button className="journal-month-date" onClick={()=>{setChosenDay(date);if(date.slice(0,7)!==view.month)store.navigate(date);}} aria-label={`${journalDateLabel(date)}，${entries.length}篇日志`} aria-pressed={chosenDay===date}>{Number(date.slice(8))}{date===today&&<span>今天</span>}</button>{entries.slice(0,3).map(result=><button key={result.entityKey} className={`journal-month-entry ${selected===result.entityKey?"is-selected":""}`} disabled={page.loading} onClick={()=>preview(result)} title={`${result.libraryName} · ${journalEntryTitle(result)}`}>{view.source&&<small>{result.libraryName}</small>}<span>{journalEntryTitle(result)}</span></button>)}{entries.length>3&&<button onClick={()=>setChosenDay(date)}>还有 {entries.length-3} 篇</button>}</section>;})}</div></div>{chosenDay&&<section className="journal-day-agenda"><header><strong>{journalDateLabel(chosenDay)}</strong><button aria-label="关闭当天日志" onClick={()=>setChosenDay("")}><X size={16}/></button></header>{cards(chosenDay,grouped.get(chosenDay)||[],Number.MAX_SAFE_INTEGER)}{!grouped.get(chosenDay)?.length&&emptyDay(chosenDay)}<button onClick={()=>{store.update({period:"day",day:chosenDay});}}>仅看这一天</button></section>}</>;
  };
  const list=()=>{
    const groups=[...grouped.entries()];groups.sort(([a],[b])=>view.ascending?a.localeCompare(b):b.localeCompare(a));
    return <div className="journal-db-list">{groups.map(([date,entries])=><section className="journal-list-day" key={date} data-journal-day={date}><header><button onClick={()=>choose(date)}>{journalDateLabel(date)}</button><small>{entries.length} 篇日志</small></header>{entries.map(result=><div className={`journal-list-row ${selected===result.entityKey?"is-selected":""}`} key={result.entityKey}><button disabled={page.loading} title={journalEntryTitle(result)} aria-label={`预览 ${journalEntryTitle(result)} · ${result.libraryName}`} aria-pressed={selected===result.entityKey} onClick={()=>preview(result)}>{renderIcon(result,result.libraryName)}<span><strong>{journalEntryTitle(result)}</strong>{view.summary&&entrySummary(result)!==journalEntryTitle(result)&&<small>{entrySummary(result)||"暂无摘要"}</small>}</span>{view.source&&<em>{result.libraryName}</em>}</button><button onClick={()=>onOpen(result)} aria-label={`在来源中打开 ${journalEntryTitle(result)}`}><ExternalLink size={14}/></button></div>)}</section>)}</div>;
  };
  const table=()=> <div className="journal-db-table-wrap"><table aria-label="日志表格"><thead><tr><th>标题</th><th><button onClick={()=>store.update({sort:"date",ascending:view.sort==="date"?!view.ascending:true})}>日志日期 {view.sort==="date"?(view.ascending?"↑":"↓"):""}</button></th>{view.source&&<th>资料库</th>}{view.summary&&<th>摘要</th>}{view.modified&&<th><button onClick={()=>store.update({sort:"modified",ascending:view.sort==="modified"?!view.ascending:false})}>更新时间 {view.sort==="modified"?(view.ascending?"↑":"↓"):""}</button></th>}<th><span className="sr-only">操作</span></th></tr></thead><tbody>{page.items.map(result=><tr key={result.entityKey} className={selected===result.entityKey?"is-selected":""}><td><button className="journal-table-title" disabled={page.loading} onClick={()=>preview(result)}>{renderIcon(result,result.libraryName)}{journalEntryTitle(result)}</button></td><td>{journalDateKey(result)}</td>{view.source&&<td>{result.libraryName}</td>}{view.summary&&<td>{entrySummary(result)||"暂无摘要"}</td>}{view.modified&&<td>{modifiedLabel(result)}</td>}<td><button onClick={()=>onOpen(result)} aria-label={`在来源中打开 ${journalEntryTitle(result)}`}><ExternalLink size={14}/></button></td></tr>)}</tbody></table></div>;
  const filtered=!!view.query||view.libraries!==null||view.period==="day";
  const monthCount=page.items.filter(item=>journalDateKey(item).startsWith(view.month));
  const stats=view.layout==="calendar"?`${new Set(monthCount.map(journalDateKey)).size} 个记录日 · ${monthCount.length} 篇日志`: `${page.days} 个记录日 · ${page.total} 篇日志 · ${page.libraries} 个资料库`;
  return <div ref={root} className={`results-pane journal-database ${view.layout==="stream"?"is-daily":""} ${view.compact?"is-compact":""}`}>
    <div className="journal-db-toolbar"><div className="journal-db-tabs" role="group" aria-label="日志视图"><button aria-pressed={!store.activeId} onClick={()=>store.reset()}>日常记录</button>{store.saved.filter(v=>!v.hidden).map(v=><button key={v.id} aria-pressed={store.activeId===v.id} onClick={()=>store.select(v.id)}>{v.name}</button>)}<button aria-label="新建日志视图" onClick={()=>openSave("save")} disabled={store.saved.length>=30}><Plus size={16}/></button></div><div className="journal-db-tools"><button aria-label="筛选日志" aria-expanded={filters} aria-pressed={filtered} onClick={()=>setFilters(!filters)}><ListFilter size={17}/></button><details ref={menu} className="journal-db-settings" onKeyDown={event=>{if(event.key==="Escape"){closeMenu();menu.current?.querySelector("summary")?.focus();}}}><summary aria-label="日志视图设置"><Settings2 size={17}/><span>{journalLayouts[view.layout]}</span><ChevronDown size={13}/></summary><div className="journal-db-menu" aria-label="当前日志视图设置"><strong>{store.active?.name||"日常记录"}</strong><div role="group" aria-label="日志布局">{Object.entries(journalLayouts).map(([layout,label])=>{const Icon=layoutIcons[layout as JournalLayout];return <button key={layout} aria-pressed={view.layout===layout} onClick={()=>changeLayout(layout as JournalLayout)}><Icon size={16}/>{label}</button>;})}</div><label>密度<select aria-label="日志密度" value={view.compact?"compact":"comfortable"} onChange={e=>store.update({compact:e.target.value==="compact"})}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label><fieldset><legend>显示属性</legend>{([['summary','摘要'],['source','资料库'],['modified','更新时间']] as const).map(([key,label])=><label key={key}><input type="checkbox" checked={view[key]} onChange={e=>store.update({[key]:e.target.checked})}/>{label}</label>)}</fieldset><label>排序字段<select aria-label="日志排序字段" value={view.sort} onChange={e=>store.update({sort:e.target.value as "date"|"modified"})}><option value="date">日志日期</option><option value="modified" disabled={view.layout==="stream"||view.layout==="calendar"||view.layout==="list"}>更新时间（表格）</option></select></label><label>排序方向<select aria-label="日志排序方向" disabled={view.layout==="stream"} value={view.layout==="stream"||view.ascending?"asc":"desc"} onChange={e=>store.update({ascending:e.target.value==="asc"})}><option value="asc">从早到晚</option><option value="desc">从晚到早</option></select></label><div className="journal-db-view-actions"><button disabled={store.saved.length>=30} onClick={()=>openSave("save",`${store.active?.name||"日常记录"} 副本`)}><Copy size={14}/>复制视图</button>{store.active&&<><button onClick={()=>openSave("rename")}>重命名</button><button onClick={()=>{store.hide(store.activeId,true);closeMenu();}}>隐藏视图</button><button onClick={()=>{store.remove(store.activeId);closeMenu();}}><Trash2 size={14}/>删除视图配置</button></>}</div></div></details></div></div>
    {saveMode&&<form className="journal-db-save-form" onSubmit={e=>{e.preventDefault();if(!name.trim())return;if(saveMode==="rename")store.rename(store.activeId,name);else {store.update({query});store.save(name);}setSaveMode(null);}}><label>{saveMode==="rename"?"视图名称":"新视图名称"}<input ref={saveInput} maxLength={60} value={name} onChange={e=>setName(e.target.value)}/></label><button type="submit" disabled={!name.trim()}>保存</button><button type="button" onClick={()=>setSaveMode(null)}>取消</button></form>}
    {store.modified&&<div className="journal-db-filter-summary"><span>当前视图已修改</span><button onClick={()=>{store.update({query});store.updateSaved();}}>更新视图</button><button onClick={()=>openSave("save")}>另存为</button></div>}
    <header className="journal-db-heading"><div><h1>{view.layout==="stream"?"日历":view.period==="all"&&view.layout!=="calendar"?"全部日志":view.period==="day"&&view.day?journalDateLabel(view.day):formatMonth(view.month)}</h1><p role="status">{view.layout==="stream"?"日志 · 当天安排 · 新建与完成":page.error?"日志读取失败":page.loading?"正在更新日志…":stats}</p></div><div><button aria-label="日志上个月" onClick={()=>moveMonth(-1)}><ChevronLeft size={17}/></button><input type="month" aria-label="日志月份" value={view.month} onChange={e=>{if(e.target.value){store.navigate(`${e.target.value}-01`);store.update({period:"month",day:""});}}}/><button aria-label="日志下个月" onClick={()=>moveMonth(1)}><ChevronRight size={17}/></button><button onClick={()=>{store.update({period:"month"});choose(today);}}>今天</button>{canCreate&&onCreate&&<button aria-label="新建日志" onClick={()=>onCreate(chosenDay||store.anchor||today)}><Plus size={16}/></button>}</div></header>
    {filters&&<div className="journal-db-filters"><label><Search size={15}/>搜索日志<input aria-label="搜索日志内容" placeholder="搜索正文或资料库" value={query} onChange={e=>setQuery(e.target.value)}/></label><label>日期范围<select aria-label="日志日期范围" value={view.period} onChange={e=>store.update({period:e.target.value as typeof view.period,day:view.day||chosenDay||store.anchor||today})}><option value="month">{view.layout==="stream"?"连续日期":"当前月份"}</option><option value="all">全部日期</option><option value="day">指定日期</option></select></label>{view.period==="day"&&<input type="date" aria-label="日志指定日期" value={view.day} onChange={e=>store.update({day:e.target.value,month:e.target.value.slice(0,7)})}/>}<fieldset><legend>资料库</legend><label><input type="checkbox" checked={view.libraries===null} onChange={()=>store.update({libraries:null})}/>全部资料库</label>{(view.layout==="stream"?taskLibraries:supported).map(l=><label key={l.id}><input type="checkbox" checked={view.libraries===null||view.libraries.includes(l.id)} onChange={e=>{const ids=view.libraries??(view.layout==="stream"?taskLibraries:supported).map(s=>s.id);store.update({libraries:e.target.checked?[...ids,l.id]:ids.filter(id=>id!==l.id)});}}/>{l.name}</label>)}</fieldset></div>}
    {filtered&&<div className="journal-db-filter-summary" aria-label="当前日志筛选条件">{view.query&&<span>搜索：{view.query}</span>}{view.libraries!==null&&<span>资料库：{view.libraries.map(id=>libraries.find(l=>l.id===id)?.name||"未连接资料库").join("、")||"未选择"}</span>}{view.period==="day"&&<span>日期：{view.day}</span>}<button onClick={()=>{store.update({query:"",libraries:null,period:"month",day:""});setQuery("");}}>清除筛选</button></div>}
    {view.layout!=="stream"&&page.error&&<div className="journal-db-status" role="alert">{page.error}<button onClick={page.retry}>重试</button></div>}
    <div ref={body} className="journal-db-body" aria-busy={view.layout!=="stream"&&page.loading} onScroll={event=>sessionPosition.current.set(sessionKey,event.currentTarget.scrollTop)}>
      {view.layout==="stream"?<JournalDailyStream store={store} today={today} scope={scope} dataVersion={dataVersion} selectedKey={selected} canCreate={canCreate} onChoose={choose} onPreview={result=>{setPickedKey(result.entityKey);onPreview(result);}} onCreate={onCreate}/>:!page.error&&(view.layout==="calendar"?calendar():view.layout==="list"?list():table())}
      {!page.loading&&!page.error&&page.total===0&&view.layout!=="stream"&&view.layout!=="calendar"&&<div className="journal-db-status"><CalendarDays size={24}/><strong>{filtered?"没有符合筛选的日志":"当前范围暂无日志"}</strong><p>可以调整日期范围或资料库。</p></div>}
      {view.layout!=="stream"&&!page.loading&&page.items.length<page.total&&<div className="journal-db-status"><button onClick={page.loadMore}>继续加载（已显示 {page.items.length} / {page.total} 篇）</button></div>}
    </div>
  </div>;
}
