import type { FailedIndexItem } from "./IndexStatusTypes";

export type DownloadFailureView = "failed" | "dismissed";
export type DownloadFailureItem = FailedIndexItem & {
  libraryId: string;
  libraryName: string;
  provider: string;
  documentId: string;
  resourceGeneration: number;
  status: string;
  nextAttemptAt?: number;
  hasCache: boolean;
  canRetry: boolean;
  canSkip: boolean;
  issueState: "failed" | "scheduled" | "retrying" | "unavailable" | "rejected" | "dismissed";
};

export type DownloadFailureTarget = Pick<DownloadFailureItem, "jobId" | "sourceId" | "resourceGeneration" | "updatedAt" | "status">;
export type DownloadFailurePage = {
  items: DownloadFailureItem[];
  total: number;
  failedCount: number;
  skippedCount: number;
  libraries: Array<{ id: string; name: string; provider: string; failedCount: number; skippedCount: number }>;
  changed: number;
  unchanged: number;
  offset: number;
};

export function downloadFailureTarget(item: DownloadFailureItem): DownloadFailureTarget {
  return { jobId: item.jobId, sourceId: item.sourceId, resourceGeneration: item.resourceGeneration, updatedAt: item.updatedAt, status: item.status };
}

// Native records are redacted at the IPC boundary. Transport exceptions can
// still contain signed addresses, so the screen never prints those addresses.
export function downloadFailureMessage(reason: unknown): string {
  return String(reason).replace(/^Error:\s*/, "")
    .replace(/https?:\/\/[^\s<>"']+/gi, "远程附件地址")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [已隐藏]");
}
