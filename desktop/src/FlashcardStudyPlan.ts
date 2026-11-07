import type { Flashcard, FlashcardDashboardStats } from "./FlashcardTypes";

export const DAILY_NEW_CARD_LIMIT_KEY = "hub.flashcards.daily-new-limit.v1";
export const DAILY_NEW_CARD_LIMIT_OPTIONS = [0, 5, 10, 20, 50] as const;

export function loadDailyNewCardLimit(storage: Pick<Storage, "getItem">): number {
  try {
    const saved = Number(storage.getItem(DAILY_NEW_CARD_LIMIT_KEY) ?? 10);
    return DAILY_NEW_CARD_LIMIT_OPTIONS.includes(saved as typeof DAILY_NEW_CARD_LIMIT_OPTIONS[number]) ? saved : 10;
  } catch { return 10; }
}

export function remainingNewCardAllowance(limit: number, studiedToday: number): number {
  return limit === 0 ? Number.POSITIVE_INFINITY : Math.max(0, limit - Math.max(0, studiedToday));
}

export function todayFlashcardDueCount(stats: Pick<FlashcardDashboardStats, "dueCards" | "newDueCards" | "newStudiedToday">, dailyNewLimit: number): number {
  const newDue = Math.max(0, stats.newDueCards ?? 0);
  const reviews = Math.max(0, stats.dueCards - newDue);
  return reviews + Math.min(newDue, remainingNewCardAllowance(dailyNewLimit, stats.newStudiedToday ?? 0));
}

export function planFlashcardReview(
  dueCards: Flashcard[],
  sessionLimit: number,
  dailyNewLimit: number,
  newStudiedToday: number,
): { eligible: Flashcard[]; session: Flashcard[]; newAvailable: number; newWaiting: number } {
  const mature = dueCards.filter(card => card.status !== "suspended" && (card.repetitions > 0 || card.lapses > 0));
  const newCards = dueCards.filter(card => card.status !== "suspended" && card.repetitions === 0 && card.lapses === 0);
  const newAvailable = Math.min(newCards.length, remainingNewCardAllowance(dailyNewLimit, newStudiedToday));
  const eligible = [...mature, ...newCards.slice(0, newAvailable)];
  return {
    eligible,
    session: sessionLimit > 0 ? eligible.slice(0, sessionLimit) : eligible,
    newAvailable,
    newWaiting: newCards.length - newAvailable,
  };
}
