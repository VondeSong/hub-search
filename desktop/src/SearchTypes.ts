import type { Provider } from "./ProviderLabels";

export type LibrarySummary = {
  id: string;
  provider: Provider;
  name: string;
  location?: string;
  connected: boolean;
  documentCount: number;
  lastSync?: string;
  excludedPaths: string[];
  iconSvg?: string;
  defaultIconUrl?: string;
};

export type FolderSummary = {
  id: string;
  name: string;
  path: string;
  spaceId: string;
  libraryName: string;
};

export type SearchSubMatch = {
  id: string;
  blockId?: string;
  contentType: string;
  sourceItemId?: string;
  sourceType: string;
  sourceTitle?: string;
  pageNumber?: number;
  title: string;
  snippet: string;
  matchTerms: string[];
  matchField: string;
};

export type SearchResult = {
  taskSourceId?: string;
  journalDate?: string;
  favoriteKind?: "page" | "snippet";
  id: string;
  entityKey: string;
  blockId?: string;
  pageId?: string;
  documentId: string;
  contentType: string;
  sourceItemId?: string;
  sourceType: string;
  sourceTitle?: string;
  pageNumber?: number;
  score?: number;
  provider: Provider;
  libraryId: string;
  libraryName: string;
  spaceId: string;
  spaceName: string;
  title: string;
  documentTitle?: string;
  path: string;
  folderId?: string;
  modifiedAt?: number;
  taskStatus?: number | null;
  snippet: string;
  matchTerms: string[];
  matchField: string;
  matchCount: number;
  subMatches: SearchSubMatch[];
  /** Page-level evidence, not evidence for this particular body. */
  pageMatchFields?: string[];
  pageMatchTerms?: string[];
};

export type OcrImagePreview = {
  imageDataUrl?: string;
  ocrText: string;
  note?: string;
};

export type PdfPagePreview = {
  imageDataUrl?: string;
  text: string;
  pageNumber: number;
  pageCount: number;
  sourceType: "pdf_native" | "pdf_ocr";
  note?: string;
};
