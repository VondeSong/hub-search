import { userProfileStorage } from "./UserProfileStorage";
import { createContext, useContext, useEffect, useState } from "react";

export const journalLayouts = { stream: "每日记录", records: "卡片", calendar: "月历", list: "列表", table: "表格" } as const;
export type JournalLayout = keyof typeof journalLayouts;
export type JournalViewConfig = {
  recordFilter?: "all" | "pinned" | "attachments" | "untagged"; layout: JournalLayout; query: string; libraries: string[] | null;
  period: "month" | "all" | "day"; day: string; month: string;
  ascending: boolean; sort: "date" | "modified"; compact: boolean;
  summary: boolean; source: boolean; modified: boolean;
};
export type SavedJournalView = { id: string; name: string; hidden: boolean; config: JournalViewConfig };
export const JOURNAL_VIEWS_KEY = "hub.journal.views.v1";

// UTC is only used for Gregorian arithmetic. Journal keys remain date-only;
// neither a timezone offset nor DST can move a record to a neighboring day.
function civilDate(year: number, month: number, day: number) {
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}
function civilDateKey(date: Date) {
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 1 || year > 9999) return "";
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
export function localJournalDate(date = new Date()) {
  if (!Number.isFinite(date.getTime()) || date.getFullYear() < 1 || date.getFullYear() > 9999) return "";
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function validMonth(value: unknown): value is string {
  return typeof value === "string" && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return civilDateKey(civilDate(year, month, day)) === value;
}
export function shiftJournalDay(day: string, count: number) {
  if (!validDay(day) || !Number.isFinite(count)) return "";
  const [year, month, date] = day.split("-").map(Number);
  return civilDateKey(civilDate(year, month, date + Math.trunc(count)));
}
export function journalMonthDays(month: string, grid = false) {
  if (!validMonth(month)) return [];
  const [year, number] = month.split("-").map(Number);
  const first = civilDate(year, number, 1), last = civilDate(year, number + 1, 0);
  const offset = grid ? first.getUTCDay() : 0;
  const count = grid ? Math.ceil((offset + last.getUTCDate()) / 7) * 7 : last.getUTCDate();
  return Array.from({ length: count }, (_, i) => civilDateKey(civilDate(year, number, 1 - offset + i))).filter(Boolean);
}
export function defaultJournalView(): JournalViewConfig {
  return { recordFilter: "all", layout: "stream", query: "", libraries: null, period: "month", day: "", month: localJournalDate().slice(0, 7), ascending: true, sort: "date", compact: false, summary: true, source: true, modified: false };
}
export function normalizeJournalView(value: unknown): JournalViewConfig {
  const base = defaultJournalView(), v = (value && typeof value === "object" ? value : {}) as Partial<JournalViewConfig>;
  const day = validDay(v.day) ? v.day : "";
  return {
    ...base,
    recordFilter: ["pinned","attachments","untagged"].includes(v.recordFilter || "") ? v.recordFilter : "all",
    layout: typeof v.layout === "string" && Object.prototype.hasOwnProperty.call(journalLayouts, v.layout) ? v.layout : base.layout,
    query: typeof v.query === "string" ? v.query.slice(0, 500) : "",
    libraries: Array.isArray(v.libraries) ? [...new Set(v.libraries.filter((id): id is string => typeof id === "string" && Boolean(id.trim())))].sort() : null,
    period: v.period === "all" || (v.period === "day" && day) ? v.period : "month",
    month: v.period === "day" && day ? day.slice(0,7) : validMonth(v.month) ? v.month : base.month,
    day,
    sort: v.sort === "modified" ? "modified" : "date",
    ...Object.fromEntries((["ascending", "compact", "summary", "source", "modified"] as const).map(k => [k, typeof v[k] === "boolean" ? v[k] : base[k]])),
  };
}
type JournalState = { view: JournalViewConfig; saved: SavedJournalView[]; activeId: string; anchor: string };
export function parseJournalViews(raw: string | null): JournalState {
  const base = { view: defaultJournalView(), saved: [] as SavedJournalView[], activeId: "", anchor: "" };
  try {
    const v = JSON.parse(raw || "null");
    if (!v || v.version !== 1) return base;
    const ids = new Set<string>();
    const saved: SavedJournalView[] = (Array.isArray(v.saved) ? v.saved : []).flatMap((s: SavedJournalView) => {
      if (!s || typeof s.id !== "string" || !s.id.trim() || ids.has(s.id) || typeof s.name !== "string" || !s.name.trim()) return [];
      ids.add(s.id);
      return [{ id: s.id, name: s.name.trim().slice(0, 60), hidden: s.hidden === true, config: normalizeJournalView(s.config) }];
    }).slice(0, 30);
    return { ...base, view: normalizeJournalView(v.view), saved, activeId: saved.some(s => s.id === v.activeId && !s.hidden) ? v.activeId : "" };
  } catch { return base; }
}
export function useJournalViewStore() {
  const [state, setState] = useState<JournalState>(() => {
    try { return parseJournalViews(userProfileStorage.getItem(JOURNAL_VIEWS_KEY)); } catch { return parseJournalViews(null); }
  });
  useEffect(() => {
    try { userProfileStorage.setItem(JOURNAL_VIEWS_KEY, JSON.stringify({ version: 1, ...state, anchor: undefined })); }
    catch { /* Session remains usable when storage is unavailable. */ }
  }, [state]);
  const active = state.saved.find(s => s.id === state.activeId);
  const update = (patch: Partial<JournalViewConfig>) => setState(s => {
    const view=normalizeJournalView({...s.view,...patch});
    const anchor=patch.day!==undefined&&view.period==="day"?view.day:view.month!==s.view.month?"":s.anchor;
    return {...s,view,anchor};
  });
  return {
    ...state, active, modified: !!active && JSON.stringify(active.config) !== JSON.stringify(state.view), update,
    navigate: (date: string) => {
      const target = date || localJournalDate();
      if (!validDay(target)) return;
      setState(s => ({ ...s, anchor: target, view: { ...s.view, month: target.slice(0, 7), ...(s.view.period === "day" ? { period: "month" as const, day: "" } : {}) } }));
    },
    select: (id: string) => setState(s => {
      const saved = s.saved.find(v => v.id === id && !v.hidden);
      return saved ? { ...s, activeId: id, view: saved.config, anchor: "" } : s;
    }),
    reset: () => setState(s => ({ ...s, activeId: "", view: defaultJournalView(), anchor: "" })),
    save: (name: string) => {
      if (!name.trim()) return;
      const id = crypto.randomUUID();
      setState(s => s.saved.length >= 30 ? s : { ...s, activeId: id, saved: [...s.saved, { id, name: name.trim().slice(0, 60), hidden: false, config: s.view }] });
    },
    updateSaved: () => setState(s => ({ ...s, saved: s.saved.map(v => v.id === s.activeId ? { ...v, config: s.view } : v) })),
    rename: (id: string, name: string) => { if (name.trim()) setState(s => ({ ...s, saved: s.saved.map(v => v.id === id ? { ...v, name: name.trim().slice(0, 60) } : v) })); },
    hide: (id: string, hidden: boolean) => setState(s => ({ ...s, activeId: hidden && s.activeId === id ? "" : s.activeId, saved: s.saved.map(v => v.id === id ? { ...v, hidden } : v) })),
    remove: (id: string) => setState(s => ({ ...s, activeId: s.activeId === id ? "" : s.activeId, saved: s.saved.filter(v => v.id !== id) })),
    move: (id: string, by: number) => setState(s => {
      const saved = [...s.saved], i = saved.findIndex(v => v.id === id), j = i + Math.trunc(by);
      if (i < 0 || !Number.isFinite(j) || j < 0 || j >= saved.length) return s;
      [saved[i], saved[j]] = [saved[j], saved[i]];
      return { ...s, saved };
    }),
  };
}
export type JournalViewStore = ReturnType<typeof useJournalViewStore>;
export const JournalViewsContext = createContext<JournalViewStore | null>(null);
export function useJournalViews() { return useContext(JournalViewsContext); }

