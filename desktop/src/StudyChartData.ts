import type { FlashcardDashboardStats, FlashcardDeckSummary } from "./FlashcardTypes";

export function studyDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function studyTimeline(activity: FlashcardDashboardStats["dailyActivity"], days: number, now = new Date()) {
  const counts = new Map(activity.map(({ date, count }) => [date, Math.max(0, count)]));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    date.setDate(date.getDate() - (days - 1 - index));
    const key = studyDateKey(date);
    return { date: key, label: `${date.getMonth() + 1}/${date.getDate()}`, count: counts.get(key) ?? 0 };
  });
}

export function studyStreak(activity: FlashcardDashboardStats["dailyActivity"], now = new Date()): number {
  const counts = new Map(activity.map(({ date, count }) => [date, count]));
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Today can still be in progress: an unbroken streak through yesterday remains current.
  if (!counts.get(studyDateKey(date))) date.setDate(date.getDate() - 1);
  let streak = 0;
  while ((counts.get(studyDateKey(date)) ?? 0) > 0) {
    streak++;
    date.setDate(date.getDate() - 1);
  }
  return streak;
}

export function deckWorkload(decks: FlashcardDeckSummary[]) {
  return decks.filter((deck) => deck.cardCount > 0)
    .map((deck) => ({ id: deck.id, label: deck.name, value: Math.max(0, deck.dueCount), total: deck.cardCount }))
    .sort((a, b) => b.value - a.value || b.total - a.total)
    .slice(0, 8);
}
