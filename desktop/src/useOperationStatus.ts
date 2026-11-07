import { useSyncExternalStore } from "react";

export type OperationTone = "working" | "success" | "warning" | "error";
export type OperationStatus = { text: string; tone: OperationTone } | null;

let current: OperationStatus = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const subscribers = new Set<() => void>();
const notify = () => subscribers.forEach(callback => callback());
export const clearOperationStatus = () => {
  clearTimeout(timer); timer = undefined; current = null; notify();
};
const apply = (text: string, tone: OperationTone, duration: number) => {
  clearTimeout(timer); timer = undefined; current = { text, tone }; notify();
  if (duration > 0) timer = setTimeout(clearOperationStatus, duration);
};
const receive = (event: Event) => {
  const detail = (event as CustomEvent).detail;
  if (!detail || typeof detail.text !== "string" || !detail.text.trim()) return;
  if (!["working", "success", "warning", "error"].includes(detail.tone)) return;
  apply(detail.text, detail.tone, typeof detail.duration === "number" && Number.isFinite(detail.duration) ? detail.duration : 3_200);
};
const subscribe = (callback: () => void) => {
  if (subscribers.size === 0) window.addEventListener("hub:operation-status", receive);
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) window.removeEventListener("hub:operation-status", receive);
  };
};
export const showOperationStatus = (text: string, tone: OperationTone = "working", duration = 3_200) => {
  // All callers publish; the single receiver applies without publishing again.
  if (subscribers.size === 0) apply(text, tone, duration);
  window.dispatchEvent(new CustomEvent("hub:operation-status", { detail: { text, tone, duration } }));
};
export function useOperationStatus() {
  const operationStatus = useSyncExternalStore(subscribe, () => current);
  return { operationStatus, showOperationStatus, clearOperationStatus };
}
