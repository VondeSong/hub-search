// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CraftBackupHistory } from "./CraftBackupHistory";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.open.mockReset();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const history = { backupRoot: "D:/backup", config: null, snapshots: [{ id:"snapshot-1", libraryId:"space", libraryName:"Main", startedAt:1, documents:[{}], attachments:[{}], limitations:[] }] };
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === label)!;
  await act(async () => { button.click(); });
}

it("keeps incomplete reading export separate from restore and automatic backup", async () => {
  const value = { ...history, snapshots: [], reading: { vaultPath:"D:/normal/Main", vaultExists:false, generatedAt:null,
    attempts:[{id:"attempt-1",libraryId:"space",libraryName:"Main",startedAt:1,documents:2,issues:3}] } };
  mocks.open.mockResolvedValue("E:/reading");
  mocks.invoke.mockImplementation(async (command:string) => {
    if(command==="craft_backup_history") return value;
    if(command==="export_craft_reading_copy") return {destination:"E:/reading/独立副本",backupComplete:false,exportedDocuments:2,skippedDocuments:0,failedAttachments:1,conflicts:0};
    if(command==="open_craft_export_in_obsidian") return undefined;
    throw new Error(`unexpected command: ${command}`);
  });
  await act(async () => root.render(<CraftBackupHistory libraryId="space"/>));
  expect(container.textContent).toContain("当前配置路径未找到");
  const normal = [...container.querySelectorAll("button")].find(b=>b.textContent==="打开正常阅读库")!;
  expect(normal.disabled).toBe(true);
  await click("生成阅读副本（有缺项）…");
  expect(mocks.invoke).toHaveBeenCalledWith("export_craft_reading_copy",{root:"D:/backup",attemptId:"attempt-1",libraryId:"space",destination:"E:/reading"});
  expect(container.textContent).toContain("这不是完整恢复点");
  expect(container.textContent).toContain("1 件附件不可用");
  await click("打开阅读副本（有缺项）");
  expect(mocks.invoke).toHaveBeenCalledWith("open_craft_export_in_obsidian",{path:"E:/reading/独立副本"});
  expect(mocks.invoke.mock.calls.map(c=>c[0])).not.toContain("restore_craft_backup");
});
it("restores a selected external archive without any Craft connection or sync call", async () => {
  mocks.open.mockResolvedValueOnce("D:/backup").mockResolvedValueOnce("E:/restore");
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "inspect_craft_backup") return history;
    if (command === "restore_craft_backup") return { destination:"E:/restore/Vault", issues:[] };
    throw new Error(`unexpected network command: ${command}`);
  });
  await act(async () => root.render(<CraftBackupHistory />));
  await click("选择已有备份…"); await click("生成 Obsidian 库（另存为）…");
  expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(["inspect_craft_backup", "restore_craft_backup"]);
  expect(mocks.invoke.mock.calls[1][1]).toMatchObject({ root:"D:/backup", snapshotId:"snapshot-1", options:{ libraryId:"space", destination:"E:/restore", includeOtherAttachments:true } });
  expect(container.textContent).toContain("Obsidian 库副本已生成");
  expect(mocks.invoke.mock.calls[1][1]).toMatchObject({ useConfiguredDestination: false });
});

it("regenerates the configured vault from a local point without saving backup settings", async () => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "craft_backup_history") return { ...history, config: { destination: "D:/saved", vaultName: "My Vault", intervalMinutes: 360, replicaDestination: "E:/copy", lastError: null, lastSuccessAt: 1 } };
    if (command === "restore_craft_backup") return { destination: "D:/saved/My Vault", issues: [] };
    throw new Error(`unexpected write or cloud call: ${command}`);
  });
  await act(async () => root.render(<CraftBackupHistory libraryId="space" />));
  await click("生成 Obsidian 库（原位置）");
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(["craft_backup_history", "restore_craft_backup"]);
  expect(mocks.invoke.mock.calls[1][1]).toMatchObject({ useConfiguredDestination: true, options: { destination: "D:/saved", vaultName: "My Vault" } });
  expect(container.textContent).toContain("自动备份设置不变");
});

it("does not offer generation from incomplete captures", async () => {
  mocks.invoke.mockResolvedValue({ ...history, snapshots: [], warnings: ["缺失 6 个附件"], config: null });
  await act(async () => root.render(<CraftBackupHistory libraryId="space" />));
  expect(container.textContent).toContain("缺失 6 个附件");
  expect(container.textContent).not.toContain("生成 Obsidian 库（原位置）");
  expect(container.textContent).not.toContain("生成 Obsidian 库（另存为）");
});
it("shows corrupted archive verification as failure instead of successful backup", async () => {
  mocks.open.mockResolvedValueOnce("D:/backup");
  mocks.invoke.mockImplementation(async (command: string) => command === "inspect_craft_backup" ? history : { valid:false, checkedObjects:2, issues:[{ message:"附件原件损坏" }] });
  await act(async () => root.render(<CraftBackupHistory />));
  await click("选择已有备份…"); await click("核验原始备份");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("附件原件损坏");
  expect(container.textContent).not.toContain("核验通过");
});
