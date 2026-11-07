import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchResultsPane } from "../src/SearchResultsPane";
import { normalizeQuickSearchResults } from "../src/QuickSearchApp";
import { pageFavoriteKey, snippetFavoriteKey, togglePageFavorite, toggleSnippetFavorite } from "../src/PageFavorites";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
const noop = () => {};
const sample = normalizeQuickSearchResults([{ id:"hit1", documentId:"doc", spaceId:"main", libraryName:"Main", title:"设计评审记录", snippet:"历史问题需要结合设计边界、验证条件和验收依据一起确认。", matchField:"body", matchTerms:["历史"], path:"项目 / 设计评审记录" }]);
function QA() {
  const [saved, setSaved] = useState(togglePageFavorite([], sample[0]));
  const [view, setView] = useState(false);
  const [filter, setFilter] = useState<"all"|"page"|"snippet">("all");
  const [index, setIndex] = useState(-1);
  const items = view ? saved.filter(r => filter === "all" || r.favoriteKind === filter) : sample;
  return <main style={{maxWidth:900, margin:"30px auto"}}><button onClick={() => {setView(!view); setIndex(-1);}}>{view ? "搜索示例" : "查看收藏"}</button><div className="desktop-workspace" style={{display:"block"}}><SearchResultsPane
    resultLabel={`${items.length} 条`} query={view ? "" : "历史"} collectionView={view ? "favorites" : undefined}
    error="" searching={false} results={items} recentGroups={[{key:"saved",label:"",entries:items.map((result,index)=>({result,index}))}]}
    selectedIndex={index} isMobileLayout={false} semanticRecentDates={false} onSelectResult={setIndex} onHoverResult={noop}
    onOpenResult={noop} onPrepareResultLink={noop} onDragResult={noop} onCopyResultLink={noop} onCopyResultMarkdown={noop}
    onCopyResultTitle={noop} onCopyResultSummary={noop} onRevealResult={noop} canRevealResult={()=>false} renderLibraryIcon={()=> <span>◇</span>}
    favoriteFilter={filter} onFavoriteFilterChange={setFilter}
    favoriteIds={new Set(saved.filter(r=>r.favoriteKind!=="snippet").map(pageFavoriteKey))}
    snippetFavoriteIds={new Set(saved.filter(r=>r.favoriteKind==="snippet").map(snippetFavoriteKey))}
    onToggleFavorite={r=>setSaved(current=>r.favoriteKind==="snippet" ? toggleSnippetFavorite(current,r) : togglePageFavorite(current,r))}
    onToggleSnippetFavorite={r=>setSaved(current=>toggleSnippetFavorite(current,r))}
  /></div></main>;
}
createRoot(document.getElementById("root")!).render(<QA/>);
