export type FlashcardDeckSummary = {
  id: string;
  name: string;
  folderId?: string;
  parentDeckId?: string;
  sortOrder?: number;
  cardCount: number;
  dueCount: number;
  newCount: number;
  suspendedCount?: number;
  updatedAt: number;
};

export type FlashcardDeckFolderSummary = {
  id: string;
  name: string;
  sortOrder: number;
  updatedAt: number;
};

export type FlashcardDashboardStats = {
  totalCards: number;
  dueCards: number;
  newDueCards?: number;
  newCards: number;
  learningCards: number;
  masteredCards: number;
  suspendedCards?: number;
  newStudiedToday?: number;
  totalReviews: number;
  reviewedToday: number;
  retentionRate: number;
  ratingCounts: [number, number, number, number];
  dailyActivity: Array<{ date: string; count: number }>;
};

export type FlashcardMedia = {
  title: string;
  mimeType: string;
  url: string;
  placement?: "question" | "answer" | "explanation";
  byteSize?: number;
};

export type FlashcardCardType = "qa" | "cloze" | "multiple_choice" | "typed_answer" | "ordering" | "image_occlusion";

export type FlashcardOcclusion = {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
};

export type FlashcardCardData = {
  options?: string[];
  correctIndex?: number;
  items?: string[];
  occlusions?: FlashcardOcclusion[];
};

export type Flashcard = {
  id: string;
  deckId: string;
  question: string;
  answer: string;
  explanation: string;
  cardType: FlashcardCardType;
  cardData: FlashcardCardData;
  sourceLibraryId: string;
  sourceDocumentId: string;
  sourceBlockId: string;
  sourceTitle: string;
  sourcePath: string;
  sourceHash: string;
  media: FlashcardMedia[];
  tags: string[];
  evidence: string;
  confidence?: number;
  customFields: Record<string, string | number | boolean>;
  generation: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  dueAt: number;
  intervalDays: number;
  ease: number;
  repetitions: number;
  lapses: number;
  status?: "active" | "suspended";
  sourceChanged: boolean;
};

export type FlashcardDraft = {
  id: string;
  batchId: string;
  deckName: string;
  question: string;
  answer: string;
  explanation: string;
  cardType: FlashcardCardType;
  cardData: FlashcardCardData;
  sourceLibraryId: string;
  sourceDocumentId: string;
  sourceBlockId: string;
  sourceTitle: string;
  sourcePath: string;
  sourceHash: string;
  media: FlashcardMedia[];
  tags: string[];
  customFields: Record<string, string | number | boolean>;
  evidence: string;
  confidence?: number;
  generation: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: number;
};

export type FlashcardDraftResolutionResult = {
  accepted: number;
  rejected: number;
  skipped: number;
  deckIds: string[];
};

export type FlashcardSyncSettings = {
  url: string;
  username: string;
  hasPassword: boolean;
  autoSync: boolean;
  configured: boolean;
  lastSyncAt?: number;
  lastError: string;
};

export type FlashcardSyncSummary = {
  cloudReport?: { uploadedBytes: number; downloadedBytes: number; pendingMedia: number; uploadedChanges: number; downloadedChanges: number; completedAt: number };
  uploadedCards: number;
  downloadedCards: number;
  mergedReviews: number;
  uploadedMedia: number;
  downloadedMedia: number;
  conflictRetries: number;
  completedAt: number;
};

export type FlashcardQualityReport = {
  totalCards: number;
  sourceCoveredCards: number;
  sourceCoverage: number;
  sourceCount: number;
  duplicateCards: number;
  duplicateRate: number;
  lowConfidenceCards: number;
  unknownConfidenceCards: number;
  cardTypeDistribution: Partial<Record<FlashcardCardType, number>>;
};

export type FlashcardSyncHistoryItem = {
  id: string;
  startedAt: number;
  completedAt: number;
  status: "success" | "failed";
  uploadedCards: number;
  downloadedCards: number;
  mergedReviews: number;
  uploadedMedia: number;
  downloadedMedia: number;
  conflictRetries: number;
  error: string;
};
