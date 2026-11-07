// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { libraryRemovalPrompt, reconcileLibraryCounts, useLibraryManagement, type LibraryRuntime } from "./LibraryManagement";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
const snapshot = (state: LibraryRuntime["state"], updatedAt = 1): LibraryRuntime => ({ libraryId: "main", state, phase: state === "running" ? "queued" : state, detail: "", activeOperations: state === "running" ? 1 : 0, pending: 0, updatedAt });
let api: ReturnType<typeof useLibraryManagement>;
let root: Root;
let container: HTMLDivElement;
let event: (value: { payload: LibraryRuntime }) => void;
let settled = vi.fn<() => void>();
it("warns before removing the vault that remains the collection default despite path presentation differences", () => {
  const prompt = libraryRemovalPrompt({ name: "Main", provider: "obsidian", location: "D:\\Notes\\Main" }, { config: { mode: "obsidian", vaultPath: "\\\\?\\D:/notes/main/" } });
  expect(prompt).toContain("原资料库中的内容不会被删除");
  expect(prompt).toContain("此路径仍是收藏默认保存位置");
  expect(prompt).toContain("移除后仍会保存新收藏");
});
it("keeps the ordinary prompt when removing a different vault or provider", () => {
  const vault = { name: "Other", provider: "obsidian" as const, location: "D:/Notes/Other" };
  const storage = { config: { mode: "obsidian" as const, vaultPath: "D:/Notes/Main" } };
  expect(libraryRemovalPrompt(vault, storage)).toBe("移除“Other”及其本地索引？原资料库中的内容不会被删除。");
  expect(libraryRemovalPrompt({ ...vault, provider: "craft", location: storage.config.vaultPath }, storage)).not.toContain("默认");
  expect(libraryRemovalPrompt(vault, { config: { mode: "database", vaultPath: vault.location } })).not.toContain("默认");
});
it("keeps removal available and explains unchanged defaults when collection settings cannot be read", () => {
  const prompt = libraryRemovalPrompt({ name: "Main", provider: "obsidian", location: "D:/Notes/Main" });
  expect(prompt).toContain("无法读取收藏保存配置");
  expect(prompt).toContain("默认位置设置保持原样");
  expect(prompt).toContain("移除资料库不会停止");
});
const Probe = () => { api = useLibraryManagement(true, settled); return <span>{api.libraries.main?.state}</span>; };
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); mocks.invoke.mockReset(); mocks.listen.mockReset(); mocks.listen.mockImplementation(async (_name, listener) => { event = listener; return () => undefined; }); mocks.invoke.mockResolvedValue({ libraries: [snapshot("paused")] }); settled = vi.fn(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("restores persisted paused state and uses resume only on explicit user action", async () => {
  await act(async () => root.render(<Probe />)); expect(container.textContent).toBe("paused");
  expect(mocks.invoke).toHaveBeenCalledWith("library_control", { args: { action: "status" } });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  mocks.invoke.mockResolvedValue(snapshot("running", 2)); await act(async () => { await api.act("main", "resume"); });
  expect(mocks.invoke).toHaveBeenCalledWith("library_control", { args: { action: "resume", libraryId: "main" } });
});
it("accepts sync through the background command instead of waiting for a full sync", async () => {
  mocks.invoke.mockResolvedValue({ libraries: [snapshot("idle")] });
  await act(async () => root.render(<Probe />)); mocks.invoke.mockResolvedValue(snapshot("running", 2));
  await act(async () => { await api.act("main", "sync"); });
  expect(mocks.invoke).toHaveBeenCalledWith("start_library_sync", { libraryId: "main" });
  expect(container.textContent).toBe("running");
  expect(mocks.invoke.mock.calls.some(([command]) => command === "sync_library" || command === "sync_all_libraries")).toBe(false);
});
it("refuses a manual sync of a paused library without resuming it", async () => {
  await act(async () => root.render(<Probe />));
  await act(async () => { await expect(api.act("main", "sync")).rejects.toThrow("已暂停"); });
  expect(mocks.invoke).toHaveBeenCalledTimes(1); expect(container.textContent).toBe("paused");
});
it("keeps removing visible until the native completion event and ignores stale snapshots", async () => {
  await act(async () => root.render(<Probe />)); mocks.invoke.mockResolvedValue(snapshot("removing", 3));
  await act(async () => { await api.act("main", "remove"); }); expect(container.textContent).toBe("removing"); expect(settled).not.toHaveBeenCalled();
  await act(async () => event({ payload: snapshot("idle", 2) })); expect(container.textContent).toBe("removing");
  await act(async () => event({ payload: snapshot("removed", 4) })); expect(container.textContent).toBe("removed"); expect(settled).toHaveBeenCalledOnce();
});
it("updates counts from actual index health while preserving library settings and unchanged identities", () => {
  const spaces = [{ id: "main", provider: "craft" as const, name: "Main", connected: true, documentCount: 0, excludedPaths: ["keep"], iconSvg: "icon" }];
  const health = [{ libraryId: "main", provider: "craft", name: "Main", documentCount: 12, lastSync: "2026-10-07T03:00:00Z", pendingJobs: 0, failedJobs: 0, consecutiveFailures: 0 }];
  const updated = reconcileLibraryCounts(spaces, health);
  expect(updated[0]).toMatchObject({ documentCount: 12, lastSync: health[0].lastSync, iconSvg: "icon", excludedPaths: ["keep"] });
  expect(reconcileLibraryCounts(updated, health)).toBe(updated);
});
it("reports removal errors once per changed error while preserving removal state for retry", async () => {
  const notice = vi.fn(); window.addEventListener("hub:operation-status", notice);
  await act(async () => root.render(<Probe />));
  const failed = { ...snapshot("removing", 3), lastError: "本地索引暂时锁定" };
  await act(async () => event({ payload: failed }));
  expect(container.textContent).toBe("removing");
  expect((notice.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ tone: "error" });
  expect((notice.mock.calls[0][0] as CustomEvent).detail.text).toContain("重试移除");
  await act(async () => event({ payload: { ...failed, updatedAt: 4 } }));
  expect(notice).toHaveBeenCalledOnce();
  mocks.invoke.mockResolvedValue(snapshot("removing", 5));
  await act(async () => { await api.act("main", "remove"); });
  expect(mocks.invoke).toHaveBeenCalledWith("library_control", { args: { action: "remove", libraryId: "main" } });
  window.removeEventListener("hub:operation-status", notice);
});
