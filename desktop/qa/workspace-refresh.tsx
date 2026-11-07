import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopSidebar } from '../src/DesktopSidebar';
import { DesktopWorkspace } from '../src/Workspace';
import { PreviewRenderer } from '../src/PreviewRenderer';
import { FlashcardsWorkspace } from '../src/FlashcardsWorkspace';
import { WorkspaceRail } from '../src/WorkspaceRail';
import { WorkspaceChrome } from '../src/WorkspaceChrome';
import { useSidebarLayout } from '../src/useSidebarLayout';
import '../src/LiquidWorkspace.css';
const noop=()=>{};
const libraries=[{libraryId:'main',name:'Main',provider:'obsidian'}];
const sampleCards = ['typed_answer', 'qa', 'ordering'].map((cardType, i) => ({
  id: 'qa-card-' + i, deckId: 'harness', question: ['填写项目代号', '先确认需求，再开始设计', '请排列工作步骤'][i],
  answer: i === 2 ? '需求\n设计\n验证' : 'T29', explanation: '仅用于界面验证的示例卡片', cardType,
  cardData: i === 2 ? { items: ['需求','设计','验证'] } : {}, sourceLibraryId: '', sourceDocumentId: '', sourceBlockId: '',
  sourceTitle: '', sourcePath: '', sourceHash: '', media: [], tags: [], evidence: '', customFields: {}, generation: {},
  createdAt: 1, updatedAt: 1, dueAt: 1, intervalDays: 0, ease: 2.5, repetitions: 0, lapses: 0, sourceChanged: false,
}));
(window as any).__TAURI_INTERNALS__={invoke:async(command:string,payload:any={})=>{
const args=payload.args??{};
if(command==='list_tag_governance_proposals')return {proposals:[],total:0,nextCursor:null};
if(command==='get_tag_taxonomy_health')return null;
if(command==='list_tag_taxonomy_repairs')return {repairs:[],total:0};
if(args.action==='definition')return {definition:{version:2,definition:{description:'记录目标达成与取得的具体成果。',include:'已经完成目标，并提供事件或结果依据。',exclude:'只有愿望或计划，尚无实际成果。',libraryIds:['main']}},draft:null,libraries};
if(args.action==='definition_models')return {models:[{id:'gpt-6-astra',name:'GPT-6 Astra',reasoningLevels:['low','medium','high','xhigh','ultra'],defaultReasoning:'medium'}]};
if(args.action==='list')return {proposals:[],nextCursor:null};
if(args.action==='discovery_status')return null;
if(args.action==='exclusion_review_due')return {count:0,hasMore:false};
if(args.action==='scan_status')return {run:null,budgetHistory:[]};
if(command==='get_flashcard_dashboard_stats')return {dueCards:30,totalCards:330,totalReviews:21,reviewedToday:0,retentionRate:0,newCards:300,learningCards:30,masteredCards:0,ratingCounts:[0,21,0,0],dailyActivity:[]};
if(command==='list_flashcard_deck_folders')return [{id:'vehicle',name:'整车研发',sortOrder:0,updatedAt:1}];
if(command==='list_flashcard_sync_history')return [];
if(command==='list_flashcard_decks')return [
  {id:'harness',name:'T29仪表线束',folderId:'vehicle',sortOrder:0,cardCount:62,dueCount:12,newCount:8,updatedAt:1},
  {id:'market',name:'T29仪表线束市场问题',folderId:'vehicle',sortOrder:1,cardCount:83,dueCount:7,newCount:4,updatedAt:1},
  {id:'standard',name:'线束设计标准',folderId:'',sortOrder:2,cardCount:185,dueCount:11,newCount:20,updatedAt:1},
];
if(command==='list_flashcards_page'){const items=sampleCards.filter(card => (!payload.deckId || card.deckId === payload.deckId) && (!payload.dueOnly || card.dueAt <= (payload.asOf??Date.now()/1000)));return {items:items.slice(payload.offset,payload.offset+payload.limit),total:items.length,revision:'sample',asOf:payload.asOf??Math.floor(Date.now()/1000)};}
if(command==='get_flashcards_by_ids')return sampleCards.filter(card=>payload.cardIds.includes(card.id));
if(command==='review_flashcard'){ const card=sampleCards.find(c=>c.id===payload.cardId); if(card){card.repetitions++;card.dueAt=Math.floor(Date.now()/1000)+86400;} return null; }
if(command==='get_flashcard_sync_status')return {};
if(command==='list_flashcard_drafts')return [];
return {items:[],run:null,budgetHistory:[]};}};
const entries=Array.from({length:10},(_,i)=>({id:String(i),entityKey:String(i),documentId:String(i),contentType:'obsidian_page',sourceType:'obsidian_page',provider:'obsidian',libraryId:'main',libraryName:'Main',spaceId:'main',spaceName:'Main',title:i===0?'项目完成后的总结：从目标到实际成果的完整记录':'如何将计划变成可验证的成果 · '+i,path:'Main/项目/总结',modifiedAt:1788000000,snippet:'记录任务完成的过程与结果。',matchTerms:[],matchField:'title',matchCount:0,subMatches:[]}));
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
function QA(){const [mode,setMode]=useState('tag'); const layout=useSidebarLayout(mode === 'flashcards' ? 'flashcards' : mode === 'tag' ? 'tags' : 'home'); const sidebarMode=layout.mode;const [index,setIndex]=useState(-1);const [selectedLibraryIds,setSelectedLibraryIds]=useState<string[] | null>(null);const ref=useRef(null);const preview=useRef(null);const selected=mode==='empty'?undefined:entries[Math.max(index,0)];
return <div className={`qa-shell desktop-app-shell sidebar-enabled unified-shell mode-${sidebarMode} module-${mode === "flashcards" ? "flashcards" : "home"} ${layout.drawerOpen ? "module-drawer-open" : ""}`}><WorkspaceRail activeView={mode === 'tag'?'tags':mode === 'flashcards'?'flashcards':mode === 'empty'?'favorites':'home'} spaces={sidebarProps.spaces as any} selectedLibraryIds={selectedLibraryIds} renderLibraryIcon={sidebarProps.renderLibraryIcon} favoriteCount={3} taskOpenCount={12} journalCount={326} historyCount={100} tagCount={353} flashcardDueCount={745} onSelectView={v=>setMode(v === 'tags'?'tag':v === 'flashcards'?'flashcards':v==='favorites'?'empty':'list')} onSelectAllLibraries={()=>setSelectedLibraryIds(null)} onSelectLibrary={id=>setSelectedLibraryIds([id])} onManageLibraries={noop}/><DesktopSidebar {...sidebarProps} selectedLibraryIds={selectedLibraryIds} onToggleLibrary={id=>setSelectedLibraryIds([id])} onToggleAllLibraries={()=>setSelectedLibraryIds(null)} activeView={mode === 'tag'?'tags':mode === 'flashcards'?'flashcards':mode === 'empty'?'favorites':'home'} onSelectView={v=>setMode(v === 'tags'?'tag':v === 'flashcards'?'flashcards':v==='favorites'?'empty':'list')} tags={[{name:'成就与成功',normalizedName:'成就与成功',count:10}]} selectedTag="成就与成功" /><div className="qa-main desktop-main-layout"><WorkspaceChrome mode={sidebarMode} onModeChange={layout.changeMode} onTogglePanel={layout.togglePanel} panelExpanded={layout.panelExpanded} view={mode === "flashcards" ? "flashcards" : "home"} spaces={sidebarProps.spaces as any} selectedLibraryIds={selectedLibraryIds} onToggleLibrary={id=>setSelectedLibraryIds([id])} onSelectAll={()=>setSelectedLibraryIds(null)} onManage={noop}/><nav className="qa-nav">{[['tag','标签'],['list','内容'],['list-preview','内容+预览'],['empty','收藏空状态'],['flashcards','闪卡']].map(([id,label])=><button key={id} onClick={()=>setMode(id)}>{label}</button>)}</nav>{mode==='flashcards'?<div className="main-content-override"><FlashcardsWorkspace onClose={noop}/></div>:<DesktopWorkspace workspaceRef={ref} showPreviewPane={mode === 'list-preview' && !!selected} resultsPanePercent={52} onResizePreviewPanes={noop} onResetPreviewSplit={noop} resultsPaneProps={{navigationContext:mode,contextReady:true,onRestoreSelection:setIndex,resultLabel:'内容 · '+(mode==='empty'?0:10),scopeLabel:mode==='list'||mode==='list-preview'?undefined:'Main · Obsidian',onClearScope:noop,error:'',searching:false,query:'',results:mode==='empty'?[]:entries,recentGroups:mode==='empty'?[]:[{key:'month',label:'2026 年 8 月',entries:entries.map((result,index)=>({result,index}))}],selectedIndex:index,showSelection:mode!=='list',compact:mode==='list'||mode==='list-preview',isMobileLayout:false,semanticRecentDates:false,onHoverResult:noop,onSelectResult:setIndex,onOpenResult:noop,onPrepareResultLink:noop,onDragResult:noop,onCopyResultLink:noop,onCopyResultMarkdown:noop,onCopyResultTitle:noop,onCopyResultSummary:noop,onRevealResult:noop,canRevealResult:()=>false,renderLibraryIcon:()=> <span>◈</span>,collectionView:mode==='tag'?'tags':mode==='empty'?'favorites':undefined,selectedCollectionTag:mode==='tag'?{name:'成就与成功',normalizedName:'成就与成功',count:10}:undefined,selectedTagLibraryCount:1}} previewPaneProps={{selected,canGoBack:false,canGoForward:false,previewPinned:false,onNavigatePreviewHistory:noop,onTogglePreviewPinned:noop,selectedMatchTerms:[],previewMatchCount:0,previewMatchIndex:0,copiedResultId:'',spaces:[{id:'main',connected:true}],pdfPreview:null,ocrImagePreview:null,previewLoading:false,renderedPreviewMarkdown:selected?<PreviewRenderer selected={selected} markdown={'---\nauthor: 示例作者\nproject: 年度项目\n---\n\n## 项目总结\n\n这是布局验证使用的示例内容。正文优先显示，文档属性可以按需展开。\n\n我们完成了项目目标，并记录了具体成果。'} matchTerms={[]} onOpenLink={noop}/>:null,previewCard:preview,startWindowDrag:noop,onCloseMobilePreview:noop,setPdfPreviewPage:noop,navigatePreviewMatch:noop,copySelectedLink:noop,openSelectedResult:noop,providerName:()=> 'Obsidian'}}/>}</div></div>}
createRoot(document.getElementById('root')!).render(<QA/>);
