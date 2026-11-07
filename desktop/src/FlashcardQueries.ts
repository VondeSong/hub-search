import { invoke } from "@tauri-apps/api/core";
import type { Flashcard } from "./FlashcardTypes";
import type { FlashcardSort, FlashcardStage } from "./FlashcardWorkspacePresentation";

export type FlashcardQuery = {
  search: string; cardType: "all" | Flashcard["cardType"]; stage: "all" | FlashcardStage;
  sort: FlashcardSort; ascending: boolean; includeMastered: boolean; includeSubdecks?: boolean; columnStage?: FlashcardStage;
};
export type FlashcardPage = {
  items: Flashcard[]; total: number; matchedTotal: number; revision: string; asOf: number;
  scopeTotal?: number; tags?: string[]; customFieldKeys?: string[]; stageCounts?: Record<FlashcardStage, number>;
};
export type FlashcardScope = { deckId: string | null; dueOnly: boolean; query: FlashcardQuery };
export type FlashcardReviewPlan = { sessionIds: string[]; sessionCount?: number; eligibleCount: number; newAvailable: number; newWaiting: number; revision: string; asOf: number };

export function loadFlashcardPage(scope: FlashcardScope, offset: number, limit: number, revision: string | null = null, asOf: number | null = null, includeMetadata = false): Promise<FlashcardPage> {
  return invoke("list_flashcards_page", { ...scope, offset, limit, revision, asOf, includeMetadata });
}

// Only IDs cross this boundary. Never collect every card body just to select it.
export async function loadFlashcardSelection(scope: FlashcardScope, revision: string, asOf: number, current = () => true): Promise<string[]> {
  const ids: string[] = [];
  while (current()) {
    const page = await invoke<{ ids: string[]; total: number }>("list_flashcard_selection_ids", { ...scope, offset: ids.length, limit: 2000, revision, asOf });
    if (!current()) return [];
    ids.push(...page.ids);
    if (ids.length >= page.total) return ids;
    if (!page.ids.length) throw new Error("闪卡选择分页未完成，请刷新重试");
  }
  return [];
}

export function loadFlashcardReviewPlan(deckId: string | null, sessionLimit: number, includeSubdecks = false, includeSessionIds = true): Promise<FlashcardReviewPlan> {
  return invoke("flashcard_review_plan", { deckId, sessionLimit, ...(includeSubdecks ? { includeSubdecks } : {}), ...(includeSessionIds ? {} : { includeSessionIds }) });
}

export async function loadFlashcardsByIds(ids: string[]): Promise<Flashcard[]> {
  const unique = [...new Set(ids)];
  const cards: Flashcard[] = [];
  for (let offset = 0; offset < unique.length; offset += 200) {
    cards.push(...await invoke<Flashcard[]>("get_flashcards_by_ids", { cardIds: unique.slice(offset, offset + 200) }));
  }
  // SQL IN has no ordering contract. The caller's review/selection order does.
  const byId = new Map(cards.map(card => [card.id, card]));
  return unique.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
}
