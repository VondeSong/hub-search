"use client";

import {taskStatus,taskDate,taskStates} from "./task-data";
import {libraryDragProps} from "./assistant-library-drag";
import {useDidaTasks} from "./useDidaTasks";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, ArrowUpRight, ChevronDown, ChevronRight, File, FileText, Folder, FolderOpen, FolderTree, Hash, LayoutGrid, List, MapPin, PanelLeft, PanelRight, Search, Star, Layers, Table2, X, Check, CheckCircle2, Circle, ListTodo, Columns3, StickyNote, Link2, Sheet, LockKeyhole } from "lucide-react";
import { columnParents, ancestorsOf, childrenOf, isContent, isContainer, contentOf, nodeKindLabel, isWithin, libraries, libraryNodes, nodeById, pathOf, searchLibrary, type LibraryId, type LibraryNode } from "./library-data";

type Position = { folder: string; selected: string; expanded: string[] };
const initialPositions = (): Record<LibraryId, Position> => Object.fromEntries((Object.keys(libraries) as LibraryId[]).map(id=>[id,{folder:libraries[id].initialFolder,selected:libraries[id].initialDocument,expanded:[...libraries[id].expanded]}])) as Record<LibraryId, Position>;
const STORAGE = "hub-library-browser-v1";
const libraryPresentation = {
  craft:{unit:"空间",tree:"文件夹与页面",hierarchy:"文件夹 → 文档 → 子页面",hint:"文档下的页面保留原有嵌套关系。"},
  obsidian:{unit:"Vault",tree:"文件夹与笔记",hierarchy:"目录 → Markdown 文件",hint:"文件名与完整路径帮助区分同名笔记。"},
  dida:{unit:"账号",tree:"文件夹、清单与任务",hierarchy:"清单 → 自定义分组 → 任务 → 子任务",hint:"自定义分组与任务完成状态分别保留。"},
  feishu:{unit:"知识空间",tree:"知识库页面节点",hierarchy:"页面节点 → 子节点 · 文档类型独立标识",hint:"节点可承载正文，也可拥有下级页面。"},
};

function Mark({library}:{library:LibraryId}) { return <span className={"lb-provider lb-"+library} aria-hidden="true">{library==="craft"?"C":library==="obsidian"?<span className="obsidian-gem"/>:library==="dida"?<Check size={14}/>:<span className="feishu-mark"/>}</span>; }
function NodeIcon({node,open=false,completed}:{node:LibraryNode;open?:boolean;completed?:boolean}) { const Icon=node.kind==="folder"?(open?FolderOpen:Folder):node.kind==="taskList"?ListTodo:node.kind==="taskGroup"?Columns3:node.kind==="task"?(completed??node.status==="done"?CheckCircle2:Circle):node.kind==="note"?StickyNote:node.kind==="shortcut"?Link2:node.kind==="collection"||node.documentType==="bitable"?Table2:node.documentType==="sheet"?Sheet:node.kind==="attachment"?File:FileText; return <Icon size={16} className={"lb-node-icon lb-kind-"+node.kind}/>; }

export default function LibraryBrowser({initialNodeId,navigationOpen,onToggleNavigation,navigationResizer,onExit,notify}:{initialNodeId?:string;navigationOpen:boolean;navigationResizer?:React.ReactNode;onToggleNavigation:()=>void;onExit:()=>void;notify:(message:string)=>void}) {
  const [browseMode,setBrowseMode]=useState("tree");
  const columnsRef=useRef<HTMLDivElement>(null);
  const [aggregateSelected,setAggregateSelected]=useState("");
  const [hubView,setHubView]=useState("all");
  const [directoryQuery,setDirectoryQuery]=useState("");
  const [favorites,setFavorites]=useState<string[]>(["c-harness","o-knowledge"]);
  const [topic,setTopic]=useState<string[]>(["c-guide","o-learning","d-review","f-sheet"]);
  const structural=(n:LibraryNode)=>isContainer(n)||((n.library==="craft"||n.library==="feishu")&&childrenOf(n.id).length>0);
  const aggregate=hubView!=="library";
  function changeView(view:string){setHubView(view);setQuery("");setMobileDetail(false);setPreview(true);setAggregateSelected("");}
  function toggleSaved(id:string,kind:"favorite"|"topic"){const setter=kind==="favorite"?setFavorites:setTopic;setter(old=>old.includes(id)?old.filter(x=>x!==id):[...old,id]);}
  const [library,setLibrary]=useState<LibraryId>("craft");
  const [positions,setPositions]=useState(initialPositions);
  const [ready,setReady]=useState(false);
  const {checks,setChecks,status:sharedStatus,dates:sharedDates}=useDidaTasks();
  const [query,setQuery]=useState("");
  const [scope,setScope]=useState("library");
  const [layout,setLayout]=useState("list");
  const [preview,setPreview]=useState(true);
  const [mobileDetail,setMobileDetail]=useState(false);
  const [focusId,setFocusId]=useState("c-harness");
  const treeRef=useRef<HTMLDivElement>(null), listRef=useRef<HTMLDivElement>(null), articleRef=useRef<HTMLDivElement>(null), searchRef=useRef<HTMLInputElement>(null);
  const scrollPositions=useRef<Record<string,{tree:number;list:number;article:number}>>({});
  const meta=libraries[library], presentation=libraryPresentation[library], position=positions[library], folder=nodeById[position.folder], selected=nodeById[aggregate?aggregateSelected:position.selected];
  const expanded=new Set(position.expanded);
  const showColumns=browseMode==="columns"&&!query.trim()&&(hubView==="all"||hubView==="library");
  const columnCursor=hubView==="all"?"":selected?.id||position.folder;
  const parents=hubView==="all"?[]:columnParents(library,columnCursor);
  const columnPath=new Set(ancestorsOf(columnCursor).map(n=>n.id));
  useEffect(()=>{if(showColumns&&columnsRef.current)columnsRef.current.scrollLeft=columnsRef.current.scrollWidth;},[showColumns,columnCursor,library]);
  function openColumn(node:LibraryNode){
    setHubView("library");setLibrary(node.library);setQuery("");if(!isContainer(node))setPreview(true);
    setPositions(all=>({...all,[node.library]:{...all[node.library],folder:isContainer(node)||childrenOf(node.id).length?node.id:node.parent,selected:isContainer(node)?"":node.id,expanded:[...new Set([...all[node.library].expanded,...ancestorsOf(node.id).map(n=>n.id)])]}}));
    setMobileDetail(!isContainer(node)&&!childrenOf(node.id).length);
    if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();
  }
  function openColumnRoot(id:LibraryId){setLibrary(id);setHubView("library");setQuery("");setMobileDetail(false);setPositions(all=>({...all,[id]:{...all[id],folder:libraries[id].root,selected:""}}));if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();}

  const update=(change:Partial<Position>)=>setPositions(all=>({...all,[library]:{...all[library],...change}}));

  useEffect(()=>{
    try {
      const saved=JSON.parse(localStorage.getItem(STORAGE)||"null");
      if(saved?.version===1) {
        const next=initialPositions();
        for(const id of Object.keys(libraries) as LibraryId[]) {
          const value=saved.positions?.[id]; if(!value)continue;
          const valid=(key:unknown)=>typeof key==="string"&&(key===libraries[id].root||nodeById[key]?.library===id);
          if(valid(value.folder)&&(value.folder===libraries[id].root||(nodeById[value.folder]&&isContainer(nodeById[value.folder]))||childrenOf(value.folder).length))next[id].folder=value.folder;
          if(value.selected===""||(valid(value.selected)&&(nodeById[value.selected]&&!isContainer(nodeById[value.selected]))))next[id].selected=value.selected;
          if(Array.isArray(value.expanded))next[id].expanded=value.expanded.filter((key:unknown)=>valid(key));
        }
        setPositions(next);
        if(Array.isArray(saved.favorites))setFavorites(saved.favorites.filter((id:string)=>nodeById[id]));
        if(Array.isArray(saved.topic))setTopic(saved.topic.filter((id:string)=>nodeById[id]));
        if(Object.prototype.hasOwnProperty.call(libraries,saved.library))setLibrary(saved.library);

      }
    } catch { /* A blocked or stale browser store does not prevent browsing. */ }
    setReady(true);
  },[]);
  useEffect(()=>{if(ready)try{localStorage.setItem(STORAGE,JSON.stringify({version:1,library,positions,checks,favorites,topic}));}catch{}},[ready,library,positions,checks,favorites,topic]);
  useEffect(()=>{
    const pos=scrollPositions.current[library];
    if(treeRef.current)treeRef.current.scrollTop=pos?.tree||0;
    if(listRef.current)listRef.current.scrollTop=pos?.list||0;
    if(articleRef.current)articleRef.current.scrollTop=pos?.article||0;
  },[library]);
  useEffect(()=>{if(ready&&initialNodeId&&nodeById[initialNodeId])locate(nodeById[initialNodeId]);},[ready,initialNodeId]);
  const previousReading=useRef({library,selected:position.selected});
  useEffect(()=>{if(previousReading.current.library===library&&previousReading.current.selected!==position.selected&&articleRef.current)articleRef.current.scrollTop=0;previousReading.current={library,selected:position.selected};},[library,position.selected]);
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();e.stopImmediatePropagation();searchRef.current?.focus();}if(e.key==="Escape"){if(query){setQuery("");searchRef.current?.focus();}else setMobileDetail(false);}};
    window.addEventListener("keydown",key,true); return()=>window.removeEventListener("keydown",key,true);
  },[query]);

  const visibleTree=useMemo(()=>{
    const rows:{node:LibraryNode;depth:number}[]=[];
    function walk(parent:string,depth:number){childrenOf(parent).filter(structural).forEach(node=>{rows.push({node,depth});if(position.expanded.includes(node.id))walk(node.id,depth+1);});}
    walk(meta.root,1);return rows;
  },[library,position.expanded,meta.root]);
  const searching=Boolean(query.trim());
  const localResults=searching?searchLibrary(library,query,scope==="folder"?position.folder:undefined):childrenOf(position.folder);
  const base=hubView==="favorites"?favorites.map(id=>nodeById[id]).filter(Boolean):hubView==="topic"?topic.map(id=>nodeById[id]).filter(Boolean):libraryNodes.filter(isContent);
  const results=aggregate?(searching?base.filter(n=>isContainer(n)?pathOf(n).toLowerCase().includes(query.trim().toLowerCase()):searchLibrary(n.library,query).some(hit=>hit.id===n.id)):base):localResults;
  const total=libraryNodes.filter(node=>node.library===library&&isContent(node)).length;
  const trail=ancestorsOf(position.folder);
  const title=searching?"搜索结果":aggregate?hubView==="favorites"?"我的收藏":hubView==="topic"?"线束项目":"全部库":folder?.title||"全部内容";
  const getDescendantCount=(node:LibraryNode)=>libraryNodes.filter(n=>n.library===node.library&&isContent(n)&&isWithin(n,node.id)).length;
  const folderSummary=(node:LibraryNode)=>{const contents=libraryNodes.filter(n=>n.library===node.library&&isContent(n)&&isWithin(n,node.id)).length;const attachments=libraryNodes.filter(n=>n.library===node.library&&n.kind==="attachment"&&isWithin(n,node.id)).length;return attachments?[contents?contents+(library==="dida"?" 项任务与笔记":" 篇内容"):"",attachments+" 个附件"].filter(Boolean).join(" · "):contents+(library==="dida"?" 项任务与笔记":" 篇内容");};
  const taskDone=(node:LibraryNode)=>checks["task:"+node.id]??node.status==="done";
  const toggleTask=(node:LibraryNode)=>setChecks(all=>({...all,["task:"+node.id]:!taskDone(node)}));
  const taskColumns=!aggregate&&library==="dida"&&!searching&&folder?.kind==="taskList"?childrenOf(folder.id).filter(node=>node.kind==="taskGroup"):[];
  const emptyTitle=folder?.kind==="taskList"?"这个清单是空的":folder?.kind==="taskGroup"?"这个分组暂无任务":"这个文件夹是空的";
  function toggle(id:string){update({expanded:expanded.has(id)?position.expanded.filter(x=>x!==id):[...position.expanded,id]});}
  function open(node:LibraryNode){
    if(node.library!==library||aggregate){
      if(aggregate)setAggregateSelected(isContainer(node)?"":node.id);
      setLibrary(node.library);setPositions(all=>({...all,[node.library]:{...all[node.library],folder:isContainer(node)?node.id:node.parent,selected:isContainer(node)?"":node.id,expanded:[...new Set([...all[node.library].expanded,...ancestorsOf(node.id).map(n=>n.id)])]}}));
      if(isContainer(node))setHubView("library");if(isContainer(node)||!query.trim())setQuery("");setPreview(true);setMobileDetail(!isContainer(node));if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();return;
    }
    if(isContainer(node)) {update({folder:node.id,selected:childrenOf(node.id).find(isContent)?.id||"",expanded:[...new Set([...position.expanded,...ancestorsOf(node.id).map(n=>n.id)])]});setQuery("");setMobileDetail(false);}
    else {update({folder:isContainer(node)?node.id:node.parent,selected:isContainer(node)?"":node.id,expanded:[...new Set([...position.expanded,...ancestorsOf(node.id).map(n=>n.id)])]});setPreview(true);setMobileDetail(true);}
    setFocusId(node.id);
    if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();
  }
  function locate(node:LibraryNode){
    setHubView("library");setLibrary(node.library);setDirectoryQuery("");
    if(node.library!==library){setPositions(all=>({...all,[node.library]:{folder:isContainer(node)?node.id:node.parent,selected:isContainer(node)?"":node.id,expanded:ancestorsOf(node.id).map(n=>n.id)}}));setQuery("");setMobileDetail(false);return;}
    update({folder:isContainer(node)?node.id:node.parent,selected:isContainer(node)?"":node.id,expanded:[...new Set([...position.expanded,...ancestorsOf(node.id).map(n=>n.id)])]});
    setQuery("");setMobileDetail(false);setFocusId(node.id);
    requestAnimationFrame(()=>treeRef.current?.querySelector<HTMLElement>('[data-node="'+node.id+'"]')?.scrollIntoView({block:"nearest"}));
    notify("已定位到 "+pathOf(node));
  }
  function switchLibrary(id:LibraryId){
    setHubView("library");setDirectoryQuery("");if(id===library)return;
    scrollPositions.current[library]={tree:treeRef.current?.scrollTop||0,list:listRef.current?.scrollTop||0,article:articleRef.current?.scrollTop||0};
    setLibrary(id);setPreview(true);setQuery("");setScope("library");setLayout("list");setMobileDetail(false);setFocusId(positions[id].folder);
  }
  function treeKey(e:React.KeyboardEvent<HTMLButtonElement>,node:LibraryNode,index:number){
    const hasChildren=childrenOf(node.id).some(structural);
    let next:string|undefined;
    if(e.key==="ArrowDown")next=visibleTree[index+1]?.node.id;
    else if(e.key==="ArrowUp")next=visibleTree[index-1]?.node.id;
    else if(e.key==="Home")next=visibleTree[0]?.node.id;
    else if(e.key==="End")next=visibleTree.at(-1)?.node.id;
    else if(e.key==="ArrowRight"){if(hasChildren&&!expanded.has(node.id))toggle(node.id);else next=visibleTree[index+1]?.depth>visibleTree[index].depth?visibleTree[index+1].node.id:undefined;}
    else if(e.key==="ArrowLeft"){if(hasChildren&&expanded.has(node.id))toggle(node.id);else next=nodeById[node.parent]?.id;}
    else return;
    e.preventDefault();if(next){setFocusId(next);treeRef.current?.querySelector<HTMLButtonElement>('[data-node="'+next+'"]')?.focus();}
  }
  const renderItem=(node:LibraryNode)=><div className={"lb-item "+(node.id===selected?.id&&!isContainer(node)?"selected ":"")+(node.kind==="task"?"lb-task-item ":"")+(node.kind==="task"&&taskDone(node)?"lb-task-completed":"")} key={node.id}>
    {node.kind==="task"&&<input className="lb-task-checkbox" type="checkbox" aria-label={"完成任务 "+node.title} checked={taskDone(node)} onChange={()=>toggleTask(node)}/>}
    <button className="lb-item-open" {...libraryDragProps(node)} onClick={()=>open(node)} aria-label={"打开 "+(node.filename||node.title)}>{node.kind!=="task"&&<span className="lb-item-icon"><NodeIcon node={node}/></span>}<span className="lb-item-copy"><strong>{node.filename||node.title}</strong><span>{isContainer(node)?folderSummary(node):node.description}</span>{node.kind==="task"&&<span className="lb-task-details">{node.priority&&<em className={node.priority==="高"?"lb-priority-high":""}>{node.priority}优先级</em>}{taskDate(node.id,sharedDates)&&<em>{taskDate(node.id,sharedDates)}</em>}<em>{taskStates[taskStatus(node.id,checks,sharedStatus)]}</em></span>}<small>{aggregate||searching?libraries[node.library].provider+" · "+pathOf(node):library==="obsidian"?(node.kind==="attachment"?(node.imageSrc?"图片附件":"PDF 附件"):isContainer(node)?"文件夹":"Markdown 笔记"):nodeKindLabel(node)+(childrenOf(node.id).length&&!isContainer(node)?" · "+childrenOf(node.id).length+(node.kind==="task"?" 个子任务":library==="feishu"?" 个子节点":" 个子页面"):"")}</small></span>{isContainer(node)&&<ChevronRight size={14}/>}</button>
    <div className="lb-save-actions"><button aria-label={(favorites.includes(node.id)?"取消收藏 ":"收藏 ")+node.title} aria-pressed={favorites.includes(node.id)} onClick={()=>toggleSaved(node.id,"favorite")}><Star size={13}/>{favorites.includes(node.id)?"已收藏":"收藏"}</button><button aria-pressed={topic.includes(node.id)} onClick={()=>toggleSaved(node.id,"topic")}><Layers size={13}/>{topic.includes(node.id)?"移出专题":"加入线束项目"}</button></div>
    {(aggregate||searching)&&<button className="lb-locate-result" aria-label={"定位 "+node.title} onClick={()=>locate(node)}><MapPin size={12}/>在结构中定位</button>}
  </div>;

  const renderContent=(node:LibraryNode)=><>
    <div className="lb-document-meta"><Mark library={library}/><span>{meta.provider} · {meta.name}</span><span>{node.kind==="attachment"?"附件信息":nodeKindLabel(node)}</span><span>示例内容</span></div>
    <h1>{node.title}</h1>
    {node.filename&&<div className="lb-filename"><FileText size={13}/>{node.filename}</div>}
    {node.kind==="task"&&<div className="lb-task-properties"><button aria-pressed={taskDone(node)} onClick={()=>toggleTask(node)}>{taskDone(node)?<CheckCircle2 size={16}/>:<Circle size={16}/>} {taskDone(node)?"已完成 · 恢复待办":"标为完成"}</button>{taskDate(node.id,sharedDates)&&<span>日期：{taskDate(node.id,sharedDates)}</span>}{node.priority&&<span>优先级：{node.priority}</span>}<small>示例操作 · 仅保存在此浏览器</small></div>}
    {node.kind==="shortcut"&&<div className="lb-shortcut"><Link2 size={16}/><div><strong>快捷方式 → {contentOf(node).title}</strong><p>指向同一份正文，保留独立目录位置。</p></div><button onClick={()=>locate(contentOf(node))}>查看原位置<ArrowUpRight size={12}/></button></div>}
    {!!node.tags?.length&&<div className="lb-tags">{node.tags.map(tag=><span key={tag}><Hash size={11}/>{tag}</span>)}</div>}
    <div className="lb-prose">{node.access==="restricted"?<div className="lb-permission"><LockKeyhole size={30}/><h2>该页面需要额外权限</h2><p>当前只能查看目录节点，无法读取正文。</p><p>权限状态示例，未发起授权或读取请求。</p></div>:node.kind==="attachment"?<div className="lb-attachment">{node.imageSrc?<><img src={node.imageSrc} alt={node.title} {...libraryDragProps(node)}/><p>可把图片拖到 Hub 助手输入框。</p></>:<><File size={38}/><h2>{node.title}</h2><p>PDF · 示例附件</p><p>此处展示附件在目录中的位置。实际 PDF 预览待接入。</p></>}</div>:contentOf(node).sections?.map((section,index)=>section.type==="h2"?<h2 key={index}>{section.text}</h2>:section.type==="list"?<ul key={index}>{section.items?.map(text=><li key={text}>{text}</li>)}</ul>:section.type==="checklist"?<ul className="lb-checklist" key={index}>{section.items?.map(text=><li key={text}>{library==="dida"?<input type="checkbox" aria-label={"检查项 "+text} checked={checks["check:"+node.id+":"+index+":"+text]??false} onChange={e=>setChecks(all=>({...all,["check:"+node.id+":"+index+":"+text]:e.target.checked}))}/>:<span className="lb-check-box"/>}{text}</li>)}</ul>:section.type==="callout"?<aside className="lb-callout" key={index}>{section.text}</aside>:section.type==="quote"?<blockquote key={index}>{section.text}</blockquote>:<p key={index}>{section.text}</p>)}</div>
    {node.rows&&<div className="lb-native-table"><div><Table2 size={15}/>{nodeKindLabel(node)}<span>只读示例 · {node.rows.length-1} 条记录</span></div><table><thead><tr>{node.rows[0].map(text=><th key={text}>{text}</th>)}</tr></thead><tbody>{node.rows.slice(1).map((row,index)=><tr key={index}>{row.map((text,col)=><td key={col}>{text}</td>)}</tr>)}</tbody></table></div>}
    {node.kind==="task"&&childrenOf(node.id).length>0&&<h2 className="lb-subtasks-heading">子任务 <span>{childrenOf(node.id).filter(taskDone).length} / {childrenOf(node.id).length}</span></h2>}
    {node.kind==="collection"?<div className="lb-collection">
      <div className="lb-collection-toolbar"><span>{childrenOf(node.id).length} 条参考</span><div><button aria-label="合集表格视图" aria-pressed={layout!=="gallery"} onClick={()=>setLayout("list")}><Table2 size={14}/></button><button aria-label="合集画廊视图" aria-pressed={layout==="gallery"} onClick={()=>setLayout("gallery")}><LayoutGrid size={14}/></button></div></div>
      {layout==="gallery"?<div className="lb-reference-gallery">{childrenOf(node.id).map((child,index)=><button key={child.id} onClick={()=>open(child)}><span className="lb-reference-cover"><span className="lb-reference-lines"><i/><i/><i/></span>{index===0?<FolderTree size={27}/>:index===1?<FileText size={27}/>:<Search size={27}/>}</span><strong>{child.title}</strong><p>{child.description}</p></button>)}</div>:<table><thead><tr><th>名称</th><th>关注点</th></tr></thead><tbody>{childrenOf(node.id).map(child=><tr key={child.id}><td><button onClick={()=>open(child)}><FileText size={14}/>{child.title}<ArrowUpRight size={12}/></button></td><td>{child.tags?.join("、")}</td></tr>)}</tbody></table>}
    </div>:childrenOf(node.id).filter(isContent).length>0&&<div className="lb-child-pages">{childrenOf(node.id).filter(isContent).map(child=><button key={child.id} onClick={()=>open(child)}><NodeIcon node={child} completed={taskDone(child)}/><span><strong>{child.title}</strong><small>{child.description}</small></span><ChevronRight size={15}/></button>)}</div>}
    {library==="obsidian"&&["o-learning","o-links","o-reading"].includes(node.id)&&<div className="lb-wikilinks">{["o-links","o-reading","o-learning"].filter(id=>id!==node.id).map(id=><button key={id} onClick={()=>{open(nodeById[id]);notify("已沿双链打开笔记，可点击右上角定位图标查看目录位置。");}}><LinkMark/> {nodeById[id].title}</button>)}</div>}
    {node.kind!=="attachment"&&<div className="lb-document-end"><span>当前位置</span><button onClick={()=>locate(node)}><MapPin size={12}/>{pathOf(node)}</button></div>}
  </>;

  return <div className={"library-browser "+(!navigationOpen?"lb-nav-closed ":"")+(mobileDetail?"lb-show-detail ":"")+(!preview?"lb-no-preview ":"")+(showColumns?"lb-column-mode":"")}>
    <aside id="hub-module-navigation" className="lb-navigation" aria-label="资料库结构导航">
      <header className="lb-nav-title"><h1>库结构</h1><button className="icon-button lb-mobile-nav-close" aria-label="收起库结构" onClick={onToggleNavigation}><X size={16}/></button><span>交互原型</span></header>
      <div className="lb-hub-controls"><label>浏览范围<select aria-label="浏览范围" value={aggregate?"all":library} onChange={e=>e.target.value==="all"?changeView("all"):switchLibrary(e.target.value as LibraryId)}><option value="all">全部库</option>{(Object.keys(libraries) as LibraryId[]).map(id=><option key={id} value={id}>{libraries[id].name} · {libraries[id].provider}</option>)}</select></label><div className="lb-shortcuts"><button aria-pressed={hubView==="all"} onClick={()=>changeView("all")}><FolderTree size={15}/>全部库</button><button aria-pressed={hubView==="favorites"} onClick={()=>changeView("favorites")}><Star size={15}/>收藏 <small>{favorites.length}</small></button><button aria-pressed={hubView==="topic"} onClick={()=>changeView("topic")}><Layers size={15}/>线束项目 <small>{topic.length}</small></button></div><label className="lb-directory-search"><Search size={14}/><input aria-label="快速定位目录" placeholder="快速定位目录或清单…" value={directoryQuery} onChange={e=>setDirectoryQuery(e.target.value)}/></label></div>
      {directoryQuery&&<div className="lb-directory-results">{libraryNodes.filter(n=>structural(n)&&(aggregate||n.library===library)&&pathOf(n).toLowerCase().includes(directoryQuery.toLowerCase())).map(n=><button key={n.id} onClick={()=>{setDirectoryQuery("");setHubView("library");open(n);}}><strong>{n.title}</strong><small>{libraries[n.library].provider} · {pathOf(n)}</small></button>)}{!libraryNodes.some(n=>structural(n)&&(aggregate||n.library===library)&&pathOf(n).toLowerCase().includes(directoryQuery.toLowerCase()))&&<p>没有匹配的目录</p>}</div>}
      {aggregate?<div className="lb-root-libraries"><p>资料库 · 按来源保留位置</p>{(Object.keys(libraries) as LibraryId[]).map(id=><details key={id}><summary><Mark library={id}/>{libraries[id].name}<small>{libraries[id].provider}</small></summary>{libraryNodes.filter(n=>n.library===id&&n.parent===libraries[id].root&&structural(n)).map(n=><button key={n.id} onClick={()=>{setHubView("library");open(n);}}><NodeIcon node={n}/>{n.title}<ChevronRight size={12}/></button>)}<button onClick={()=>switchLibrary(id)}>进入资料库<ArrowUpRight size={12}/></button></details>)}</div>:<>
      <div className="lb-library-heading"><div className="lb-library-mark"><Mark library={library}/></div><div><strong>{meta.name}<span>{presentation.unit}</span></strong><p>{meta.description}</p></div></div>
      <button className={"lb-all "+(position.folder===meta.root?"active":"")} onClick={()=>{update({folder:meta.root,selected:""});setQuery("");setMobileDetail(false);}}><List size={15}/><span>全部内容</span><small>{total}</small></button>
      <div className="lb-tree-caption"><span>{presentation.tree}</span><button title="折叠全部目录" aria-label="折叠全部目录" onClick={()=>update({expanded:[]})}><FolderTree size={14}/></button></div>
      <div className="lb-tree" role="tree" aria-label={meta.name+"库结构"} ref={treeRef}>
        {visibleTree.map(({node,depth},index)=>{
          const hasChildren=childrenOf(node.id).some(structural);
          const active=node.id===(selected?[...ancestorsOf(selected.id)].reverse().find(n=>visibleTree.some(row=>row.node.id===n.id))?.id:position.folder);
          return <button key={node.id} {...libraryDragProps(node)} role="treeitem" data-node={node.id} aria-level={depth} aria-expanded={hasChildren?expanded.has(node.id):undefined} aria-selected={active} tabIndex={node.id===focusId||(!visibleTree.some(r=>r.node.id===focusId)&&index===0)?0:-1} onFocus={()=>setFocusId(node.id)} onKeyDown={e=>treeKey(e,node,index)} className={"lb-tree-row "+(active?"active":"")} style={{paddingLeft:12+(depth-1)*17}} title={pathOf(node)} onClick={()=>open(node)}>
            <span className={"lb-disclosure "+(!hasChildren?"lb-no-children":"")} onClick={e=>{if(hasChildren){e.stopPropagation();toggle(node.id);}}}>{expanded.has(node.id)?<ChevronDown size={12}/>:<ChevronRight size={12}/>}</span><NodeIcon node={node} open={expanded.has(node.id)} completed={taskDone(node)}/><span className="lb-tree-type" aria-hidden="true">{node.access==="restricted"&&<LockKeyhole size={11}/>}</span><span className="lb-tree-name">{node.filename||node.title}</span>{isContainer(node)&&<small title={folderSummary(node)}>{getDescendantCount(node)+libraryNodes.filter(n=>n.library===node.library&&n.kind==="attachment"&&isWithin(n,node.id)).length}</small>}
          </button>;
        })}
      </div>
      </>}<footer className="lb-nav-footer"><span className="lb-local-dot"/><div><strong>{aggregate?"各库独立归属 · 跨库共同浏览":presentation.hierarchy}</strong><p>示例数据 · 浏览位置自动保留</p></div></footer>
    </aside>{navigationResizer}
    {navigationOpen&&<button className="lb-nav-scrim" onClick={onToggleNavigation} aria-label="关闭库结构导航"/>}
    <div className="lb-main">
      <header className="lb-topbar"><div className="lb-topbar-title"><button className="icon-button" aria-label={navigationOpen?"隐藏库结构导航":"显示库结构导航"} onClick={onToggleNavigation}><PanelLeft size={17}/></button><span>资料库</span><ChevronRight size={12}/><strong>{aggregate?"全部库":meta.name}</strong></div><div className="lb-search"><Search size={16}/><input ref={searchRef} value={query} onChange={e=>{setQuery(e.target.value);setMobileDetail(false);}} placeholder={"搜索 "+(aggregate?"全部库":meta.name)+" 中的内容…"} aria-label="搜索当前资料库"/>{query?<button aria-label="清除库搜索" onClick={()=>setQuery("")}><X size={14}/></button>:<kbd>Ctrl K</kbd>}</div><button className="lb-exit" aria-label="返回全部内容" onClick={onExit}><ArrowLeft size={14}/><span>返回全部内容</span></button></header>
      <div className="lb-scopebar">{aggregate?<span>{hubView==="topic"?"跨库专题 · 手动收集引用，不移动原资料":hubView==="favorites"?"收藏的目录和内容 · 保存在此浏览器":"四个资料库 · 来源与原始路径始终保留"}</span>:<><nav aria-label="库结构路径"><button onClick={()=>{update({folder:meta.root,selected:""});setQuery("");setMobileDetail(false);}}><Mark library={library}/>{meta.name}</button>{trail.map(node=><React.Fragment key={node.id}><ChevronRight size={11}/><button onClick={()=>{update({folder:node.id,selected:isContainer(node)?childrenOf(node.id).find(isContent)?.id||"":node.id});setQuery("");setMobileDetail(false);}}>{node.title}</button></React.Fragment>)}</nav><label><span>搜索范围</span><select aria-label="库搜索范围" value={scope} onChange={e=>setScope(e.target.value)}><option value="library">整个库</option><option value="folder">当前位置及下级</option></select></label></>}</div>
      <div className="lb-browse-toolbar"><div role="group" aria-label="浏览模式"><button aria-pressed={browseMode==="tree"} onClick={()=>{setBrowseMode("tree");setMobileDetail(false);}}><FolderTree size={14}/>目录树</button><button aria-pressed={browseMode==="columns"} onClick={()=>{setBrowseMode("columns");setLayout("list");setPreview(true);setMobileDetail(false);}}><Columns3 size={14}/>分栏浏览</button></div><span>{showColumns?"每栏一个层级 · 左右滚动切换层级":browseMode==="columns"?"搜索、收藏与专题以列表呈现；定位后继续分栏":"目录与内容列表"}</span>{showColumns&&selected&&<button onClick={()=>{setPreview(true);setMobileDetail(true);if(window.innerWidth<1100&&navigationOpen)onToggleNavigation();}}><FileText size={14}/>阅读当前页</button>}{showColumns&&<button onClick={()=>{setPreview(!preview);setMobileDetail(false);}}><PanelRight size={14}/>{preview?"收起预览":"显示预览"}</button>}</div>
      <div className="lb-content">
        {showColumns?<section className="lb-columns" aria-label="分栏目录浏览" ref={columnsRef}>
          <div className="lb-column"><header>资料库 <small>4 个来源</small></header>{(Object.keys(libraries) as LibraryId[]).map(id=><button key={id} aria-pressed={hubView==="library"&&library===id} onClick={()=>openColumnRoot(id)}><Mark library={id}/><span>{libraries[id].name}<small>{libraries[id].provider}</small></span><ChevronRight size={13}/></button>)}</div>
          {parents.map((parent,index)=><div className="lb-column" key={parent} role="region" aria-label={(nodeById[parent]?.title||meta.name)+"下级"}><header>{nodeById[parent]?.title||meta.name}<small>{childrenOf(parent).length} 项</small></header>{childrenOf(parent).map(node=><button key={node.id} {...libraryDragProps(node)} aria-pressed={columnPath.has(node.id)} title={pathOf(node)} onClick={()=>openColumn(node)} onKeyDown={e=>{if(e.key==="ArrowRight"){e.preventDefault();openColumn(node);}else if(e.key==="ArrowLeft"){e.preventDefault();const previous=columnsRef.current?.children[index] as HTMLElement|undefined;previous?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();}}}><NodeIcon node={node} completed={taskDone(node)}/><span>{node.filename||node.title}<small>{nodeKindLabel(node)}</small></span>{(isContainer(node)||childrenOf(node.id).length>0)&&<ChevronRight size={13}/>}</button>)}{!childrenOf(parent).length&&<p className="lb-column-empty">当前位置为空</p>}</div>)}
        </section>:<>

        <section className={"lb-list "+(taskColumns.length&&layout==="board"?"lb-board-list":"")} aria-label="目录内容" ref={listRef}>
          <header className="lb-list-header"><div><h2>{title}</h2><span>{results.length} {searching?"条结果":taskColumns.length?"个分组":"项内容"}</span></div><div className="lb-list-view-actions">{!!taskColumns.length&&<><button className="icon-button" aria-label="任务分组列表" aria-pressed={layout!=="board"} onClick={()=>{setLayout("list");setPreview(true);}}><List size={16}/></button><button className="icon-button" aria-label="任务分组看板" aria-pressed={layout==="board"} onClick={()=>{setLayout("board");setPreview(false);setMobileDetail(false);}}><Columns3 size={16}/></button></>}<button className="icon-button" aria-label={preview?"隐藏内容预览":"显示内容预览"} aria-pressed={preview} onClick={()=>{setPreview(!preview);setMobileDetail(false);}}><PanelRight size={16}/></button></div></header>
          {!searching&&!aggregate&&<p className="lb-folder-summary">{folder?.description||"按原库中的位置浏览，打开一项查看内容。"}</p>}
          {!aggregate&&position.folder!==meta.root&&!searching&&<button className="lb-up" onClick={()=>{update({folder:folder?.parent||meta.root,selected:""});setMobileDetail(false);}}><ArrowUp size={13}/>返回上级</button>}
          {!results.length?<div className="lb-empty">{searching?<Search size={30}/>:<FolderOpen size={30}/>}<h3>{searching?"没有找到匹配内容":(aggregate?"这里还没有内容":emptyTitle)}</h3><p>{searching?"试试更短的关键词，或扩大搜索范围。":aggregate?"从内容列表收藏资料，或加入线束项目。":"当前位置已读取，当前没有内容。"}</p>{searching&&<button onClick={()=>scope==="folder"?setScope("library"):setQuery("")}>{scope==="folder"?"搜索整个库":"清除搜索"}</button>}</div>:taskColumns.length?<div className={layout==="board"?"lb-task-board":"lb-task-groups"}>{taskColumns.map(group=><section className="lb-task-group" key={group.id}><header><button onClick={()=>open(group)}>{group.title}<ChevronRight size={12}/></button><span>{childrenOf(group.id).length}</span></header>{childrenOf(group.id).map(renderItem)}{!childrenOf(group.id).length&&<p className="lb-group-empty">暂无任务</p>}</section>)}</div>:<div className="lb-items">{results.map(renderItem)}</div>}
          <div className="lb-list-hint">{aggregate?"示例资料 · 收藏与专题只改变 Hub 中的组织方式":presentation.hint}</div>
        </section>
        </>}{preview&&<section className="lb-reader" aria-label="库内容预览"><header className="lb-reader-toolbar"><button className="lb-back" onClick={()=>setMobileDetail(false)}><ArrowLeft size={15}/>返回列表</button><div className="lb-reader-trail"><FileText size={14}/><span>{selected?.title||"内容预览"}</span></div>{selected&&<button className="icon-button" aria-label="在库结构中定位当前内容" title="在库结构中定位" onClick={()=>locate(selected)}><MapPin size={16}/></button>}</header><div className="lb-reader-scroll" ref={articleRef}>{selected?<article className="lb-document" key={selected.id}>{selected.parent!==position.folder&&<button className="lb-inline-location" onClick={()=>locate(selected)}><MapPin size={12}/>{pathOf(selected)}<ArrowUpRight size={12}/></button>}{renderContent(selected)}</article>:<div className="lb-empty"><FileText size={30}/><h3>打开一项内容</h3><p>从左侧列表选择文档，在这里阅读。</p></div>}</div></section>}
      </div>
    </div>
  </div>;
}
function LinkMark(){return <span className="lb-link-mark" aria-hidden="true">[[ ]]</span>;}
