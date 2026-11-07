import type { Flashcard } from "./FlashcardTypes";
import type { FlashcardQuery } from "./FlashcardQueries";
import { collectFlashcardTags, filterAndSortFlashcards, groupFlashcardsByStage } from "./FlashcardWorkspacePresentation";
import { planFlashcardReview } from "./FlashcardStudyPlan";

// Workspace tests mock the native transport. Native query tests separately cover
// SQL producers; this fixture keeps the mock projection's wire contract complete.
export function flashcardPageFixture(cards: Flashcard[], parameters?: unknown) {
  const args = (parameters ?? {}) as Record<string, unknown>;
  const asOf = typeof args.asOf === "number" ? args.asOf : Math.floor(Date.now() / 1000);
  const scope = cards.filter(card => (!args.deckId || card.deckId === args.deckId) && (!args.dueOnly || (card.status !== "suspended" && card.dueAt <= asOf)));
  const query = { search: "", cardType: "all", stage: "all", sort: "updated", ascending: false, includeMastered: true, ...(args.query as Partial<FlashcardQuery> ?? {}), nowSeconds: asOf } as FlashcardQuery;
  const matches = filterAndSortFlashcards(scope, query);
  const groups = groupFlashcardsByStage(matches, asOf);
  const visible = query.columnStage ? groups.find(group => group.stage === query.columnStage)!.cards : matches;
  const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 200);
  return { items: visible.slice(offset, offset + limit), total: visible.length, matchedTotal: matches.length, scopeTotal: scope.length,
    revision: "1", asOf, tags: collectFlashcardTags(scope), customFieldKeys: [...new Set(matches.flatMap(card => Object.keys(card.customFields ?? {})))],
    stageCounts: Object.fromEntries(groups.map(group => [group.stage, group.cards.length])) };
}

export function flashcardReviewPlanFixture(cards: Flashcard[], parameters?: unknown, dailyNewLimit = 10, studiedToday = 0) {
  const args = (parameters ?? {}) as Record<string, unknown>;
  const asOf = Math.floor(Date.now() / 1000);
  const due = cards.filter(card => (!args.deckId || card.deckId === args.deckId) && card.status !== "suspended" && card.dueAt <= asOf);
  const plan = planFlashcardReview(due, Number(args.sessionLimit ?? 20), dailyNewLimit, studiedToday);
  return { sessionIds: plan.session.map(card => card.id), eligibleCount: plan.eligible.length, newAvailable: plan.newAvailable, newWaiting: plan.newWaiting, revision: "1", asOf };
}
