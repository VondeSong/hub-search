import type { Flashcard } from "./FlashcardTypes";

const CLOZE_PATTERN = /\{\{(?:c\d+::)?([^{}]*?)(?:::[^{}]*?)?\}\}/gi;

export function flashcardFrontPreview(card: Pick<Flashcard, "cardType" | "question">): string {
  if (card.cardType !== "cloze") return card.question;
  return card.question.replace(CLOZE_PATTERN, "_____");
}

export function flashcardGridHint(card: Pick<Flashcard, "cardType" | "cardData">): string {
  switch (card.cardType) {
    case "cloze":
      return "填空 · 点击打开查看答案";
    case "multiple_choice": {
      const count = card.cardData.options?.filter((option) => option.trim()).length ?? 0;
      return count > 0 ? `${count} 个选项 · 单选` : "选择题 · 点击打开";
    }
    case "typed_answer":
      return "输入答案后核对";
    case "ordering": {
      const count = card.cardData.items?.filter((item) => item.trim()).length ?? 0;
      return count > 0 ? `${count} 个步骤 · 排序` : "排序题 · 点击打开";
    }
    case "image_occlusion": {
      const count = card.cardData.occlusions?.length ?? 0;
      return count > 0 ? `${count} 个遮挡区域 · 点击打开` : "图片遮挡 · 点击打开";
    }
    default:
      return "点击打开查看答案";
  }
}
