// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseMaintenanceSection } from "./DatabaseMaintenanceSection";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const preview = { reclaimableBytes: 1024 ** 3, requiredFreeBytes: 4 * 1024 ** 3, availableFreeBytes: 8 * 1024 ** 3 };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => command === "get_local_database_maintenance" ? { preview, status: null }
    : { phase: command === "schedule_local_database_maintenance" ? "requested" : "cancelled", error: "", beforeBytes: 0, afterBytes: 0 });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("arranges next-startup maintenance and can cancel without running compaction in the current UI", async () => {
  await act(async () => root.render(<DatabaseMaintenanceSection />));
  expect(host.textContent).toContain("预计可释放 1.0 GB");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.textContent).toContain("已安排，下次启动时整理");
  expect(host.querySelector("button")?.textContent).toBe("取消安排");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["get_local_database_maintenance", "schedule_local_database_maintenance", "cancel_local_database_maintenance"]);
  expect(host.querySelector("button")?.textContent).toBe("安排下次启动整理");
});
it("keeps insufficient-space devices from scheduling maintenance", async () => {
  invoke.mockResolvedValue({ preview: { ...preview, availableFreeBytes: 1 }, status: null });
  await act(async () => root.render(<DatabaseMaintenanceSection />));
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  expect(host.textContent).toContain("可用空间不足");
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("keeps the pending request visible when cancellation fails", async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === "get_local_database_maintenance") return { preview, status: { phase: "requested", error: "" } };
    throw new Error("暂时无法取消");
  });
  await act(async () => root.render(<DatabaseMaintenanceSection />));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.querySelector("button")?.textContent).toBe("取消安排");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("暂时无法取消");
});
