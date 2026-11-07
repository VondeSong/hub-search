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
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
const render = async () => { await act(async () => root.render(<QuickJournal libraries={[]} scope={null} dataVersion="1" view={{ ...defaultJournalView(), period: "all", layout: "records" }} />)); };
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
