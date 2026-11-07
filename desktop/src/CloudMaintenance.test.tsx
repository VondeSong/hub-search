// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudMaintenance, type CloudMaintenancePlan, type CloudMaintenanceStatus } from "./CloudMaintenance";
const { invoke, capability } = vi.hoisted(() => ({ invoke: vi.fn(), capability: { desktop: true, mobile: false } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: capability }));
let root: Root, host: HTMLDivElement;
const scope: CloudMaintenancePlan = {
  token: "exact-scope", purpose: "cleanup", state: "preview", phase: "read", objects: 4, read: 0,
  checkpoints: 0, verified: 0, deleted: 0, stagedBytes: 0, createdAt: 1, completedAt: 0,
  canAdvance: true, canClean: false, canRestore: false, errors: [], modules: [],
};
const ready: CloudMaintenancePlan = { ...scope, state: "ready", phase: "ready", read: 4, checkpoints: 2, verified: 2, canAdvance: false, canClean: true, canRestore: true };
const done: CloudMaintenancePlan = { ...ready, state: "complete", phase: "done", deleted: 3, canClean: false };
const device = (local: boolean) => ({ device: local ? "local" : "other", label: local ? "Windows · 本机" : "Android · 手机", platform: local ? "Windows" : "Android", local, lastSeenAt: 0, retired: false, longOffline: !local, confirmedCheckpoint: "" });
const status: CloudMaintenanceStatus = { supported: true, currentDevice: "local", confirmedCheckpoint: "", devices: [device(true), device(false)], plan: null };
const button = (name: string) => [...host.querySelectorAll("button")].find(value => value.textContent === name);
const mount = async () => { await act(async () => root.render(<CloudMaintenance />)); };
const click = async (name: string) => { await act(async () => button(name)!.click()); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  capability.desktop = true; capability.mobile = false;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockReset(); invoke.mockImplementation(async command => command === "get_cloud_maintenance_status" ? status : scope);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("loads local progress without making cloud requests or automatically starting maintenance", async () => {
  await mount(); expect(invoke.mock.calls.map(([command]) => command)).toEqual(["get_cloud_maintenance_status"]);
  expect(button("清理已覆盖历史")).toBeUndefined();
  await click("预览历史清理范围"); expect(invoke).toHaveBeenCalledWith("preview_cloud_history_cleanup");
  expect(button("准备并核验检查点")).toBeDefined();
  expect(invoke.mock.calls.some(([command]) => command === "advance_cloud_history_cleanup" || command === "clean_cloud_history")).toBe(false);
});

it("stops after preparing verified checkpoints and requires separate explicit deletion agreement", async () => {
  invoke.mockImplementation(async command => command === "get_cloud_maintenance_status" ? status : command === "advance_cloud_history_cleanup" ? ready : command === "clean_cloud_history" ? done : scope);
  await mount(); await click("预览历史清理范围"); await click("准备并核验检查点");
  expect(invoke).toHaveBeenCalledWith("advance_cloud_history_cleanup", { token: "exact-scope" });
  expect(invoke.mock.calls.some(([command]) => command === "clean_cloud_history")).toBe(false);
  expect(button("清理已覆盖历史")!.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click("清理已覆盖历史"); expect(invoke).toHaveBeenCalledWith("clean_cloud_history", { token: "exact-scope" });
  expect(host.textContent).toContain("已清理 3 项");
  expect(host.textContent).toContain("全部附件文件");
});

it("retains partial progress and stops further network rounds on reported failure", async () => {
  invoke.mockImplementation(async command => command === "get_cloud_maintenance_status" ? { ...status, plan: ready } : { ...ready, state: "partial", phase: "delete", deleted: 1, errors: ["部分历史仍保留：没有删除权限"] });
  await mount(); await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click("清理已覆盖历史");
  expect(invoke.mock.calls.filter(([command]) => command === "clean_cloud_history")).toHaveLength(1);
  expect(host.textContent).toContain("已清理 1 项"); expect(host.textContent).toContain("没有删除权限");
  expect(button("清理已覆盖历史")).toBeDefined();
});

it("permits mobile recovery while hiding retirement and destructive maintenance controls", async () => {
  capability.desktop = false; capability.mobile = true;
  const restoreScope = { ...scope, purpose: "restore" as const };
  const restoreReady = { ...ready, purpose: "restore" as const, phase: "restoreReady", canClean: false };
  invoke.mockImplementation(async command => command === "get_cloud_maintenance_status" ? status : command === "advance_cloud_restore" ? restoreReady : command === "restore_cloud_history" ? { ...done, purpose: "restore", deleted: 0 } : restoreScope);
  await mount(); expect(button("标记退休")).toBeUndefined(); expect(button("预览历史清理范围")).toBeUndefined();
  await click("预览恢复范围"); await click("检查恢复范围"); await click("恢复并确认本设备");
  expect(invoke).toHaveBeenCalledWith("preview_cloud_restore");
  expect(invoke).toHaveBeenCalledWith("advance_cloud_restore", { token: "exact-scope" });
  expect(invoke).toHaveBeenCalledWith("restore_cloud_history", { token: "exact-scope" });
  expect(invoke.mock.calls.some(([command]) => ["clean_cloud_history", "set_cloud_device_retired", "advance_cloud_history_cleanup"].includes(command))).toBe(false);
  expect(host.textContent).toContain("附件仍按现有下载策略获取");
});

it("offers retirement only for another device and keeps it distinct from credential revocation", async () => {
  invoke.mockImplementation(async command => command === "set_cloud_device_retired" ? { ...status, devices: [device(true), { ...device(false), retired: true }] } : status);
  await mount(); expect(host.querySelectorAll("li button")).toHaveLength(1);
  expect(host.textContent).toContain("长期离线"); await click("标记退休");
  expect(invoke).toHaveBeenCalledWith("set_cloud_device_retired", { device: "other", retired: true });
  expect(host.textContent).toContain("已标记退休"); expect(host.textContent).toContain("不会删除本机内容或撤销云服务密钥");
});

it("resumes an interrupted durable preparation and discards old responses after cloud scope changes", async () => {
  let resolve!: (value: CloudMaintenancePlan) => void;
  invoke.mockImplementation(command => command === "get_cloud_maintenance_status" ? Promise.resolve({ ...status, plan: scope }) : new Promise(value => { resolve = value; }));
  await mount(); await click("准备并核验检查点");
  expect(invoke).toHaveBeenCalledWith("advance_cloud_history_cleanup", { token: "exact-scope" });
  invoke.mockImplementation(async () => status);
  await act(async () => window.dispatchEvent(new Event("hub:cloud-data-changed")));
  await act(async () => resolve(ready));
  expect(button("清理已覆盖历史")).toBeUndefined();
  expect(host.textContent).not.toContain("已验证检查点 2/2");
});

it("can release local maintenance scratch while cloud transfers are paused without making cloud calls", async () => {
  const released = { ...scope, state: "cancelled", phase: "released", canAdvance: false };
  invoke.mockImplementation(async command => command === "get_cloud_maintenance_status" ? { ...status, plan: scope } : { ...status, plan: released });
  await act(async () => root.render(<CloudMaintenance blocked />));
  expect(button("预览恢复范围")!.disabled).toBe(true);
  expect(button("释放本机维护暂存")!.disabled).toBe(false);
  await click("释放本机维护暂存");
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["get_cloud_maintenance_status", "release_cloud_maintenance"]);
  expect(host.textContent).toContain("云记录、阅读内容和附件文件均保留");
  expect(button("准备并核验检查点")).toBeUndefined();
});
