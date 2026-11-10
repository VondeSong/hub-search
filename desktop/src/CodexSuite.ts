import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isWindowVisible, subscribeWindowVisibility } from "./WindowVisibility";
import { resetCodexAccountsForTests } from "./CodexAccounts";

export type ModelProvider = "codex" | "deepseek";
export type CodexSettings = { provider?: ModelProvider; model: string; reasoningEffort: string; fast: boolean; maxConcurrent: number };
export type CodexModel = { id: string; name: string; reasoningLevels?: string[]; defaultReasoning?: string | null; fastDescription?: string };
export type ModelExecution = { provider: string; outcome: string; elapsedMs: number; inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null };
export type CodexJob = { id: string; workflow: string; label: string; state: "queued" | "running" | "succeeded" | "failed" | "cancelled"; provider?: ModelProvider; model: string; reasoningEffort: string; fast: boolean; startedAt?: number; finishedAt?: number; error?: string; context?: string | null; progress?: { at: number; message: string }[]; executions?: ModelExecution[]; usage?: { calls: number; callsWithTokens: number; totalTokens: number } };
export type CodexSnapshot = { settings: CodexSettings; jobs: CodexJob[]; revision: number };
type Store = CodexSnapshot & { loaded: boolean; loading: boolean; error: string };
const initial = (): Store => ({ settings: { model: "", reasoningEffort: "", fast: false, maxConcurrent: 2 }, jobs: [], revision: 0, loaded: false, loading: false, error: "" });
let snapshot = initial();
let pending: Promise<CodexSnapshot> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let visibilityUnsubscribe: (() => void) | null = null;
let visible: boolean | null = null;
let resumePending: Promise<CodexSnapshot> | null = null;
let resumeSerial = 0;
const modelCatalogs = new Map<ModelProvider, { models?: CodexModel[]; loadedAt: number; pending?: Promise<CodexModel[]> }>();
const subscribers = new Set<() => void>();
function emit(next: Store) { snapshot = next; subscribers.forEach(listener => listener()); }
function apply(result: CodexSnapshot) {
  if (snapshot.loaded && result.revision < snapshot.revision) return snapshot;
  if (snapshot.loaded && result.revision === snapshot.revision && !snapshot.error) return snapshot;
  emit({ ...result, loaded: true, loading: false, error: "" }); return result;
}
function schedule() {
  if (!subscribers.size || timer !== null || pending || resumePending || !isWindowVisible()) return;
  timer = setTimeout(() => {
    timer = null;
    if (!subscribers.size || !isWindowVisible()) return;
    void refreshCodexSuite("status").catch(() => undefined).finally(schedule);
  }, 1500);
}
function stopTimer() { if (timer !== null) clearTimeout(timer); timer = null; }
function refreshVisible() {
  stopTimer();
  if (!subscribers.size || !isWindowVisible()) return;
  if (pending) {
    const waiting = pending;
    if (resumePending === waiting) return;
    resumePending = waiting; const serial = ++resumeSerial;
    void waiting.catch(() => undefined).then(() => {
      if (resumePending !== waiting || serial !== resumeSerial) return;
      resumePending = null; refreshVisible();
    });
    return;
  }
  void refreshCodexSuite(snapshot.loaded ? "status" : "get").catch(() => undefined).finally(schedule);
}
function visibilityChanged() {
  const previous = visible; visible = isWindowVisible();
  if (!visible) { stopTimer(); resumeSerial++; resumePending = null; return; }
  if (previous !== true) refreshVisible(); else schedule();
}
function subscribe(listener: () => void) {
  subscribers.add(listener);
  if (subscribers.size === 1) {
    visible = null; visibilityUnsubscribe = subscribeWindowVisibility(visibilityChanged); visibilityChanged();
  } else schedule();
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) { stopTimer(); resumeSerial++; resumePending = null; visible = null; visibilityUnsubscribe?.(); visibilityUnsubscribe = null; }
  };
}
export function useCodexSuite() { return useSyncExternalStore(subscribe, () => snapshot, () => snapshot); }
export function refreshCodexSuite(action: "get" | "status" = "status"): Promise<CodexSnapshot> {
  if (pending) return pending;
  if (!snapshot.loaded) emit({ ...snapshot, loading: true, error: "" });
  pending = invoke<CodexSnapshot>("model_runtime", { args: { action } }).then(apply).catch(error => {
    emit({ ...snapshot, loading: false, error: String(error) }); throw error;
  }).finally(() => { pending = null; });
  return pending;
}
export async function saveCodexSuite(settings: CodexSettings) {
  // Let an older in-flight status finish before saving; it cannot overwrite this save.
  if (pending) await pending.catch(() => undefined);
  const saving = invoke<CodexSnapshot>("model_runtime", { args: { action: "save", settings } }).then(apply);
  pending = saving;
  try { return await saving; } finally { if (pending === saving) pending = null; }
}
export function cachedCodexSuiteModels(provider: ModelProvider) { return modelCatalogs.get(provider)?.models; }
export function loadCodexSuiteModels(provider: ModelProvider = snapshot.settings.provider ?? "codex", refresh = false): Promise<CodexModel[]> {
  let entry = modelCatalogs.get(provider);
  if (entry?.pending) return entry.pending;
  if (!refresh && entry?.models && Date.now() - entry.loadedAt < 300_000) return Promise.resolve(entry.models);
  if (!entry) { entry = { loadedAt: 0 }; modelCatalogs.set(provider, entry); }
  const current = entry;
  current.pending = invoke<{ models: CodexModel[] }>("model_runtime", { args: { action: "models", provider } }).then(result => {
    if (!Array.isArray(result.models)) throw new Error("模型目录返回无效，请刷新后重试");
    if (modelCatalogs.get(provider) === current) { current.models = result.models; current.loadedAt = Date.now(); }
    return result.models;
  }).finally(() => { current.pending = undefined; });
  return current.pending;
}
export function openCodexSuiteSettings() { window.dispatchEvent(new Event("hub:open-codex-settings")); }
export function publishCodexNotice(text: string, tone: "working" | "success" | "warning" | "error" = "working", duration = 3200) {
  window.dispatchEvent(new CustomEvent("hub:operation-status", { detail: { text, tone, duration } }));
}
export function modelProviderLabel(provider?: ModelProvider) { return provider === "deepseek" ? "DeepSeek" : "Codex"; }
export function codexModelLabel(settings: CodexSettings) { return settings.model || (settings.provider === "deepseek" ? "请选择模型" : "CLI 默认模型"); }
export const CODEX_EFFORT_LABELS: Record<string, string> = { none: "无推理", minimal: "最低", low: "轻度", medium: "中等", high: "高", xhigh: "极高", max: "最大", ultra: "Ultra" };
export function codexSelectionLabel(settings: CodexSettings) {
  const effort = CODEX_EFFORT_LABELS[settings.reasoningEffort] ?? (settings.reasoningEffort || "默认推理");
  // A saved Fast request is meaningful without reinterpreting historical jobs through today's catalog.
  // fast:false alone does not establish that this model has a selectable speed tier.
  const speed = settings.provider !== "deepseek" && settings.fast ? " · Fast" : "";
  return `${codexModelLabel(settings)} · ${effort}${speed}${settings.provider === "deepseek" ? " · DeepSeek" : ""}`;
}
export async function cancelModelJob(id: string) {
  await invoke("model_runtime", { args: { action: "cancel", id } });
  return refreshCodexSuite();
}
// Shared state reset for isolated tests; no production preference is stored in the browser.
export function resetCodexSuiteForTests() {
  resetCodexAccountsForTests();
  stopTimer(); resumeSerial++; resumePending = null; visible = null; visibilityUnsubscribe?.(); visibilityUnsubscribe = null;
  pending = null; snapshot = initial(); subscribers.clear();
  modelCatalogs.clear();
}
