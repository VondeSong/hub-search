import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopSidebar } from '../src/DesktopSidebar';
import { GlobalExclusionReviewProvider, GlobalExclusionReviewSettings } from '../src/GlobalExclusionReviewReminder';
import { SettingsDialog } from '../src/SettingsDialog';
import { TagAssignmentExclusionReminder } from '../src/TagAssignmentExclusionReminder';
import '../src/TagAssignmentInbox.css';
(window as any).__TAURI_INTERNALS__={invoke:async()=>({count:8,hasMore:false,asOf:Math.floor(Date.now()/1000)})};
const sidebarProps = {
      activeView: "home",
      smartCollections: [],
      activeSmartCollectionId: "",
      currentSearchCanBeSaved: false,
      spaces: [{id:'main',name:'Main',provider:'obsidian',connected:true,documentCount:330,excludedPaths:[]},{id:'craft',name:'Main',provider:'craft',connected:true,documentCount:120,excludedPaths:[]}],
      selectedLibraryIds: null,
      renderLibraryIcon: () => <span>◈</span>,
      onSelectView: () => undefined,
      onToggleLibrary: () => undefined,
      onToggleAllLibraries: () => undefined,
      onManageLibraries: () => undefined,
      favoriteCount: 0,
      taskOpenCount: 0,
      journalCount: 0,
      journalDates: [],
      selectedJournalDate: "",
      onSelectJournalDate: () => undefined,
      historyCount: 0,
      flashcardDueCount: 0,
      tags: [],
      selectedTag: "",
      tagOverviewMode: "all",
      favoriteTags: [],
      recentTags: [],
      customTagGroups: [],
      tagProperties: {},
      tagsLoading: false,
      onSelectTagsOverview: () => undefined,
      onSelectCleanupTags: () => undefined,
      onSelectTag: () => undefined,
      onToggleFavoriteTag: () => undefined,
      onCreateTagGroup: () => undefined,
      onDeleteTagGroup: () => undefined,
      onAssignTagToGroup: () => undefined,
      onCreateSmartCollection: () => true,
      onApplySmartCollection: () => undefined,
      onRenameSmartCollection: () => true,
      onDeleteSmartCollection: () => undefined,
      onCollapse: () => undefined,
    };
function QA(){const [settings,setSettings]=useState(false);const [sidebar,setSidebar]=useState(true);return <GlobalExclusionReviewProvider><div className="qa-shell" style={{gridTemplateColumns:sidebar?'240px minmax(0,1fr)':'1fr'}}>{sidebar&&<DesktopSidebar {...sidebarProps} onCollapse={()=>setSidebar(false)} onManageLibraries={()=>setSettings(true)} onSelectCleanupTags={()=>document.getElementById('review')?.scrollIntoView()}/>}<main style={{padding:32}}><h2>复核提醒 · 布局预览</h2><p>示例数据，用于验证侧栏与设置布局。</p><button onClick={()=>setSettings(true)}>打开设置</button> <button onClick={()=>setSidebar(!sidebar)}>切换侧栏</button><div id="review" style={{maxWidth:420,marginTop:32}}><TagAssignmentExclusionReminder days={90} revision={0} onOpen={()=>{}}/></div></main></div>{settings&&<SettingsDialog canClose category="behavior" onCategoryChange={()=>{}} onClose={()=>setSettings(false)}><div className="background-settings settings-content-panels"><GlobalExclusionReviewSettings/></div></SettingsDialog>}</GlobalExclusionReviewProvider>};createRoot(document.getElementById('root')!).render(<QA/>);
