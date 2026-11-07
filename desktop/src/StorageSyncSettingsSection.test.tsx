// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StorageSyncSettingsSection } from "./StorageSyncSettingsSection";
import { runtimeCapabilities } from "./RuntimePlatform";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("./UserProfileStorage", () => ({ flushUserProfileStorage: vi.fn() }));
vi.mock("./DataPortabilitySettings", () => ({ DataPortabilitySettings: () => <input aria-label="备份草稿" defaultValue="" /> }));
let host: HTMLDivElement, root: Root;
const props = () => ({ runtimeCapabilities: { ...runtimeCapabilities, customStorageLocation: true }, storageInfo: { mode: "custom" as const, path: "C:/synthetic/hub", defaultPath: "C:/synthetic/default", portablePath: "C:/synthetic/portable", sizeBytes: 1024, fileCount: 1 }, storageMode: "custom" as const, storageCustomPath: "C:/synthetic/new", changingStorage: false, autoSyncMinutes: 30, formatFileSize: String, revealStorageLocation: vi.fn(), chooseStorageFolder: vi.fn(), applyStorageLocation: vi.fn(), changeAutoSync: vi.fn(), setStorageMode: vi.fn(), setStorageCustomPath: vi.fn(), advancedSettings: <div>原有索引功能</div> });
const toggle = async (label: string, open = true) => { const item = [...host.querySelectorAll("details")].find(detail => detail.querySelector("summary strong")?.textContent === label)!; await act(async () => { item.open = open; item.dispatchEvent(new Event("toggle")); }); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.invoke.mockReset(); mocks.listen.mockResolvedValue(vi.fn());
  mocks.invoke.mockResolvedValue({ root: "C:/synthetic/hub", activeOperation: null, usage: { logicalBytes: 2048, categories: [], warnings: [] }, compaction: { preview: { reclaimableBytes: 1024, requiredFreeBytes: 4096, availableFreeBytes: 8192 }, status: null, retainedBytes: 0, note: "" }, cleanup: { status: null } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("shows total and location before expansion, with distinct actionable groups and lazy advanced controls", async () => {
  const values = props(); await act(async () => root.render(<StorageSyncSettingsSection {...values} />));
  expect(host.querySelector("header")?.textContent).toContain("2.0 KB");
  expect(host.querySelector("header")?.textContent).toContain("C:/synthetic/hub");
  expect([...host.querySelectorAll("summary strong")].map(item => item.textContent)).toEqual(["管理空间", "备份与迁移", "索引与高级设置"]);
  expect(host.querySelectorAll("details[open]")).toHaveLength(0);
  expect(host.textContent).toContain("数据库内可回收 1.0 KB");
  expect(host.querySelector('[aria-label="自动同步间隔"]')).toBeNull();
  await toggle("索引与高级设置"); expect(host.textContent).toContain("原有索引功能");
  await act(async () => { const select = host.querySelector<HTMLSelectElement>('[aria-label="自动同步间隔"]')!; select.value = "60"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(values.changeAutoSync).toHaveBeenCalledWith(60);
});

it("keeps backup input when collapsed and retains the existing migration action behind a location editor", async () => {
  const values = props(); await act(async () => root.render(<StorageSyncSettingsSection {...values} />)); await toggle("备份与迁移");
  host.querySelector<HTMLInputElement>('[aria-label="备份草稿"]')!.value = "keep";
  await toggle("备份与迁移", false); await toggle("备份与迁移");
  expect(host.querySelector<HTMLInputElement>('[aria-label="备份草稿"]')?.value).toBe("keep");
  await act(async () => [...host.querySelectorAll("button")].find(item => item.textContent === "更改数据位置…")!.click());
  expect(host.querySelector('[aria-label="自定义数据文件夹"]')?.getAttribute("id")).toBe("data-management-custom-path");
  await act(async () => [...host.querySelectorAll("button")].find(item => item.textContent === "更改并迁移")!.click());
  expect(values.applyStorageLocation).toHaveBeenCalledTimes(1);
});

it("reports an initial usage error on the collapsed overview and offers refresh", async () => {
  mocks.invoke.mockRejectedValue(new Error("统计目录失败"));
  await act(async () => root.render(<StorageSyncSettingsSection {...props()} />));
  expect(host.querySelector("header [role=alert]")?.textContent).toContain("统计目录失败");
  expect([...host.querySelectorAll("button")].some(item => item.textContent === "刷新空间占用" && !item.disabled)).toBe(true);
});

it("shows a usable path and reports folder-open failures beside the action with a retry", async () => {
  const values = props();
  mocks.invoke.mockResolvedValue({ root: String.raw`\\?\C:\Users\name\Hub`, activeOperation: null, usage: { logicalBytes: 2048, categories: [], warnings: [] }, compaction: { preview: { reclaimableBytes: 0, requiredFreeBytes: 1, availableFreeBytes: 2 }, status: null, retainedBytes: 0, note: "" }, cleanup: { status: null } });
  values.revealStorageLocation.mockRejectedValueOnce(new Error("无法启动文件管理器"));
  await act(async () => root.render(<StorageSyncSettingsSection {...values} />));
  expect(host.querySelector(".data-management-path")?.textContent).toBe(String.raw`C:\Users\name\Hub`);
  const open = () => [...host.querySelectorAll("button")].find(item => item.textContent === "打开数据文件夹")!;
  await act(async () => open().click());
  expect(host.querySelector("header [role=alert]")?.textContent).toContain("无法启动文件管理器");
  expect(host.querySelector("header [role=alert]")?.textContent).toContain("可复制下方路径");
  await act(async () => open().click());
  expect(values.revealStorageLocation).toHaveBeenCalledTimes(2);
  expect(host.querySelector("header [role=alert]")).toBeNull();
});
