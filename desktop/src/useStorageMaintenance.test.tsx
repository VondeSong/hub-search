// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStorageMaintenance } from "./useStorageMaintenance";
import type { LibrarySummary } from "./SearchTypes";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), open: vi.fn(), openPath: vi.fn(), flush: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: mocks.openPath }));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: { customStorageLocation: true } }));
vi.mock("./UserProfileStorage", () => ({ flushUserProfileStorage: mocks.flush }));

let host: HTMLDivElement, root: Root;
let state: ReturnType<typeof useStorageMaintenance>;
const refresh = vi.fn(async () => undefined);
function Harness({ scope = "first", open = false }: { scope?: string; open?: boolean }) {
  state = useStorageMaintenance({ statusSpaceId: scope, refreshStatus: refresh, settingsOpen: open });
  return null;
}
const render = async (props: Parameters<typeof Harness>[0] = {}) => { await act(async () => root.render(<Harness {...props} />)); };
const info = { mode: "default", path: "D:/owned/current", defaultPath: "D:/owned/current", portablePath: "D:/owned/portable", sizeBytes: 1, fileCount: 1 };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const mock of Object.values(mocks)) mock.mockReset();
  refresh.mockClear();
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.flush.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async command => command === "get_storage_info" ? info : 2);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("retains chosen storage on failed migration and requires the existing user confirmation", async () => {
  await render({ open: true });
  mocks.open.mockResolvedValue("D:/owned/selected");
  await act(async () => state.chooseStorageFolder());
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => state.applyStorageLocation());
  expect(mocks.invoke.mock.calls.some(([command]) => command === "change_storage_location")).toBe(false);
  confirmation.mockReturnValue(true);
  mocks.invoke.mockImplementation(async command => { if (command === "change_storage_location") throw new Error("destination unavailable"); if (command === "data_portability") return {ready:true,warnings:[]}; return info; });
  await act(async () => state.applyStorageLocation());
  expect(mocks.invoke).toHaveBeenLastCalledWith("change_storage_location", { mode: "custom", customPath: "D:/owned/selected" });
  expect(state.storageCustomPath).toBe("D:/owned/selected");
  expect(state.storageInfo?.path).toBe("D:/owned/current");
  expect(state.changingStorage).toBe(false);
  expect(state.maintenanceMessage).toContain("destination unavailable");
});

it("opens the native active directory without frontend paths or the ungranted generic opener", async () => {
  await render();
  await act(async () => state.revealStorageLocation());
  expect(mocks.invoke).toHaveBeenLastCalledWith("open_storage_directory");
  expect(mocks.openPath).not.toHaveBeenCalled();
  mocks.invoke.mockRejectedValue(new Error("文件管理器不可用"));
  await expect(state.revealStorageLocation()).rejects.toThrow("文件管理器不可用");
});

it("refreshes the existing index owner with the latest scope after retry and dismiss", async () => {
  await render(); await render({ scope: "second" });
  await act(async () => state.retryFailedOcr());
  expect(mocks.invoke).toHaveBeenLastCalledWith("retry_failed_ocr", { spaceId: "second" });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => state.retryFailedJobs());
  expect(mocks.invoke).toHaveBeenLastCalledWith("retry_failed_index", { spaceId: "second" });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await act(async () => state.dismissFailedJobs());
  expect(mocks.invoke).toHaveBeenLastCalledWith("dismiss_failed_index", { spaceId: "second" });
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(state.retryingOcr || state.retryingFailedJobs || state.dismissingFailedJobs).toBe(false);
});

it("moves to the chosen location before consolidation so the old disk does not need extra space", async () => {
  await render({open:true});
  mocks.open.mockResolvedValue("D:/owned/selected");
  await act(async()=>state.chooseStorageFolder());
  vi.spyOn(window,"confirm").mockReturnValue(true);
  mocks.invoke.mockImplementation(async command=>command==="change_storage_location"?{restartRequired:true}:info);
  await act(async()=>state.applyStorageLocation());
  expect(mocks.invoke.mock.calls.some(([command])=>command==="data_portability")).toBe(false);
  expect(mocks.invoke).toHaveBeenLastCalledWith("change_storage_location",{mode:"custom",customPath:"D:/owned/selected"});
});

it("blocks migration when personal data cannot be saved", async () => {
  await render({ open: true });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  mocks.flush.mockRejectedValue(new Error("个人设置尚未保存"));
  await act(async () => state.applyStorageLocation());
  expect(mocks.invoke.mock.calls.some(([command]) => command === "change_storage_location")).toBe(false);
  expect(state.maintenanceMessage).toContain("个人设置尚未保存");
  expect(state.changingStorage).toBe(false);
});

it("keeps overview maintenance away from downloads while preserving the legacy default", async () => {
  await render({ scope:"library" });
  await act(async () => state.retryFailedJobs({excludeDownloads:true}));
  expect(mocks.invoke).toHaveBeenLastCalledWith("retry_failed_index",{spaceId:"library",excludeDownloads:true});
  vi.spyOn(window,"confirm").mockReturnValue(true);
  await act(async () => state.dismissFailedJobs({excludeDownloads:true}));
  expect(mocks.invoke).toHaveBeenLastCalledWith("dismiss_failed_index",{spaceId:"library",excludeDownloads:true});
  await act(async () => state.retryFailedJobs());
  expect(mocks.invoke).toHaveBeenLastCalledWith("retry_failed_index",{spaceId:"library"});
});

it("preserves a completed export when opening Obsidian fails and opens the verified output path", async () => {
  await render();
  mocks.invoke.mockImplementation(async command => {
    if (command === "open_craft_export_in_obsidian") throw new Error("Obsidian unavailable");
    return { destination: "D:/owned/export", vaultName: "Vault", exportedDocuments: 3, skippedDocuments: 1, exportedAttachments: 2, skippedAttachments: 0,
      conflicts: 1, failedAttachments: 0, snapshotId: "verified-snapshot", backupComplete: true, issues: [], replicaPath: null, externalReferences: 0 };
  });
  const library = { id: "craft-library", name: "Craft", provider: "craft" } as LibrarySummary;
  let result: boolean | undefined;
  await act(async () => { result = await state.exportCraftVault(library, { destination: "D:/owned/export", vaultName: "Vault", includeImages: true,
    includeVideos: true, includeOtherAttachments: true, exportDailyNotes: true, backupIntervalMinutes: 60, replicaDestination: "", openAfterExport: true }); });
  expect(result).toBe(true);
  expect(state.lastExportPath).toBe("D:/owned/export");
  expect(state.maintenanceMessage).toContain("verified-snapshot");
  expect(state.maintenanceMessage).toContain("Obsidian unavailable");
  expect(state.exportingLibraryId).toBe(""); expect(state.exportProgress).toBe(null);
  await act(async () => state.openExportPath());
  expect(mocks.openPath).toHaveBeenCalledWith("D:/owned/export");
});

it("releases an event subscription that resolves only after its owner unmounts", async () => {
  let subscribed!: (dispose: () => void) => void;
  mocks.listen.mockImplementation(() => new Promise(resolve => { subscribed = resolve; }));
  await render();
  await act(async () => root.unmount());
  const dispose = vi.fn();
  await act(async () => subscribed(dispose));
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(mocks.listen).toHaveBeenCalledTimes(1);
  // Replace the empty root so afterEach keeps the same ownership protocol.
  root = createRoot(host);
});
