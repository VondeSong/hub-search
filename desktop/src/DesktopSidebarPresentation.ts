export type SidebarTagSummary = {
  name: string;
  normalizedName: string;
  count: number;
};

export type SidebarTagGroup = {
  id: string;
  name: string;
  tagIds: string[];
};

export type SidebarHierarchyGroup = {
  name: string;
  tags: Array<{ tag: SidebarTagSummary; label: string }>;
};

export type SidebarTagNavigation = {
  favoriteTagSet: Set<string>;
  cleanupTags: SidebarTagSummary[];
  customGroupByTag: Map<string, string>;
  customGroupTagItems: Map<string, SidebarTagSummary[]>;
  favoriteTagItems: SidebarTagSummary[];
  tagGroups: SidebarHierarchyGroup[];
  commonTags: SidebarTagSummary[];
  recentTagItems: SidebarTagSummary[];
};

export function tagCleanupReason(tag: SidebarTagSummary): string | null {
  const name = tag.name.trim();
  if (tag.count <= 0) return "空标签";
  if (/\^|`|<br\s*\/?>|[{}]/i.test(name)) return "格式异常";
  if (/^#?[0-9a-f]{6}$/i.test(name)) return "疑似颜色值";
  if (name.length > 40) return "名称过长";
  if (tag.count === 1) return "仅使用 1 次";
  return null;
}

export function splitTagPath(tag: SidebarTagSummary): { group: string; label: string } | null {
  const parts = tag.name.split(/[\/／]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return { group: parts[0], label: parts.slice(1).join(" / ") };
}

export function filterSidebarTags(tags: SidebarTagSummary[], query: string): SidebarTagSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return tags.filter((tag) => tag.name.toLocaleLowerCase().includes(needle));
}

export function buildSidebarTagNavigation(
  tags: SidebarTagSummary[],
  favoriteTags: string[],
  recentTags: string[],
  customTagGroups: SidebarTagGroup[],
): SidebarTagNavigation {
  const favoriteTagSet = new Set(favoriteTags);
  const customGroupByTag = new Map<string, string>();
  for (const group of customTagGroups) {
    for (const tagId of group.tagIds) customGroupByTag.set(tagId, group.id);
  }

  const tagById = new Map<string, SidebarTagSummary>();
  const cleanupTags: SidebarTagSummary[] = [];
  const hierarchyGroups = new Map<string, SidebarHierarchyGroup>();
  const commonCandidates: SidebarTagSummary[] = [];

  for (const tag of tags) {
    tagById.set(tag.normalizedName, tag);
    if (tagCleanupReason(tag)) cleanupTags.push(tag);

    if (customGroupByTag.has(tag.normalizedName)) continue;
    const path = splitTagPath(tag);
    if (path) {
      const group = hierarchyGroups.get(path.group) ?? { name: path.group, tags: [] };
      group.tags.push({ tag, label: path.label });
      hierarchyGroups.set(path.group, group);
    } else if (!favoriteTagSet.has(tag.normalizedName)) {
      commonCandidates.push(tag);
    }
  }

  const favoriteTagItems = favoriteTags.flatMap((id) => tagById.get(id) ?? []);
  const tagGroups = [...hierarchyGroups.values()]
    .map((group) => ({
      ...group,
      tags: group.tags.sort((left, right) => right.tag.count - left.tag.count || left.label.localeCompare(right.label, "zh-CN")),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const commonTags = commonCandidates
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN"))
    .slice(0, 8);

  const customGroupTagItems = new Map<string, SidebarTagSummary[]>();
  for (const group of customTagGroups) {
    customGroupTagItems.set(group.id, group.tagIds.flatMap((tagId) => tagById.get(tagId) ?? []));
  }

  const alreadyVisible = new Set([
    ...favoriteTags,
    ...customGroupByTag.keys(),
    ...commonTags.map((tag) => tag.normalizedName),
  ]);
  const recentTagItems = recentTags
    .flatMap((id) => alreadyVisible.has(id) ? [] : tagById.get(id) ?? [])
    .slice(0, 5);

  return {
    favoriteTagSet,
    cleanupTags,
    customGroupByTag,
    customGroupTagItems,
    favoriteTagItems,
    tagGroups,
    commonTags,
    recentTagItems,
  };
}
