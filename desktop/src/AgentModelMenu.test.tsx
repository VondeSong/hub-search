// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentModelMenu } from "./AgentModelMenu";
import type { AssistantOptions } from "./AgentAssistantOptions";
import { resetCodexSuiteForTests, type CodexModel, type ModelProvider } from "./CodexSuite";
import { loadAgentModelPreference, rememberAgentModelPreference } from "./AgentPreferences";

const { invoke, runtime } = vi.hoisted(() => ({
  invoke: vi.fn(),
  runtime: { loaded: true, settings: { provider: "codex", model: "sol", reasoningEffort: "medium", fast: false, maxConcurrent: 2 } },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./CodexSuite", async original => ({ ...await original<object>(), useCodexSuite: () => runtime }));

let host: HTMLDivElement, root: Root;
let catalogs: Record<ModelProvider, CodexModel[]>;
const save = vi.fn<(value: AssistantOptions) => Promise<void>>();
const options = (model = "sol", provider: ModelProvider = "codex", reasoningEffort = "high", fast = false): AssistantOptions => ({
  model: { provider, model, reasoningEffort, fast, maxConcurrent: 2 },
  autoFlashcardInbox: false, webSearch: "disabled",
});

function Harness({ initial }: { initial: AssistantOptions }) {
  const [value, setValue] = useState(initial);
  return <AgentModelMenu value={value} disabled={false} onSave={async next => { await save(next); setValue(next); }} />;
}

beforeEach(() => {
  resetCodexSuiteForTests(); localStorage.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  catalogs = {
    codex: [
      { id: "sol", name: "Sol", reasoningLevels: ["low", "medium", "high"], defaultReasoning: "medium", fastDescription: "提供方的实际 Fast 说明" },
      { id: "plain", name: "普通模型", reasoningLevels: ["low", "high"], defaultReasoning: "low" },
      { id: "fixed-fast", name: "固定强度模型", reasoningLevels: ["high"], defaultReasoning: "high", fastDescription: "可选择 Fast" },
      { id: "fast-no-effort", name: "无推理档位模型", fastDescription: "可选择 Fast" },
    ],
    deepseek: [{ id: "deepseek-flash", name: "DeepSeek Flash", reasoningLevels: ["none", "low", "high", "max"], defaultReasoning: "high" }],
  };
  invoke.mockReset().mockImplementation(async (_command, { args }) => ({ models: catalogs[args.provider as ModelProvider] }));
  save.mockReset().mockResolvedValue();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function render(initial = options()) { await act(async () => root.render(<Harness initial={initial} />)); }
const details = (kind: "effort" | "model") => host.querySelector<HTMLDetailsElement>(`.agent-option-${kind}`)!;
const summary = (kind: "effort" | "model") => details(kind).querySelector("summary")!;
async function open(kind: "effort" | "model") {
  await act(async () => { details(kind).open = true; details(kind).dispatchEvent(new Event("toggle")); });
}
async function browse(_provider: ModelProvider) { await open("model"); }

async function choose(id: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(`.agent-model-list button[title="${id}"]`)!.click());
}
async function setRange(index: number, _interaction: "pointer" | "assistive" = "pointer") {
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.agent-effort-levels button')[index].click());
}

it("uses DeepSeek's actual effort levels and never exposes speed, even with a malformed speed hint", async () => {
  catalogs.deepseek[0].fastDescription = "not a DeepSeek capability";
  await render(options("deepseek-flash", "deepseek")); await open("effort");
  expect(host.querySelectorAll('.agent-effort-levels button').length).toBe(4);
  expect(host.querySelector('[aria-label="快速模式"]')).toBeNull();
  expect(host.querySelector(".agent-speed-setting")).toBeNull();
  expect(host.querySelector(".agent-model-fast-active")).toBeNull();
  expect(host.textContent).not.toContain("标准速度");
  await setRange(0, "assistive");
  expect(save).toHaveBeenCalledExactlyOnceWith(options("deepseek-flash", "deepseek", "none"));
  expect(summary("effort").getAttribute("aria-label")).toContain("关闭思考");
});

it("hides speed for Codex models that do not advertise Fast", async () => {
  await render(options("plain")); await open("effort");
  expect(host.querySelector('[aria-label="推理强度"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="快速模式"]')).toBeNull();
  expect(host.querySelector(".agent-speed-setting")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("does not resubmit a stale Fast flag after the model loses that capability", async () => {
  await render(options("plain", "codex", "high", true)); await open("effort");
  await setRange(0);
  expect(save).toHaveBeenCalledExactlyOnceWith(options("plain", "codex", "low", false));
  expect(host.querySelector(".agent-model-fast-active")).toBeNull();
});

it.each([["fixed-fast", "high"], ["fast-no-effort", ""]])("keeps real Fast in model settings for %s without inventing reasoning levels", async (model, effort) => {
  const initial = options(model, "codex", effort);
  await render(initial); await open("model");
  expect(details("effort").hidden).toBe(model==="fast-no-effort");
  expect(host.querySelectorAll(".agent-effort-levels button").length).toBeLessThanOrEqual(1);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="快速模式"]')!.click());
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...initial, model: { ...initial.model!, fast: true } });
  expect(summary("model").getAttribute("aria-label")).toContain("Fast 已开启");
  expect(host.querySelector(".agent-model-fast-active")).not.toBeNull();
  expect(runtime.settings.fast).toBe(false);
  expect(invoke.mock.calls.every(([, value]) => value.args.action === "models")).toBe(true);
});

it("shows the model before textual reasoning depth, with only the depth carrying an arrow", async()=>{
  await render();
  expect([...host.querySelector('.agent-model-controls')!.children].map(e=>e.classList.contains('agent-option-model'))).toEqual([true,false]);
  expect(summary('model').querySelector('svg')).toBeNull();
  expect(summary('effort').textContent).toBe('高');
  expect(summary('effort').querySelector('.agent-reasoning-bars')).toBeNull();
  expect(summary('effort').querySelector('svg')).not.toBeNull();
  await open('model'); await choose('plain');
  expect(details('model').open).toBe(true);
  await open('effort');
  expect(details('model').open).toBe(false);
  expect(details('effort').open).toBe(true);
  expect(summary('effort').textContent).toBe('低');
});

it("restores each provider/model preference when switching back, without changing other options", async () => {
  await render({ ...options("sol", "codex", "high", true), autoFlashcardInbox: true });
  await browse("codex"); await choose("plain");
  expect(save).toHaveBeenLastCalledWith({ ...options("plain", "codex", "low"), autoFlashcardInbox: true });
  await browse("deepseek"); await choose("deepseek-flash"); await open("effort"); await setRange(3);
  expect(save).toHaveBeenLastCalledWith({ ...options("deepseek-flash", "deepseek", "max"), autoFlashcardInbox: true });
  await browse("codex"); await choose("sol");
  expect(save).toHaveBeenLastCalledWith({ ...options("sol", "codex", "high", true), autoFlashcardInbox: true });
  await browse("deepseek"); await choose("deepseek-flash");
  expect(save).toHaveBeenLastCalledWith({ ...options("deepseek-flash", "deepseek", "max"), autoFlashcardInbox: true });
});

it("revalidates remembered reasoning and speed against the current catalog", async () => {
  rememberAgentModelPreference({ provider: "codex", model: "plain", reasoningEffort: "ultra", fast: true, maxConcurrent: 2 });
  await render(); await browse("codex"); await choose("plain");
  expect(save).toHaveBeenLastCalledWith(options("plain", "codex", "low", false));
});

it("does not remember an attempted model change when the actual save fails", async () => {
  await render(); await browse("codex"); save.mockRejectedValueOnce(new Error("保存失败")); await choose("plain");
  expect(details("model").open).toBe(true);
  expect(summary("model").textContent).toBe("Sol");
  expect(loadAgentModelPreference("codex", "plain")).toBeNull();
  expect(loadAgentModelPreference("codex", "sol")).toBeNull();
  expect(details("model").querySelector('[role="alert"]')?.textContent).toContain("保存失败");
});

it("keeps inherited global settings intact when setting or clearing a conversation override", async () => {
  await render({ model: null, autoFlashcardInbox: true, webSearch: "cached", externalMcp: true });
  await open("effort");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="快速模式"]')!.click());
  expect(save).toHaveBeenLastCalledWith({ model: { ...runtime.settings, fast: true }, autoFlashcardInbox: true, webSearch: "cached", externalMcp: true });
  await open("model"); await act(async () => host.querySelector<HTMLButtonElement>(".agent-model-default")!.click());
  expect(save).toHaveBeenLastCalledWith({ model: null, autoFlashcardInbox: true, webSearch: "cached", externalMcp: true });
  expect(runtime.settings.fast).toBe(false);
  expect(host.querySelector(".agent-model-fast-active")).toBeNull();
});

it("dismisses effort choices with focus restored without saving", async () => {
  await render(); await open("effort");
  const choice=host.querySelector<HTMLButtonElement>('.agent-effort-levels button')!;
  await act(async()=>{choice.focus();choice.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));});
  expect(save).not.toHaveBeenCalled();expect(details("effort").open).toBe(false);expect(document.activeElement).toBe(summary("effort"));
});
