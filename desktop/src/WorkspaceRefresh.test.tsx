// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { journalDateLabel } from "./SearchWorkspacePresentation";
import { formatDate, formatSemanticDate, recentDateGroup } from "./SearchResultPresentation";
const { recentResultListRender } = vi.hoisted(() => ({ recentResultListRender: vi.fn() }));
vi.mock("./TagPropertiesCard", () => ({ TagPropertiesCard: () => <header>标签属性</header> }));
vi.mock("./TagGovernanceInbox", () => ({ TagGovernanceInbox: () => <div>关系建议</div> }));
vi.mock("./TagAssignmentInbox", () => ({ TagAssignmentInbox: () => { const [value,setValue] = useState(""); return <input aria-label="定义草稿" value={value} onChange={e => setValue(e.target.value)} />; } }));
vi.mock("./RecentResultList", () => ({ RecentResultList: (props: unknown) => { recentResultListRender(props); return <div>笔记列表</div>; } }));
import { SearchResultsPane } from "./SearchResultsPane";
import { normalizeQuickSearchResults } from "./SearchResultTestData";
const noop=()=>{};

it("toggles detail and compact search modes and remembers the selection", async () => {
  localStorage.removeItem("hub.results.compact");
  const node = document.createElement("div"); let root = createRoot(node);
  const results = normalizeQuickSearchResults([{ id: "hit", spaceId: "main", title: "页面", snippet: "历史正文", matchField: "body", matchTerms: ["历史"] }]);
  const props = { resultLabel: "搜索结果", error: "", searching: false, query: "历史", results, recentGroups: [], selectedIndex: -1, isMobileLayout: false, semanticRecentDates: false,
    onHoverResult: noop, onSelectResult: noop, onOpenResult: noop, onPrepareResultLink: noop, onDragResult: noop, onCopyResultLink: noop, onCopyResultMarkdown: noop, onCopyResultTitle: noop, onCopyResultSummary: noop, onRevealResult: noop, canRevealResult: () => false, renderLibraryIcon: () => null };
  try {
    await act(async () => root.render(<SearchResultsPane {...props} />));
    expect(node.querySelector(".result-density")?.textContent).toBe("详情");
    expect(node.querySelector(".grouped-page-summary")).not.toBeNull();
    await act(async () => node.querySelector<HTMLButtonElement>(".result-density")!.click());
    expect(node.querySelector(".result-density")?.textContent).toBe("紧凑");
    expect(node.querySelector(".grouped-page-summary")).toBeNull();
    expect(localStorage.getItem("hub.results.compact")).toBe("true");
    await act(async () => root.unmount()); root = createRoot(node);
    await act(async () => root.render(<SearchResultsPane {...props} />));
    expect(node.querySelector(".result-density")?.textContent).toBe("紧凑");
    await act(async () => node.querySelector<HTMLButtonElement>(".result-density")!.click());
    expect(node.querySelector(".grouped-page-summary")).not.toBeNull();
  } finally { await act(async () => root.unmount()); localStorage.removeItem("hub.results.compact"); }
});
afterEach(()=>{ document.body.innerHTML=""; });
it("preserves an unsaved definition while switching between content and management", async()=>{
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  const changed=vi.fn();
  const props:any={resultLabel:"内容",error:"",searching:false,query:"",results:[],recentGroups:[],selectedIndex:0,isMobileLayout:false,semanticRecentDates:false,collectionView:"tags",selectedCollectionTag:{name:"成果",normalizedName:"成果",count:1},onHoverResult:noop,onSelectResult:noop,onOpenResult:noop,onPrepareResultLink:noop,onDragResult:noop,onCopyResultLink:noop,onCopyResultMarkdown:noop,onCopyResultTitle:noop,onCopyResultSummary:noop,onRevealResult:noop,canRevealResult:()=>false,renderLibraryIcon:noop,onTagTabChange:changed};
  await act(async()=>root.render(<SearchResultsPane {...props}/>));
  const buttons=container.querySelectorAll<HTMLButtonElement>('.tag-workspace-tabs button');
  const input=container.querySelector<HTMLInputElement>('input')!;
  expect(input.closest('[hidden]')).not.toBeNull();
  await act(async()=>buttons[1].click());
  expect(input.closest('[hidden]')).toBeNull();
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'保留我的定义');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>buttons[2].click());
  await act(async()=>buttons[1].click());
  expect(container.querySelector('input')).toBe(input);
  expect(input.value).toBe('保留我的定义');
  await act(async()=>buttons[0].click());
  expect(changed).toHaveBeenLastCalledWith(false);
  await act(async()=>root.unmount());
});
it("renders unknown dates safely instead of crashing the list",()=>{
  expect(journalDateLabel("")).toBe("日期待核对");
  expect(journalDateLabel("2026-02-31")).toBe("日期待核对");
  expect(formatDate(Infinity)).toBe("");
  expect(formatSemanticDate(NaN)).toBe("");
  expect(recentDateGroup(Infinity).key).toBe("unknown");
});
it("marks the empty-query content view as the search landing surface", async()=>{
  const container=document.createElement("div");document.body.appendChild(container);const root=createRoot(container);
  const hoverResult=vi.fn();
  const props:any={resultLabel:"",error:"",searching:false,query:"",results:[],recentGroups:[],selectedIndex:0,isMobileLayout:false,semanticRecentDates:true,onHoverResult:hoverResult,onSelectResult:noop,onOpenResult:noop,onPrepareResultLink:noop,onDragResult:noop,onCopyResultLink:noop,onCopyResultMarkdown:noop,onCopyResultTitle:noop,onCopyResultSummary:noop,onRevealResult:noop,canRevealResult:()=>false,renderLibraryIcon:noop};
  await act(async()=>root.render(<SearchResultsPane {...props}/>));
  expect(container.querySelector(".results-pane")?.classList.contains("search-home-results")).toBe(true);
  expect(container.querySelector(".results-pane")?.classList.contains("empty-results")).toBe(true);
  recentResultListRender.mock.calls[recentResultListRender.mock.calls.length - 1]?.[0].onHoverResult(0);
  expect(hoverResult).not.toHaveBeenCalled();
  await act(async()=>root.render(<SearchResultsPane {...props} query="线束"/>));
  expect(container.querySelector(".results-pane")?.classList.contains("search-home-results")).toBe(false);
  expect(container.querySelector(".results-pane")?.classList.contains("empty-results")).toBe(true);
  for (const collectionView of ["journals", "favorites", "history"] as const) {
    await act(async()=>root.render(<SearchResultsPane {...props} query="" collectionView={collectionView}/>));
    expect(container.querySelector(".results-pane")?.classList.contains("collection-list-results")).toBe(true);
    recentResultListRender.mock.calls[recentResultListRender.mock.calls.length - 1]?.[0].onHoverResult(0);
    expect(hoverResult).not.toHaveBeenCalled();
  }
  await act(async()=>root.render(<SearchResultsPane {...props} query="" collectionView="tags"/>));
  expect(container.querySelector(".results-pane")?.classList.contains("collection-list-results")).toBe(false);
  await act(async()=>root.unmount());
});
