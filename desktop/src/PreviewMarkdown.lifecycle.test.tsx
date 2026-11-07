// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { PreviewMarkdownMedia } from "./PreviewMarkdown";

function mediaHarness() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const originalObserver = globalThis.IntersectionObserver;
  class Observer {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) { this.callback([{ target: element, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() {}
  }
  globalThis.IntersectionObserver = Observer as unknown as typeof IntersectionObserver;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  return {
    host,
    render: async (src: string) => act(async () => root.render(<PreviewMarkdownMedia src={src} provider="craft" spaceId="library" documentId="note" />)),
    close: async () => { await act(async () => root.unmount()); host.remove(); globalThis.IntersectionObserver = originalObserver; delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; },
  };
}

it("does not issue a second image download after the image request fails", async () => {
  const harness = mediaHarness();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async command => {
    if (command === "local_markdown_resource_info") return { title: "image.png", mimeType: "image/png", resourceType: "image" };
    if (command === "local_markdown_image") throw new Error("download interrupted");
    throw new Error(command);
  });
  try {
    await harness.render("https://r.craft.do/image");
    expect(invokeMock.mock.calls.filter(call => call[0] === "local_markdown_image")).toHaveLength(1);
    expect(harness.host.textContent).toContain("download interrupted");
  } finally { await harness.close(); }
});

it("does not start fallback downloading after leaving a failed metadata request", async () => {
  const harness = mediaHarness();
  let reject!: (reason: Error) => void;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "local_markdown_resource_info" && args.source === "https://r.craft.do/old") return new Promise((_, fail) => { reject = fail; });
    if (command === "local_markdown_resource_info") return { title: "video.mp4", mimeType: "video/mp4", resourceType: "video" };
    if (command === "local_markdown_image") return { source: "data:image/png;base64,aW1hZ2U=", mimeType: "image/png", mediaType: "image" };
    throw new Error(command);
  });
  try {
    await harness.render("https://r.craft.do/old");
    await harness.render("https://r.craft.do/current-video");
    await act(async () => { reject(new Error("metadata unavailable")); await Promise.resolve(); });
    expect(invokeMock.mock.calls.filter(call => call[0] === "local_markdown_image")).toHaveLength(0);
    expect(harness.host.querySelector(".preview-video-label")?.textContent).toBe("video.mp4");
  } finally { await harness.close(); }
});

it("uses one image fallback when current resource metadata is unavailable", async () => {
  const harness = mediaHarness();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async command => {
    if (command === "local_markdown_resource_info") throw new Error("metadata unavailable");
    if (command === "local_markdown_image") return { source: "data:image/png;base64,aW1hZ2U=", mimeType: "image/png", mediaType: "image" };
    throw new Error(command);
  });
  try {
    await harness.render("https://r.craft.do/image");
    expect(invokeMock.mock.calls.filter(call => call[0] === "local_markdown_image")).toHaveLength(1);
    expect(harness.host.querySelector<HTMLImageElement>(".preview-image-zoom img")?.src).toBe("data:image/png;base64,aW1hZ2U=");
  } finally { await harness.close(); }
});

it("keeps a registered video on the play button when resource metadata fails", async () => {
  const harness = mediaHarness();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "local_markdown_resource_info") throw new Error("metadata unavailable");
    if (command === "local_markdown_image") {
      if (!args.allowVideo) throw new Error("VIDEO_REQUIRES_ACTIVATION");
      return { source: "video-local.mp4", mimeType: "video/mp4", mediaType: "video" };
    }
    throw new Error(command);
  });
  try {
    await harness.render("https://r.craft.do/video");
    expect(harness.host.querySelector("video.preview-video")).toBeNull();
    expect(harness.host.querySelector(".preview-video-poster")).not.toBeNull();
    const passive = invokeMock.mock.calls.filter(call => call[0] === "local_markdown_image");
    expect(passive).toHaveLength(1);
    expect(passive[0][1].allowVideo).not.toBe(true);
    await act(async () => harness.host.querySelector<HTMLButtonElement>(".preview-video-poster")!.click());
    const active = invokeMock.mock.calls.filter(call => call[0] === "local_markdown_image");
    expect(active).toHaveLength(2);
    expect(active[1][1].allowVideo).toBe(true);
    expect(harness.host.querySelector("video.preview-video")).not.toBeNull();
  } finally { await harness.close(); }
});

it("ignores a video activation that arrives after changing the resource", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const originalObserver = globalThis.IntersectionObserver;
  class Observer {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) { this.callback([{ target: element, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() {}
  }
  globalThis.IntersectionObserver = Observer as unknown as typeof IntersectionObserver;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let finish!: (value: unknown) => void;
  invokeMock.mockReset(); invokeMock.mockImplementation(async (command, args) => {
    if (command === "local_markdown_resource_info") return { title: args.source, mimeType: "video/mp4", resourceType: "video" };
    if (command === "local_markdown_image") return new Promise(resolve => { finish = resolve; });
    throw new Error(command);
  });
  const render = async (src: string) => act(async () => root.render(<PreviewMarkdownMedia src={src} provider="obsidian" spaceId="library" documentId="note" />));
  try {
    await render("A.mp4");
    await act(async () => host.querySelector<HTMLButtonElement>(".preview-video-poster")!.click());
    await render("B.mp4");
    await act(async () => { finish({ source: "A-local.mp4", mimeType: "video/mp4", mediaType: "video" }); await Promise.resolve(); });
    expect(host.querySelector("video.preview-video")).toBeNull();
    expect(host.querySelector(".preview-video-label")?.textContent).toBe("B.mp4");
  } finally { await act(async () => root.unmount()); host.remove(); globalThis.IntersectionObserver = originalObserver; delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; }
});
