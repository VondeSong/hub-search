// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, openUrl } = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn() }));
const { platform } = vi.hoisted(() => ({ platform: { platform: "windows" } }));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: platform }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { useExternalLinkOpener } from "./useExternalLinkOpener";
import { clearOperationStatus, useOperationStatus } from "./useOperationStatus";

type OpenExternalLink = ReturnType<typeof useExternalLinkOpener>;

function Harness({ capture, showStatus, setError }: {
  capture: (openLink: OpenExternalLink) => void;
  showStatus: (text: string, tone?: "working" | "success" | "error", duration?: number) => void;
  setError?: (message: string) => void;
}) {
  const openLink = useExternalLinkOpener({ showStatus, setError });
  useEffect(() => capture(openLink), [capture, openLink]);
  return null;
}

const containers: HTMLElement[] = [];

afterEach(() => {
  clearOperationStatus();
  containers.splice(0).forEach((container) => container.remove());
  openUrl.mockReset();
  invoke.mockReset();
  platform.platform = "windows";
});

describe("useExternalLinkOpener", () => {
  it("opens Android Craft links in the external browser without the desktop bridge", async () => {
    platform.platform = "android";
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    let openLink!: OpenExternalLink;
    invoke.mockResolvedValue(undefined);
    await act(async () => root.render(<Harness capture={(value) => { openLink = value; }} showStatus={vi.fn()} setError={vi.fn()} />));
    await act(async () => { expect(await openLink("https://docs.craft.do/editor/d/space/document#block")).toBe(true); });
    expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "https://docs.craft.do/editor/d/space/document#block" });
    expect(openUrl).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
  it("shows immediate handoff feedback and suppresses a duplicate click", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const showStatus = vi.fn<(text: string, tone?: "working" | "success" | "error", duration?: number) => void>();
    const setError = vi.fn<(message: string) => void>();
    let resolveOpen!: () => void;
    openUrl.mockReturnValue(new Promise<void>((resolve) => { resolveOpen = resolve; }));
    let openLink!: OpenExternalLink;

    await act(async () => root.render(
      <Harness capture={(value) => { openLink = value; }} showStatus={showStatus} setError={setError} />,
    ));

    let firstOpen!: Promise<boolean>;
    await act(async () => {
      firstOpen = openLink("https://example.com/article");
      await Promise.resolve();
    });
    expect(showStatus).toHaveBeenCalledWith(
      "正在交给浏览器打开 · example.com",
      "working",
      8_000,
    );
    expect(await openLink("https://example.com/article")).toBe(false);
    expect(openUrl).toHaveBeenCalledTimes(1);

    resolveOpen();
    await act(async () => { expect(await firstOpen).toBe(true); });
    expect(showStatus).toHaveBeenLastCalledWith(
      expect.stringContaining("已交给浏览器打开 · example.com"),
      "success",
      4_200,
    );
    expect(setError).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("routes official Craft HTTPS links through the Rust CraftBridge command", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const showStatus = vi.fn<(text: string, tone?: "working" | "success" | "error", duration?: number) => void>();
    let openLink!: OpenExternalLink;
    invoke.mockResolvedValue({ craftBridgeAction: "updated" });

    await act(async () => root.render(
      <Harness capture={(value) => { openLink = value; }} showStatus={showStatus} setError={vi.fn()} />,
    ));
    await act(async () => { expect(await openLink("https://docs.craft.do/editor/d/space/document#block")).toBe(true); });

    expect(invoke).toHaveBeenCalledWith("open_craft_url", {
      url: "https://docs.craft.do/editor/d/space/document#block",
    });
    expect(openUrl).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenLastCalledWith("已在 Craft 中定位 · Craft 网页链接", "success", 4_200);
    await act(async () => root.unmount());
  });

  it("keeps queued Craft links as a waiting notice instead of claiming they are open", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const showStatus = vi.fn();
    const setError = vi.fn();
    let openLink!: OpenExternalLink;
    invoke.mockResolvedValue({ craftBridgeAction: "queued" });

    await act(async () => root.render(<Harness capture={(value) => { openLink = value; }} showStatus={showStatus} setError={setError} />));
    await act(async () => { expect(await openLink("https://docs.craft.do/editor/d/space/document")).toBe(true); });
    expect(showStatus).toHaveBeenLastCalledWith("Craft 正在准备页面，已排队等待打开 · Craft 网页链接", "working", 15_000);
    expect(setError).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it.each([
    ["https://example.com/article", "打开失败 · 系统无法打开链接"],
    ["https://docs.craft.do/editor/d/space/document", "打开失败 · 系统无法打开链接"],
    ["javascript:alert(1)", "无法打开：仅支持 HTTPS、HTTP、Obsidian 或 Craft 链接"],
  ])("reports %s failures in the search footer without replacing the search error", async (href, expected) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    let openLink!: OpenExternalLink;
    function SearchHarness() {
      const { operationStatus, showOperationStatus } = useOperationStatus();
      openLink = useExternalLinkOpener({ showStatus: showOperationStatus });
      return <><main role="alert">搜索读取失败</main><footer data-tone={operationStatus?.tone}>{operationStatus?.text}</footer></>;
    }
    openUrl.mockRejectedValue("系统无法打开链接");
    invoke.mockRejectedValue("系统无法打开链接");

    await act(async () => root.render(<SearchHarness />));
    await act(async () => { expect(await openLink(href)).toBe(false); });
    expect(container.querySelector("main")?.textContent).toBe("搜索读取失败");
    expect(container.querySelector("footer")?.textContent).toBe(expected);
    expect(container.querySelector("footer")?.getAttribute("data-tone")).toBe("error");
    await act(async () => root.unmount());
  });

  it("retains explicit error callbacks for other workspaces", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    let openLink!: OpenExternalLink;
    const setError = vi.fn();
    const showStatus = vi.fn();
    openUrl.mockRejectedValue("系统无法打开链接");

    await act(async () => root.render(<Harness capture={(value) => { openLink = value; }} showStatus={showStatus} setError={setError} />));
    await act(async () => { expect(await openLink("https://example.com")).toBe(false); });
    expect(setError).toHaveBeenCalledWith("打开失败 · 系统无法打开链接");
    expect(showStatus).toHaveBeenLastCalledWith("打开失败 · 系统无法打开链接", "error", 6_000);
    await act(async () => root.unmount());
  });
});
