import { useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { CalendarDays, BookOpen, X } from "lucide-react";
import { JournalNavigator } from "../src/JournalNavigator";
import { SearchResultsPane } from "../src/SearchResultsPane";
import { deriveSearchWorkspaceResults } from "../src/SearchWorkspacePresentation";
import { journalEntryTitle } from "../src/JournalPresentation";
import type { SearchResult } from "../src/SearchTypes";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
import "../src/InterfaceSelection.css";
import "../src/LiquidWorkspace.css";
import "../src/DisplayPreferences.css";
import "../src/JournalWorkspace.css";

const noop = () => {};
const fixtures = [
  ["2026-10-07", "Private", "把生活中值得留下的片刻，认真记录下来。"],
  ["2026-10-07", "Car", "仪表线束方案复盘：整理接口与下一轮验证要点。"],
  ["2026-10-07", "Archive", "2026.10.07 <page>阅读笔记：[简洁设计的秩序](https://example.com)</page>"],
  ["2026-10-06", "Car", "整理视频记录，补充结构设计中的关键细节。"],
  ["2026-10-06", "Archive", "少一些干扰，多一些清晰。今天的设计观察。"],
  ["2026-09-27", "LifeOS", "你的心没有改变的时候，一切都没有用。当你的心改变的时候，你身边的一切开始不同。"],
  ["2026-09-27", "Car", "电瓶线束正极桩头紧固力矩衰减：问题记录与验证。"],
  ["2026-09-25", "Archive", "周五回顾：把零散想法整理成可以继续使用的知识。"],
  ["2026-08-30", "Archive", "交互设计参考与收藏。"],
];
const entries: SearchResult[] = fixtures.map(([date, library, snippet], index) => ({
  id: String(index), entityKey: String(index), documentId: String(index), title: date.replaceAll("-", "."), snippet,
  libraryId: library, libraryName: library, spaceId: library, spaceName: library, path: "日常记录",
  provider: "craft", contentType: "document", sourceType: "craft_page", matchField: "", matchTerms: [], matchCount: 0, subMatches: [],
}));
const availableDates = [...new Set(fixtures.map(item => item[0]))].map(date => ({ date, sources: fixtures.filter(item => item[0] === date).length }));
function Preview() {
  const [date, setDate] = useState("");
  const [selection, setSelection] = useState(-1);
  const [preview, setPreview] = useState<SearchResult | null>(null);
  const [draftDate, setDraftDate] = useState("");
  const presentation = deriveSearchWorkspaceResults({ desktopSidebarEnabled: true, isMobileLayout: false, query: "", view: "journals", results: [], journalResults: entries, favoriteResults: [], historyResults: [], tagResults: [], selectedLibraryIdSet: null, selectedJournalDate: date, dateFilter: "any", groupRecentByDateWhenUnlimited: true });
  return <div className="app-shell desktop-app-shell journal-qa" style={{ "--result-font-size": "14px", "--list-title-weight": "500", height: "100dvh", width: "100%", maxWidth: "none", display: "grid", gridTemplateColumns: "260px minmax(0, 1fr)", border: 0, borderRadius: 0, margin: 0, overflow: "hidden", fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' } as CSSProperties}>
    <style>{`.journal-qa { grid-template-rows: minmax(0, 1fr); } .journal-qa .desktop-workspace > .results-pane { flex: 1; width: auto; max-width: none; } .journal-qa .desktop-workspace { margin-bottom: 0; } @media(max-width:900px) { .journal-qa { grid-template-columns: 200px minmax(0,1fr) !important; } } @media(max-width:600px) { .journal-qa { display:block !important; overflow:auto !important; } .journal-qa > aside { height:auto !important; } .journal-qa .sidebar-journal-navigation { width:100%; max-width:320px; align-self:center; } .journal-qa > aside > p { margin:0; text-align:center; } .journal-qa > main { min-height:720px; } }`}</style>
    <aside className="desktop-sidebar view-journals" style={{ display: "flex", minWidth: 0, height: "100%", padding: "18px 14px", gap: 16 }}>
      <div style={{display:"flex", alignItems:"center",gap:10,padding:"9px 8px 12px",color:"#313945",fontSize:15,fontWeight:600}}><CalendarDays size={19}/>日志</div>
      <section className="sidebar-journal-navigation"><JournalNavigator availableDates={availableDates} selectedDate={date} onSelectDate={value => { setDate(value); setSelection(-1); setPreview(null); setDraftDate(""); }} /></section>
      <p style={{fontSize:11,color:"#626b77",lineHeight:1.8,padding:"0 8px"}}>交互预览 · 示例内容<br/>可以选日期、切换年月和查看日志。</p>
    </aside>
    <main style={{display:"flex",flexDirection:"column",minWidth:0,minHeight:0,background:"#fff"}}>
      <div style={{height:56,flexShrink:0,display:"flex",alignItems:"center",gap:8,padding:"0 32px",borderBottom:"1px solid #edf0f3",color:"#626b77",fontSize:12}}><BookOpen size={16}/>全部资料库<span style={{marginLeft:"auto"}}>Hub · 日志</span></div>
      <div className="desktop-workspace" style={{display:"flex",flex:1,minHeight:0,overflow:"hidden"}}>
        <SearchResultsPane resultLabel="日志" query="" collectionView="journals" error="" searching={false} results={presentation.visibleResults} recentGroups={presentation.groups}
          selectedIndex={selection} isMobileLayout={false} semanticRecentDates={false} onSelectResult={index => {setSelection(index);setPreview(presentation.visibleResults[index]);}} onHoverResult={noop}
          onOpenResult={setPreview} onPrepareResultLink={noop} onDragResult={noop} onCopyResultLink={noop} onCopyResultMarkdown={noop} onCopyResultTitle={noop} onCopyResultSummary={noop} onRevealResult={noop} canRevealResult={()=>false}
          selectedJournalDate={date} onClearJournalDate={()=>setDate("")} onCreateJournal={date.length===10 ? ()=>setDraftDate(date) : undefined}
          renderLibraryIcon={result=><span className="library-icon" style={{display:"grid",placeItems:"center",background:result.libraryName==="Car"?"#ecf2fd":result.libraryName==="Private"?"#f5effb":"#eaf2ee",color:"#42566e",fontSize:12,fontWeight:600}}>{result.libraryName.slice(0,1)}</span>}/>
        {(preview || draftDate) && <aside style={{flex:"0 0 36%",minWidth:220,padding:24,borderLeft:"1px solid #e8ebef",overflow:"auto"}}>
          <button aria-label="关闭预览" style={{float:"right"}} onClick={()=>{setPreview(null);setDraftDate("");}}><X size={16}/></button>
          <p style={{color:"#626b77",fontSize:12}}>{preview?.title || draftDate}</p><h2 style={{fontSize:20}}>{preview ? journalEntryTitle(preview) : "新建日志"}</h2>
          <p style={{color:"#626b77",lineHeight:1.8,fontSize:13}}>{preview ? `${preview.libraryName} · 示例内容预览` : "此预览使用示例内容。正式应用会打开现有的资料库选择与创建对话框。"}</p>
        </aside>}
      </div>
    </main>
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview/>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
