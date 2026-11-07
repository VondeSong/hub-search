import type { FlashcardCardType, FlashcardMedia, FlashcardOcclusion } from "./FlashcardTypes";

export type FlashcardEditorValidationField = "question" | "deck" | "answer";

export type FlashcardEditorValidationIssue = {
  field: FlashcardEditorValidationField;
  message: string;
};

export type FlashcardEditorValidationInput = {
  question: string;
  deckId: string;
  answer: string;
  cardType: FlashcardCardType;
  options: string[];
  correctIndex: number;
  media: FlashcardMedia[];
  occlusions: FlashcardOcclusion[];
};

export function validateFlashcardEditor(input: FlashcardEditorValidationInput): FlashcardEditorValidationIssue | null {
  if (!input.question.trim()) return { field: "question", message: "请先填写闪卡问题" };
  if ([...input.question.trim()].length < 3) return { field: "question", message: "闪卡问题至少需要 3 个字符" };
  if (!input.deckId) return { field: "deck", message: "请先选择闪卡所属牌组" };

  if (input.cardType === "multiple_choice") {
    const options = input.options.map((option) => option.trim());
    const distinctOptions = new Set(options.map((option) => option.toLocaleLowerCase()));
    const validCorrectOption = input.correctIndex >= 0
      && input.correctIndex < options.length
      && Boolean(options[input.correctIndex]);
    if (options.length < 2 || options.some((option) => !option) || distinctOptions.size !== options.length || !validCorrectOption) {
      return { field: "answer", message: "请补全至少两个不重复的选项，并标记正确答案" };
    }
    return null;
  }

  if (input.cardType === "ordering") {
    const items = input.answer.split("\n").filter((item) => item.trim());
    return items.length >= 2 ? null : { field: "answer", message: "请至少填写两个排序步骤" };
  }

  if (input.cardType === "image_occlusion") {
    const hasImage = input.media.some((item) => item.mimeType.startsWith("image/"));
    return hasImage && input.occlusions.length > 0
      ? null
      : { field: "answer", message: "请先选择图片，并绘制至少一个遮挡区域" };
  }

  return input.answer.trim() ? null : { field: "answer", message: "请先填写闪卡答案" };
}
