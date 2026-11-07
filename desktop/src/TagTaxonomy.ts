export type TagTaxonomySummary = {
  canonicalTagId: string | null;
  canonicalTargets: string[];
  ambiguousCanonical: boolean;
  aliases: string[];
  mergedSources: string[];
  parents: string[];
  children: string[];
  retired: boolean;
  replacementTagId: string | null;
  splitRequired: boolean;
};

export type TagTaxonomyResponse = {
  schemaVersion: "hub.tag-taxonomy.v1";
  tagId: string | null;
  count: number;
  summary: TagTaxonomySummary;
  sourceTagsModified: false;
};

export const EMPTY_TAG_TAXONOMY: TagTaxonomySummary = {
  canonicalTagId: null,
  canonicalTargets: [],
  ambiguousCanonical: false,
  aliases: [],
  mergedSources: [],
  parents: [],
  children: [],
  retired: false,
  replacementTagId: null,
  splitRequired: false,
};
