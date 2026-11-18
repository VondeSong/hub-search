import type { AssistantOptions } from "./AgentAssistantOptions";
import type { CodexSettings, ModelProvider } from "./CodexSuite";

const key = "hub.agent.preferences.v1";
const modelsKey = "hub.agent.model-preferences.v1";
const memoryKey = "hub.agent.memory-preferences.v1";
export type MemorySelection = { projectId: string; enabled: boolean };

export function loadMemoryPreference(): MemorySelection {
  try {
    const saved = JSON.parse(localStorage.getItem(memoryKey) || "null");
    if (saved && typeof saved.projectId === "string" && saved.projectId.length <= 100 && typeof saved.enabled === "boolean") {
      return { projectId: saved.projectId, enabled: saved.enabled };
    }
  } catch { /* Missing or invalid preferences never opt a new chat into memory. */ }
  return { projectId: "", enabled: false };
}
export function rememberMemoryPreference(selection: MemorySelection) {
  try { localStorage.setItem(memoryKey, JSON.stringify(selection)); }
  catch { /* The current conversation can still use its explicit selection. */ }
}
type ModelPreference = { provider: ModelProvider; model: string; reasoningEffort: string; fast: boolean };

function readModelPreferences(): ModelPreference[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(modelsKey) || "null");
    if (!Array.isArray(saved)) return [];
    return saved.slice(0, 64).filter((value): value is ModelPreference =>
      !!value && typeof value === "object" &&
      ["codex", "deepseek"].includes(value.provider) &&
      typeof value.model === "string" && value.model.length > 0 && value.model.length <= 200 &&
      typeof value.reasoningEffort === "string" && value.reasoningEffort.length <= 40 &&
      typeof value.fast === "boolean"
    );
  } catch { return []; }
}

/** These are display preferences, never permissions or a substitute for the current model catalog. */
export function loadAgentModelPreference(provider: ModelProvider, model: string) {
  const saved = readModelPreferences().find(value => value.provider === provider && value.model === model);
  return saved ? { reasoningEffort: saved.reasoningEffort, fast: saved.fast } : null;
}

export function rememberAgentModelPreference(settings: CodexSettings | null) {
  if (!settings?.model) return;
  const provider = settings.provider ?? "codex";
  const value: ModelPreference = { provider, model: settings.model, reasoningEffort: settings.reasoningEffort, fast: provider === "codex" && settings.fast };
  try {
    const previous = readModelPreferences().filter(item => item.provider !== provider || item.model !== value.model);
    localStorage.setItem(modelsKey, JSON.stringify([value, ...previous].slice(0, 64)));
  } catch { /* A full or unavailable preference store must not turn a successful model save into a failure. */ }
}

export function loadAgentPreferences(): AssistantOptions {
  const defaults: AssistantOptions = { model: null, autoFlashcardInbox: false, webSearch: "live", researchPolicy:"material-first" };
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved || typeof saved !== "object") return defaults;
    const model = saved.model;
    if (model && [undefined, "codex", "deepseek"].includes(model.provider) && typeof model.model === "string" && model.model.length <= 200 && typeof model.reasoningEffort === "string" && model.reasoningEffort.length <= 40 && typeof model.fast === "boolean" && Number.isInteger(model.maxConcurrent) && model.maxConcurrent >= 1 && model.maxConcurrent <= 32) {
      defaults.model = { provider: model.provider, model: model.model, reasoningEffort: model.reasoningEffort, fast: model.fast, maxConcurrent: model.maxConcurrent };
    }
    defaults.webSearch = defaults.model?.provider === "deepseek" ? "disabled" : loadCodexWebSearchPreference();
  } catch { /* Invalid or unavailable storage falls back to new-chat defaults. */ }
  return defaults;
}
export function loadCodexWebSearchPreference(): NonNullable<AssistantOptions["webSearch"]> {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (["disabled", "cached", "live"].includes(saved?.codexWebSearch)) return saved.codexWebSearch;
    const value = saved?.model?.provider !== "deepseek" ? saved?.webSearch : undefined;
    if (["disabled", "cached", "live"].includes(value)) return value;
  } catch { /* Missing or invalid preferences use the normal new-chat default. */ }
  return "live";
}

export function rememberAgentPreferences(value: AssistantOptions, previous?: AssistantOptions, inheritedProvider: ModelProvider = "codex") {
  // Only preferences carry forward; material grants, MCP and saving permissions never do.
  const provider = value.model ? value.model.provider ?? "codex" : inheritedProvider;
  const previousProvider = previous?.model ? previous.model.provider ?? "codex" : inheritedProvider;
  // DeepSeek's capability restriction must not become the user's Codex preference.
  const codexWebSearch = provider === "codex" ? value.webSearch ?? "disabled"
    : previous && previousProvider === "codex" ? previous.webSearch ?? "disabled"
    : loadCodexWebSearchPreference();
  try { localStorage.setItem(key, JSON.stringify({ model: value.model, webSearch: provider === "deepseek" ? "disabled" : codexWebSearch, codexWebSearch })); }
  catch { /* Saving the actual conversation does not depend on browser preference storage. */ }
  rememberAgentModelPreference(value.model);
}
