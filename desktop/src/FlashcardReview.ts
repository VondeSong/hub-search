import type { Flashcard, FlashcardCardType } from "./FlashcardTypes";

export function normalizeReviewAnswer(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function typedReviewAnswerMatches(response: string, answer: string): boolean {
  const normalizedResponse = normalizeReviewAnswer(response);
  return normalizedResponse.length > 0 && normalizedResponse === normalizeReviewAnswer(answer);
}

export function correctReviewOrdering(card: Pick<Flashcard, "answer" | "cardData">): string[] {
  return card.cardData.items?.map((item) => item.trim()).filter(Boolean)
    ?? card.answer.split("\n").map((item) => item.trim()).filter(Boolean);
}

export function reviewOrderingMatches(response: string[], correctItems: string[]): boolean {
  return response.length === correctItems.length
    && response.every((item, index) => item === correctItems[index]);
}

type ObjectiveReviewResult = {
  cardType: FlashcardCardType;
  selectedChoice: number | null;
  correctChoice?: number;
  typedAnswerMatches: boolean;
  orderingMatches: boolean;
};

export function recommendedReviewRating(result: ObjectiveReviewResult): 1 | 3 | null {
  if (result.cardType === "multiple_choice" && result.selectedChoice !== null && result.correctChoice !== undefined) {
    return result.selectedChoice === result.correctChoice ? 3 : 1;
  }
  if (result.cardType === "typed_answer") return result.typedAnswerMatches ? 3 : 1;
  if (result.cardType === "ordering") return result.orderingMatches ? 3 : 1;
  return null;
}
