import { describe, expect, it } from "vitest";
import { flashcardFrontPreview, flashcardGridHint } from "./FlashcardPresentation";

describe("flashcardFrontPreview", () => {
  it("hides simple and Anki-style cloze answers", () => {
    expect(flashcardFrontPreview({ cardType: "cloze", question: "耐温为 {{≤80℃}}，厚度 {{c2::≥3mm::尺寸}}。" }))
      .toBe("耐温为 _____，厚度 _____。");
  });

  it("keeps non-cloze questions unchanged", () => {
    expect(flashcardFrontPreview({ cardType: "qa", question: "RPM 是什么？" })).toBe("RPM 是什么？");
  });
});

describe("flashcardGridHint", () => {
  it("summarizes structured cards without exposing their answer", () => {
    expect(flashcardGridHint({ cardType: "multiple_choice", cardData: { options: ["A", "B", "", "C"] } })).toBe("3 个选项 · 单选");
    expect(flashcardGridHint({ cardType: "ordering", cardData: { items: ["一", "二", "三"] } })).toBe("3 个步骤 · 排序");
    expect(flashcardGridHint({ cardType: "image_occlusion", cardData: { occlusions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.2 }] } })).toBe("1 个遮挡区域 · 点击打开");
  });
});
