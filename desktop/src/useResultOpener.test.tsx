// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { clearOperationStatus, useOperationStatus } from "./useOperationStatus";
import { useResultOpener } from "./useResultOpener";
import type { SearchResult } from "./SearchTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: { platform: "windows" } }));

const result: SearchResult = {
  id: "result-1", entityKey: "craft:page:block", documentId: "document-1", blockId: "block-1",
  contentType: "craft_subpage", sourceType: "craft_page", provider: "craft", libraryId: "main",
  libraryName: "Main", spaceId: "space-1", spaceName: "Main", title: "Hub #项目",
  path: "AI/使用AI/Hub #项目", snippet: "内容", matchTerms: ["Hub"], matchField: "body",
  matchCount: 1, subMatches: [],
};

let root: Root;
let container: HTMLDivElement;

function Probe({ hideAfterOpen = false, initialSearchError = "" }: { hideAfterOpen?: boolean; initialSearchError?: string }) {
  const [searchError, setSearchError] = useState(initialSearchError);
  const { operationStatus, showOperationStatus } = useOperationStatus();
  // Retain the previous caller's setter in this fixture to catch an opening
  // failure being routed into the search result area again.
  const options = {
    settings: { craftResultOpenMode: "client" as const, craftPreviewOpenMode: "bridge" as const, hideAfterOpen },
    setError: setSearchError,
    showOperationStatus,
  };
  const open = useResultOpener(options);
  return <>
    <main data-search-results>{searchError && <div role="alert">{searchError}</div>}<p>Hub #项目</p></main>
    <button onClick={() => open(result, "preview")}>打开来源</button>
    <footer data-operation-status data-tone={operationStatus?.tone}>{operationStatus?.text}</footer>
  </>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
  clearOperationStatus();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); clearOperationStatus(); });
  container.remove();
  vi.useRealTimers();
});

async function openPreview(props: Parameters<typeof Probe>[0] = {}) {
  await act(async () => root.render(<Probe {...props} />));
  await act(async () => container.querySelector("button")!.click());
}

it("reports an opening failure in the footer and leaves search results intact", async () => {
  vi.mocked(invoke).mockRejectedValue("CraftBridge 返回了未知的打开状态");
  await openPreview();
  expect(container.querySelector("main")?.textContent).toBe("Hub #项目");
  expect(container.querySelector("main [role=alert]")).toBeNull();
  expect(container.querySelector("footer")?.textContent).toBe("打开失败 · CraftBridge 返回了未知的打开状态");
  expect(container.querySelector("footer")?.getAttribute("data-tone")).toBe("error");
  await act(async () => vi.advanceTimersByTime(6000));
  expect(container.querySelector("footer")?.textContent).toBe("");
});

it("keeps an existing search failure separate from an opening failure", async () => {
  vi.mocked(invoke).mockRejectedValue("CraftBridge 服务不可用");
  await openPreview({ initialSearchError: "搜索读取失败" });
  expect(container.querySelector("main [role=alert]")?.textContent).toBe("搜索读取失败");
  expect(container.querySelector("footer")?.textContent).toBe("打开失败 · CraftBridge 服务不可用");
});

it("shows an accepted queued request as waiting and keeps the Hub window visible", async () => {
  vi.mocked(invoke).mockResolvedValue({ craftBridgeAction: "queued" });
  await openPreview({ hideAfterOpen: true });
  expect(container.querySelector("footer")?.textContent).toBe("Craft 正在准备页面，已排队等待打开 · Hub #项目");
  expect(container.querySelector("footer")?.getAttribute("data-tone")).toBe("working");
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["open_result"]);
  expect(container.querySelector("main [role=alert]")).toBeNull();
});

it.each([
  ["activated", "已切换到 Craft"],
  ["updated", "已在 Craft 中定位"],
  ["opened", "已在 Craft 中打开"],
])("retains confirmed %s feedback and the configured window action", async (action, message) => {
  vi.mocked(invoke).mockResolvedValueOnce({ craftBridgeAction: action }).mockResolvedValueOnce(undefined);
  await openPreview({ hideAfterOpen: true });
  expect(container.querySelector("footer")?.textContent).toBe(`${message} · Hub #项目`);
  expect(container.querySelector("footer")?.getAttribute("data-tone")).toBe("success");
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["open_result", "hide_window"]);
});

it("reports a window hiding failure only in the footer after a successful opening", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ craftBridgeAction: "opened" }).mockRejectedValueOnce("窗口不可用");
  await openPreview({ hideAfterOpen: true });
  expect(container.querySelector("footer")?.textContent).toBe("结果已打开，但隐藏窗口失败 · 窗口不可用");
  expect(container.querySelector("footer")?.getAttribute("data-tone")).toBe("error");
  expect(container.querySelector("main [role=alert]")).toBeNull();
});

it.each([false, true])("keeps an open assistant visible after opening a source (collapsed: %s)",async hidden=>{
  vi.mocked(invoke).mockResolvedValue({craftBridgeAction:"opened"});
  await act(async()=>root.render(<Probe hideAfterOpen/>));
  const panel=document.createElement("aside");panel.className="agent-panel";panel.hidden=hidden;container.append(panel);
  await act(async()=>container.querySelector("button")!.click());
  expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(hidden?["open_result","hide_window"]:["open_result"]);
});
