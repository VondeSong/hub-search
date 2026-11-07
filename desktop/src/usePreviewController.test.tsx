// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { clearOperationStatus, useOperationStatus } from "./useOperationStatus";
import { usePreviewController } from "./usePreviewController";
import type { SearchResult } from "./SearchTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const selected: SearchResult = {
  id: "result-1", entityKey: "craft:page:block", documentId: "document-1", blockId: "block-1",
  contentType: "craft_subpage", sourceType: "craft_page", provider: "craft", libraryId: "main",
  libraryName: "Main", spaceId: "space-1", spaceName: "Main", title: "Hub #项目",
  path: "AI/使用AI/Hub #项目", snippet: "内容", matchTerms: [], matchField: "body",
  matchCount: 0, subMatches: [],
};

let root: Root;
let container: HTMLDivElement;
let api: ReturnType<typeof usePreviewController>;
function Probe({ initialSearchError = "" }: { initialSearchError?: string }) {
  const [searchError, setSearchError] = useState(initialSearchError);
  const { operationStatus, showOperationStatus } = useOperationStatus();
  const options = {
    selected, results: [selected], selectedIndex: 0, selectedMatchTerms: [], showPreviewPane: false,
    setError: setSearchError,
    showOperationStatus,
  };
  api = usePreviewController(options);
  return <>
    <main>{searchError && <div role="alert">{searchError}</div>}<p>{selected.title}</p></main>
    <footer data-tone={operationStatus?.tone}>{operationStatus?.text}</footer>
    <button onClick={() => void api.copySelectedLink()}>复制链接</button>
  </>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
  clearOperationStatus();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); clearOperationStatus(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  ["", "Hub #项目"],
  ["搜索读取失败", "搜索读取失败Hub #项目"],
])("puts a link resolution failure in the footer while retaining search content (%s)", async (initialSearchError, expectedMain) => {
  vi.mocked(invoke).mockRejectedValue("无法生成结果链接");
  await act(async () => root.render(<Probe initialSearchError={initialSearchError} />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("main")?.textContent).toBe(expectedMain);
  expect(container.querySelector("footer")?.textContent).toBe("复制链接失败：无法生成结果链接");
  expect(container.querySelector("footer")?.getAttribute("data-tone")).toBe("error");
  expect(api.copiedResultId).toBe("");
});

it("puts clipboard rejection in the footer without replacing an existing search error", async () => {
  vi.mocked(invoke).mockResolvedValue("https://docs.craft.do/editor/d/space/document");
  vi.mocked(navigator.clipboard.writeText).mockRejectedValue("剪贴板不可用");
  await act(async () => root.render(<Probe initialSearchError="搜索读取失败" />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("main [role=alert]")?.textContent).toBe("搜索读取失败");
  expect(container.querySelector("footer")?.textContent).toBe("复制链接失败：剪贴板不可用");
  expect(api.copiedResultId).toBe("");
});

it("retains successful copy feedback and clears the copied indicator", async () => {
  const link = "https://docs.craft.do/editor/d/space/document";
  vi.mocked(invoke).mockResolvedValue(link);
  await act(async () => root.render(<Probe />));
  await act(async () => container.querySelector("button")!.click());
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(link);
  expect(container.querySelector("footer")?.textContent).toBe("已复制结果链接 · Hub #项目");
  expect(api.copiedResultId).toBe(selected.id);
  await act(async () => vi.advanceTimersByTime(1800));
  expect(api.copiedResultId).toBe("");
});

function MediaProbe({ result }: { result: SearchResult }) {
  api = usePreviewController({ selected: result, results: [result], selectedIndex: 0,
    selectedMatchTerms: [], showPreviewPane: true, showOperationStatus: vi.fn() });
  return <p>{api.previewLoading ? "loading" : api.ocrImagePreview?.ocrText || api.pdfPreview?.text || api.preview}</p>;
}
const media = (id: string, type: string): SearchResult => ({ ...selected, id,
  blockId: undefined, entityKey: "same-parent", sourceItemId: id, contentType: type, pageNumber: 1 });

it("clears the previous attachment kind before loading another attachment on the same page", async () => {
  let finishPdf!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "local_ocr_image_preview") return Promise.resolve({ ocrText: "image limit 12 mm" }) as never;
    if (command === "local_pdf_page_preview") return new Promise(resolve => { finishPdf = resolve; }) as never;
    if (command === "local_document") return Promise.resolve("parent note") as never;
    throw new Error(`Unexpected command ${command}`);
  });
  await act(async () => root.render(<MediaProbe result={media("image", "image_ocr")} />));
  expect(container.textContent).toBe("image limit 12 mm");
  await act(async () => root.render(<MediaProbe result={media("pdf", "pdf_ocr")} />));
  expect(container.textContent).toBe("loading");
  expect(api.ocrImagePreview).toBeNull();
  await act(async () => finishPdf({ text: "PDF limit 5 bar", pageNumber: 1, pageCount: 1, sourceType: "pdf_ocr" }));
  expect(container.textContent).toBe("PDF limit 5 bar");
  await act(async () => root.render(<MediaProbe result={{ ...media("note", "markdown"), sourceItemId: undefined }} />));
  expect(container.textContent).toBe("parent note");
  expect(api.ocrImagePreview).toBeNull(); expect(api.pdfPreview).toBeNull();
});

it("does not let a late image response replace another attachment on the same page", async () => {
  let finishOld!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation((_command, args) => args?.resultId === "old-image"
    ? new Promise(resolve => { finishOld = resolve; }) as never
    : Promise.resolve({ ocrText: "current image" }) as never);
  await act(async () => root.render(<MediaProbe result={media("old-image", "image_ocr")} />));
  await act(async () => root.render(<MediaProbe result={media("new-image", "image_ocr")} />));
  expect(container.textContent).toBe("current image");
  await act(async () => finishOld({ ocrText: "stale image" }));
  expect(container.textContent).toBe("current image");
});
