export type UnifiedTask = {
  collectionId?: string;
  id: string;
  provider: "craft" | "dida365" | "obsidian";
  libraryId: string;
  libraryName: string;
  /** Materialized source libraries represented by this deduplicated task. */
  linkedLibraryIds?: string[];
  /** Exact materialized sources of this task, including a linked secondary provider. */
  sourceRefs?: Array<{ provider: UnifiedTask["provider"]; libraryId: string; documentId: string; sourceId: string }>;
  sourceId: string;
  parentTaskId: string;
  parentPageId: string;
  documentId: string;
  documentTitle: string;
  collectionName?: string;
  title: string;
  completed: boolean;
  status: "open" | "completed" | "abandoned";
  isAllDay: boolean;
  /** Provider timezone used to decode all-day timestamps stored as instants. */
  timeZone?: string;
  startAt?: string;
  dueAt?: string;
  scheduledAt?: string;
  createdAt?: string;
  completedAt?: string;
  reminderAt?: string[];
  createdTimeSource?: "source" | "hub";
  completedTimeSource?: "source" | "hub";
  completionHistory?: Array<{ at: string; source: "source" | "hub"; reopened: boolean }>;
  statusMutation?: { operationId: number; state: "pending" | "failed" | "confirmed"; targetStatus: "open" | "completed"; error?: string };
  statusWriteBlockedReason?: string;
  modifiedAt?: number;
  contentRevision?: string;
  indexedAt?: number;
  priority?: number;
  tags?: string[];
  path: string;
  depth: number;
  isProject: boolean;
  linkedProviders: string[];
  syncState: "unlinked" | "linked" | "conflict" | "paused";
};

export type TaskStatusFilter = "open" | "all" | "completed" | "abandoned";
export type TaskSourceFilter = "all" | UnifiedTask["provider"];
export type TaskSort = "default" | "title" | "due" | "updated";

export function taskMatchesLibraryScope(task: UnifiedTask, libraryIds: string[] | null): boolean {
  return libraryIds === null || libraryIds.includes(task.libraryId)
    || (task.linkedLibraryIds || []).some(libraryId => libraryIds.includes(libraryId));
}

export function filterTasksByLibraries(tasks: UnifiedTask[], libraryIds: string[] | null) {
  return libraryIds === null ? tasks : tasks.filter(task => taskMatchesLibraryScope(task, libraryIds));
}

export function taskCollectionKey(task: UnifiedTask) {
  return JSON.stringify([task.provider, task.libraryId, task.collectionId || task.documentId || task.parentPageId || task.sourceId]);
}
export function taskCollections(tasks: UnifiedTask[]) {
  const groups = new Map<string, { key: string; name: string; library: string; count: number }>();
  for (const task of tasks) {
    const key = taskCollectionKey(task);
    const group = groups.get(key) ?? { key, name: task.documentTitle || task.title || "未命名清单", library: task.libraryName, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function filterCollapsedTaskDescendants(
  tasks: UnifiedTask[],
  options: {
    collapsedTaskIds: ReadonlySet<string>;
    parentIds: ReadonlyMap<string, string>;
    taskIdsWithChildren: ReadonlySet<string>;
    query: string;
  },
): UnifiedTask[] {
  if (options.collapsedTaskIds.size === 0 || options.query.trim()) return tasks;

  const result: UnifiedTask[] = [];
  let collapsedProjectDepth: number | null = null;
  for (const task of tasks) {
    let ancestorId = options.parentIds.get(task.id);
    let hiddenByAncestor = false;
    while (ancestorId) {
      if (options.collapsedTaskIds.has(ancestorId)) {
        hiddenByAncestor = true;
        break;
      }
      ancestorId = options.parentIds.get(ancestorId);
    }
    if (hiddenByAncestor) continue;

    if (collapsedProjectDepth !== null) {
      if (task.depth > collapsedProjectDepth) continue;
      collapsedProjectDepth = null;
    }
    result.push(task);
    if (task.isProject && options.taskIdsWithChildren.has(task.id) && options.collapsedTaskIds.has(task.id)) {
      collapsedProjectDepth = task.depth;
    }
  }
  return result;
}

export function filterAndSortTasks(
  tasks: UnifiedTask[],
  options: {
    query: string;
    status: TaskStatusFilter;
    source: TaskSourceFilter;
    sort: TaskSort;
    ascending: boolean;
  },
): UnifiedTask[] {
  const needle = options.query.trim().toLocaleLowerCase();
  const filtered = tasks.filter((task) => {
    if (options.status !== "all" && task.status !== options.status) return false;
    if (options.source !== "all" && task.provider !== options.source
      && !task.sourceRefs?.some(ref => ref.provider === options.source)) return false;
    if (!needle) return true;
    return `${task.title} ${task.documentTitle} ${task.libraryName}`.toLocaleLowerCase().includes(needle);
  });
  if (options.sort === "default") return filtered;

  const units: UnifiedTask[][] = [];
  for (const task of filtered) {
    if (task.depth === 0 || units.length === 0) units.push([task]);
    else units[units.length - 1].push(task);
  }
  const value = (task: UnifiedTask) => options.sort === "title"
    ? task.title.toLocaleLowerCase()
    : options.sort === "due"
      ? task.dueAt ?? "9999-12-31"
      : String(task.modifiedAt ?? 0).padStart(16, "0");
  units.sort((left, right) => {
    const compared = value(left[0]).localeCompare(value(right[0]), "zh-CN");
    return options.ascending ? compared : -compared;
  });
  return units.flat();
}

export function summarizeTasks(tasks: UnifiedTask[]) {
  const summary = { total: 0, projects: 0, open: 0, completed: 0, abandoned: 0, linked: 0, craft: 0, dida365: 0, obsidian: 0 };
  for (const task of tasks) {
    if (task.isProject) { summary.projects += 1; continue; }
    summary.total += 1;
    summary[task.status] += 1;
    if (task.syncState === "linked") summary.linked += 1;
    for (const provider of new Set([task.provider, ...(task.sourceRefs || []).map(ref => ref.provider)])) summary[provider] += 1;
  }
  return summary;
}

export function groupTasksByProvider(tasks: UnifiedTask[]) {
  const groups: Record<UnifiedTask["provider"], UnifiedTask[]> = { dida365: [], craft: [], obsidian: [] };
  for (const task of tasks) groups[task.provider].push(task);
  return ([
    ["dida365", "滴答清单"],
    ["craft", "Craft"],
    ["obsidian", "Obsidian"],
  ] as const).map(([provider, label]) => ({ provider, label, tasks: groups[provider] }));
}

export function restoreTaskStatusFilter(value: unknown): TaskStatusFilter {
  return value === "all" || value === "completed" || value === "abandoned" ? value : "open";
}
