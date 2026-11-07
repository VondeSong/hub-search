import type { FlashcardEditorValues } from "./FlashcardEditorState";

export const FLASHCARD_EDITOR_DRAFT_KEY = "hub.flashcards.editor-draft-v1";

export type FlashcardEditorDraft = {
  version: 1;
  target: { kind: "edit"; cardId: string } | { kind: "create"; deckId: string };
  values: FlashcardEditorValues;
  updatedAt: number;
};

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function validValues(value: unknown): value is FlashcardEditorValues {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FlashcardEditorValues>;
  return typeof candidate.question === "string"
    && typeof candidate.answer === "string"
    && typeof candidate.deckId === "string"
    && typeof candidate.cardType === "string"
    && Array.isArray(candidate.options)
    && Array.isArray(candidate.media)
    && Array.isArray(candidate.occlusions)
    && Array.isArray(candidate.customFields);
}

export function loadFlashcardEditorDraft(storage: DraftStorage): FlashcardEditorDraft | null {
  try {
    const raw = storage.getItem(FLASHCARD_EDITOR_DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<FlashcardEditorDraft>;
    if (draft.version !== 1 || !draft.target || !validValues(draft.values) || typeof draft.updatedAt !== "number") return null;
    if (draft.target.kind === "edit" && typeof draft.target.cardId === "string") return draft as FlashcardEditorDraft;
    if (draft.target.kind === "create" && typeof draft.target.deckId === "string") return draft as FlashcardEditorDraft;
    return null;
  } catch {
    return null;
  }
}

export function saveFlashcardEditorDraft(storage: DraftStorage, draft: FlashcardEditorDraft) {
  try { storage.setItem(FLASHCARD_EDITOR_DRAFT_KEY, JSON.stringify(draft)); return true; } catch { return false; }
}

export function clearFlashcardEditorDraft(storage: DraftStorage) {
  try { storage.removeItem(FLASHCARD_EDITOR_DRAFT_KEY); } catch { /* best effort */ }
}

export function flashcardEditorDraftMatches(draft: FlashcardEditorDraft, target: FlashcardEditorDraft["target"]): boolean {
  return draft.target.kind === target.kind
    && (target.kind === "edit"
      ? draft.target.kind === "edit" && draft.target.cardId === target.cardId
      : draft.target.kind === "create" && draft.target.deckId === target.deckId);
}
