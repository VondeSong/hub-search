import type { Flashcard } from "./FlashcardTypes";

export type FlashcardStage = "new" | "due" | "learning" | "mastered" | "suspended";
export type FlashcardSort = "updated" | "created" | "due" | "question" | "type";

export const FLASHCARD_STAGE_LABELS: Record<FlashcardStage, string> = {
  new: "未学习",
  due: "待复习",
  learning: "学习中",
  mastered: "已掌握",
  suspended: "暂停学习",
};

export function flashcardStage(card: Flashcard, nowSeconds = Math.floor(Date.now() / 1_000)): FlashcardStage {
  if (card.status === "suspended") return "suspended";
  if (card.repetitions === 0 && card.lapses === 0) return "new";
  if (card.dueAt <= nowSeconds) return "due";
  if (card.intervalDays >= 21) return "mastered";
  return "learning";
}

export function filterAndSortFlashcards(
  cards: Flashcard[],
  options: {
    search: string;
    cardType: "all" | Flashcard["cardType"];
    stage: "all" | FlashcardStage;
    sort: FlashcardSort;
    ascending: boolean;
    includeMastered: boolean;
    nowSeconds?: number;
  },
): Flashcard[] {
  const query = options.search.trim().toLocaleLowerCase();
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const result = cards.filter((card) => {
    const stage = flashcardStage(card, nowSeconds);
    if (!options.includeMastered && stage === "mastered") return false;
    if (options.cardType !== "all" && card.cardType !== options.cardType) return false;
    if (options.stage !== "all" && stage !== options.stage) return false;
    if (!query) return true;
    return [
      card.question,
      card.answer,
      card.sourceTitle,
      card.sourcePath,
      ...(card.tags ?? []),
      ...Object.values(card.customFields ?? {}).map(String),
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });

  result.sort((left, right) => {
    const order = options.sort === "question" ? left.question.localeCompare(right.question, "zh-CN")
      : options.sort === "type" ? left.cardType.localeCompare(right.cardType)
        : options.sort === "created" ? left.createdAt - right.createdAt
          : options.sort === "due" ? left.dueAt - right.dueAt
            : left.updatedAt - right.updatedAt;
    return options.ascending ? order : -order;
  });
  return result;
}

export function collectFlashcardTags(cards: Flashcard[]): string[] {
  return [...new Set(cards.flatMap((card) => card.tags ?? []).map((tag) => tag.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export function groupFlashcardsByStage(cards: Flashcard[], nowSeconds = Math.floor(Date.now() / 1_000)) {
  const groups = (Object.entries(FLASHCARD_STAGE_LABELS) as Array<[FlashcardStage, string]>).map(([stage, label]) => ({
    stage,
    label,
    cards: [] as Flashcard[],
  }));
  const groupByStage = new Map(groups.map((group) => [group.stage, group]));
  for (const card of cards) groupByStage.get(flashcardStage(card, nowSeconds))?.cards.push(card);
  return groups;
}
