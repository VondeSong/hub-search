import type { CollectionLibraryOperation, CollectionStorageLocation } from "./CollectionDestination";
import type { CollectionPost } from "./CollectionPostBody";
import type { CollectionSyncSource } from "./CollectionSyncPanel";
import type { CollectionNavigationCounts } from "./CollectionViews";

export type CollectionItem = {
  cloudImported?: boolean;
  cloudPreviewUrls?: string[];
  attentionOperations?: CollectionLibraryOperation[]; attentionIssues?: {kind:string;error:string}[];
  lifecycle?: string; destinationId?: string; destinationIds?: string[]; storageLocations?: CollectionStorageLocation[]; storageLocation?: CollectionStorageLocation; operation?: CollectionLibraryOperation | null; status?: string; tags?: string[]; key: string; collectedAt: number; read: boolean; savedMedia?: string[];
  post: CollectionPost & {liked?: boolean; source?: string};
};
export type CollectionPage = { navigationCounts?: CollectionNavigationCounts; archived?: number; availableTags?: string[]; pendingCancellations?: number; items: CollectionItem[]; total: number; unread: number; matched: number; sources?: CollectionSyncSource[]; connected: boolean; running: boolean; canResume: boolean; status: string };
export type CollectionPageSnapshot = { key: string; page: CollectionPage };
