import { describe, expect, it } from "vitest";
import { planFlashcardReview, remainingNewCardAllowance, todayFlashcardDueCount } from "./FlashcardStudyPlan";
import type { Flashcard } from "./FlashcardTypes";

const card = (id: string, repetitions: number, lapses = 0, status: "active" | "suspended" = "active") =>
  ({ id, repetitions, lapses, status } as Flashcard);

describe("daily flashcard plan", () => {
  it("counts today's available cards consistently with the daily new allowance", () => {
    const stats = { dueCards: 795, newDueCards: 770, newStudiedToday: 0 };
    expect(todayFlashcardDueCount(stats, 10)).toBe(35);
    expect(todayFlashcardDueCount({ ...stats, newStudiedToday: 10 }, 10)).toBe(25);
    expect(todayFlashcardDueCount(stats, 0)).toBe(795);
    expect(todayFlashcardDueCount({ dueCards: 0, newDueCards: 0 }, 10)).toBe(0);
  });
  it("keeps due reviews ahead of new cards and applies both limits", () => {
    const due = [card("new-1", 0), card("review-1", 2), card("new-2", 0), card("relearn", 0, 1), card("new-3", 0)];
    const plan = planFlashcardReview(due, 3, 2, 1);
    expect(plan.eligible.map(item => item.id)).toEqual(["review-1", "relearn", "new-1"]);
    expect(plan.session.map(item => item.id)).toEqual(["review-1", "relearn", "new-1"]);
    expect(plan.newWaiting).toBe(2);
  });
  it("does not count suspended cards or block mature reviews when the new quota is full", () => {
    const due = [card("new", 0), card("paused", 2, 0, "suspended"), card("review", 2)];
    expect(planFlashcardReview(due, 20, 10, 10).session.map(item => item.id)).toEqual(["review"]);
    expect(remainingNewCardAllowance(0, 200)).toBe(Number.POSITIVE_INFINITY);
  });
});
