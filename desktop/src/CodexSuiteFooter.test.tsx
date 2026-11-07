// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexSuiteFooter } from "./CodexSuiteFooter";
import { refreshCodexSuite, resetCodexSuiteForTests, type CodexSnapshot } from "./CodexSuite";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root, snapshot: CodexSnapshot;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); resetCodexSuiteForTests();
  snapshot = { settings: { model: "gpt-test", reasoningEffort: "high", fast: false, maxConcurrent: 2 }, revision: 1, jobs: [
    { id: "run", workflow: "collection-craft", label: "Craft 归档", state: "running", model: "old-model", reasoningEffort: "low", fast: true },
    { id: "wait", workflow: "definition", label: "标签定义", state: "queued", model: "gpt-test", reasoningEffort: "high", fast: false },
    { id: "failed", workflow: "dida", label: "滴答转换", state: "failed", model: "gpt-test", reasoningEffort: "high", fast: false, error: "额度暂不可用", finishedAt: 10 },
  ] };
  invoke.mockReset().mockResolvedValue(snapshot); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetCodexSuiteForTests(); });
const open = async () => { await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="模型运行状态"]')!.click()); };
it("labels defaults separately and uses the sole active or last job selection in the status", async () => {
  snapshot = { ...snapshot, jobs: [{ ...snapshot.jobs[0], reasoningEffort: "xhigh" }] };
  invoke.mockResolvedValue(snapshot);
  await act(async () => root.render(<CodexSuiteFooter />));
  const title = () => host.querySelector('[aria-label="模型运行状态"]')!.getAttribute("title");
  expect(title()).toContain("old-model");
  expect(title()).not.toContain("gpt-test");
  await open();
  expect(host.querySelector('.codex-suite-popover > p')?.textContent).toContain("old-model");
  expect(host.textContent).toContain("默认设置：");
  snapshot = { ...snapshot, revision: 2, jobs: [{ ...snapshot.jobs[0], state: "succeeded", finishedAt: 50 }] };
  invoke.mockResolvedValue(snapshot);
  await act(async () => refreshCodexSuite());
  expect(title()).toContain("old-model");
  snapshot = { ...snapshot, revision: 3, jobs: [] };
  invoke.mockResolvedValue(snapshot);
  await act(async () => refreshCodexSuite());
  expect(title()).toContain("默认设置：");
});
it("presents actual concurrent jobs and their captured selections and errors", async () => {
  await act(async () => root.render(<CodexSuiteFooter />));
  expect(host.textContent).toContain("运行 1 · 等待 1 · 历史失败 1");
  await open(); expect(host.textContent).toContain("old-model · 轻度 · Fast");
  expect(host.textContent).toContain("额度暂不可用"); expect(host.textContent).toContain("资料库的写入与附件处理结果另行核验");
  snapshot = { ...snapshot, jobs: snapshot.jobs.map(job => job.id === "run" ? { ...job, state: "succeeded", finishedAt: 20 } : job), revision: 2 };
  invoke.mockResolvedValue(snapshot); await act(async () => refreshCodexSuite());
  expect(host.textContent).toContain("生成完成"); expect(host.textContent).toContain("额度暂不可用");
  expect(host.textContent).not.toContain("Craft 保存成功");
});
it("opens central settings and dismisses the details on outside focus", async () => {
  const settings = vi.fn(); window.addEventListener("hub:open-codex-settings", settings);
  await act(async () => root.render(<CodexSuiteFooter />)); await open();
  await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "模型与速度设置")!.click());
  expect(settings).toHaveBeenCalledOnce(); expect(host.querySelector('[role="dialog"]')).toBeNull();
  await open(); const outside = document.createElement("button"); document.body.append(outside);
  await act(async () => outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(host.querySelector('[role="dialog"]')).toBeNull(); outside.remove(); window.removeEventListener("hub:open-codex-settings", settings);
});
it("presents a cancelled operation without a generation failure warning", async () => {
  snapshot = { ...snapshot, jobs: [{ ...snapshot.jobs[0], state: 'cancelled', finishedAt: 30 }] };
  invoke.mockResolvedValue(snapshot);
  await act(async () => root.render(<CodexSuiteFooter />));
  expect(host.textContent).toContain('已停止，可继续');
  expect(host.textContent).not.toContain('生成失败');
  expect(host.querySelector('.has-error')).toBeNull();
});
it("presents a DeepSeek evidence failure with its captured provider and host error", async () => {
  snapshot = { ...snapshot, settings: { provider: "deepseek", model: "deepseek-flash", reasoningEffort: "none", fast: false, maxConcurrent: 2 }, jobs: [{ ...snapshot.jobs[0], provider: "deepseek", model: "deepseek-flash", reasoningEffort: "none", fast: false, state: "failed", finishedAt: 40, error: "调查结果未通过引文核验，未提交结果。" }] };
  invoke.mockResolvedValue(snapshot);
  await act(async () => root.render(<CodexSuiteFooter />)); await open();
  expect(host.textContent).toContain("DeepSeek");
  expect(host.textContent).toContain("调查结果未通过引文核验，未提交结果。");
  expect(host.textContent).not.toContain("Codex");
});
