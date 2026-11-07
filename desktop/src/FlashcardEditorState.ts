import type { Flashcard, FlashcardMedia, FlashcardOcclusion } from "./FlashcardTypes";

export type FlashcardEditorValues = {
  question: string;
  answer: string;
  explanation: string;
  cardType: Flashcard["cardType"];
  deckId: string;
  sourceTitle: string;
  sourcePath: string;
  options: string[];
  correctIndex: number;
  media: FlashcardMedia[];
  occlusions: FlashcardOcclusion[];
  tags: string;
  customFields: Array<{ key: string; value: string }>;
};

export function editorValuesForCard(card: Flashcard): FlashcardEditorValues {
  return {
    question: card.question,
    answer: card.answer,
    explanation: card.explanation ?? "",
    cardType: card.cardType,
    deckId: card.deckId,
    sourceTitle: card.sourceTitle ?? "",
    sourcePath: card.sourcePath ?? "",
    options: card.cardData.options?.length ? [...card.cardData.options] : [card.answer, "", "", ""],
    correctIndex: card.cardData.correctIndex ?? 0,
    media: [...card.media],
    occlusions: card.cardData.occlusions ? [...card.cardData.occlusions] : [],
    tags: (card.tags ?? []).join(", "),
    customFields: Object.entries(card.customFields ?? {}).map(([key, value]) => ({ key, value: String(value) })),
  };
}

export function emptyEditorValues(deckId: string): FlashcardEditorValues {
  return {
    question: "",
    answer: "",
    explanation: "",
    cardType: "qa",
    deckId,
    sourceTitle: "",
    sourcePath: "",
    options: ["", "", "", ""],
    correctIndex: 0,
    media: [],
    occlusions: [],
    tags: "",
    customFields: [],
  };
}

export function serializeEditorValues(values: FlashcardEditorValues): string {
  return JSON.stringify(values);
}
