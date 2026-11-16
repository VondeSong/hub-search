import { shiftJournalDay, type JournalViewConfig } from "./JournalViews";

export function journalDateInRange(date: string, view: JournalViewConfig) {
  return view.period === "all" || (view.period === "day" ? date === view.day : date.startsWith(view.month + "-"));
}

export function journalUsesResultDays(view: JournalViewConfig) {
  return view.period === "all" || !!view.query.trim() || view.libraries !== null || (view.recordFilter || "all") !== "all";
}

export function journalResultDates(dates: string[], view: JournalViewConfig) {
  return [...new Set(dates.filter(date => !!shiftJournalDay(date, 0) && journalDateInRange(date, view)))]
    .sort((a, b) => view.ascending ? a.localeCompare(b) : b.localeCompare(a));
}
