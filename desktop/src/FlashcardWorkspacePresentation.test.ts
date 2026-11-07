import { describe, expect, it } from "vitest";
import type { Flashcard } from "./FlashcardTypes";
import {
  collectFlashcardTags,
  filterAndSortFlashcards,
  flashcardStage,
  groupFlashcardsByStage,
} from "./FlashcardWorkspacePresentation";

function card(overrides: Partial<Flashcard> & Pick<Flashcard, "id" | "question">): Flashcard {
  const { id, question, ...rest } = overrides;
  return {
    id,
    deckId: "deck",
    question,
    answer: "答案",
    explanation: "",
    cardType: "qa",
    cardData: {},
    sourceLibraryId: "library",
    sourceDocumentId: "document",
    sourceBlockId: "",
    sourceTitle: "来源",
    sourcePath: "路径",
    sourceHash: "hash",
    media: [],
    tags: [],
    evidence: "",
    customFields: {},
    generation: {},
    createdAt: 1,
    updatedAt: 1,
    dueAt: 2_000,
    intervalDays: 1,
    ease: 2.5,
    repetitions: 1,
    lapses: 0,
    sourceChanged: false,
    ...rest,
  };
}

describe("flashcard workspace presentation", () => {
  const now = 1_000;

  it("classifies stages against one deterministic clock", () => {
    expect(flashcardStage(card({ id: "new", question: "新卡", repetitions: 0 }), now)).toBe("new");
    expect(flashcardStage(card({ id: "due", question: "到期", dueAt: now }), now)).toBe("due");
    expect(flashcardStage(card({ id: "learning", question: "学习", intervalDays: 5 }), now)).toBe("learning");
    expect(flashcardStage(card({ id: "mastered", question: "掌握", intervalDays: 21 }), now)).toBe("mastered");
    expect(flashcardStage(card({ id: "paused", question: "暂停", status: "suspended", dueAt: now }), now)).toBe("suspended");
    expect(flashcardStage(card({ id: "relearn", question: "重学", repetitions: 0, lapses: 1, dueAt: now }), now)).toBe("due");
  });

  it("searches all user-facing fields, filters mastered cards and sorts without mutating input", () => {
    const source = [
      card({ id: "b", question: "第二张", updatedAt: 20, tags: ["项目"] }),
      card({ id: "a", question: "第一张", updatedAt: 10, customFields: { 场景: "项目" } }),
      card({ id: "mastered", question: "已掌握", intervalDays: 30, updatedAt: 30 }),
    ];
    const result = filterAndSortFlashcards(source, {
      search: "项目",
      cardType: "all",
      stage: "all",
      sort: "updated",
      ascending: true,
      includeMastered: false,
      nowSeconds: now,
    });

    expect(result.map((item) => item.id)).toEqual(["a", "b"]);
    expect(source.map((item) => item.id)).toEqual(["b", "a", "mastered"]);
  });

  it("deduplicates tags and groups cards in one stable stage order", () => {
    const cards = [
      card({ id: "due", question: "待复习", dueAt: now, tags: [" 工作 ", "项目"] }),
      card({ id: "new", question: "未学习", repetitions: 0, tags: ["工作", ""] }),
    ];

    expect(collectFlashcardTags(cards)).toEqual(["工作", "项目"]);
    expect(groupFlashcardsByStage(cards, now).map((group) => [group.stage, group.cards.map((item) => item.id)])).toEqual([
      ["new", ["new"]],
      ["due", ["due"]],
      ["learning", []],
      ["mastered", []],
      ["suspended", []],
    ]);
  });
});
