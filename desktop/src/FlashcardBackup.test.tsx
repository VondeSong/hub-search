// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke, open, save } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open, save }));
import { FlashcardBackup } from "./FlashcardBackup";

const backup = { path: "local/backup.hubfc", checksum: "verified", createdAt: 1000, cards: 3, reviews: 7, attachments: 2, profiles: 1, externalLinks: 0, bytes: 12345 };
let root: Root; let container: HTMLDivElement;
const restored = vi.fn(async () => {});
async function settle() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === text);
  expect(button).toBeTruthy(); await act(async () => button!.click()); await settle();
}
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.documentElement.dataset.runtimePlatform = "windows";
  invoke.mockReset(); open.mockReset(); save.mockReset(); restored.mockClear();
  invoke.mockImplementation(async (name: string) => name === "list_flashcard_backups" ? { items: [], issues: [] } : backup);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<FlashcardBackup disabled={false} onRestored={restored} />)); await settle();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("exports a complete backup through the system save dialog", async () => {
  save.mockResolvedValue("chosen.hubfc"); await click("备份到文件");
  expect(invoke).toHaveBeenCalledWith("create_flashcard_backup", { operationId: expect.any(String) });
  expect(invoke).toHaveBeenCalledWith("save_flashcard_backup", { path: backup.path, destination: "chosen.hubfc", operationId: expect.any(String) });
  expect(container.textContent).toContain("完整备份已导出并通过校验");
});
it("cancelled export retains the local backup and never writes a destination", async () => {
  save.mockResolvedValue(null); await click("备份到文件");
  expect(invoke.mock.calls.some(([name]) => name === "save_flashcard_backup")).toBe(false);
  expect(container.textContent).toContain("备份已保存在本机");
});
it("requires a checked preview and explicit confirmation before merging and refreshing", async () => {
  open.mockResolvedValue("chosen.hubfc"); await click("从文件恢复");
  expect(invoke).toHaveBeenCalledWith("inspect_flashcard_backup", { path: "chosen.hubfc", operationId: expect.any(String) });
  expect(invoke.mock.calls.some(([name]) => name === "restore_flashcard_backup")).toBe(false);
  expect(container.textContent).toContain("不会回退到旧时间点");
  await click("确认恢复");
  expect(invoke).toHaveBeenCalledWith("restore_flashcard_backup", { path: backup.path, checksum: backup.checksum, operationId: expect.any(String) });
  expect(restored).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("恢复已完成");
});
it("cancellation and validation errors never restore", async () => {
  open.mockResolvedValue(null); await click("从文件恢复");
  expect(invoke.mock.calls.some(([name]) => name === "inspect_flashcard_backup")).toBe(false);
  open.mockResolvedValue("bad.hubfc"); invoke.mockImplementation(async name => {
    if (name === "inspect_flashcard_backup") throw new Error("备份附件校验失败"); return [];
  }); await click("从文件恢复");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("校验失败");
  expect(invoke.mock.calls.some(([name]) => name === "restore_flashcard_backup")).toBe(false);
});
it("Android export reports opening the save flow, not completion", async () => {
  document.documentElement.dataset.runtimePlatform = "android"; await click("备份到文件");
  expect(save).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith("save_flashcard_backup", { path: backup.path, destination: "", operationId: expect.any(String) });
  expect(container.textContent).toContain("请在系统对话框中完成另存");
});
it("retains valid backups beside a damaged file and still exports a new backup", async () => {
  invoke.mockImplementation(async name => name === "list_flashcard_backups"
    ? { items: [backup], issues: [{ path: "local/damaged.hubfc", error: "附件校验失败" }] } : backup);
  save.mockResolvedValue("chosen.hubfc");
  await click("备份到文件");
  expect(invoke).toHaveBeenCalledWith("save_flashcard_backup", { path: backup.path, destination: "chosen.hubfc", operationId: expect.any(String) });
  expect(container.textContent).toContain("damaged.hubfc");
  expect(container.textContent).toContain("其他完整备份仍可导出和恢复");
  expect([...container.querySelectorAll("button")].some(b => b.textContent === "恢复此备份")).toBe(true);
});
it("history enumeration failure does not prevent exporting the newly verified backup", async () => {
  invoke.mockImplementation(async name => {
    if (name === "list_flashcard_backups") throw new Error("目录读取失败");
    return backup;
  });
  save.mockResolvedValue("chosen.hubfc");
  await click("备份到文件");
  expect(invoke).toHaveBeenCalledWith("save_flashcard_backup", { path: backup.path, destination: "chosen.hubfc", operationId: expect.any(String) });
  expect(container.textContent).toContain("历史记录暂时无法读取");
});

it("stops the exact running backup and waits for its producer before unlocking", async () => {
  let rejectBackup!: (error: Error) => void;
  invoke.mockImplementation((name: string) => {
    if (name === "create_flashcard_backup") return new Promise((_, reject) => { rejectBackup = reject; });
    if (name === "cancel_flashcard_backup") return Promise.resolve(true);
    return Promise.resolve({ items: [], issues: [] });
  });
  await click("备份到文件");
  const operationId = invoke.mock.calls.find(([name]) => name === "create_flashcard_backup")![1].operationId;
  await click("停止操作");
  expect(invoke).toHaveBeenCalledWith("cancel_flashcard_backup", { operationId });
  expect([...container.querySelectorAll("button")].find(b => b.textContent === "备份到文件")!.disabled).toBe(true);
  await act(async () => { rejectBackup(new Error("BACKUP_CANCELLED:已取消")); }); await settle();
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("本次操作已停止");
  expect([...container.querySelectorAll("button")].find(b => b.textContent === "备份到文件")!.disabled).toBe(false);
});

it("stopping during a system dialog preserves the completed local backup and sends no later export", async () => {
  let finishDialog!: (path: string) => void;
  save.mockImplementation(() => new Promise(resolve => { finishDialog = resolve; }));
  await click("备份到文件"); await click("停止操作");
  expect(container.textContent).toContain("请关闭它");
  await act(async () => { finishDialog("chosen.hubfc"); }); await settle();
  expect(invoke.mock.calls.some(([name]) => name === "save_flashcard_backup")).toBe(false);
  expect(container.textContent).toContain("已经完成的本机备份仍会保留");
});

it("a restore whose commit wins a late stop still refreshes the committed data", async () => {
  open.mockResolvedValue("chosen.hubfc"); await click("从文件恢复");
  let finishRestore!: () => void;
  invoke.mockImplementation((name: string) => {
    if (name === "restore_flashcard_backup") return new Promise<void>(resolve => { finishRestore = resolve; });
    if (name === "cancel_flashcard_backup") return Promise.resolve(false);
    return Promise.resolve({ items: [], issues: [] });
  });
  await click("确认恢复"); await click("停止操作");
  await act(async () => { finishRestore(); }); await settle();
  expect(restored).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("恢复已完成");
  expect(container.textContent).not.toContain("确认合并恢复");
});

it("unmount cancels an in-flight native read and ignores its late result", async () => {
  open.mockResolvedValue("chosen.hubfc");
  let finishInspect!: (value: typeof backup) => void;
  invoke.mockImplementation((name: string) => name === "inspect_flashcard_backup"
    ? new Promise(resolve => { finishInspect = resolve; }) : Promise.resolve(true));
  await click("从文件恢复");
  const operationId = invoke.mock.calls.find(([name]) => name === "inspect_flashcard_backup")![1].operationId;
  await act(async () => root.unmount());
  expect(invoke).toHaveBeenCalledWith("cancel_flashcard_backup", { operationId });
  await act(async () => finishInspect(backup)); await settle();
  expect(restored).not.toHaveBeenCalled();
  expect(invoke.mock.calls.some(([name]) => name === "restore_flashcard_backup")).toBe(false);
  root = createRoot(container);
});
