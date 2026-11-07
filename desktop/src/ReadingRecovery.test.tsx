// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReadingRecovery, type ReadingRecoveryOutcome, type ReadingRecoveryPlan } from "./ReadingRecovery";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let root: Root, host: HTMLDivElement;
const plan: ReadingRecoveryPlan = {
  token: "scope", postHash: "body", total: 2, downloadBytes: 1048576, actionable: true,
  warnings: [], previous: "", checkedAt: 0,
  items: [
    { url: "https://example.invalid/photo.png", state: "check", bytes: 1048576, reason: "待读取云端并校验" },
    { url: "https://example.invalid/video.mp4", state: "excluded", bytes: 12345, reason: "未包含音视频或 ZIP" },
  ],
};
const complete: ReadingRecoveryOutcome = { plan, bodyVerified: true, verified: 2, complete: true, checkedAt: 1700000000, failures: [] };
const button = (name: string) => [...host.querySelectorAll("button")].find(value => value.textContent === name);
const mount = async (key = "article", revision?: string) => { await act(async () => root.render(<ReadingRecovery itemKey={key} revision={revision} />)); };
const click = async (name: string) => { await act(async () => button(name)!.click()); };
const ready = async () => { invoke.mockResolvedValue(plan); await mount(); await click("预览云端检查范围"); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("requires an explicit preview and separate cloud check without requesting on mount", async () => {
  invoke.mockResolvedValue(plan); await mount(); expect(invoke).not.toHaveBeenCalled();
  expect(button("检查云端恢复")).toBeUndefined();
  await click("预览云端检查范围");
  expect(invoke).toHaveBeenCalledWith("preview_reading_recovery", { key: "article", includeExtras: false });
  expect(host.textContent).toContain("1.0 MB");
  expect(host.textContent).toContain("不写入本机附件缓存");
  expect(invoke.mock.calls.some(([command]) => command === "check_reading_recovery")).toBe(false);
  invoke.mockResolvedValue(complete); await click("检查云端恢复");
  expect(invoke).toHaveBeenCalledWith("check_reading_recovery", { key: "article", includeExtras: false, token: "scope" });
  expect(host.textContent).toContain("本次当前已同步版本的正文及全部登记原附件通过云端读取校验");
  expect(host.textContent).toContain("独立的来源恢复凭证和删除前复核");
});

it("reports partial success and body failures without presenting complete recovery", async () => {
  await ready();
  invoke.mockResolvedValue({ ...complete, bodyVerified: false, verified: 1, complete: false, failures: ["正文云副本缺失", "每日额度不足"] });
  await click("检查云端恢复");
  expect(host.textContent).toContain("原附件已校验 1 / 2 个");
  expect(host.textContent).toContain("正文校验尚未通过");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("正文云副本缺失\n每日额度不足");
  expect(host.textContent).not.toContain("正文及全部登记原附件通过云端读取校验");
});

it("requires a fresh preview after the optional audio video ZIP selection changes", async () => {
  await ready();
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button("检查云端恢复")).toBeUndefined();
  await click("预览云端检查范围");
  expect(invoke).toHaveBeenLastCalledWith("preview_reading_recovery", { key: "article", includeExtras: true });
});

it("disables cloud checking when the backend requires attachment sync to be enabled", async () => {
  invoke.mockResolvedValue({ ...plan, actionable: false, warnings: ["请先开启阅读附件同步，再执行原附件恢复检查"] });
  await mount(); await click("预览云端检查范围");
  expect(button("检查云端恢复")!.disabled).toBe(true);
  expect(host.textContent).toContain("请先开启阅读附件同步");
  await click("检查云端恢复");
  expect(invoke.mock.calls.some(([command]) => command === "check_reading_recovery")).toBe(false);
});

it("discards old article responses and shows previous completion only as history", async () => {
  let resolve!: (value: ReadingRecoveryPlan) => void;
  invoke.mockImplementation(() => new Promise(value => { resolve = value; }));
  await mount("old"); await click("预览云端检查范围"); await mount("new");
  await act(async () => resolve({ ...plan, previous: "complete" }));
  expect(button("检查云端恢复")).toBeUndefined();
  invoke.mockResolvedValue({ ...plan, previous: "complete" });
  await click("预览云端检查范围");
  expect(host.textContent).toContain("已有上次检查记录");
  expect(host.textContent).not.toContain("正文及全部登记原附件通过云端读取校验");
});

it("withdraws stale plans and in-flight results when reading data or this article attachments change", async () => {
  await ready();
  await act(async () => window.dispatchEvent(new CustomEvent("hub:reading-attachment-ready", { detail: "another" })));
  expect(button("检查云端恢复")).toBeDefined();
  await act(async () => window.dispatchEvent(new CustomEvent("hub:reading-attachment-ready", { detail: "article" })));
  expect(button("检查云端恢复")).toBeUndefined();
  await click("预览云端检查范围");
  let resolve!: (value: ReadingRecoveryOutcome) => void;
  invoke.mockImplementation(() => new Promise(value => { resolve = value; }));
  await click("检查云端恢复");
  await act(async () => window.dispatchEvent(new Event("hub:reading-data-changed")));
  await act(async () => resolve(complete));
  expect(button("检查云端恢复")).toBeUndefined();
  expect(host.textContent).not.toContain("正文及全部登记原附件通过云端读取校验");
});

it("discards rejected stale scopes and keeps interruption distinct from verified completion", async () => {
  invoke.mockResolvedValue({ ...plan, previous: "interrupted", warnings: ["正文仍可能不完整"] });
  await mount(); await click("预览云端检查范围");
  expect(host.textContent).toContain("上次检查被中断");
  expect(host.textContent).toContain("正文仍可能不完整");
  invoke.mockRejectedValue("正文或云空间已变化，请重新预览"); await click("检查云端恢复");
  expect(button("检查云端恢复")).toBeUndefined();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("请重新预览");
  expect(host.textContent).not.toContain("正文及全部登记原附件通过云端读取校验");
});

it("keeps equal revisions stable and withdraws completed or in-flight checks after same-article changes", async () => {
  invoke.mockResolvedValue(plan); await mount("article", "v1"); await click("预览云端检查范围");
  invoke.mockResolvedValue(complete); await click("检查云端恢复");
  const calls = invoke.mock.calls.length;
  await mount("article", "v1");
  expect(host.textContent).toContain("正文及全部登记原附件通过云端读取校验");
  expect(invoke).toHaveBeenCalledTimes(calls);
  await mount("article", "v2");
  expect(host.textContent).not.toContain("正文及全部登记原附件通过云端读取校验");
  expect(button("检查云端恢复")).toBeUndefined();
  expect(invoke).toHaveBeenCalledTimes(calls);
  invoke.mockResolvedValue(plan); await click("预览云端检查范围");
  let resolve!: (value: ReadingRecoveryOutcome) => void;
  invoke.mockImplementation(() => new Promise(value => { resolve = value; }));
  await click("检查云端恢复");
  await mount("article", "v3");
  await act(async () => resolve(complete));
  expect(host.textContent).not.toContain("正文及全部登记原附件通过云端读取校验");
  expect(button("检查云端恢复")).toBeUndefined();
  expect(invoke).toHaveBeenCalledTimes(calls + 2);
});
