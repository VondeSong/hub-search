// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuickJournal } from "./QuickJournal";
import { defaultJournalView } from "./JournalViews";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
let node: HTMLDivElement, root: Root;
const record = { version: 1, id: "a".repeat(32), date: "2026-11-07", text: "待保存 #想法", attachments: [] };
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  invoke.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === "get_quick_journal_draft") return JSON.stringify(record);
    if (cmd === "get_quick_journal_settings") return { settings: { libraryId: "os", folder: "Journals", sync: false }, mobile: false };
    if (cmd === "list_quick_journal") return { items: [{ record, body: "OS 中手动修改后的正文", applied: true, uploaded: true, path: "daily", libraryId: "os", namespace: "" }], error: "" };
    if (cmd === "capture_quick_journal") return { warning: null };
  });
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.useRealTimers(); });
const render = async (dataVersion = "1") => { await act(async () => root.render(<QuickJournal libraries={[]} scope={null} dataVersion={dataVersion} view={{ ...defaultJournalView(), period: "all", layout: "records" }} />)); };
it("restores a draft and displays each record's current Markdown without clock times", async () => {
  await render(); expect(node.querySelector("textarea")?.value).toBe(record.text);
  expect(node.querySelector("article")?.textContent).toContain("OS 中手动修改后的正文");
  expect(node.querySelector("article")?.textContent).toContain("2026-11-07");
  expect(node.querySelector("article")?.textContent).not.toMatch(/\d{2}:\d{2}/);
});
it("does not discard the draft when capture fails; retries reuse the same ID", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, args: unknown) => cmd === "capture_quick_journal" ? Promise.reject("磁盘写入失败") : original(cmd, args));
  await render();
  for (let i = 0; i < 2; i++) await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(node.querySelector("textarea")?.value).toBe(record.text);
  expect(invoke.mock.calls.filter(c => c[0] === "capture_quick_journal").map(c => c[1].record.id)).toEqual([record.id, record.id]);
  expect(node.textContent).toContain("磁盘写入失败");
});
it("clears only after durable capture and distinguishes local save from upload", async () => {
  await render();
  await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(node.querySelector("textarea")?.value).toBe("");
  expect(node.textContent).toContain("已保存到本机，可以锁屏");
  expect(invoke).toHaveBeenCalledWith("capture_quick_journal", { record });
});
const button = (text: string) => [...node.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
it("blocks manual sync with unsaved settings, then reports the saved request result", async () => {
  await render();
  const checkbox = [...node.querySelectorAll("label")].find(l => l.textContent?.includes("开启本设备速记云同步"))!.querySelector<HTMLInputElement>("input")!;
  await act(async () => checkbox.click());
  expect(node.textContent).toContain("设置尚未保存");
  await act(async () => button("同步 / 重试").click());
  expect(invoke.mock.calls.filter(c => c[0] === "sync_quick_journal")).toHaveLength(0);
  expect(node.textContent).toContain("请先点击“保存设置”");
  await act(async () => button("保存设置").click());
  expect(node.textContent).not.toContain("设置尚未保存");
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, args: unknown) => cmd === "sync_quick_journal" ? Promise.resolve({ pendingUpload: 0, awaitingOs: 1, written: 0 }) : original(cmd, args));
  await act(async () => button("同步 / 重试").click());
  expect(node.textContent).toContain("等待电脑写入 1 条");
});
it("shows a disabled gate error, exposes settings, and refreshes cards after partial failure", async () => {
  const original = invoke.getMockImplementation()!;
  let uploaded = false;
  invoke.mockImplementation((cmd: string, args: unknown) => {
    if (cmd === "sync_quick_journal") { uploaded = true; return Promise.reject("云同步总开关未开启"); }
    if (cmd === "list_quick_journal") return Promise.resolve({ items: [{ record, body: record.text, applied: false, uploaded, path: "", libraryId: "os" }], error: "" });
    return original(cmd, args);
  });
  await render(); await act(async () => button("同步 / 重试").click());
  expect(node.querySelector("[role=alert]")?.textContent).toContain("云同步总开关未开启");
  expect(node.querySelector<HTMLDetailsElement>("details")!.open).toBe(true);
  expect(node.querySelector("article")?.textContent).toContain("已上传，等待电脑写入");
});
it("previews the record date in year/month mode and preserves a legacy fixed directory", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, args: unknown) => cmd === "get_quick_journal_settings" ? Promise.resolve({ settings: { libraryId: "os", folder: "Journals", sync: false, dateFolders: true }, mobile: false }) : original(cmd, args));
  await render(); expect(node.textContent).toContain("Journals/2026/11/2026-11-07.md");
  const toggle = [...node.querySelectorAll("label")].find(l => l.textContent?.includes("按记录日期分年/月目录"))!.querySelector<HTMLInputElement>("input")!;
  await act(async () => toggle.click());
  expect(node.textContent).toContain("Journals/2026-11-07.md");
  expect(node.textContent).toContain("固定目录，跨月时不会自动切换");
});
it("keeps loaded Markdown images mounted through expansion, parent updates and polling while showing OS edits", async () => {
  vi.useFakeTimers();
  const hash = "b".repeat(64), linkedHash = "c".repeat(64);
  let body = `${"正文".repeat(180)}\n\n![照片](_hub-assets/${hash}.jpg)\n\n[![链接图片](_hub-assets/${linkedHash}.jpg)](https://example.com)`;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd: string, args: any) => {
    if (cmd === "quick_journal_image") return Promise.resolve(`data:image/jpeg;base64,${args.hash}`);
    if (cmd === "list_quick_journal") return Promise.resolve({ items: [{ record: { ...record }, body, applied: true, uploaded: true, path: "daily", libraryId: "os" }], error: "" });
    return original(cmd, args);
  });
  await render();
  const images = [...node.querySelectorAll("article img")];
  expect(images).toHaveLength(2);
  const reads = invoke.mock.calls.filter(c => c[0] === "quick_journal_image").length;
  await act(async () => button("展开全文").click());
  await render("2");
  body = body.replace("正文", "OS 中的新修改");
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  await act(async () => button("同步 / 重试").click());
  expect(node.querySelectorAll("article img")[0]).toBe(images[0]);
  expect(node.querySelectorAll("article img")[1]).toBe(images[1]);
  expect(invoke.mock.calls.filter(c => c[0] === "quick_journal_image")).toHaveLength(reads);
  expect(node.querySelector("article")?.textContent).toContain("OS 中的新修改");
  expect(button("收起").getAttribute("aria-expanded")).toBe("true");
});
