export type ObsidianWatchStatus = {
  libraryId: string;
  watching: boolean;
  pendingPaths: number;
  lastEventAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
};

export type IndexJobDetail = {
  jobType: string;
  status: string;
  count: number;
  lastError?: string;
};

export type FailedIndexItem = {
  jobId: number;
  sourceId: string;
  sourceType: string;
  jobType: string;
  title: string;
  parentTitle?: string;
  documentPath?: string;
  mimeType?: string;
  sourceReference?: string;
  pageNumber?: number;
  error: string;
  attempts: number;
  updatedAt: number;
};

export type LibrarySyncHealth = {
  libraryId: string;
  provider: string;
  name: string;
  documentCount: number;
  lastSync?: string;
  pendingJobs: number;
  runningJobs?: number;
  failedJobs: number;
  lastJobAt?: number;
  lastError?: string;
  syncPhase?: string;
  consecutiveFailures: number;
  failedItems?: FailedIndexItem[];
};

export type IndexStatus = {
  journalVersions: Array<{ libraryId: string; revision: string; name: string; provider: string }>;
  documentCount: number;
  pendingJobs: number;
  pendingDownloads: number;
  policyPausedDownloads?: number;
  pendingOcrPages: number;
  pendingOtherJobs: number;
  deferredOcrSources: number;
  failedJobs: number;
  failedOcrPages: number;
  pendingLexicalJobs: number;
  rateLimitEvents: number;
  rateLimitedUntil?: number;
  autoSyncEnabled: boolean;
  autoSyncConsecutiveFailures: number;
  nextAutoSyncAt?: number;
  syncPhase?: string;
  lastFullReconcile?: string;
  lastSync?: string;
  jobDetails: IndexJobDetail[];
  libraryHealth: LibrarySyncHealth[];
  obsidianWatchers: ObsidianWatchStatus[];
};
