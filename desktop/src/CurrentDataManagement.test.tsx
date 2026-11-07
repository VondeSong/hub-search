// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CurrentDataManagement } from "./CurrentDataManagement";
import { useCurrentDataManagement, type CurrentDataStatus, type RecoveryCleanupPreview, type RecoveryCleanupStatus } from "./useCurrentDataManagement";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), flush: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("./UserProfileStorage", () => ({ flushUserProfileStorage: mocks.flush }));
const cleanupStatus = (phase: RecoveryCleanupStatus["phase"]): RecoveryCleanupStatus => ({ id: "synthetic", phase, error: "", plannedFiles: 2, plannedLogicalBytes: 1024, deletedFiles: 0, deletedLogicalBytes: 0, retainedFiles: 1, updatedAt: 1700000000 });
const initialStatus = (): CurrentDataStatus => ({ root: "C:/synthetic-hub", activeOperation: null,
  usage: { root: "C:/synthetic-hub", logicalBytes: 4096, files: 3, categories: [{ id: "database", label: "数据库", logicalBytes: 4096, files: 3, rebuildable: false }], warnings: [] },
  compaction: { preview: { reclaimableBytes: 1024, requiredFreeBytes: 4096, availableFreeBytes: 8192 }, status: null, retainedBytes: 2048, note: "压实后仍保留恢复副本。" }, cleanup: { status: null } });
const preview: RecoveryCleanupPreview = { token: "synthetic-preview", files: 2, logicalBytes: 1024, candidates: [{ id: "duplicate", label: "重复恢复副本", files: 2, logicalBytes: 1024 }], retained: [{ id: "unknown", label: "旧恢复副本", files: 1, logicalBytes: 500, reason: "缺少可验证清单" }], warnings: ["实际释放空间可能不同"], requiresRestart: true };
let host: HTMLDivElement, root: Root, status: CurrentDataStatus, updated: () => void;
function Subject() { return <CurrentDataManagement state={useCurrentDataManagement()} />; }
const actions = () => mocks.invoke.mock.calls.map(([command, options]) => options?.args?.action ?? command);
const button = (label: string) => { const result = [...host.querySelectorAll("button")].find(item => item.textContent === label); if (!result) throw new Error(`Missing button ${label}`); return result; };
const click = async (label: string) => { await act(async () => button(label).click()); };
const render = async () => { await act(async () => root.render(<Subject />)); };
const reply = async (command: string, options?: { args?: { action: string } }) => {
  switch (options?.args?.action ?? command) {
    case "storage_status": return structuredClone(status);
    case "preview_recovery_cleanup": return preview;
    case "schedule_recovery_cleanup": status.cleanup.status = cleanupStatus("requested"); return { status: status.cleanup.status, restartRequired: false };
    case "cancel_recovery_cleanup": status.cleanup.status = cleanupStatus("cancelled"); return status.cleanup.status;
    case "schedule_local_database_maintenance": status.compaction.status = { phase: "requested", error: "", beforeBytes: 0, afterBytes: 0 }; return status.compaction.status;
    case "cancel_local_database_maintenance": status.compaction.status = { phase: "cancelled", error: "", beforeBytes: 0, afterBytes: 0 }; return status.compaction.status;
    default: throw new Error(`Unexpected command ${command}`);
  }
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.values(mocks).forEach(mock => mock.mockReset()); status = initialStatus();
  mocks.invoke.mockImplementation(reply); mocks.flush.mockResolvedValue(undefined);
  mocks.listen.mockImplementation(async (_event, listener) => { updated = listener; return vi.fn(); });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("shows categories and requires a preview before scheduling; preserves unknown files and supports cancellation", async () => {
  await render(); expect(host.querySelector('[aria-label="分类空间占用"]')?.textContent).toContain("4.0 KB");
  expect(actions()).toEqual(["storage_status"]);
  await click("检查可清理项目");
  expect(actions()).toEqual(["storage_status", "preview_recovery_cleanup"]);
  expect(host.textContent).toContain("缺少可验证清单"); expect(host.textContent).toContain("实际释放空间可能不同");
  await click("安排下次启动清理");
  const scheduled = mocks.invoke.mock.calls.find(([, args]) => args?.args?.action === "schedule_recovery_cleanup")!;
  expect(scheduled).toEqual(["data_portability", { args: { action: "schedule_recovery_cleanup", token: "synthetic-preview", operationId: expect.any(String) } }]);
  expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[mocks.invoke.mock.calls.indexOf(scheduled)]);
  expect(host.querySelector('[aria-label="清理范围预览"]')).toBeNull();
  expect(host.textContent).toContain("已安排下次启动清理 2 个文件");
  await click("取消清理安排"); expect(actions()).toContain("cancel_recovery_cleanup");
  expect(button("检查可清理项目").disabled).toBe(false);
});

it("does not schedule cleanup or compaction when personal data cannot be saved", async () => {
  await render(); await click("检查可清理项目"); mocks.flush.mockRejectedValue(new Error("个人数据未保存"));
  await click("安排下次启动清理"); expect(actions()).not.toContain("schedule_recovery_cleanup");
  expect(host.querySelector('[aria-label="清理范围预览"]')).not.toBeNull();
  await click("安排下次启动压实"); expect(actions()).not.toContain("schedule_local_database_maintenance");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("个人数据未保存");
});

it("discards a backend-rejected cleanup token and asks for a fresh inspection", async () => {
  await render(); await click("检查可清理项目");
  mocks.invoke.mockImplementation((command, options) => options?.args?.action === "schedule_recovery_cleanup" ? Promise.reject(new Error("检查结果已过期")) : reply(command, options));
  await click("安排下次启动清理");
  expect(host.querySelector('[aria-label="清理范围预览"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("检查结果已过期");
  expect(button("检查可清理项目").disabled).toBe(false);
});

it("uses the existing compaction schedule/cancel commands and explains retained copies", async () => {
  await render(); await click("安排下次启动压实");
  expect(actions()).toContain("schedule_local_database_maintenance"); expect(mocks.flush).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("已保留的数据库恢复副本：2.0 KB");
  await click("取消压实安排"); expect(actions()).toContain("cancel_local_database_maintenance");
  expect(mocks.flush).toHaveBeenCalledTimes(1);
});

it("keeps a successful scheduling result visible if the subsequent usage refresh fails", async () => {
  await render(); let scheduled = false;
  mocks.invoke.mockImplementation(async (command, options) => {
    if (command === "schedule_local_database_maintenance") scheduled = true;
    if (scheduled && options?.args?.action === "storage_status") throw new Error("占用统计暂不可用");
    return reply(command, options);
  });
  await click("安排下次启动压实"); expect(button("取消压实安排").disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("占用统计暂不可用");
});

it("prevents compaction without adequate space and cleanup during an unfinished startup operation", async () => {
  status.compaction.preview.availableFreeBytes = 1; status.cleanup.status = cleanupStatus("running");
  await render(); expect(button("安排下次启动压实").disabled).toBe(true);
  expect(button("检查可清理项目").disabled).toBe(true);
  expect(host.textContent).toContain("可用空间不足"); expect(host.textContent).toContain("上次清理尚未完成");
});

it("debounces update bursts and serializes a single coalesced refresh behind an in-flight request", async () => {
  vi.useFakeTimers(); let finish!: (value: CurrentDataStatus) => void;
  mocks.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await render();
  await act(async () => { updated(); updated(); await vi.advanceTimersByTimeAsync(249); });
  expect(actions()).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); updated(); await vi.advanceTimersByTimeAsync(250); });
  expect(actions()).toHaveLength(1);
  await act(async () => finish(status)); expect(actions()).toEqual(["storage_status", "storage_status"]);
  await act(async () => { updated(); updated(); });
  await act(async () => root.unmount());
  await act(async () => vi.advanceTimersByTimeAsync(300)); expect(actions()).toHaveLength(2);
});
