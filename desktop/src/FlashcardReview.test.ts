import { describe, expect, it } from "vitest";
import {
  correctReviewOrdering,
  normalizeReviewAnswer,
  recommendedReviewRating,
  reviewOrderingMatches,
  typedReviewAnswerMatches,
} from "./FlashcardReview";

describe("flashcard review answers", () => {
  it("normalizes harmless case, width, and whitespace differences", () => {
    expect(normalizeReviewAnswer("  ＲＰＭ\n ")).toBe("rpm");
    expect(typedReviewAnswerMatches(" Requests   Per Minute ", "requests per minute")).toBe(true);
    expect(typedReviewAnswerMatches("", "RPM")).toBe(false);
    expect(typedReviewAnswerMatches("TPM", "RPM")).toBe(false);
  });

  it("uses structured ordering data and requires exact order", () => {
    const correct = correctReviewOrdering({ answer: "旧\n答案", cardData: { items: [" 第一步 ", "第二步", ""] } });
    expect(correct).toEqual(["第一步", "第二步"]);
    expect(reviewOrderingMatches(["第一步", "第二步"], correct)).toBe(true);
    expect(reviewOrderingMatches(["第二步", "第一步"], correct)).toBe(false);
  });

  it("recommends Again for incorrect objective answers and Good for correct ones", () => {
    expect(recommendedReviewRating({ cardType: "multiple_choice", selectedChoice: 2, correctChoice: 1, typedAnswerMatches: false, orderingMatches: false })).toBe(1);
    expect(recommendedReviewRating({ cardType: "typed_answer", selectedChoice: null, typedAnswerMatches: true, orderingMatches: false })).toBe(3);
    expect(recommendedReviewRating({ cardType: "ordering", selectedChoice: null, typedAnswerMatches: false, orderingMatches: false })).toBe(1);
    expect(recommendedReviewRating({ cardType: "qa", selectedChoice: null, typedAnswerMatches: false, orderingMatches: false })).toBeNull();
  });
});
