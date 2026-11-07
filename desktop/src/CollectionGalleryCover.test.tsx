// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionGalleryCover } from "./CollectionGalleryCover";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const video = { kind: "video", url: "telegram://7/large/original.mp4", previewUrl: "telegram://7/thumb/cover.jpg" };
const image = { source: "http://craft-media.localhost/collection/27", mediaType: "image", mimeType: "image/jpeg" };
let host: HTMLDivElement;
let root: Root;
let reveal: (entries: { isIntersecting: boolean }[]) => void;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  reveal = () => {};
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: typeof reveal) { reveal = callback; }
    observe() {}
    disconnect() {}
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); invoke.mockReset();
});
async function mount(props: Partial<Parameters<typeof CollectionGalleryCover>[0]> = {}) {
  await act(async () => root.render(<CollectionGalleryCover itemKey="telegram:7:42:9" media={video} saved={false} {...props}/>));
}
async function show() { await act(async () => reveal([{ isIntersecting: true }])); }

it("loads a proven cloud thumbnail only near the viewport and never requests the large video", async () => {
  invoke.mockResolvedValue(image);
  await mount({ cloudPreview: true });
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => reveal([{ isIntersecting: false }]));
  expect(invoke).not.toHaveBeenCalled();
  await show();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("collection_media_preview", { key: "telegram:7:42:9", url: video.previewUrl });
  expect(host.querySelector("img")?.src).toBe(image.source);
  expect(host.querySelector("video")).toBeNull();
});

it("keeps an unregistered remote preview as a placeholder", async () => {
  await mount(); await show();
  expect(invoke).not.toHaveBeenCalled();
  expect(host.querySelector("img,video")).toBeNull();
  expect(host.textContent).toContain("附件未下载");
});

it("does not use cloud-preview permission to download a primary video URL", async () => {
  await mount({ cloudPreview: true, media: { kind: "video", url: video.url } }); await show();
  expect(invoke).not.toHaveBeenCalled();
  expect(host.querySelector("img,video")).toBeNull();
});

it("supports a registered preview URL without a primary media URL", async () => {
  invoke.mockResolvedValue(image);
  await mount({ cloudPreview: true, media: { ...video, url: "" } }); await show();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("collection_media_preview", { key: "telegram:7:42:9", url: video.previewUrl });
  expect(host.querySelector("img")?.src).toBe(image.source);
});

it.each([
  { mediaType: "video", mimeType: "video/mp4" },
  { mediaType: "image", mimeType: "video/mp4" },
  { mediaType: "image", mimeType: "image/svg+xml" },
])("rejects a non-image or unsupported thumbnail result $mediaType / $mimeType", async value => {
  invoke.mockResolvedValue({ ...image, ...value });
  await mount({ cloudPreview: true }); await show();
  expect(host.querySelector("img,video")).toBeNull();
  expect(host.textContent).toContain("封面不可用");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("does not fall back to a third-party URL or automatically retry a failed cloud cover", async () => {
  invoke.mockRejectedValue("当前网络不符合阅读同步策略");
  await mount({ cloudPreview: true }); await show();
  await show(); await mount({ cloudPreview: true });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(host.querySelector("img,video")).toBeNull();
  expect(host.textContent).toContain("封面不可用");
  invoke.mockResolvedValue(image);
  await act(async () => { window.dispatchEvent(new CustomEvent("hub:reading-attachment-ready", { detail: "another-item" })); });
  await show(); expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => { window.dispatchEvent(new CustomEvent("hub:reading-attachment-ready", { detail: "telegram:7:42:9" })); });
  await show();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(host.querySelector("img")?.src).toBe(image.source);
});

it("validates local preview results too while preserving a saved primary video cover", async () => {
  invoke.mockResolvedValue({ ...image, mediaType: "video", mimeType: "video/mp4" });
  await mount({ saved: true }); await show();
  expect(host.querySelector("img,video")).toBeNull();
  await mount({ saved: true, media: { kind: "video", url: video.url } }); await show();
  expect(host.querySelector("video")?.src).toBe(image.source);
  expect(host.querySelector("video")?.autoplay).toBe(false);
  expect(host.querySelector("img")).toBeNull();
});
