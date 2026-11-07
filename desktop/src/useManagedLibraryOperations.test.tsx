// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useManagedLibraryOperations } from "./useManagedLibraryOperations";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
let root: Root, host: HTMLDivElement;
let state: ReturnType<typeof useManagedLibraryOperations>;
const reloadSpaces = vi.fn(async () => []), refreshStatus = vi.fn(async () => undefined);
const message = vi.fn(), error = vi.fn();
const library = { id: "original-id", provider: "obsidian" as const, name: "Alias", location: "D:/Old", connected: false, documentCount: 1347, excludedPaths: [] };
function Harness() {
  state = useManagedLibraryOperations({ libraryManagement: { act: vi.fn() }, reloadSpaces, refreshStatus, removeLibrarySelection: vi.fn(), setConnectionError: error, setConnectionErrorProvider: vi.fn(), setMaintenanceMessage: message } as unknown as Parameters<typeof useManagedLibraryOperations>[0]);
  return null;
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.invoke.mockReset(); mocks.open.mockReset(); reloadSpaces.mockClear(); refreshStatus.mockClear(); message.mockClear(); error.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("updates the original library then refreshes its path and watcher status", async () => {
  mocks.open.mockResolvedValue("D:/LifeOS"); mocks.invoke.mockResolvedValue({ location: "D:/LifeOS", warning: null });
  await act(async () => state.relocateObsidian(library));
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("relocate_obsidian_library", { libraryId: library.id, path: "D:/LifeOS" });
  expect(reloadSpaces).toHaveBeenCalledOnce(); expect(refreshStatus).toHaveBeenCalledOnce();
  expect(message).toHaveBeenCalledWith(expect.stringContaining("已有索引与资料库关联已保留"));
  expect(state.relocatingLibraryId).toBe("");
});
it("canceling the native folder picker does not mutate the library", async () => {
  mocks.open.mockResolvedValue(null);
  await act(async () => state.relocateObsidian(library));
  expect(mocks.invoke).not.toHaveBeenCalled(); expect(reloadSpaces).not.toHaveBeenCalled(); expect(message).not.toHaveBeenCalled();
  expect(state.relocatingLibraryId).toBe("");
});
it("failed relocation exposes the error without showing success or refreshing unrelated state", async () => {
  mocks.open.mockResolvedValue("D:/Wrong"); mocks.invoke.mockRejectedValue(new Error("未找到原库的笔记"));
  await act(async () => state.relocateObsidian(library));
  expect(error).toHaveBeenLastCalledWith(expect.stringContaining("未找到原库的笔记"));
  expect(message).not.toHaveBeenCalled(); expect(reloadSpaces).not.toHaveBeenCalled();
});
it("a repeated click while the folder picker is open makes only one path update", async () => {
  let resolve!: (path: string) => void;
  mocks.open.mockReturnValue(new Promise<string>(done => { resolve = done; }));
  mocks.invoke.mockResolvedValue({ location: "D:/LifeOS", warning: null });
  let first!: Promise<void>;
  await act(async () => { first = state.relocateObsidian(library); });
  await act(async () => state.relocateObsidian(library));
  expect(mocks.open).toHaveBeenCalledOnce();
  await act(async () => { resolve("D:/LifeOS"); await first; });
  expect(mocks.invoke).toHaveBeenCalledOnce();
});
