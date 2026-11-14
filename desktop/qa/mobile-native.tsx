import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
import "../src/InterfaceSelection.css";
import "../src/LiquidWorkspace.css";
import "../src/DisplayPreferences.css";
import "../src/MobileExperience.css";
import "../src/MobileDesign.css";
import "../src/MobileGlass.css";
import "../src/MobileNavigationDesign.css";
import "../src/JournalDatabase.css";
import "../src/MobilePrototype.css";
import { MobileAppEntry } from "../src/MobileAppEntry";
import { MobileHeader } from "../src/MobileHeader";
import { MobileBrowse, MobileNavigation, type MobileDestination } from "../src/MobileNavigation";
import { MobileQuickCapture } from "../src/MobileQuickCapture";
import CloudAgents from "../src/CloudAgents";
import { QuickJournal } from "../src/QuickJournal";
import { OPEN_QUICK_JOURNAL } from "../src/QuickJournalEvents";
import { defaultJournalView, type JournalViewConfig } from "../src/JournalViews";
import { MobileAppearanceSettings } from "../src/MobileAppearance";
import { initializeUserProfileStorage } from "../src/UserProfileStorage";
import { runtimeCapabilities } from "../src/RuntimePlatform";
import { MobileSearchControls, MobileSearchFilterForm } from "../src/MobileSearchControls";
import { MobileFilterSheet } from "../src/MobileFilterSheet";
import type { FilterBar } from "../src/FilterBar";
import { SearchHeader } from "../src/SearchHeader";
Object.assign(runtimeCapabilities,{platform:"android",mobile:true,desktop:false});
document.documentElement.dataset.runtimePlatform="android";
// Test-only native adapter: no accounts, real files or cloud calls; unknown IPC fails.
let draft="";
const items:any[]=[{record:{version:1,id:"b".repeat(32),date:"2026-11-12",text:"今天路上想到，先把想法记下来，整理可以晚一点。 #灵感",attachments:[]},body:"今天路上想到，先把想法记下来，整理可以晚一点。 #灵感",uploaded:true,applied:false,libraryId:"",path:""},{record:{version:1,id:"c".repeat(32),date:"2026-11-11",text:"把产品做得简单一点，留下真正需要的入口。 #设计",attachments:[]},body:"把产品做得简单一点，留下真正需要的入口。 #设计",uploaded:true,applied:true,libraryId:"os",path:"daily"}];
Object.assign(window,{__TAURI_INTERNALS__:{async invoke(cmd:string,args:any){
 if(cmd==="cloud_agents"&&args.action.op==="config")return null;
 if(cmd==="load_user_profile")return{contextId:"fixture",initialized:true,values:{}};
 if(cmd==="save_user_profile_changes")return;
 if(cmd==="get_quick_journal_draft")return draft;
 if(cmd==="save_quick_journal_draft"){draft=args.draft;return;}
 if(cmd==="get_quick_journal_settings")return{settings:{libraryId:"",folder:"Journals",sync:true,dateFolders:true},mobile:true,cloudEnabled:true,autoSync:true};
 if(cmd==="save_quick_journal_settings")return{};
 if(cmd==="list_quick_journal")return{items,error:""};
 if(cmd==="capture_quick_journal"){items.unshift({record:args.record,body:args.record.text,uploaded:false,applied:false,path:"",libraryId:""});return{warning:null};}
 if(cmd==="sync_quick_journal")return{pendingUpload:items.filter(i=>!i.uploaded).length,awaitingOs:1,written:1};
 throw new Error(`隔离示例不支持 IPC: ${cmd}`);
},convertFileSrc:(p:string)=>p,transformCallback:()=>0,unregisterCallback:()=>{}}});
await initializeUserProfileStorage();
const noop=()=>{};
function Fixture(){
 const[route,setRoute]=useState("browse"),[capture,setCapture]=useState(false),[settings,setSettings]=useState(false),[view,setView]=useState<JournalViewConfig>({...defaultJournalView(),layout:"records",period:"all",ascending:false}),[query,setQuery]=useState(""),[focused,setFocused]=useState(false);
 const search=useRef<HTMLInputElement>(null);
 const [filtersOpen,setFiltersOpen]=useState(false),[date,setDate]=useState<"any"|"7"|"30"|"90">("any"),[scope,setScope]=useState<"all"|"title"|"title_heading">("all"),[folder,setFolder]=useState(""),[libraries,setLibraries]=useState<string[]|null>(null),[sources,setSources]=useState({craft:true,task:true,pdf:true,media:true,attachment:true});
 const spaces=[{id:"os",name:"OS · 隔离资料",provider:"obsidian" as const,connected:true,documentCount:2,excludedPaths:[]}];
 const filters:React.ComponentProps<typeof FilterBar>={activeSpaces:libraries===null?spaces:spaces.filter(s=>libraries.includes(s.id)),spaces,dateFilter:date,dateMenuOpen:false,folderId:folder,folderMenuOpen:false,folders:[],searchScope:scope,searchScopeMenuOpen:false,selectedLibraryIds:libraries,sourceFilters:sources,syncing:false,refreshIndex:noop,setDateFilter:setDate,setDateMenuOpen:noop,setFolderId:setFolder,setFolderMenuOpen:noop,setSearchScope:setScope,setSearchScopeMenuOpen:noop,setSourceFilters:setSources,startWindowDrag:noop};
 useEffect(()=>{const open=()=>setCapture(true);window.addEventListener(OPEN_QUICK_JOURNAL,open);return()=>window.removeEventListener(OPEN_QUICK_JOURNAL,open);},[]);
 const active=(route==="journals"?"browse":route)as MobileDestination;
 return <MobileAppEntry filtersOpen={filtersOpen} previewOpen={false} style={{"--interface-font-size":"14px"}as React.CSSProperties}>
  <div className="mobile-top-area" hidden={route==="agents"}><MobileHeader onBack={route==="journals"?()=>setRoute("browse"):undefined} onSettings={()=>setSettings(true)}/>{route==="search"&&<><div className="mobile-page-intro"><h1>搜索</h1><p>找回已索引的资料与任务。</p></div><SearchHeader activeFilterCount={Object.values(sources).every(Boolean)?0:1} activeSpaces={[]} currentSpaceName="全部资料" filtersOpen={filtersOpen} isComposing={false} isMobileLayout mobilePreviewOpen={false} query={query} searchFocused={focused} searchHistory={[]} searchHistoryEnabled={false} searchSuggestionsEnabled={false} searchInput={search} suggestions={[]} syntaxHints={[]} filterSummary="全部资料" searching={false} selectedLibraryIds={null} showPreviewPane={false} spaceMenuOpen={false} spaces={spaces} clearSearchHistory={noop} openSelectedResult={noop} providerName={()=>""} providerUnavailableLabel={()=>""} rememberQuery={noop} removeSearchHistoryItem={noop} onApplySuggestion={noop} renderLibraryIcon={()=>null} setFiltersOpen={setFiltersOpen} setIsComposing={noop} setMobilePreviewOpen={noop} setPreviewOpen={noop} setQuery={setQuery} setSearchFocused={setFocused} setShowConnection={setSettings} setSpaceMenuOpen={noop} startWindowDrag={noop} toggleAllLibraries={noop} toggleLibrarySelection={noop} hideLibrarySwitcher/><MobileSearchControls filters={filters} onSelectLibraries={setLibraries}/></>}</div>
  <div className="main-content-override">{settings?<section style={{padding:20,overflowY:"auto",height:"100%"}}><button onClick={()=>setSettings(false)}>返回</button><h1>设置 · 隔离示例</h1><MobileAppearanceSettings/><QuickJournal libraries={[]} scope={null} view={view} dataVersion="settings" mode="settings"/></section>:route==="agents"?<CloudAgents onClose={()=>setRoute("browse")}/>:route==="journals"?<div className="journal-db" style={{height:"100%",overflowY:"auto"}}><QuickJournal libraries={[]} scope={null} view={view} dataVersion="fixture" mode="feed" onViewChange={change=>setView(v=>({...v,...change}))} onSyncSettings={()=>setSettings(true)}/></div>:route==="browse"?<MobileBrowse favoriteCount={4} historyCount={12} journalCount={items.length} tagCount={6} onOpen={key=>setRoute(key)} onOpenInsights={()=>setRoute("insights")} onOpenLibraries={()=>setSettings(true)} onOpenSettings={()=>setSettings(true)} onOpenSyncHealth={()=>setSettings(true)} syncNeedsAttention={false}/>:<section style={{padding:20}}><h1>{route==="search"?"搜索":route==="tasks"?"任务":"复习"}</h1><p>此验收页仅模拟数据；APK 使用真实原生资料。</p></section>}</div>
  <footer className="mobile-navigation-footer"><MobileNavigation active={active} onSelect={key=>{setSettings(false);setRoute(key);}} dueCount={3}/></footer>
  <MobileFilterSheet open={filtersOpen} onClose={()=>setFiltersOpen(false)} draft>{filtersOpen&&<MobileSearchFilterForm filters={filters} onSelectLibraries={setLibraries} onApply={()=>setFiltersOpen(false)}/>}</MobileFilterSheet>
  {capture&&<MobileQuickCapture onClose={()=>setCapture(false)} onSaved={record=>{setView(v=>({...v,period:"day",day:record.date,query:""}));setCapture(false);setRoute("journals");}} onSyncSettings={()=>{setCapture(false);setSettings(true);}}/>}
 </MobileAppEntry>;
}
const root=createRoot(document.getElementById("root")!);
root.render(<Fixture/>);
if(import.meta.hot)import.meta.hot.dispose(()=>root.unmount());
