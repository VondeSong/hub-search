import type { AssistantOptions } from "./AgentAssistantOptions";

const key = "hub.agent.preferences.v1";
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
  localStorage.setItem(key, JSON.stringify({ model: value.model, webSearch: value.webSearch ?? "disabled" }));
}
