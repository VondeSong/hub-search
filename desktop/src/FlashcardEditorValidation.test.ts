import { describe, expect, it } from "vitest";
import { validateFlashcardEditor, type FlashcardEditorValidationInput } from "./FlashcardEditorValidation";

const validEditor: FlashcardEditorValidationInput = {
  question: "什么是间隔重复？",
  deckId: "deck-1",
  answer: "根据遗忘规律安排复习",
  cardType: "qa",
  options: [],
  correctIndex: 0,
  media: [],
  occlusions: [],
};

describe("validateFlashcardEditor", () => {
  it("returns the first incomplete field in reading order", () => {
    expect(validateFlashcardEditor({ ...validEditor, question: "", deckId: "" })).toEqual({
      field: "question",
      message: "请先填写闪卡问题",
    });
    expect(validateFlashcardEditor({ ...validEditor, deckId: "" })).toEqual({
      field: "deck",
      message: "请先选择闪卡所属牌组",
    });
    expect(validateFlashcardEditor({ ...validEditor, question: "Q" })?.message).toContain("至少需要 3 个字符");
  });

  it("explains invalid answers for each structured card type", () => {
    expect(validateFlashcardEditor({
      ...validEditor,
      cardType: "multiple_choice",
      options: ["A", "A"],
      correctIndex: 0,
    })?.message).toContain("不重复");
    expect(validateFlashcardEditor({ ...validEditor, cardType: "ordering", answer: "只有一步" })?.message).toContain("两个排序步骤");
    expect(validateFlashcardEditor({ ...validEditor, cardType: "image_occlusion", answer: "查看原图" })?.message).toContain("遮挡区域");
  });

  it("accepts complete regular and structured cards", () => {
    expect(validateFlashcardEditor(validEditor)).toBeNull();
    expect(validateFlashcardEditor({
      ...validEditor,
      cardType: "multiple_choice",
      options: ["A", "B"],
      correctIndex: 1,
    })).toBeNull();
    expect(validateFlashcardEditor({ ...validEditor, cardType: "ordering", answer: "第一步\n第二步" })).toBeNull();
    expect(validateFlashcardEditor({
      ...validEditor,
      cardType: "image_occlusion",
      answer: "查看原图",
      media: [{ title: "diagram", mimeType: "image/png", url: "asset://diagram" }],
      occlusions: [{ x: 0, y: 0, width: 0.2, height: 0.2 }],
    })).toBeNull();
  });
});
