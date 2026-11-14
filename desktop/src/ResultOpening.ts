import type { LibrarySummary, SearchResult } from "./SearchTypes";

export type ResultOpenSource = "result" | "preview";
export type CraftOpenMode = "bridge" | "web" | "client";

export type CraftBridgeAction = "activated" | "updated" | "opened" | "queued";

export type OpenResultOutcome = {
  craftBridgeAction?: CraftBridgeAction;
};

export type ResultOpenSettings = {
  craftResultOpenMode: CraftOpenMode;
  craftPreviewOpenMode: CraftOpenMode;
};

export type OpenResultRequest = {
  libraryId: string;
  documentId: string;
  blockId: string;
  pageId?: string;
  resultId: string;
  matchField: string;
  matchTerms: string[];
  openMode: CraftOpenMode;
};

export type OpenAttemptGate = {
  pending: boolean;
  cooldownUntil: number;
};

export function resultOpenMode(
  settings: ResultOpenSettings,
  source: ResultOpenSource,
): CraftOpenMode {
  return source === "preview"
    ? settings.craftPreviewOpenMode
    : settings.craftResultOpenMode;
}

export function buildOpenResultRequest(
  result: SearchResult,
  source: ResultOpenSource,
  settings: ResultOpenSettings,
): OpenResultRequest {
  return {
    libraryId: result.libraryId,
    documentId: result.documentId,
    blockId: result.blockId ?? result.documentId,
    ...(result.pageId ? { pageId: result.pageId } : {}),
    resultId: result.id,
    matchField: result.matchField,
    matchTerms: result.matchTerms,
    openMode: resultOpenMode(settings, source),
  };
}

export function beginOpenAttempt(
  gate: OpenAttemptGate,
  now: number,
  cooldownMs = 2500,
): boolean {
  if (gate.pending || now < gate.cooldownUntil) return false;
  gate.pending = true;
  gate.cooldownUntil = now + cooldownMs;
  return true;
}

export function finishOpenAttempt(
  gate: OpenAttemptGate,
  now: number,
  trailingCooldownMs = 1200,
): void {
  gate.pending = false;
  gate.cooldownUntil = Math.max(gate.cooldownUntil, now + trailingCooldownMs);
}

export function usesCraftBridge(
  result: SearchResult,
  source: ResultOpenSource,
  settings: ResultOpenSettings,
): boolean {
  return result.provider === "craft" && resultOpenMode(settings, source) === "bridge";
}

/** Sync-session availability is separate from opening an indexed Craft page. */
export function canOpenResultSource(result: SearchResult | undefined, libraries: LibrarySummary[], platform: string): boolean {
  if (!result) return false;
  if (result.provider === "hub") return (result.contentType === "reading" || result.contentType === "flashcard") && Boolean(result.documentId);
  if (result.provider === "craft") return Boolean(result.libraryId.trim() && result.documentId.trim());
  if (platform === "android" && result.provider === "dida365") return true;
  return Boolean(libraries.find((library) => library.id === result.libraryId)?.connected);
}
