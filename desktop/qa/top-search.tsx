import { useState,useRef } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceChrome } from "../src/WorkspaceChrome";
import { SearchHeader } from "../src/SearchHeader";
import { FilterBar } from "../src/FilterBar";
import { SearchFilterReveal } from "../src/SearchFilterReveal";
import { Bookmark, PanelLeftClose, PanelRight, Plus, Search } from "lucide-react";
import "../src/App.css";
import "../src/SearchToolbar.css";
import "../src/WorkspaceRefresh.css";
const noop=()=>{};
const demoSpace={id:"demo",name:"Main",provider:"craft",connected:true,documentCount:1,excludedPaths:[]} as any;
function QA(){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(""),[focused,setFocused]=useState(false);
 const [scope,setScope]=useState<"all"|"title"|"title_heading">("all"),[scopeOpen,setScopeOpen]=useState(false);
 const [folderOpen,setFolderOpen]=useState(false),[dateOpen,setDateOpen]=useState(false);
 const [date,setDate]=useState<"any"|"7"|"30"|"90">("any"),[folder,setFolder]=useState("");
 const [sources,setSources]=useState({craft:true,task:true,pdf:true,media:true,attachment:true});
 const input=useRef<HTMLInputElement>(null);
 return <main className="app-shell desktop-app-shell unified-shell mode-compact module-home" style={{display:"grid",gridTemplateColumns:"56px 240px 8px minmax(0,1fr)",gridTemplateRows:"minmax(0,1fr)"}}>
 <nav className="workspace-rail"><button aria-label="全部内容" className="active"><Search size={17}/></button></nav>
 <aside className="desktop-sidebar view-home">
   <div className="desktop-sidebar-brand"><button className="sidebar-home"><strong>全部内容</strong></button><button className="sidebar-collapse" aria-label="收起左侧边栏"><PanelLeftClose size={17}/></button></div>
   <div className="sidebar-smart-collections"><div className="sidebar-smart-heading"><span><Bookmark size={14}/><strong>智能集合</strong><small>1</small></span><button><Plus size={13}/></button></div><div className="sidebar-smart-list"><div className="sidebar-smart-row"><button className="sidebar-smart-open"><Bookmark size={14}/><span><strong>使用AI</strong><small>“使用” · 全部类型</small></span></button></div></div></div>
 </aside>
 <div className="context-sidebar-resizer" role="separator" aria-label="调整中间栏宽度" tabIndex={0}/>
 <div className="desktop-main-layout">
 <WorkspaceChrome mode="compact" onModeChange={noop} view="home" spaces={[]} selectedLibraryIds={null} onToggleLibrary={noop} onSelectAll={noop} onManage={noop}
 actions={<button aria-label="预览"><PanelRight size={17}/></button>}
 search={<SearchHeader hideLibrarySwitcher hidePreviewToggle activeFilterCount={scope==='all'?0:1} activeSpaces={[demoSpace]} currentSpaceName="全部资料库" filtersOpen={open} isComposing={false} isMobileLayout={false} mobilePreviewOpen={false} query={query} searchFocused={focused} searchHistory={[]} searchHistoryEnabled={false} searchSuggestionsEnabled={false} searchInput={input} suggestions={[]} syntaxHints={[]} filterSummary="" searching={false} selectedLibraryIds={null} showPreviewPane={false} spaceMenuOpen={false} spaces={[demoSpace]} clearSearchHistory={noop} openSelectedResult={noop} providerName={()=>"Craft"} providerUnavailableLabel={()=>""} rememberQuery={noop} removeSearchHistoryItem={noop} onApplySuggestion={noop} renderLibraryIcon={()=>null} setFiltersOpen={setOpen} setIsComposing={noop} setMobilePreviewOpen={noop} setPreviewOpen={noop} setQuery={setQuery} setSearchFocused={setFocused} setShowConnection={noop} setSpaceMenuOpen={noop} startWindowDrag={noop} toggleAllLibraries={noop} toggleLibrarySelection={noop}/>}/>
 <SearchFilterReveal open={open}><FilterBar visible={open} activeSpaces={[demoSpace]} dateFilter={date} dateMenuOpen={dateOpen} folderId={folder} folderMenuOpen={folderOpen} folders={[]} searchScope={scope} searchScopeMenuOpen={scopeOpen} selectedLibraryIds={null} sourceFilters={sources} spaces={[demoSpace]} syncing={false} refreshIndex={noop} setDateFilter={setDate} setDateMenuOpen={setDateOpen} setFolderId={setFolder} setFolderMenuOpen={setFolderOpen} setSearchScope={setScope} setSearchScopeMenuOpen={setScopeOpen} setSourceFilters={setSources} startWindowDrag={noop}/></SearchFilterReveal>
 <section className="workspace desktop-workspace"><div className="results-pane search-home-results"><div className="recent-list"><section className="recent-group"><h3 className="recent-group-label">今天</h3><div style={{padding:"5px 8px"}}>项目评审记录 — Main / 工作</div></section></div></div></section>
 </div>
 </main>;
}
createRoot(document.getElementById("root")!).render(<QA/>);
