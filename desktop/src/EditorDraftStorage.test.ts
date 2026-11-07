import { describe, expect, it } from "vitest";
import { emptyEditorValues } from "./FlashcardEditorState";
import { clearFlashcardEditorDraft, flashcardEditorDraftMatches, loadFlashcardEditorDraft, saveFlashcardEditorDraft } from "./EditorDraftStorage";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("flashcard editor draft storage", () => {
  it("reports storage failure so the editor can stay open", () => {
    const storage = { ...memoryStorage(), setItem: () => { throw Error("QuotaExceeded"); } };
    expect(saveFlashcardEditorDraft(storage, { version: 1, target: { kind: "create", deckId: "deck" }, values: emptyEditorValues("deck"), updatedAt: 1 })).toBe(false);
  });
  it("round-trips a validated draft and clears it", () => {
    const storage = memoryStorage();
    const draft = { version: 1 as const, target: { kind: "edit" as const, cardId: "card-a" }, values: { ...emptyEditorValues("deck-a"), question: "未保存问题" }, updatedAt: 12 };
    saveFlashcardEditorDraft(storage, draft);
    expect(loadFlashcardEditorDraft(storage)).toEqual(draft);
    expect(flashcardEditorDraftMatches(draft, { kind: "edit", cardId: "card-a" })).toBe(true);
    expect(flashcardEditorDraftMatches(draft, { kind: "edit", cardId: "card-b" })).toBe(false);
    clearFlashcardEditorDraft(storage);
    expect(loadFlashcardEditorDraft(storage)).toBeNull();
  });

  it("ignores malformed or unsupported drafts", () => {
    const storage = memoryStorage();
    storage.setItem("hub.flashcards.editor-draft-v1", "{not-json");
    expect(loadFlashcardEditorDraft(storage)).toBeNull();
    storage.setItem("hub.flashcards.editor-draft-v1", JSON.stringify({ version: 2, target: {}, values: {} }));
    expect(loadFlashcardEditorDraft(storage)).toBeNull();
  });
});
