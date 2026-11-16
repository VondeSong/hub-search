import type { JournalViewConfig } from "./journal-local/JournalViews";
import { shiftJournalDay } from "./journal-local/JournalViews";
import type { MemoRecord } from "./memo-data";

export function journalDateInRange(date: string, view: JournalViewConfig) {
  return view.period === "all" || (view.period === "day" ? date === view.day : date.startsWith(view.month + "-"));
}

export function journalMatchesQuery(record: MemoRecord, query: string) {
  const words = [record.text, ...record.files, ...(record.tags || []).map(tag => "#" + tag)].join(" ");
  return words.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

// A filtered daily view must show the dates containing its results. A plain
// daily view keeps the familiar consecutive days for writing new entries.
export function journalUsesResultDays(view: JournalViewConfig) {
  return view.period === "all" || !!view.query.trim() || view.libraries !== null || view.recordFilter !== "all";
}

export function journalStreamDates(view: JournalViewConfig, anchor: string, count: number, resultDates: string[]) {
  if (journalUsesResultDays(view)) {
    return [...new Set(resultDates.filter(date => !!shiftJournalDay(date, 0) && journalDateInRange(date, view)))]
      .sort((a, b) => view.ascending ? a.localeCompare(b) : b.localeCompare(a));
  }
  if (view.period === "day") return view.day ? [view.day] : [];
  const first = anchor.startsWith(view.month + "-") ? anchor : view.month + "-01";
  return Array.from({ length: Math.min(35, Math.max(1, count)) }, (_, i) => shiftJournalDay(first, i))
    .filter(date => !!date && journalDateInRange(date, view));
}
