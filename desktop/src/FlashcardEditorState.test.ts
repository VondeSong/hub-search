import { describe, expect, it } from "vitest";
import type { Flashcard } from "./FlashcardTypes";
import { editorValuesForCard, emptyEditorValues, serializeEditorValues } from "./FlashcardEditorState";

const card: Flashcard = {
  id: "card", deckId: "deck", question: "问题", answer: "答案", explanation: "解释", cardType: "qa", cardData: {},
  sourceLibraryId: "", sourceDocumentId: "", sourceBlockId: "", sourceTitle: "来源", sourcePath: "路径", sourceHash: "",
  media: [], tags: ["标签"], evidence: "", customFields: { 难度: "高" }, generation: {}, createdAt: 1, updatedAt: 1,
  dueAt: 1, intervalDays: 0, ease: 2.5, repetitions: 0, lapses: 0, sourceChanged: false,
};

describe("flashcard editor state", () => {
  it("creates a stable baseline from an existing card", () => {
    const first = editorValuesForCard(card);
    const second = editorValuesForCard(card);
    expect(serializeEditorValues(first)).toBe(serializeEditorValues(second));
    expect(first.customFields).toEqual([{ key: "难度", value: "高" }]);
  });

  it("detects a user-visible edit without mutating the baseline", () => {
    const baseline = editorValuesForCard(card);
    const changed = { ...baseline, question: "修改后的问题" };
    expect(serializeEditorValues(changed)).not.toBe(serializeEditorValues(baseline));
    expect(baseline.question).toBe("问题");
  });

  it("creates a clean new-card baseline for the selected deck", () => {
    expect(emptyEditorValues("deck-b")).toMatchObject({ deckId: "deck-b", question: "", media: [], customFields: [] });
  });
});
