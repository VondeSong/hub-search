import type { AssistantOptions } from "./AgentAssistantOptions";
import type { CodexSettings, ModelProvider } from "./CodexSuite";

const key = "hub.agent.preferences.v1";
const modelsKey = "hub.agent.model-preferences.v1";
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
  const defaults: AssistantOptions = { model: null, autoFlashcardInbox: false, webSearch: "live" };
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved || typeof saved !== "object") return defaults;
    const model = saved.model;
    if (model && [undefined, "codex", "deepseek"].includes(model.provider) && typeof model.model === "string" && model.model.length <= 200 && typeof model.reasoningEffort === "string" && model.reasoningEffort.length <= 40 && typeof model.fast === "boolean" && Number.isInteger(model.maxConcurrent) && model.maxConcurrent >= 1 && model.maxConcurrent <= 32) {
      defaults.model = { provider: model.provider, model: model.model, reasoningEffort: model.reasoningEffort, fast: model.fast, maxConcurrent: model.maxConcurrent };
    }
    if (["disabled", "cached", "live"].includes(saved.webSearch)) defaults.webSearch = saved.webSearch;
  } catch { /* Invalid or unavailable storage falls back to new-chat defaults. */ }
  return defaults;
}
export function rememberAgentPreferences(value: AssistantOptions) {
  // Only preferences carry forward; material grants, MCP and saving permissions never do.
  try { localStorage.setItem(key, JSON.stringify({ model: value.model, webSearch: value.webSearch ?? "disabled" })); }
  catch { /* Saving the actual conversation does not depend on browser preference storage. */ }
  rememberAgentModelPreference(value.model);
}
