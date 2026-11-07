import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TaskWorkspace } from "../src/TaskWorkspace";
import { DesktopAppEntry } from "../src/DesktopAppEntry";
import { WorkspaceChrome } from "../src/WorkspaceChrome";
import { WorkspaceRail } from "../src/WorkspaceRail";
import { useSidebarLayout } from "../src/useSidebarLayout";
import { SearchFilterSummary } from "../src/FilterBar";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
import "../src/LiquidWorkspace.css";
const noop = () => {};
const tasks = Array.from({length:18}, (_,i) => ({ id:String(i), provider:"craft", libraryId:i < 12 ? "car" : "main", libraryName:i < 12 ? "Car" : "Main", sourceId:String(i), parentTaskId:"", parentPageId:`doc${i % 3}`, documentId:`doc${i % 3}`, documentTitle:["T29 仪表线束评审", "线束设计标准", "项目周计划"][i % 3], title:["核对接插件定义与回路编号", "整理测试记录和校核结论", "更新项目交付清单"][i % 3] + ` · ${i+1}`, completed:i % 5 === 0, status:i % 5 === 0 ? "completed" : "open", isAllDay:true, path:"研发 / 任务", depth:0, isProject:false, linkedProviders:[], syncState:"unlinked" }));
(window as any).__TAURI_INTERNALS__ = { transformCallback:()=>1, unregisterCallback:noop, metadata:{currentWindow:{label:"main"},currentWebview:{label:"main"}}, invoke:async(command:string)=> {
  if(command === "list_unified_tasks") return { tasks,total:18,open:14,completed:4,craft:18,dida365:0,obsidian:0,linked:0,syncEnabled:false,backgroundSyncIntervalMinutes:0,lastSyncFailed:0,syncReviews:[] };
  if(command === "local_document") return "## 任务说明\n\n这是示例数据，用于验证布局。";
  return null;
}};
const spaces = [{id:"car",name:"Car",provider:"craft" as const,connected:true,documentCount:12,excludedPaths:[]},{id:"main",name:"Main",provider:"craft" as const,connected:true,documentCount:6,excludedPaths:[]}];
function QA() {
  const layout = useSidebarLayout("tasks");
  const [scope,setScope] = useState<string[]|null>(null);
  const [filter,setFilter] = useState<"any"|"7"|"30"|"90">("7");
  return <DesktopAppEntry filtersOpen={false} style={{"--interface-font-size":"14px"} as any} sidebarEnabled sidebarMode={layout.mode} workspaceView="tasks" sidebarDrawerOpen={layout.drawerOpen}>
    <WorkspaceRail activeView="tasks" spaces={spaces} selectedLibraryIds={scope} renderLibraryIcon={()=> <span>◈</span>} favoriteCount={3} taskOpenCount={14} journalCount={12} historyCount={10} tagCount={8} flashcardDueCount={0} onSelectView={noop} onSelectLibrary={id=>setScope([id])} onSelectAllLibraries={()=>setScope(null)} onManageLibraries={noop}/>
    <div className="desktop-main-layout">
      <WorkspaceChrome mode={layout.mode} onModeChange={layout.changeMode} onTogglePanel={layout.togglePanel} panelExpanded={layout.panelExpanded} view="tasks" spaces={spaces} selectedLibraryIds={scope} onToggleLibrary={id=>setScope(current=>current === null ? spaces.filter(space=>space.id !== id).map(space=>space.id) : current.includes(id) ? current.filter(value=>value!==id) : [...current,id])} onSelectAll={()=>setScope(null)} onManage={noop}/>
      <SearchFilterSummary activeSpaces={spaces} spaces={spaces} folders={[]} selectedLibraryIds={scope} dateFilter={filter} folderId="" searchScope="all" sourceFilters={{craft:true,task:true,pdf:true,media:true,attachment:true}} dateMenuOpen={false} folderMenuOpen={false} searchScopeMenuOpen={false} syncing={false} refreshIndex={noop} startWindowDrag={noop} setDateFilter={setFilter} setDateMenuOpen={noop} setFolderId={noop} setFolderMenuOpen={noop} setSearchScope={noop} setSearchScopeMenuOpen={noop} setSourceFilters={noop}/>
      <div className="main-content-override"><TaskWorkspace desktopSidebarVisible selectedLibraryIds={scope} onClearLibraryScope={()=>setScope(null)}/></div>
    </div>
  </DesktopAppEntry>;
}
createRoot(document.getElementById("root")!).render(<QA/>);
