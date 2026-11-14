// @vitest-environment jsdom
import { act, createRef, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreviewThemePicker, PREVIEW_THEME_KEY, usePreviewTheme } from "./PreviewTheme";
import { initializeUserProfileStorage, userProfileStorage } from "./UserProfileStorage";
import { PreviewPane, type PreviewPaneProps } from "./PreviewPane";
import type { SearchResult } from "./SearchTypes";

const { platform } = vi.hoisted(() => ({ platform: { platform: "windows", desktop: false } }));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: platform }));
vi.mock("./PdfPreviewPanel", () => ({ PdfPreviewPanel: () => <div>PDF 专属阅读面板</div> }));
let host: HTMLDivElement, root: Root;
function Sample() {
  const ref = useRef<HTMLDivElement>(null), preference = usePreviewTheme(ref);
  return <section className={preference.theme}><PreviewThemePicker {...preference}/><div ref={ref} className="preview-content"><div className="preview-document"><p>同一正文</p></div></div></section>;
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); platform.platform = "windows";
  await initializeUserProfileStorage();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const choose = async (label: string) => act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === label)!.click());

it("keeps current as default, saves only explicit choices, shares and restores the personal preference", async () => {
  userProfileStorage.setItem(PREVIEW_THEME_KEY, "unknown-future-theme");
  await act(async () => root.render(<><Sample/><Sample/></>));
  expect(host.querySelectorAll("section.current")).toHaveLength(2);
  expect(userProfileStorage.getItem(PREVIEW_THEME_KEY)).toBe("unknown-future-theme");
  await choose("Craft 风格");
  expect(host.querySelectorAll("section.craft")).toHaveLength(2);
  expect(userProfileStorage.getItem(PREVIEW_THEME_KEY)).toBe("craft");
  await act(async () => root.render(null));
  await act(async () => root.render(<Sample/>));
  expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Craft 风格");
  await choose("当前");
  expect(userProfileStorage.getItem(PREVIEW_THEME_KEY)).toBe("current");
});

it("preserves the current reading block when a theme changes its geometry", async () => {
  await act(async () => root.render(<Sample/>));
  const content = host.querySelector<HTMLDivElement>(".preview-content")!, paragraph = host.querySelector("p")!;
  content.scrollTop = 500;
  content.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
  paragraph.getBoundingClientRect = () => ({ top: host.querySelector("section.craft") ? 145 : 90, bottom: 200 } as DOMRect);
  await choose("Craft 风格");
  expect(content.scrollTop).toBe(555);
  expect(host.querySelector("p")).toBe(paragraph);
});

it("reports storage failures and keeps the rendered theme when a choice cannot be written", async () => {
  await act(async () => root.render(<Sample/>));
  vi.spyOn(userProfileStorage, "setItem").mockImplementation(() => { throw new Error("只读存储"); });
  await choose("Craft 风格");
  expect(host.querySelector("section.current")).toBeTruthy();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("只读存储");
});

it("scopes the theme to Markdown and preserves content nodes, matches, outline and folding", async () => {
  const selected = { id:"real-shape",provider:"craft",documentId:"doc",spaceId:"space",libraryId:"space",title:"文档",path:"文档" } as SearchResult;
  const props: PreviewPaneProps = {selected,canGoBack:false,canGoForward:false,previewPinned:false,onNavigatePreviewHistory:vi.fn(),selectedMatchTerms:[],previewMatchCount:0,previewMatchIndex:0,copiedResultId:"",spaces:[],pdfPreview:null,ocrImagePreview:null,previewLoading:false,
    renderedPreviewMarkdown:<div className="preview-document"><details open className="preview-outline"><summary>目录</summary><a href="#a">章节</a></details><h2 id="a">章节</h2><details open><summary>折叠</summary><p><mark className="active-match">命中</mark>正文</p></details></div>,onOpenLink:vi.fn(),previewCard:createRef(),startWindowDrag:vi.fn(),onCloseMobilePreview:vi.fn(),setPdfPreviewPage:vi.fn(),navigatePreviewMatch:vi.fn(),copySelectedLink:vi.fn(),openSelectedResult:vi.fn(),providerName:()=>"Craft"};
  await act(async () => root.render(<PreviewPane {...props}/>));
  const doc = host.querySelector(".preview-document"), match = host.querySelector("mark");
  await choose("Craft 风格");
  expect(host.querySelector(".preview-theme-craft")).toBeTruthy();
  expect(host.querySelector(".preview-document")).toBe(doc);
  expect(host.querySelector("mark")).toBe(match);
  expect(host.querySelectorAll("details[open]")).toHaveLength(2);
  await act(async () => root.render(<PreviewPane {...props} selected={{...selected,contentType:"pdf_page"}} previewLoading/>));
  expect(host.querySelector(".preview-theme-bar")).toBeNull(); expect(host.querySelector(".preview-theme-craft")).toBeNull();
  expect(host.textContent).toContain("PDF 专属阅读面板");
  await act(async () => root.render(<PreviewPane {...props} ocrImagePreview={{ocrText:"图片文字"}}/>));
  expect(host.querySelector(".preview-theme-bar")).toBeNull(); expect(host.querySelector(".preview-theme-craft")).toBeNull();
  platform.platform="android";
  await act(async () => root.render(<PreviewPane {...props} previewPinned/>));
  expect(host.querySelector(".preview-theme-bar")).toBeNull();
});
