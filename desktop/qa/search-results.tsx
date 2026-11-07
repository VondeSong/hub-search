import React, { useState, useRef } from "react";
import { pageFavoriteKey } from "../src/PageFavorites";
import { createRoot } from "react-dom/client";
import { QuickSearchResultList } from "../src/QuickSearchResultList";
import { prepareQuickSearchResults, resultMatchTerms, searchResultSummary } from "../src/QuickSearchGrouping";
import { normalizeQuickSearchResults } from "../src/QuickSearchApp";
import { HighlightedText } from "../src/SearchPresentation";
import { LibraryIcon } from "../src/LibraryIcon";
import "../src/App.css";
import "../src/GroupedSearchResults.css";

import { SearchHeader } from "../src/SearchHeader";
import "../src/WorkspaceRefresh.css";
import "../src/LiquidWorkspace.css";
import "../src/SearchToolbar.css";
const rows = [
  ...[0, 1, 2].map(i => ({ id: `long${i}`, documentId: "long", provider: "craft", libraryName: "Car", title: "专业术语和专业术语缩写手册", path: "规范与标准 / 手册", snippet: `来源：用户提供的专业术语手册.docx。专业接口${i}需要逐项确认。${"根据实际项目要求检查术语、缩略语、中文含义和英文全称，确保各阶段理解一致。".repeat(12)}` })),
  { id: "a", documentId: "a", provider: "obsidian", libraryName: "Main", title: "美国赔款的历史", path: "00_Journals / 阅读资料 / 历史 / 2026 / 01 / 2026-01-31.md", snippet: "美国这个国家，历史上是非常喜欢在打赢了战争之后，向战败国支付战争赔款的。" },
  ...["以下是本项目及历史项目中发生的代表性线束相关布置问题：仪表线束与空调风门拉杆动态干涉案例。", "风险分析：通过DFMEA、历史问题、设计评审和现场经验识别潜在失效模式。制定 DVP：将要求和风险转换成试验项目、条件、验收标准。", "历史输出：根据在制造、运输或装车阶段发生的问题，确认允许偏差及验收依据。"].map((snippet, i) => ({ id: `b${i}`, documentId: "b", provider: "craft", libraryName: "Car", title: "历史案例与避坑汇总", path: "工程 / 经验", snippet })),
  { id: "c", documentId: "b", provider: "obsidian", libraryName: "笔记库", title: "历史案例与避坑汇总", path: "工程", snippet: "图纸符号库（历史遗留）与实际材料规范之间存在叫法脱节。" },
  ...["CC Switch 官方网站 - AI 编程 CLI 统一管理工具", "其他模型的编程能力比较"].map((snippet, i) => ({ id: `d${i}`, documentId: "d", provider: "craft", libraryName: "Main", title: "使用AI", path: "未分类", snippet })),
  { id: "e", documentId: "e", provider: "obsidian", libraryName: "笔记库", title: "Craft Icon Plugin", path: "工具", snippet: "调整SVG容器空间，和第三方图标容器空间不同，又会导致上下不对齐，使用AI调整，效果不理想。使用 Inkscape 进行调整，效果比较好。" },
];
function QA() {
  const searchInput = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [filters, setFilters] = useState(false);
  const [preview, setPreview] = useState(false);
  const noop = () => {};
  const [compact, setCompact] = useState(false);
  const [query, setQuery] = useState("历史"); const [index, setIndex] = useState(-1); const [narrow, setNarrow] = useState(false); const [opened, setOpened] = useState(""); const [favorites, setFavorites] = useState(new Set<string>());
  const raw = normalizeQuickSearchResults(rows.flatMap(row => {
    const fields = [row.title.includes(query) ? "title" : "", row.path.includes(query) ? "path" : "", row.snippet.includes(query) ? "body" : ""].filter(Boolean);
    return query && fields.length ? [{ ...row, modifiedAt: 1769817600, spaceId: row.libraryName, matchField: fields.join(","), matchTerms: [query] }] : [];
  }));
  const results = prepareQuickSearchResults(raw, query); const selected = results[index];
  return <div style={{ height: "100%", overflow: "auto", background: "#fff" }}>
    <div style={{ padding: 12, display: "flex", gap: 12 }}><span>界面验证 · 示例数据</span><button onClick={() => { setQuery(query === "历史" ? "使用AI" : "历史"); setIndex(-1); }}>切换搜索示例</button><button onClick={() => setNarrow(!narrow)}>窄屏</button><button onClick={() => setCompact(!compact)}>{compact ? "紧凑" : "详情"}</button><span>{opened}</span></div>
    <div className="app-shell desktop-app-shell" style={{ width: narrow ? 360 : "calc(100% - 28px)", maxWidth: 1120, height: "auto", display: "block", margin: "0 auto", border: "1px solid #e9ebef", borderRadius: 10, background: "#fff", boxShadow: "none" }} onKeyDown={e => {
      if (e.key === "ArrowDown") { e.preventDefault(); setIndex(i => Math.min(i + 1, results.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setIndex(i => Math.max(i - 1, 0)); }
    }}>
      <div style={{ padding: "16px 24px", borderBottom: "1px solid #e9ebef" }}>全部内容 / 全部资料库 <button onClick={() => setPreview(!preview)}>显示预览窗格</button></div>
      <div className={`workspace desktop-workspace ${preview && !narrow ? "with-preview" : ""}`} style={{height: 550}}>
        <div className="search-results-column">
          <SearchHeader activeFilterCount={0} activeSpaces={[]} currentSpaceName="全部资料库" filtersOpen={filters} isComposing={composing} isMobileLayout={false} mobilePreviewOpen={false} query={query} searchFocused={focused} searchHistory={[]} searchHistoryEnabled={false} searchSuggestionsEnabled={false} searchInput={searchInput} suggestions={[]} syntaxHints={[]} filterSummary="全部资料库" searching={false} selected={selected} selectedLibraryIds={null} showPreviewPane={preview} spaceMenuOpen={false} spaces={[{id:"demo"} as any]} clearSearchHistory={noop} openSelectedResult={noop} providerName={() => "Craft"} providerUnavailableLabel={() => ""} rememberQuery={noop} removeSearchHistoryItem={noop} onApplySuggestion={noop} renderLibraryIcon={() => null} setFiltersOpen={setFilters} setIsComposing={setComposing} setMobilePreviewOpen={noop} setPreviewOpen={setPreview} setQuery={setQuery} setSearchFocused={setFocused} setShowConnection={noop} setSpaceMenuOpen={noop} startWindowDrag={noop} toggleAllLibraries={noop} toggleLibrarySelection={noop} hideLibrarySwitcher hidePreviewToggle />
          <div className="results-pane"><p style={{ color: "#737982", fontSize: 12 }}>{searchResultSummary(results, query)}</p>
          <QuickSearchResultList compact={compact} query={query} results={results} selectedIndex={index} onSelectResult={setIndex} onOpenResult={r => setOpened(`打开目标：${r.id}`)} renderLibraryIcon={(r, name) => <LibraryIcon provider={r.provider} name={name} compact />} favoriteIds={favorites} onToggleFavorite={r => { const next = new Set(favorites); const key = pageFavoriteKey(r); next.has(key) ? next.delete(key) : next.add(key); setFavorites(next); }} />
          </div>
        </div>
        {preview && !narrow && <div className="pane-resizer" />}
        {preview && !narrow && <article className="preview-content" style={{ padding: 24, background: "#f7f8fa", minWidth: 0 }}><h3>{selected?.documentTitle || selected?.title || "页面预览"}</h3><p><HighlightedText text={selected?.snippet || "选择左侧结果查看正文"} terms={selected ? resultMatchTerms(selected, query) : []} /></p><small>目标：{selected?.id}</small></article>}
      </div>
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<QA />);
