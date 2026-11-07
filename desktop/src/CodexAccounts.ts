import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isWindowVisible, subscribeWindowVisibility } from "./WindowVisibility";

export type CodexAccount = { id: string; label: string; scopeId: string; plan: string; workspaceLabel?: string };
export type CodexLogin = { id: string; state: "pending" | "completed" | "cancelled" | "failed"; authUrl?: string; error?: string; profile?: CodexAccount };
export type CodexAccountSnapshot = { selected: string; accounts: CodexAccount[]; current: { label: string; scopeId: string; plan: string; kind: string; workspaceLabel?: string } | null; error?: string | null; login?: CodexLogin | null };
type State = CodexAccountSnapshot & { accountNotice: CodexAccountSnapshot["current"]; loaded: boolean; loading: boolean; busy: boolean; requestError: string };
const initial = (): State => ({ selected: "desktop", accounts: [], current: null, loaded: false, loading: false, busy: false, requestError: "", accountNotice: null });
let state = initial();
let serial = 0;
let lastKnownScopeId: string | undefined;
let pending: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let unwatch: (() => void) | null = null;
const listeners = new Set<() => void>();
const emit = (next: State) => { state = next; listeners.forEach(listener => listener()); };
const stop = () => { if (timer !== null) clearTimeout(timer); timer = null; };
function schedule() {
  stop();
  if (!listeners.size || pending || state.busy || !isWindowVisible()) return;
  timer = setTimeout(() => { timer = null; void refreshCodexAccounts(); }, state.login?.state === "pending" ? 1500 : 30000);
}
function validate(value: CodexAccountSnapshot) {
  if (!value || typeof value.selected !== "string" || !Array.isArray(value.accounts) || !value.accounts.every(account => typeof account.id === "string" && typeof account.label === "string") || !(value.current === null || (value.current && typeof value.current.scopeId === "string" && typeof value.current.label === "string"))) throw new Error("Codex 账号状态返回无效，请刷新重试");
  return value;
}
export function refreshCodexAccounts(): Promise<void> {
  if (pending) return pending;
  const ticket = ++serial;
  emit({ ...state, loading: true, requestError: "" });
  pending = invoke<CodexAccountSnapshot>("model_runtime", { args: { action: "codexAccounts" } }).then(value => {
    if (ticket === serial) {
      validate(value);
      const fromScopeId = state.current?.scopeId;
      const changed = state.loaded && state.selected === value.selected && fromScopeId && value.current?.scopeId && fromScopeId !== value.current.scopeId;
      const switched = !!value.current && !!lastKnownScopeId && lastKnownScopeId !== value.current.scopeId;
      if (value.current) lastKnownScopeId = value.current.scopeId;
      emit({ ...state, ...value, loaded: true, loading: false, requestError: "", accountNotice: switched ? value.current : value.current ? state.accountNotice : null });
      if (changed) window.dispatchEvent(new CustomEvent("hub:agent-account-changed", { detail: { newConversation: false, selected: value.selected, scopeId: value.current?.scopeId, fromScopeId, fromSelected: value.selected } }));
    }
  }).catch(reason => { if (ticket === serial) emit({ ...state, loading: false, requestError: String(reason) }); })
    .finally(() => { if (ticket === serial) pending = null; schedule(); });
  return pending;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const visibility = () => { stop(); if (isWindowVisible()) void refreshCodexAccounts(); };
    unwatch = subscribeWindowVisibility(visibility);
    if (!pending) void refreshCodexAccounts();
  }
  return () => { listeners.delete(listener); if (!listeners.size) { stop(); unwatch?.(); unwatch = null; } };
}
export const useCodexAccounts = () => useSyncExternalStore(subscribe, () => state, () => state);
export const getCodexAccountSnapshot = () => state;
export const dismissCodexAccountNotice = () => emit({ ...state, accountNotice: null });
export async function authorizeCodexConversation(id: string, scopeId: string) {
  await invoke("agent_investigation", { args: { action: "authorizeCodexConversation", id, scopeId } });
}
async function mutate<T>(args: object): Promise<T> {
  if (state.busy) throw new Error("账号操作正在进行，请稍候");
  stop();
  serial++;
  pending = null;
  emit({ ...state, busy: true, loading: false, requestError: "" });
  try { return await invoke<T>("model_runtime", { args }); }
  catch (reason) { emit({ ...state, requestError: String(reason) }); throw reason; }
  finally { emit({ ...state, busy: false }); schedule(); }
}
export async function selectCodexAccount(id: string, newConversation: boolean) {
  const fromScopeId = state.current?.scopeId;
  const fromSelected = state.selected;
  await mutate({ action: "selectCodexAccount", id });
  emit({ ...state, selected: id, current: null, accountNotice: null });
  await refreshCodexAccounts();
  window.dispatchEvent(new CustomEvent("hub:agent-account-changed", { detail: { newConversation, selected: id, scopeId: state.current?.scopeId, fromScopeId, fromSelected } }));
}
export async function startCodexLogin() {
  const login = await mutate<CodexLogin>({ action: "startCodexLogin" });
  emit({ ...state, login }); schedule();
  return login;
}
export async function cancelCodexLogin(id: string) {
  await mutate({ action: "cancelCodexLogin", id });
  await refreshCodexAccounts();
}
export async function removeCodexAccount(id: string) {
  await mutate({ action: "removeCodexAccount", id });
  await refreshCodexAccounts();
}
export function resetCodexAccountsForTests() {
  serial++; stop(); unwatch?.(); unwatch = null; pending = null; listeners.clear(); state = initial(); lastKnownScopeId = undefined;
}
