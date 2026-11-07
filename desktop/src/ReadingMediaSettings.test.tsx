// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { ReadingMediaSettings, type ReadingMediaPolicy } from "./ReadingMediaSettings";
import { ReadingAttachments } from "./ReadingAttachments";
import { ReadingCacheSettings } from "./ReadingCacheSettings";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let root: Root, host: HTMLDivElement;
const policy: ReadingMediaPolicy = { enabled: false, download: "onDemand", imageMb: 10, documentMb: 20, batchMb: 64, dailyMb: 256, cacheMb: 512 };
const cache = { bytes: 1048576, pinnedBytes: 0, removableBytes: 1048576, removableCount: 1, otherCount: 0, pins: [], token: "snapshot" };
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (name: string) => [...host.querySelectorAll("button")].find(b => b.textContent === name)!;
it("keeps attachments opt-in and saves the exact edited policy separately", async () => {
  invoke.mockImplementation(async (command, args) => command === "get_reading_cache_status" ? cache : command === "get_reading_media_policy" ? { policy, reservedBytes: 0, day: "" } : args.settings);
  await act(async () => root.render(<ReadingMediaSettings blocked={false} />));
  const input = host.querySelector<HTMLInputElement>('[aria-label="同步阅读附件"]')!; expect(input.checked).toBe(false);
  expect(host.querySelector<HTMLInputElement>('[aria-label="单张图片上限"]')!.disabled).toBe(true);
  await act(async () => input.click()); await act(async () => button("保存阅读附件策略").click());
  expect(invoke).toHaveBeenCalledWith("update_reading_media_policy", { settings: { ...policy, enabled: true } });
  expect(host.textContent).toContain("策略已保存");expect(invoke.mock.calls.some(([c]) => c === "update_cloud_sync_policy")).toBe(false);
});
it("keeps failed edits available for retry and honors the master pause", async () => {
  invoke.mockImplementation(async command => { if (command === "get_reading_cache_status") return cache; if (command === "get_reading_media_policy") return { policy, reservedBytes: 0, day: "" }; throw "无法保存附件策略"; });
  await act(async () => root.render(<ReadingMediaSettings blocked={false} />));
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="同步阅读附件"]')!.click());
  await act(async () => button("保存阅读附件策略").click());expect(host.querySelector('[role="alert"]')?.textContent).toBe("无法保存附件策略");expect(button("保存阅读附件策略").disabled).toBe(false);
  await act(async () => root.render(<ReadingMediaSettings blocked />));expect(button("保存阅读附件策略").disabled).toBe(true);
});
it("shows skipped and missing attachments without claiming recovery and downloads a ready cloud copy", async () => {
  let downloaded = false; const changed = vi.fn(); window.addEventListener("hub:reading-attachment-ready", changed);
  invoke.mockImplementation(async command => {
    if (command === "transfer_reading_attachment") { downloaded = true; return "完成"; }
    return [{ url: "https://test.invalid/file.pdf", local: downloaded, canUpload: false, state: "ready", size: 1024, error: "" }, { url: "https://test.invalid/movie.mp4", local: true, canUpload: true, state: "skipped", error: "" }];
  });
  await act(async () => root.render(<ReadingAttachments itemKey="article" />));
  expect(host.textContent).toContain("策略已跳过");expect(host.textContent).toContain("不代表已完整保存");
  await act(async () => button("下载附件").click());
  expect(invoke).toHaveBeenCalledWith("transfer_reading_attachment", { key: "article", url: "https://test.invalid/file.pdf", upload: false });
  expect(changed).toHaveBeenCalledTimes(1);expect(host.textContent).toContain("本机可用");window.removeEventListener("hub:reading-attachment-ready", changed);
});
it("surfaces quota failures and never announces a successful download", async () => {
  invoke.mockImplementation(async command => { if (command === "transfer_reading_attachment") throw "今日附件额度不足";return [{url:"https://test.invalid/file.pdf",local:false,canUpload:false,state:"ready",error:""}]; });
  const changed=vi.fn();window.addEventListener("hub:reading-attachment-ready",changed);
  await act(async()=>root.render(<ReadingAttachments itemKey="article"/>));await act(async()=>button("下载附件").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("额度不足");expect(changed).not.toHaveBeenCalled();window.removeEventListener("hub:reading-attachment-ready",changed);
});
it("previews exact cleanup before committing and works while cloud sync is paused", async () => {
  invoke.mockImplementation(async command => command === "get_reading_media_policy" ? { policy, reservedBytes: 0, day: "" } : command === "clean_reading_cache" ? { removed: 1, removedBytes: 1048576, failures: [], status: { ...cache, bytes: 0, removableCount: 0 } } : cache);
  await act(async () => root.render(<ReadingMediaSettings blocked />));
  await act(async () => button("预览可清理缓存").click());
  expect(invoke.mock.calls.some(([c]) => c === "clean_reading_cache")).toBe(false);
  expect(host.textContent).toContain("将清理 1 个文件");
  await act(async () => button("确认清理本机缓存").click());
  expect(invoke).toHaveBeenCalledWith("clean_reading_cache", { token: "snapshot" });
  expect(host.textContent).toContain("已清理 1 个缓存文件");
});
it("requires a fresh cleanup preview after a stale snapshot is rejected", async () => {
  invoke.mockImplementation(async command => { if (command === "clean_reading_cache") throw "离线保留状态已变化，请重新预览"; return cache; });
  await act(async () => root.render(<ReadingCacheSettings />));
  await act(async () => button("预览可清理缓存").click());
  await act(async () => button("确认清理本机缓存").click());
  expect(host.textContent).toContain("请重新预览"); expect(button("确认清理本机缓存")).toBeUndefined();
  expect(host.textContent).not.toContain("已清理");
});
it("only announces offline preservation after the backend succeeds", async () => {
  let pinned = false; const changed = vi.fn(); window.addEventListener("hub:reading-attachment-ready", changed);
  invoke.mockImplementation(async command => {
    if (command === "pin_reading_attachment") { pinned = true; return null; }
    if (command === "unpin_reading_attachment") { pinned = false; return null; }
    return [{url:"https://test.invalid/file.pdf",local:pinned,canUpload:false,state:"ready",canPin:true,pinned,hash:"file-hash",error:""}];
  });
  await act(async () => root.render(<ReadingAttachments itemKey="article" />));
  await act(async () => button("下载并离线保留").click());
  expect(invoke).toHaveBeenCalledWith("pin_reading_attachment", {key:"article",url:"https://test.invalid/file.pdf"});
  expect(host.textContent).toContain("已离线保留"); expect(changed).toHaveBeenCalledTimes(1);
  await act(async () => button("取消离线保留").click());
  expect(invoke).toHaveBeenCalledWith("unpin_reading_attachment", {hash:"file-hash"});
  expect(host.textContent).not.toContain("已离线保留"); window.removeEventListener("hub:reading-attachment-ready", changed);
});
it("keeps failed offline requests retryable without displaying a preserved state", async () => {
  const changed=vi.fn();window.addEventListener("hub:reading-attachment-ready",changed);
  invoke.mockImplementation(async command => { if(command==="pin_reading_attachment") throw "今日附件额度不足"; return [{url:"https://test.invalid/file.pdf",local:false,canUpload:false,state:"ready",canPin:true,pinned:false,hash:"file-hash",error:""}]; });
  await act(async()=>root.render(<ReadingAttachments itemKey="article"/>));
  await act(async()=>button("下载并离线保留").click());
  expect(host.textContent).toContain("今日附件额度不足");expect(host.textContent).not.toContain("已离线保留");expect(changed).not.toHaveBeenCalled();
  expect(button("下载并离线保留").disabled).toBe(false);window.removeEventListener("hub:reading-attachment-ready",changed);
});

it("shows measured payload separately from legacy reservations without changing limits", async () => {
  invoke.mockImplementation(async command => command === "get_reading_cache_status" ? cache : {policy, reservedBytes:104857600,day:"2026-10-09",uploadedBytes:1048576,downloadedBytes:2097152,attachmentDownloadedBytes:1048576,metadataDownloadedBytes:1048576,legacyReservedBytes:101711872});
  await act(async()=>root.render(<ReadingMediaSettings blocked={false}/>));
  expect(host.querySelector('[aria-label="今日云端传输用量"]')?.textContent).toContain("今日上传 1.00 MB · 下载 2.00 MB");
  expect(host.textContent).toContain("旧版预留占用 97.00 MB");
  expect(host.textContent).toContain("不是阿里云账单");
  expect(host.textContent).toContain("本机检查与缓存读取不计入");
  expect(invoke.mock.calls.some(([c])=>c==="update_reading_media_policy")).toBe(false);
});
