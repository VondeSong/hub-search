import type { CollectionLibraryOperation, CollectionStorageLocation } from "./CollectionDestination";
import type { CollectionPost } from "./CollectionPostBody";
import type { CollectionSyncSource } from "./CollectionSyncPanel";
import type { CollectionNavigationCounts } from "./CollectionViews";

export type CollectionItem = {
  summaryRevision?: string;
  cloudImported?: boolean;
  cloudPreviewUrls?: string[];
  attentionOperations?: CollectionLibraryOperation[]; attentionIssues?: {kind:string;error:string}[];
  lifecycle?: string; destinationId?: string; destinationIds?: string[]; storageLocations?: CollectionStorageLocation[]; storageLocation?: CollectionStorageLocation; operation?: CollectionLibraryOperation | null; status?: string; tags?: string[]; key: string; collectedAt: number; read: boolean; savedMedia?: string[];
  post: CollectionPost & {liked?: boolean; source?: string};
};
export type CollectionVersion = { rows: string; properties: number };
export type CollectionPropertyChange = Pick<CollectionItem, "key" | "read"> & { status: string; tags: string[] };
export type CollectionChanges = {
  version: CollectionVersion;
  auxiliary: number;
  activity: Record<string, unknown>;
  property?: CollectionPropertyChange | null;
};
export type CollectionPage = { navigationCounts?: CollectionNavigationCounts; archived?: number; availableTags?: string[]; pendingCancellations?: number; items: CollectionItem[]; total: number; unread: number; matched: number; sources?: CollectionSyncSource[]; connected: boolean; running: boolean; canResume: boolean; status: string; viewRevision?: CollectionVersion };
export type CollectionPageSnapshot = { key: string; page: CollectionPage; overview?: Partial<CollectionPage>; overviewSource?: string; compact?: boolean; readMinute?: number };

export function patchCollectionStatus(page: CollectionPage, change: CollectionPropertyChange, version: CollectionVersion) {
  const current = page.items.find(item => item.key === change.key);
  if (!current || current.lifecycle === "archived" || current.status === "abandoned" || change.status === "abandoned"
      || JSON.stringify(current.tags ?? []) !== JSON.stringify(change.tags)) return;
  return {
    ...page,
    viewRevision: version,
    unread: Math.max(0, page.unread + Number(current.read) - Number(change.read)),
    items: page.items.map(item => item === current ? { ...item, status: change.status, read: change.read } : item),
  };
}
