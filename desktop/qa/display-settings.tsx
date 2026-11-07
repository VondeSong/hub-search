import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { appShellStyle, DEFAULT_APP_SETTINGS } from "../src/AppSettings";
import { DisplaySettingsSection } from "../src/DisplaySettingsSection";
import { RecentResultList } from "../src/RecentResultList";
import { QuickSearchResultList } from "../src/QuickSearchResultList";
import { normalizeQuickSearchResults } from "../src/QuickSearchApp";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
import "../src/LiquidWorkspace.css";
import "../src/DisplayPreferences.css";
const noop = () => {};
const results = normalizeQuickSearchResults([{id:"demo",spaceId:"main",libraryName:"Main",provider:"craft",title:"专业接口检查",path:"工程 / 项目 / 专业接口",snippet:"专业接口需要逐项确认，检查各阶段的设计要求和交付资料。",modifiedAt:Date.now()/1000,matchField:"title,body",matchTerms:["专业"]}]);
function Demo(){
 const [settings,setSettings]=useState({...DEFAULT_APP_SETTINGS}); const [sidebar,setSidebar]=useState(true);
 return <main className="app-shell desktop-app-shell" style={{...appShellStyle(settings),display:"block",height:"100vh",width:"100%",margin:0,overflow:"auto",padding:20}}>
 <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)",gap:24}}>
 <div><DisplaySettingsSection appSettings={settings} saveSettings={setSettings} desktopSidebarEnabled={sidebar} changeDesktopSidebarSetting={setSidebar} changeRecentGroupingSetting={value=>setSettings({...settings,groupRecentByDateWhenUnlimited:value})}/></div>
 <section className="desktop-workspace"><header className="workspace-chrome">全部资料库</header><div className="search-header"><input placeholder="搜索全部资料库…"/></div>
 <div className="search-home-results"><RecentResultList recentGroups={[{key:"today",label:settings.groupRecentByDateWhenUnlimited?"今天":"",entries:[{result:results[0],index:0}]}]} selectedIndex={-1} isMobileLayout={false} semanticRecentDates={settings.semanticRecentDates} onHoverResult={noop} onSelectResult={noop} onOpenResult={noop} onContextResult={noop} onPrepareResultLink={noop} onDragResult={noop} renderLibraryIcon={()=>null} onToggleFavorite={noop}/></div>
 <QuickSearchResultList query="专业" results={results} selectedIndex={-1} renderLibraryIcon={()=>null} onSelectResult={noop} onOpenResult={noop}/>
 <header className="preview-heading"><h1>专业接口检查</h1></header><article className="preview-content"><h2>正文标题</h2><p>预览正文按设置缩放，页面标题独立调整。</p></article>
 </section></div></main>
} createRoot(document.getElementById("root")!).render(<Demo/>);
