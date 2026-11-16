import { useEffect, useRef, useState } from "react";
import { CalendarDays, Check, ChevronDown, Image, Link, Mic, Search, SlidersHorizontal, Tag } from "lucide-react";
import type { QuickJournalItem } from "./JournalRecords";
import { tagsFor } from "./QuickJournal";
import { localJournalDate } from "./JournalViews";

export const journalSortLabels = {
  "date-desc": "记录日期，从新到旧", "date-asc": "记录日期，从旧到新",
  "edit-desc": "编辑时间，从新到旧", "edit-asc": "编辑时间，从旧到新",
};
export type JournalSort = keyof typeof journalSortLabels;
export type JournalSearchScope = {
  period: "all" | "week" | "month" | "custom" | "anniversary";
  start: string; end: string; tagMode: "all" | "untagged" | "include" | "exclude";
  tags: string[]; more: Array<"images" | "links" | "audio">;
};
export const emptyJournalScope = (): JournalSearchScope => ({ period: "all", start: "", end: "", tagMode: "all", tags: [], more: [] });
export function journalSearchActive(scope: JournalSearchScope) {
  return scope.period !== "all" || scope.tagMode !== "all" || scope.more.length > 0;
}
export function journalSearchMatches(item: QuickJournalItem, scope: JournalSearchScope, today = localJournalDate()) {
  const { date, text, attachments } = item.record, tags = tagsFor(text), monday = new Date(today + "T12:00:00");
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const week = localJournalDate(monday);
  return (scope.period !== "week" || date >= week && date <= today)
    && (scope.period !== "month" || date.startsWith(today.slice(0, 7)))
    && (scope.period !== "custom" || (!scope.start || date >= scope.start) && (!scope.end || date <= scope.end))
    && (scope.period !== "anniversary" || date.slice(5) === today.slice(5) && date < today)
    && (scope.tagMode !== "untagged" || !tags.length)
    && (scope.tagMode !== "include" || scope.tags.some(tag => tags.includes(tag)))
    && (scope.tagMode !== "exclude" || !scope.tags.some(tag => tags.includes(tag)))
    && scope.more.every(kind => kind === "images" ? attachments.some(a => a.image) : kind === "links" ? /https?:\/\//i.test(text) : attachments.some(a => /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i.test(a.name)));
}
export function compareJournalItems(a: QuickJournalItem, b: QuickJournalItem, sort: JournalSort, pins: string[]) {
  const pinned = Number(pins.includes(b.record.id)) - Number(pins.includes(a.record.id));
  const value = sort.startsWith("edit") ? (a.modifiedAt || Date.parse(a.record.date)) - (b.modifiedAt || Date.parse(b.record.date)) : a.record.date.localeCompare(b.record.date);
  return pinned || (sort.endsWith("asc") ? value : -value) || a.record.id.localeCompare(b.record.id);
}
export function withJournalTags(text: string, input: string) {
  const requested = [...new Set(input.trim().split(/\s+/u).filter(Boolean).map(t => t.replace(/^#+/, "")))];
  if (!requested.length || requested.some(t => tagsFor("#" + t)[0] !== t)) throw new Error("请输入有效标签，多个标签用空格分开");
  const existing = new Set(tagsFor(text)), missing = requested.filter(t => !existing.has(t));
  return missing.length ? text + (text ? "\n" : "") + missing.map(t => "#" + t).join(" ") : text;
}
export function JournalSearchHeader({ query, onQuery, onCancel, onFilters, onSubmit }: {
  query: string; onQuery: (query: string) => void; onCancel: () => void; onFilters: () => void; onSubmit: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  return <form className="mobile-journal-search-heading" onSubmit={e => { e.preventDefault(); ref.current?.blur(); onSubmit(); }}>
    <label><Search size={19}/><input ref={ref} type="search" enterKeyHint="search" aria-label="搜索日志正文" placeholder="搜索" value={query} onChange={e => onQuery(e.target.value)}/><button type="button" aria-label="展开日志筛选" onClick={() => { ref.current?.blur(); onFilters(); }}><SlidersHorizontal size={19}/></button></label>
    <button type="button" onClick={onCancel}>取消</button>
  </form>;
}
export function JournalQuickSearch({ onChoose }: { onChoose: (scope: JournalSearchScope) => void }) {
  return <div className="mobile-journal-quick-search"><p>快捷搜索</p><div>{([
    ["无标签", Tag, "untagged"], ["有链接", Link, "links"], ["有图片", Image, "images"], ["有语音", Mic, "audio"], ["那年今日", CalendarDays, "anniversary"],
  ] as const).map(([label, Icon, kind]) => <button type="button" key={kind} onClick={() => {
    (document.activeElement as HTMLElement | null)?.blur();
    onChoose({ ...emptyJournalScope(), period: kind === "anniversary" ? kind : "all", tagMode: kind === "untagged" ? kind : "all", more: kind === "images" || kind === "links" || kind === "audio" ? [kind] : [] });
  }}><Icon size={16}/>{label}</button>)}</div></div>;
}
export function JournalSearchFilterBar({ onChoose, scope }: { onChoose: (kind: string) => void; scope: JournalSearchScope }) {
  return <div className="mobile-journal-search-filters">{[["日期", "date", scope.period !== "all"], ["标签", "tags", scope.tagMode !== "all"], ["更多", "more", scope.more.length > 0]].map(([label, kind, active]) =>
    <button type="button" key={String(kind)} onClick={() => onChoose(String(kind))} data-active={Boolean(active)}>{label}<ChevronDown size={13}/></button>)}</div>;
}
export function JournalFilterForm({ kind, scope, tags, onApply }: { kind: string; scope: JournalSearchScope; tags: string[]; onApply: (scope: JournalSearchScope) => void }) {
  const [error, setError] = useState("");
  const [range, setRange] = useState({ period: scope.period, start: scope.start, end: scope.end });
  return <form className="mobile-journal-filter-form" onSubmit={e => {
    e.preventDefault(); const data = new FormData(e.currentTarget), next = { ...scope };
    if (kind === "date") {
      next.start = String(data.get("start") || ""); next.end = String(data.get("end") || "");
      if (next.start && next.end && next.start > next.end) { setError("结束日期不能早于开始日期"); return; }
      next.period = next.start || next.end ? "custom" : String(data.get("period") || "all") as JournalSearchScope["period"];
    }
    if (kind === "tags") {
      next.tagMode = String(data.get("tagMode") || "all") as JournalSearchScope["tagMode"]; next.tags = data.getAll("tags").map(String);
      if (["include", "exclude"].includes(next.tagMode) && !next.tags.length) { setError("请选择至少一个标签"); return; }
    }
    if (kind === "more") next.more = data.getAll("more").map(String) as JournalSearchScope["more"];
    onApply(next);
  }}>
    {kind === "date" && <><div className="mobile-journal-filter-choices">{([["all", "不限时间"], ["week", "本周"], ["month", "本月"]] as const).map(([value, label]) => <label key={value}><input type="radio" name="period" value={value} checked={range.period === value} onChange={()=>setRange({period:value,start:"",end:""})}/>{label}</label>)}</div><div className="mobile-journal-filter-dates"><label>开始日期<input name="start" type="date" value={range.start} onChange={e=>setRange(previous=>({...previous,period:"custom",start:e.target.value}))}/></label><span>—</span><label>结束日期<input name="end" type="date" value={range.end} onChange={e=>setRange(previous=>({...previous,period:"custom",end:e.target.value}))}/></label></div></>}
    {kind === "tags" && <><div className="mobile-journal-filter-choices">{[["all", "全部内容"], ["untagged", "无标签"], ["include", "包含指定标签"], ["exclude", "排除指定标签"]].map(([value, label]) => <label key={value}><input type="radio" name="tagMode" value={value} defaultChecked={scope.tagMode === value}/>{label}</label>)}</div><fieldset className="mobile-journal-filter-tags"><legend>指定标签</legend>{tags.map(t => <label key={t}><input type="checkbox" name="tags" value={t} defaultChecked={scope.tags.includes(t)}/>#{t}</label>)}</fieldset></>}
    {kind === "more" && <div className="mobile-journal-filter-more">{([["images", "有图片"], ["links", "有链接"], ["audio", "有语音"]] as const).map(([value, label]) => <label key={value}>{label}<input type="checkbox" name="more" value={value} defaultChecked={scope.more.includes(value)}/></label>)}</div>}
    {error && <p role="alert" className="mobile-journal-error">{error}</p>}<button className="mobile-journal-filter-confirm">确定</button>
  </form>;
}
export function JournalViewMenu({ sort, onSort, onSelect }: { sort: JournalSort; onSort: (sort: JournalSort) => void; onSelect: () => void }) {
  return <div className="mobile-journal-view-options"><button type="button" onClick={onSelect}><Check size={18}/>选择笔记</button><details><summary>排序方式<span>{journalSortLabels[sort]}</span></summary>{Object.entries(journalSortLabels).map(([value, label]) => <button type="button" key={value} aria-pressed={sort === value} onClick={() => onSort(value as JournalSort)}>{label}{sort === value && <Check size={16}/>}</button>)}</details><p>未记录编辑时间的旧记录按记录日期排列。</p></div>;
}
