import type { FlashcardDraft } from "./FlashcardTypes";

export function inboxDraftIdsFromTransfer(transfer: Pick<DataTransfer, "getData">, drafts: FlashcardDraft[]): string[] {
  const batch = transfer.getData("application/x-hub-flashcard-drafts");
  let ids: unknown;
  if (batch) {
    try { ids = JSON.parse(batch); } catch { return []; }
    if (!Array.isArray(ids)) return [];
  } else {
    const single = transfer.getData("application/x-hub-flashcard-draft");
    ids = single ? [single] : [];
  }
  const liveIds = new Set(drafts.map((draft) => draft.id));
  return [...new Set((ids as unknown[]).filter((id): id is string => typeof id === "string" && liveIds.has(id)))];
}
