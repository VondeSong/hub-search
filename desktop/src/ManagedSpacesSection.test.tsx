// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ManagedSpacesSection } from "./ManagedSpacesSection";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("./CraftBackupHistory", () => ({ CraftBackupHistory: () => null }));
vi.mock("./LibrarySyncSchedule", () => ({ LibrarySyncSchedule: () => null }));
let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof ManagedSpacesSection>;
const policy = { imageDownload: true, imageOcr: true, pdfDownload: true, pdfText: true, pdfOcr: true, otherDownload: false, outgoingAttachments: true };
const policySnapshot = { global: policy, effective: policy, overrides: Object.fromEntries(Object.keys(policy).map(key => [key, null])), capabilities: { ...policy, otherDownload: true } };
beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async command => command === "library_content_policy" ? policySnapshot : undefined);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  props = {
    spaces: [{ id: "space", name: "Main", provider: "craft", documentCount: 145, connected: true, excludedPaths: [] }],
    renderLibraryIcon: () => null, indexStatus: null, renamingLibraryId: "", libraryNameDraft: "", exportingLibraryId: "", exportProgress: null,
    lastExportPath: "", exportError: "", maintenanceMessage: "", editingExclusions: "", exclusionDraft: "", savingExclusions: false, restartingWatcher: "",
    providerName: () => "Craft", providerUnavailableLabel: () => "", obsidianWatchLabel: () => "",
    beginRenameLibrary: vi.fn(), saveLibraryName: vi.fn(), updateLibraryIcon: vi.fn(), resetLibraryIcon: vi.fn(), chooseExportDirectory: vi.fn(),
    exportCraftVault: vi.fn(async () => false), editExclusions: vi.fn(), restartWatcher: vi.fn(), removeSpace: vi.fn(), saveExclusions: vi.fn(),
    openExportPath: vi.fn(), openExportInObsidian: vi.fn(), setRenamingLibraryId: vi.fn(), setLibraryNameDraft: vi.fn(), setEditingExclusions: vi.fn(), setExclusionDraft: vi.fn(),
  };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function click(label: string) {
  await act(async () => { [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === label)!.click(); });
}
async function more() { await act(async () => (container.querySelector('[aria-label="更多资料库设置 · Main"]') as HTMLButtonElement).click()); }
it("relocates a disconnected Obsidian vault in place without adding or removing a library", async () => {
  props.spaces[0] = { ...props.spaces[0], provider: "obsidian", connected: false, location: "D:/Notes/Old" };
  const relocateObsidian = vi.fn();
  Object.assign(props, { relocateObsidian, relocatingLibraryId: "" });
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  const relocate = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "重新定位文件夹");
  expect(relocate).toBeDefined();
  await act(async () => relocate!.click());
  expect(relocateObsidian).toHaveBeenCalledWith(props.spaces[0]);
  expect(props.removeSpace).not.toHaveBeenCalled();
  expect(props.restartWatcher).not.toHaveBeenCalled();
});
it("keeps the saved name, location, interval and replica when manually backing up", async () => {
  mocks.invoke.mockImplementation(async command => command === "library_content_policy" ? policySnapshot : { config: { destination: "D:/saved", vaultName: "Custom Vault", intervalMinutes: 360, replicaDestination: "E:/copy" } });
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  await more(); await click("备份与恢复"); await click("备份与恢复"); await click("立即备份");
  expect(props.exportCraftVault).toHaveBeenCalledWith(props.spaces[0], expect.objectContaining({ destination: "D:/saved", vaultName: "Custom Vault", backupIntervalMinutes: 360, replicaDestination: "E:/copy" }));
  expect(container.querySelector('.vault-export-fields input')).toBeNull();
  expect(mocks.invoke.mock.calls.filter(call => call[0] === "craft_backup_history")).toHaveLength(1);
});
it("blocks backup if saved settings cannot be read", async () => {
  const notices = vi.fn(); window.addEventListener("hub:operation-status", notices);
  mocks.invoke.mockImplementation(async command => { if (command === "library_content_policy") return policySnapshot; throw Error("配置读取失败"); });
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  await more(); await click("备份与恢复");
  expect((notices.mock.calls[notices.mock.calls.length - 1]?.[0] as CustomEvent).detail.text).toContain("配置读取失败");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  window.removeEventListener("hub:operation-status", notices);
  expect([...container.querySelectorAll("button")].find(b => b.textContent === "设置并开始首次备份")?.disabled).toBe(true);
  expect(props.exportCraftVault).not.toHaveBeenCalled();
});
it("allows choosing a location during initial setup only", async () => {
  mocks.invoke.mockImplementation(async command => command === "library_content_policy" ? policySnapshot : command === "craft_backup_history" ? { config: null } : "D:/initial");
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  await more(); await click("备份与恢复"); await click("设置并开始首次备份");
  expect(props.exportCraftVault).toHaveBeenCalledWith(props.spaces[0], expect.objectContaining({ destination: "D:/initial", vaultName: "Main - Craft", backupIntervalMinutes: 1440 }));
});
it("allows a disconnected library to retry saved authorization without removing cached documents", async () => {
  props.spaces = [{ ...props.spaces[0], connected: false }]; props.controlLibrary = vi.fn();
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  const sync = [...container.querySelectorAll("button")].find(button => button.textContent === "同步一次")!;
  expect(sync.disabled).toBe(false);
  await act(async () => sync.click());
  expect(props.controlLibrary).toHaveBeenCalledWith(props.spaces[0], "sync");
  expect(props.removeSpace).not.toHaveBeenCalled();
});
it("keeps paused libraries paused when the manual sync button is used", async () => {
  props.controlLibrary = vi.fn();
  props.libraryRuntime = { space: { libraryId: "space", state: "paused", phase: "paused", detail: "", activeOperations: 0, pending: 3, updatedAt: 1 } };
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  const sync = [...container.querySelectorAll("button")].find(button => button.textContent === "同步一次")!;
  expect(sync.disabled).toBe(true); await act(async () => sync.click()); expect(props.controlLibrary).not.toHaveBeenCalled();
  await click("继续"); expect(props.controlLibrary).toHaveBeenCalledWith(props.spaces[0], "resume");
});
it("shows removing state and disables new work while preserving the visible row", async () => {
  props.controlLibrary = vi.fn();
  props.libraryRuntime = { space: { libraryId: "space", state: "removing", phase: "removing", detail: "", activeOperations: 0, pending: 0, updatedAt: 1 } };
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  expect(container.textContent).toContain("正在移除本地索引"); expect(container.textContent).toContain("Main");
  expect([...container.querySelectorAll(".managed-space-actions button")].every(button => (button as HTMLButtonElement).disabled)).toBe(true);
});
it("allows retrying a failed removal from More while keeping normal work disabled", async () => {
  props.controlLibrary = vi.fn();
  props.libraryRuntime = { space: { libraryId: "space", state: "removing", phase: "removing", detail: "", lastError: "本地索引锁定", activeOperations: 0, pending: 0, updatedAt: 2 } };
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  expect([...container.querySelectorAll<HTMLButtonElement>(".managed-space-actions button")].slice(0, 2).every(button => button.disabled)).toBe(true);
  await more(); expect(container.textContent).toContain("本地索引锁定");
  expect(container.querySelector<HTMLButtonElement>('[title="修改资料库显示名称"]')?.disabled).toBe(true);
  expect(container.querySelector(".library-content-policy")).toBeNull();
  await click("重试移除"); expect(props.removeSpace).toHaveBeenCalledWith(props.spaces[0]);
  expect(props.controlLibrary).not.toHaveBeenCalled();
});
it("does not label an unscanned library as empty and closes more settings outside its focus area", async () => {
  props.spaces[0] = { ...props.spaces[0], documentCount: 0 };
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  expect(container.textContent).toContain("尚未同步"); expect(container.textContent).not.toContain("0 篇");
  await more(); expect(container.querySelector(".library-management-panel")).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(container.querySelector(".library-management-panel")).toBeNull();
});
it("shows intentional Obsidian pauses neutrally rather than as a watcher failure", async () => {
  props.spaces[0] = { ...props.spaces[0], provider: "obsidian" };
  props.obsidianWatchLabel = () => "监听中断";
  props.libraryRuntime = { space: { libraryId: "space", state: "paused", phase: "paused", detail: "", activeOperations: 0, pending: 0, updatedAt: 1 } };
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  expect(container.textContent).toContain("文件监控已暂停"); expect(container.textContent).not.toContain("监听中断"); expect(container.querySelector(".watch-status.error")).toBeNull();
});
it("keeps the file chooser alive when native picker focus dismisses library settings", async () => {
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  await more();
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const open = vi.spyOn(input, "click");
  await click("选择并裁剪图标");
  expect(open).toHaveBeenCalledOnce();
  await act(async () => document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(container.querySelector(".library-management-panel")).toBeNull();
  expect(input.isConnected).toBe(true);
  const file = new File(["image"], "chosen.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(props.updateLibraryIcon).toHaveBeenCalledWith(props.spaces[0], file);
  expect(input.value).toBe("");
  open.mockRestore();
});
it("only starts icon cropping after a file is selected and permits selecting the same file again", async () => {
  await act(async () => root.render(<ManagedSpacesSection {...props} />));
  await more();
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  await click("选择并裁剪图标");
  Object.defineProperty(input, "files", { value: [], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(props.updateLibraryIcon).not.toHaveBeenCalled();
  const file = new File(["<svg/>"], "chosen.svg", { type: "image/svg+xml" });
  for (let index = 0; index < 2; index += 1) {
    await click("选择并裁剪图标");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  }
  expect(props.updateLibraryIcon).toHaveBeenCalledTimes(2);
  expect(props.updateLibraryIcon).toHaveBeenLastCalledWith(props.spaces[0], file);
});
