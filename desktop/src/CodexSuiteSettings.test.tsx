// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodexSuiteSettings } from "./CodexSuiteSettings";
import { CodexDefinitionModel } from "./CodexDefinitionModel";
import { refreshCodexSuite, resetCodexSuiteForTests, saveCodexSuite, type CodexSnapshot } from "./CodexSuite";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root, snapshot: CodexSnapshot;
const models = [{ id: "fast-model", name: "Fast model", reasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoning: "medium", fastDescription: "2x speed, increased usage" }, { id: "standard-model", name: "Standard model", reasoningLevels: ["low"], defaultReasoning: "low" }];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); resetCodexSuiteForTests();
  snapshot = { settings: { model: "", reasoningEffort: "", fast: false, maxConcurrent: 2 }, jobs: [], revision: 1 };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockReset().mockImplementation(async (command, { args }) => {
    expect(command).toBe("model_runtime");
    if (args.action === "models") return { models };
    if (args.action === "codexAccounts") return { selected: "desktop", accounts: [], current: { label: "t***@example.invalid", scopeId: "a".repeat(64), kind: "chatgpt", plan: "plus" } };
    if (args.action === "save") snapshot = { ...snapshot, settings: args.settings, revision: snapshot.revision + 1 };
    return snapshot;
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetCodexSuiteForTests(); vi.useRealTimers(); });
const select = async (label: string, value: string) => { const input = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("change", { bubbles: true })); }); };
const saveButton = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "保存模型设置")!;

it("loads one shared snapshot, and catalog only when settings are opened", async () => {
  await act(async () => root.render(<><CodexDefinitionModel /><CodexDefinitionModel /></>));
  expect(invoke.mock.calls.filter(([, value]) => value.args.action === "get")).toHaveLength(1);
  expect(invoke.mock.calls.some(([, value]) => value.args.action === "models")).toBe(false);
  await act(async () => root.render(<><CodexDefinitionModel /><CodexSuiteSettings /></>));
  expect(invoke.mock.calls.filter(([, value]) => value.args.action === "models")).toHaveLength(1);
  expect(host.textContent).toContain("CLI 默认模型");
});
it("saves model effort speed and concurrency once, immediately synchronizing other screens", async () => {
  await act(async () => root.render(<><CodexSuiteSettings /><CodexDefinitionModel /></>));
  await select("模型", "fast-model");
  expect(Array.from(host.querySelectorAll('[aria-label="推理强度"] option')).map(option => (option as HTMLOptionElement).value)).toEqual(["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  await select("推理强度", "ultra"); await select("速度", "fast"); await select("同时运行数量", "3");
  await act(async () => saveButton().click());
  expect(invoke).toHaveBeenCalledWith("model_runtime", { args: { action: "save", settings: { model: "fast-model", reasoningEffort: "ultra", fast: true, maxConcurrent: 3 } } });
  expect(host.querySelector('.codex-suite-summary')?.textContent).toContain("fast-model · Ultra · Fast");
  expect(saveButton().disabled).toBe(true);
  expect(localStorage.getItem("hub.codex.definition.model.v1")).toBeNull();
});
it("resets unsupported effort and Fast when changing models", async () => {
  snapshot.settings = { model: "fast-model", reasoningEffort: "max", fast: true, maxConcurrent: 2 };
  await act(async () => root.render(<CodexSuiteSettings />));
  await select("模型", "standard-model");
  expect(host.querySelector<HTMLSelectElement>('[aria-label="推理强度"]')?.value).toBe("");
  expect(host.querySelector<HTMLSelectElement>('[aria-label="速度"]')?.value).toBe("standard");
  expect(host.querySelector<HTMLSelectElement>('[aria-label="速度"]')?.disabled).toBe(true);
  await act(async () => saveButton().click());
  expect(snapshot.settings).toEqual({ model: "standard-model", reasoningEffort: "", fast: false, maxConcurrent: 2 });
});
it("keeps an unavailable persisted selection visible and blocks saving it", async () => {
  snapshot.settings.model = "removed-model";
  await act(async () => root.render(<CodexSuiteSettings />));
  expect(host.textContent).toContain("removed-model（当前不可用）");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("当前不可用");
  expect(saveButton().disabled).toBe(true);
  await select("模型", ""); expect(saveButton().disabled).toBe(false);
});
it("does not overwrite unsaved fields with polling, and stops polling after the last subscriber leaves", async () => {
  vi.useFakeTimers();
  await act(async () => root.render(<CodexSuiteSettings />));
  await select("模型", "fast-model");
  snapshot = { ...snapshot, settings: { ...snapshot.settings, model: "standard-model" }, revision: 2 };
  await act(async () => refreshCodexSuite());
  expect(host.querySelector<HTMLSelectElement>('[aria-label="模型"]')?.value).toBe("fast-model");
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(invoke.mock.calls.some(([, value]) => value.args.action === "status")).toBe(true);
  await act(async () => root.unmount()); const count = invoke.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(invoke.mock.calls).toHaveLength(count);
  root = createRoot(host);
});
it("rejects an older status snapshot after a newer saved selection", async () => {
  await act(async () => root.render(<CodexDefinitionModel />));
  const older = snapshot;
  await act(async () => saveCodexSuite({ model: "fast-model", reasoningEffort: "high", fast: true, maxConcurrent: 3 }));
  invoke.mockResolvedValue(older);
  await act(async () => refreshCodexSuite());
  expect(host.textContent).toContain("fast-model · 高 · Fast");
  expect(host.textContent).not.toContain("CLI 默认模型");
});

it("switches to a direct provider with its own catalog and hides unsupported Fast", async () => {
  invoke.mockImplementation(async (_command, { args }) => {
    if (args.action === "credentialStatus") return { deepseekConfigured: true };
    if (args.action === "models") return { models: args.provider === "deepseek" ? [{ id: "deepseek-flash", name: "DeepSeek Flash", reasoningLevels: ["none", "low", "high", "max"] }] : models };
    if (args.action === "save") snapshot = { ...snapshot, settings: args.settings, revision: snapshot.revision + 1 };
    return snapshot;
  });
  await act(async () => root.render(<CodexSuiteSettings />));
  await select("模型入口", "deepseek");
  expect(host.querySelector('[aria-label="DeepSeek API 密钥"]')?.getAttribute("type")).toBe("password");
  expect(host.querySelector('[aria-label="速度"]')).toBeNull();
  expect(host.textContent).toContain("DeepSeek Flash");
  expect(host.textContent).toContain("密钥已保存到系统凭据库");
  await act(async () => saveButton().click());
  expect(snapshot.settings).toEqual({ provider: "deepseek", model: "deepseek-flash", reasoningEffort: "none", fast: false, maxConcurrent: 2 });
  expect(invoke.mock.calls.some(([,value]) => value.args.action === "models" && value.args.provider === "deepseek")).toBe(true);
  expect(host.textContent).toContain("当前生效：DeepSeek");
});

it("a missing provider catalog blocks saving without overwriting the active provider", async () => {
  invoke.mockImplementation(async (_command, { args }) => {
    if (args.action === "credentialStatus") return { deepseekConfigured: false };
    if (args.action === "models") { if (args.provider === "deepseek") throw new Error("请先保存 DeepSeek API 密钥"); return { models }; }
    return snapshot;
  });
  await act(async () => root.render(<CodexSuiteSettings />));
  await select("模型入口", "deepseek");
  expect(saveButton().disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("API 密钥");
  expect(snapshot.settings.provider).toBeUndefined();
  expect(invoke.mock.calls.some(([,value]) => value.args.action === "save")).toBe(false);
});
