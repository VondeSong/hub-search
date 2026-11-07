import { userProfileStorage } from "./UserProfileStorage";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { DesktopSidebarView } from "./DesktopSidebar";
import { tagCleanupReason, type SidebarTagSummary, type SidebarTagGroup } from "./DesktopSidebarPresentation";
import { formatSemanticDate } from "./SearchResultPresentation";
import type { SearchResult } from "./SearchTypes";
import type { SearchScope, SourceFilters } from "./useLocalSearch";
import type { SmartCollectionDateFilter } from "./SmartCollections";
import { updatedAfter } from "./useSearchWorkspaceState";
import { isTagColor, parseTagUserProperties, resolveTagColor, type TagUserPropertyMap } from "./TagProperties";
import type { TagTaxonomyResponse, TagTaxonomySummary } from "./TagTaxonomy";

type DynamicFacetCounts = { total: number; truncated: boolean; sources: Record<string, number>; libraries: Record<string, number>; folders: Record<string, number>; tags: Record<string, number> };
const EMPTY_DYNAMIC_FACETS: DynamicFacetCounts = { total: 0, truncated: false, sources: {}, libraries: {}, folders: {}, tags: {} };
const DESKTOP_FAVORITE_TAGS_KEY = "hub-desktop-favorite-tags-v1";
const DESKTOP_RECENT_TAGS_KEY = "hub-desktop-recent-tags-v1";
const DESKTOP_TAG_GROUPS_KEY = "hub-desktop-tag-groups-v1";
const DESKTOP_TAG_PROPERTIES_KEY = "hub-desktop-tag-properties-v1";

function loadStoredStrings(key: string, limit: number): string[] {
  try {
    const value = JSON.parse(userProfileStorage.getItem(key) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

function loadStoredTagGroups(): SidebarTagGroup[] {
  try {
    const value = JSON.parse(userProfileStorage.getItem(DESKTOP_TAG_GROUPS_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): SidebarTagGroup[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || !candidate.name.trim()) return [];
      const tagIds = Array.isArray(candidate.tagIds)
        ? candidate.tagIds.filter((tagId): tagId is string => typeof tagId === "string" && Boolean(tagId.trim()))
        : [];
      return [{ id: candidate.id, name: candidate.name.trim(), tagIds: [...new Set(tagIds)] }];
    });
  } catch {
    return [];
  }
}

type Options = {
  ready: boolean; libraryCount: number; currentSpaceIds: string[] | null;
  effectiveSpaceIds: string[] | null; effectiveFolderId: string; query: string;
  dateFilter: SmartCollectionDateFilter; sourceFilters: SourceFilters; searchScope: SearchScope;
  documentCount: number | undefined; dynamicFacetCountsEnabled: boolean; activeView: DesktopSidebarView;
  normalizeResults: (value: unknown) => SearchResult[]; setError: Dispatch<SetStateAction<string>>;
};

/** Owns tag queries, facets, taxonomy invalidation and all saved tag organization. */
export function useSidebarTags({ ready, libraryCount, currentSpaceIds, effectiveSpaceIds, effectiveFolderId, query, dateFilter, sourceFilters, searchScope, documentCount, dynamicFacetCountsEnabled, activeView, normalizeResults, setError }: Options) {
const [sidebarTags, setSidebarTags] = useState<SidebarTagSummary[]>([]);

const [selectedSidebarTag, setSelectedSidebarTag] = useState("");

const [tagResults, setTagResults] = useState<SearchResult[]>([]);

const [tagResultsFor, setTagResultsFor] = useState("");

const [relatedSidebarTags, setRelatedSidebarTags] = useState<SidebarTagSummary[]>([]);

const [tagsLoading, setTagsLoading] = useState(false);

const [dynamicFacets, setDynamicFacets] = useState<DynamicFacetCounts>(EMPTY_DYNAMIC_FACETS);

const [favoriteSidebarTags, setFavoriteSidebarTags] = useState<string[]>(() => loadStoredStrings(DESKTOP_FAVORITE_TAGS_KEY, 50));

const [recentSidebarTags, setRecentSidebarTags] = useState<string[]>(() => loadStoredStrings(DESKTOP_RECENT_TAGS_KEY, 20));

const [sidebarTagGroups, setSidebarTagGroups] = useState<SidebarTagGroup[]>(loadStoredTagGroups);

const [tagProperties, setTagProperties] = useState<TagUserPropertyMap>(() => (
    parseTagUserProperties(userProfileStorage.getItem(DESKTOP_TAG_PROPERTIES_KEY))
  ));

const [selectedTagTaxonomy, setSelectedTagTaxonomy] = useState<TagTaxonomySummary | null>(null);

const [tagTaxonomyRevision, setTagTaxonomyRevision] = useState(0);

const displayedSidebarTags = useMemo(() => dynamicFacetCountsEnabled
    ? sidebarTags.map((tag) => ({ ...tag, count: dynamicFacets.tags[tag.normalizedName] ?? 0 }))
    : sidebarTags, [dynamicFacetCountsEnabled, dynamicFacets.tags, sidebarTags]);

const cleanupSidebarTags = useMemo(
    () => sidebarTags.filter((tag) => tagCleanupReason(tag)),
    [sidebarTags],
  );

useEffect(() => {
    if (!dynamicFacetCountsEnabled || !ready || libraryCount === 0) {
      setDynamicFacets(EMPTY_DYNAMIC_FACETS);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void invoke<DynamicFacetCounts>("dynamic_search_facets", {
        query,
        updatedAfter: updatedAfter(dateFilter),
        searchScope,
      }).then((counts) => {
        if (!cancelled) setDynamicFacets(counts);
      }).catch(() => {
        if (!cancelled) setDynamicFacets(EMPTY_DYNAMIC_FACETS);
      });
    }, 360);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [dynamicFacetCountsEnabled, dateFilter, documentCount, query, ready, searchScope, libraryCount, tagTaxonomyRevision]);

useEffect(() => {
    if (!ready || libraryCount === 0) return;
    let cancelled = false;
    setTagsLoading(true);
    void invoke<SidebarTagSummary[]>("list_tags", {
      spaceIds: currentSpaceIds,
      limit: 500,
    }).then((tags) => {
      if (cancelled) return;
      setSidebarTags(tags);
      setSelectedSidebarTag((current) => (
        current && tags.some((tag) => tag.normalizedName === current) ? current : ""
      ));
    }).catch((reason) => {
      if (!cancelled) setError(String(reason));
    }).finally(() => {
      if (!cancelled) setTagsLoading(false);
    });
    return () => { cancelled = true; };
  }, [currentSpaceIds, ready, libraryCount, tagTaxonomyRevision]);

const tagResultContext = JSON.stringify([selectedSidebarTag, effectiveSpaceIds, effectiveFolderId, dateFilter, sourceFilters.craft, sourceFilters.task, tagTaxonomyRevision]);

useEffect(() => {
    if (activeView !== "tags" || !selectedSidebarTag || !ready) {
      setTagResults([]);
      setTagResultsFor("");
      return;
    }
    const selectedTag = sidebarTags.find((tag) => tag.normalizedName === selectedSidebarTag);
    if (!selectedTag) return;
    let cancelled = false;
    void invoke<unknown>("local_search", {
      query: selectedTag.name,
      limit: 200,
      spaceIds: effectiveSpaceIds,
      folderId: effectiveFolderId || null,
      updatedAfter: updatedAfter(dateFilter),
      includeCraftPages: sourceFilters.craft,
      includeDidaTasks: sourceFilters.task,
      includeImageOcr: false,
      includePdf: false,
      includePdfOcr: false,
      includeAttachments: false,
      searchScope: "tag",
    }).then((value) => {
      if (!cancelled) {
        setTagResults(normalizeResults(value));
        setTagResultsFor(tagResultContext);
      }
    }).catch((reason) => {
      if (!cancelled) setError(String(reason));
    });
    return () => { cancelled = true; };
  }, [dateFilter, activeView, effectiveFolderId, effectiveSpaceIds, ready, selectedSidebarTag, sidebarTags, sourceFilters.craft, sourceFilters.task, tagTaxonomyRevision, tagResultContext]);

useEffect(() => {
    if (activeView !== "tags" || !selectedSidebarTag || !ready) {
      setRelatedSidebarTags([]);
      return;
    }
    let cancelled = false;
    void invoke<SidebarTagSummary[]>("list_related_tags", {
      normalizedName: selectedSidebarTag,
      spaceIds: effectiveSpaceIds,
      limit: 3,
    }).then((tags) => {
      if (!cancelled) setRelatedSidebarTags(tags);
    }).catch((reason) => {
      if (!cancelled) setError(String(reason));
    });
    return () => { cancelled = true; };
  }, [activeView, effectiveSpaceIds, ready, selectedSidebarTag, tagTaxonomyRevision]);

useEffect(() => {
    if (activeView !== "tags" || !selectedSidebarTag || !ready) {
      setSelectedTagTaxonomy(null);
      return;
    }
    let cancelled = false;
    void invoke<TagTaxonomyResponse>("get_tag_taxonomy", {
      tag: selectedSidebarTag,
      limit: 100,
    }).then((result) => {
      if (!cancelled) setSelectedTagTaxonomy(result.summary);
    }).catch((reason) => {
      if (!cancelled) {
        setSelectedTagTaxonomy(null);
        setError(String(reason));
      }
    });
    return () => { cancelled = true; };
  }, [activeView, ready, selectedSidebarTag, tagTaxonomyRevision]);

const toggleFavoriteSidebarTag = useCallback((normalizedName: string) => {
    setFavoriteSidebarTags((current) => {
      const next = current.includes(normalizedName)
        ? current.filter((item) => item !== normalizedName)
        : [normalizedName, ...current].slice(0, 50);
      userProfileStorage.setItem(DESKTOP_FAVORITE_TAGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

const rememberSidebarTag = useCallback((normalizedName: string) => {
    setRecentSidebarTags((current) => {
      const next = [normalizedName, ...current.filter((item) => item !== normalizedName)].slice(0, 20);
      userProfileStorage.setItem(DESKTOP_RECENT_TAGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

const createSidebarTagGroup = useCallback((name: string) => {
    setSidebarTagGroups((current) => {
      const normalized = name.trim();
      if (!normalized || current.some((group) => group.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) return current;
      const next = [...current, { id: `tag-group-${Date.now().toString(36)}`, name: normalized, tagIds: [] }];
      userProfileStorage.setItem(DESKTOP_TAG_GROUPS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

const deleteSidebarTagGroup = useCallback((groupId: string) => {
    setSidebarTagGroups((current) => {
      const next = current.filter((group) => group.id !== groupId);
      userProfileStorage.setItem(DESKTOP_TAG_GROUPS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

const assignSidebarTagToGroup = useCallback((normalizedName: string, groupId: string | null) => {
    setSidebarTagGroups((current) => {
      const next = current.map((group) => ({
        ...group,
        tagIds: group.tagIds.filter((tagId) => tagId !== normalizedName),
      })).map((group) => groupId === group.id
        ? { ...group, tagIds: [...group.tagIds, normalizedName] }
        : group);
      userProfileStorage.setItem(DESKTOP_TAG_GROUPS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

const updateSidebarTagProperty = useCallback((normalizedName: string, property: { color?: string; description?: string }) => {
    setTagProperties((current) => {
      const existing = current[normalizedName] ?? {};
      const nextProperty = { ...existing };
      if (property.color !== undefined && isTagColor(property.color)) nextProperty.color = property.color.toUpperCase();
      if (property.description !== undefined) {
        const description = property.description.trim().slice(0, 240);
        if (description) nextProperty.description = description;
        else delete nextProperty.description;
      }
      const next = { ...current, [normalizedName]: nextProperty };
      userProfileStorage.setItem(DESKTOP_TAG_PROPERTIES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

const selectedSidebarTagSummary = useMemo(
    () => sidebarTags.find((item) => item.normalizedName === selectedSidebarTag),
    [selectedSidebarTag, sidebarTags],
  );

const selectedSidebarTagGroup = useMemo(() => {
    if (!selectedSidebarTagSummary) return "未分组";
    const customGroup = sidebarTagGroups.find((group) => group.tagIds.includes(selectedSidebarTagSummary.normalizedName));
    if (customGroup) return customGroup.name;
    const [hierarchy] = selectedSidebarTagSummary.name.split(/[\/／]/).map((part) => part.trim()).filter(Boolean);
    return selectedSidebarTagSummary.name.includes("/") || selectedSidebarTagSummary.name.includes("／")
      ? hierarchy || "层级标签"
      : "未分组";
  }, [selectedSidebarTagSummary, sidebarTagGroups]);

const selectedSidebarTagLibraryCount = useMemo(
    () => new Set(tagResults.map((result) => result.libraryId)).size,
    [tagResults],
  );

const selectedSidebarTagLastUpdated = useMemo(() => {
    const latest = tagResults.reduce<number | undefined>((current, result) => (
      result.modifiedAt && (!current || result.modifiedAt > current) ? result.modifiedAt : current
    ), undefined);
    return latest ? formatSemanticDate(latest) : "暂无";
  }, [tagResults]);

const selectedSidebarTagRelated = useMemo(() => (
    relatedSidebarTags
      .map((tag) => ({ ...tag, color: resolveTagColor(tagProperties, tag.normalizedName) }))
  ), [relatedSidebarTags, tagProperties]);

  const refreshSidebarTags = useCallback(() => setTagTaxonomyRevision(current => current + 1), []);
  return { sidebarTags, selectedSidebarTag, setSelectedSidebarTag, tagResults, tagResultsFor, relatedSidebarTags, tagsLoading, dynamicFacets, favoriteSidebarTags, recentSidebarTags, sidebarTagGroups, tagProperties, selectedTagTaxonomy, tagTaxonomyRevision, tagResultContext, displayedSidebarTags, cleanupSidebarTags, selectedSidebarTagSummary, selectedSidebarTagGroup, selectedSidebarTagLibraryCount, selectedSidebarTagLastUpdated, selectedSidebarTagRelated, toggleFavoriteSidebarTag, rememberSidebarTag, createSidebarTagGroup, deleteSidebarTagGroup, assignSidebarTagToGroup, updateSidebarTagProperty, refreshSidebarTags };
}
