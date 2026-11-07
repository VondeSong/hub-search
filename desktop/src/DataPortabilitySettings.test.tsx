// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DataPortabilitySettings } from "./DataPortabilitySettings";
import { defaultDataBackupSchedule, type DataBackupPreview, type DataDirectoryPreview, type DataPortabilityProgress, type DataPortabilityStatus } from "./useDataPortability";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), save: vi.fn(), listen: vi.fn(), openPath: vi.fn(), flush: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: mocks.openPath }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("./UserProfileStorage", () => ({ flushUserProfileStorage: mocks.flush }));

const dependency = { id: "vault:one", kind: "obsidian" as const, name: "笔记库", sourcePath: "D:/notes", included: false, archivePath: null, available: false, canRelocate: true };
const status: DataPortabilityStatus = {
  root: "D:/Hub Data", schedule: { ...defaultDataBackupSchedule }, dependencies: [dependency], activeOperation: null, warnings: [],
  usage: { root: "D:/Hub Data", logicalBytes: 1024, files: 1, categories: [{ id: "database", label: "数据库", logicalBytes: 1024, files: 1, rebuildable: false }], warnings: [] },
};
const directory: DataDirectoryPreview = { token: "directory-token", path: "E:/copied", schemaVersion: 70, libraries: 2, documents: 42, profileValues: 5, warnings: ["笔记库需重新定位"], dependencies: [dependency] };
const backup: DataBackupPreview = { token: "backup-token", path: "E:/data.hubbackup", datasetId: "dataset", createdAt: 1700000000, appVersion: "0.16.1", schemaVersion: 70, files: 2, bytes: 2048, archiveBytes: 1024, checksum: "checked", complete: false, dependencies: [dependency], warnings: ["原始库未包含"] };
let container: HTMLDivElement, root: Root;
let progressListener: (event: { payload: DataPortabilityProgress }) => void;
let updatedListener: () => void;
const actions = () => mocks.invoke.mock.calls.map(([, options]) => options?.args?.action);
const button = (text: string) => {
  const found = [...container.querySelectorAll("button")].find(item => item.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};
const click = async (text: string) => { await act(async () => button(text).click()); };
const render = async () => { await act(async () => root.render(<DataPortabilitySettings />)); };
const reply = async (_command: string, options: { args: { action: string; config?: unknown } }) => {
  switch (options.args.action) {
    case "status": return status;
    case "inspect_directory": return directory;
    case "open_directory": return { restartRequired: true };
    case "inspect_backup": return backup;
    case "create_backup": return backup;
    case "restore_backup": return { destination: "F:/restored", backup, pathMappings: [], warnings: [], restartRequired: false };
    case "save_schedule": return options.args.config;
    case "relocate_dependency": return {};
    case "cancel": return {};
    default: throw new Error(`Unexpected action: ${options.args.action}`);
  }
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.flush.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(reply);
  mocks.listen.mockImplementation(async (event, listener) => {
    if (event === "data-portability-progress") progressListener = listener;
    if (event === "data-portability-updated") updatedListener = listener;
    return vi.fn();
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it("inspects a copied data directory before confirmation and flushes personal data before opening it", async () => {
  await render(); mocks.open.mockResolvedValue("E:/copied");
  await click("打开已有数据目录…");
  expect(actions()).toEqual(["status", "inspect_directory"]);
  expect(container.textContent).toContain("42 篇内容");
  expect(container.textContent).toContain("笔记库需重新定位");
  await click("打开此目录并重启");
  expect(mocks.flush).toHaveBeenCalledTimes(1);
  const openCall = mocks.invoke.mock.calls.find(([, options]) => options?.args?.action === "open_directory");
  expect(openCall).toEqual(["data_portability", { args: { action: "open_directory", token: "directory-token" } }]);
  const index = mocks.invoke.mock.calls.indexOf(openCall!);
  expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[index]);
  expect(button("备份到文件…").disabled).toBe(true);
});

it("discards an earlier directory inspection when a new selection is cancelled", async () => {
  await render(); mocks.open.mockResolvedValueOnce("E:/copied").mockResolvedValueOnce(null);
  await click("打开已有数据目录…"); await click("打开已有数据目录…");
  expect(container.querySelector('[aria-label="已有数据目录检查结果"]')).toBeNull();
  expect(actions().filter(action => action === "inspect_directory")).toHaveLength(1);
});

it("blocks backup when personal data fails to persist and keeps a retry available", async () => {
  await render(); mocks.save.mockResolvedValue("E:/backup.hubbackup"); mocks.flush.mockRejectedValue(new Error("个人数据尚未保存"));
  await click("备份到文件…");
  expect(actions()).not.toContain("create_backup");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("个人数据尚未保存");
  expect(button("备份到文件…").disabled).toBe(false);
});

it("requires an explicit restore directory and invalidates a rejected backup token", async () => {
  await render(); mocks.open.mockResolvedValueOnce("E:/data.hubbackup").mockResolvedValueOnce("F:/occupied");
  await click("从备份恢复…");
  expect(actions()).not.toContain("restore_backup");
  expect(button("恢复并重启").disabled).toBe(true);
  await click("选择空文件夹…");
  mocks.invoke.mockImplementation(async (command, options) => {
    if (options.args.action === "restore_backup") throw new Error("目标文件夹必须为空");
    return reply(command, options);
  });
  await click("恢复并重启");
  expect(mocks.flush).toHaveBeenCalledTimes(1);
  expect(mocks.invoke.mock.calls.find(([, options]) => options?.args?.action === "restore_backup")?.[1].args).toMatchObject({ token: "backup-token", destination: "F:/occupied", openAfterRestore: true, operationId: expect.any(String) });
  expect(container.textContent).toContain("目标文件夹必须为空");
  expect(container.querySelector('[aria-label="备份文件检查结果"]')).toBeNull();
});

it("reports omitted sources without claiming that every source was backed up", async () => {
  await render(); mocks.save.mockResolvedValue("E:/backup.hubbackup");
  await click("备份到文件…");
  expect(mocks.invoke.mock.calls.find(([, options]) => options?.args?.action === "create_backup")?.[1].args).toMatchObject({ destination: "E:/backup.hubbackup", includeExternalSources: false });
  expect(container.textContent).toContain("Obsidian 原始库不打包");
  expect(container.textContent).toContain("原始库未包含");
  expect(container.textContent).toContain("覆盖范围中的缺项");
});

it("matches progress and cancellation to the active operation and accepts committed success after a stop request", async () => {
  await render(); mocks.save.mockResolvedValue("E:/backup.hubbackup");
  let finish!: (value: DataBackupPreview) => void;
  mocks.invoke.mockImplementation((command, options) => options.args.action === "create_backup" ? new Promise(resolve => { finish = resolve; }) : reply(command, options));
  await click("备份到文件…");
  const operationId = mocks.invoke.mock.calls.find(([, options]) => options?.args?.action === "create_backup")![1].args.operationId;
  await act(async () => progressListener({ payload: { operationId: "old", phase: "copy", message: "错误代次" } }));
  expect(container.textContent).not.toContain("错误代次");
  await act(async () => progressListener({ payload: { operationId, phase: "copy", completedBytes: 10, totalBytes: 20, completedFiles: 1 } }));
  expect(container.querySelector("progress")?.value).toBe(10);
  await click("停止操作");
  expect(mocks.invoke).toHaveBeenLastCalledWith("data_portability", { args: { action: "cancel", operationId } });
  await act(async () => finish(backup));
  expect(container.textContent).toContain("本次备份结果");
  expect(button("备份到文件…").disabled).toBe(false);
});

it("does not start a native operation after its file dialog outlives the settings owner", async () => {
  await render();
  let choose!: (path: string) => void;
  mocks.open.mockReturnValue(new Promise(resolve => { choose = resolve; }));
  await click("打开已有数据目录…");
  await act(async () => root.unmount());
  await act(async () => choose("E:/copied"));
  expect(actions()).toEqual(["status"]);
  root = createRoot(container);
});

it("saves automatic backup settings only after a destination is selected", async () => {
  await render();
  const checkbox = [...container.querySelectorAll("label")].find(label => label.textContent === "启用自动备份")!.querySelector("input")!;
  await act(async () => checkbox.click());
  await click("保存自动备份设置");
  expect(actions()).not.toContain("save_schedule");
  expect(container.textContent).toContain("请先选择自动备份位置");
  mocks.open.mockResolvedValue("E:/automatic"); await click("选择…");
  await click("保存自动备份设置");
  expect(mocks.invoke.mock.calls.find(([, options]) => options?.args?.action === "save_schedule")?.[1].args.config).toMatchObject({ enabled: true, destination: "E:/automatic", intervalHours: 24, keepCount: 7, includeExternalSources: false });
});

it("relocates the selected dependency through its stable identity", async () => {
  await render(); mocks.open.mockResolvedValue("F:/notes");
  mocks.invoke.mockImplementation((command, options) => options.args.action === "relocate_dependency" ? Promise.resolve({ location: "F:/notes", warning: "请同时核对第二份备份" }) : reply(command, options));
  await click("重新定位");
  expect(mocks.invoke.mock.calls.find(([, options]) => options?.args?.action === "relocate_dependency")?.[1].args).toEqual({ action: "relocate_dependency", id: "vault:one", path: "F:/notes" });
  expect(container.textContent).toContain("“笔记库”的位置已更新");
  expect(container.textContent).toContain("请同时核对第二份备份");
});

it("distinguishes already collected Craft originals from independently managed vaults", async () => {
  const nativeRoot = String.raw`\\?\C:\Hub Data`;
  const craft = ["xv", "Car", "Main"].map(name => ({ id: `craft:${name}`, kind: "craftBackup" as const, name: `${name} - Craft`, sourcePath: `${nativeRoot}\\external-sources\\${name}`, included: true, archivePath: "owned", available: true }));
  mocks.invoke.mockResolvedValue({ ...status, root: nativeRoot, dependencies: [...craft, { ...dependency, sourcePath: String.raw`\\?\D:\Obsidian\OS` }, { ...dependency, id: "reading", kind: "reading", name: "阅读资料目录", sourcePath: String.raw`\\?\D:\Obsidian\Sources` }] });
  await render();
  const details = [...container.querySelectorAll("details")];
  const local = details.find(item => item.querySelector("summary")?.textContent === "已在 Hub 数据文件夹内的原件（3 项）")!;
  const independent = details.find(item => item.querySelector("summary")?.textContent === "独立管理的库与外部文件（2 项）")!;
  expect(local.textContent).toContain("xv - Craft");
  expect(local.textContent).toContain("已在 Hub 数据文件夹内");
  expect(independent.textContent).not.toContain("xv - Craft");
  expect(independent.textContent).toContain("原库由你单独管理");
  expect(container.textContent).not.toContain("\\\\?\\");
  expect(container.textContent).not.toContain("已包含在备份中");
});

it("locks conflicting storage actions while an operation owned by the backend is active", async () => {
  const onBusyChange = vi.fn();
  mocks.invoke.mockResolvedValue({ ...status, activeOperation: { operationId: "automatic", phase: "copy" } });
  await act(async () => root.render(<DataPortabilitySettings onBusyChange={onBusyChange} />));
  expect(button("备份到文件…").disabled).toBe(true);
  expect(button("打开已有数据目录…").disabled).toBe(true);
  expect(onBusyChange).toHaveBeenLastCalledWith(true);
  mocks.invoke.mockResolvedValue(status);
  await click("刷新");
  expect(button("备份到文件…").disabled).toBe(false);
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
});

it("refreshes automatic backup results without replacing unsaved settings", async () => {
  await render();
  const checkbox = [...container.querySelectorAll("label")].find(label => label.textContent === "启用自动备份")!.querySelector("input")!;
  await act(async () => checkbox.click());
  mocks.invoke.mockResolvedValue({ ...status, schedule: { ...status.schedule, lastAttemptAt: 1700000000, lastError: "目标磁盘暂时不可用" } });
  await act(async () => updatedListener());
  expect(checkbox.checked).toBe(true);
  expect(container.textContent).toContain("目标磁盘暂时不可用");
  expect(actions()).not.toContain("save_schedule");
});
