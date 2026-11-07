// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReadingSourceRecovery, ReadingSourceCleanupSettings } from "./ReadingSourceRecovery";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let root: Root, host: HTMLDivElement;
const plan = { token: "source-bound", downloadBytes: 1024, sourceBytes: 128, cleanupEnabled: false, recovery: { total: 1, actionable: true, warnings: [] } };
const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
const mount = async (key = "dida:original", revision = "first") => { await act(async () => root.render(<ReadingSourceRecovery itemKey={key} revision={revision} />)); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("does not request or expose source recovery for unrelated reading items", async () => {
  await mount("x:article"); expect(host.textContent).toBe(""); expect(invoke).not.toHaveBeenCalled();
});
it("requires source preview before saving a cloud proof and preserves originals", async () => {
  await mount(); expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValue(plan); await click("查看要检查的内容");
  expect(invoke).toHaveBeenCalledWith("preview_reading_source_recovery", { key: "dida:original" });
  invoke.mockResolvedValue({ complete: true, checkedAt: 1, verified: 1, total: 1, failures: [] });
  await click("检查云端备份");
  expect(invoke).toHaveBeenCalledWith("check_reading_source_recovery", { key: "dida:original", token: "source-bound" });
  expect(host.textContent).toContain("这次检查不会删除滴答里的原内容");
  expect(host.textContent).toContain("正文和全部附件都已确认可以从云端完整取回");
  expect(invoke.mock.calls.some(([cmd]) => cmd === "delete_task")).toBe(false);
});
it("shows partial source failure and withdraws in-flight results on a same-item change", async () => {
  invoke.mockResolvedValue(plan); await mount(); await click("查看要检查的内容");
  invoke.mockResolvedValue({ complete: false, checkedAt: 1, verified: 0, total: 1, failures: ["云端原件缺失"] });
  await click("检查云端备份");
  expect(host.textContent).toContain("云端备份还没全部检查通过"); expect(host.querySelector('[role="alert"]')?.textContent).toBe("云端原件缺失");
  let resolve!: (value: unknown) => void;
  invoke.mockImplementation(() => new Promise(r => { resolve = r; }));
  await click("检查云端备份"); await mount("dida:original", "changed");
  await act(async () => resolve({ complete: true, checkedAt: 1, verified: 1, total: 1, failures: [] }));
  expect(host.textContent).not.toContain("正文和全部附件都已确认可以从云端完整取回");
  expect(button("检查云端备份")).toBeUndefined();
});
it("does not turn on cleanup optimistically when saving the explicit device choice fails", async () => {
  invoke.mockResolvedValue(false);
  await act(async () => root.render(<ReadingSourceCleanupSettings blocked={false} />));
  const input = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(input.checked).toBe(false);
  invoke.mockRejectedValue("阅读云同步已暂停"); await act(async () => input.click());
  expect(invoke).toHaveBeenLastCalledWith("set_reading_source_cleanup", { enabled: true });
  expect(input.checked).toBe(false); expect(host.querySelector('[role="alert"]')?.textContent).toContain("已暂停");
});
it("explains unavailable attachment lists and keeps the delete switch disabled until reading cloud sync is available", async () => {
  invoke.mockResolvedValue(false);
  await act(async () => root.render(<ReadingSourceCleanupSettings blocked unavailableReason="请先开启本设备的云同步和阅读云同步，再开启同步后删除。" />));
  const input = host.querySelector<HTMLInputElement>('input[aria-label="保存完整后，删除滴答里的原内容"]')!;
  expect(input.disabled).toBe(true); expect(input.checked).toBe(false);
  expect(host.textContent).toContain("没有返回附件列表，不等于没有附件，也不代表附件丢失");
  expect(host.textContent).toContain("正文和全部附件在本机与云端都检查通过");
  await act(async () => input.click());
  expect(invoke.mock.calls.some(([command]) => command === "set_reading_source_cleanup")).toBe(false);
});
