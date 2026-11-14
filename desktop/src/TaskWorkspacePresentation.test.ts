import { describe, expect, it } from "vitest";
import {
  filterCollapsedTaskDescendants,
  filterAndSortTasks,
  filterTasksByLibraries,
  taskCollections,
  taskCollectionKey,
  groupTasksByProvider,
  summarizeTasks,
  restoreTaskStatusFilter,
  type UnifiedTask,
} from "./TaskWorkspacePresentation";

it("applies exact multi-library scope without treating an empty scope as all", () => {
  const tasks = [task({ id: "a", title: "A", libraryId: "one" }), task({ id: "b", title: "B", libraryId: "two" })];
  expect(filterTasksByLibraries(tasks, null)).toEqual(tasks);
  expect(filterTasksByLibraries(tasks, ["one"]).map(item => item.id)).toEqual(["a"]);
  expect(filterTasksByLibraries(tasks, ["one", "two"])).toEqual(tasks);
  expect(filterTasksByLibraries(tasks, [])).toEqual([]);
});

it("retains one canonical task when selecting either of its materialized source libraries", () => {
  const linked = task({ id: "shared", title: "跨来源任务", libraryId: "one", linkedLibraryIds: ["one", "dida"], linkedProviders: ["craft", "dida365"], syncState: "linked" });
  const tasks = [linked, task({ id: "other", title: "其他任务", libraryId: "two" })];
  expect(filterTasksByLibraries(tasks, ["dida"])).toEqual([linked]);
  expect(filterTasksByLibraries(tasks, ["one", "dida"])).toEqual([linked]);
  expect(filterTasksByLibraries(tasks, [])).toEqual([]);
});

it("groups projects without merging identical names or IDs across libraries", () => {
  const a = task({ id: "a", title: "A", libraryId: "one", documentId: "same", documentTitle: "项目" });
  const b = task({ id: "b", title: "B", libraryId: "two", documentId: "same", documentTitle: "项目" });
  expect(taskCollectionKey(a)).not.toBe(taskCollectionKey(b));
  expect(taskCollections([a, { ...a, id: "c" }, b]).map(group => group.count)).toEqual([2, 1]);
});

it("groups Dida tasks by their real project ID, not each task's document ID", () => {
  const a = task({ id: "a", title: "A", provider: "dida365", documentId: "task-a", collectionId: "project-1" });
  const b = task({ id: "b", title: "B", provider: "dida365", documentId: "task-b", collectionId: "project-1" });
  const c = task({ id: "c", title: "C", provider: "dida365", documentId: "task-c", collectionId: "project-2" });
  expect(taskCollectionKey(a)).toBe(taskCollectionKey(b));
  expect(taskCollections([a,b,c])).toHaveLength(2);
});

function task(overrides: Partial<UnifiedTask> & Pick<UnifiedTask, "id" | "title">): UnifiedTask {
  const { id, title, ...rest } = overrides;
  return {
    id,
    provider: "craft",
    libraryId: "library",
    libraryName: "资料库",
    sourceId: id,
    parentTaskId: "",
    parentPageId: "page",
    documentId: "document",
    documentTitle: "项目文档",
    title,
    completed: false,
    status: "open",
    isAllDay: true,
    path: "路径",
    depth: 0,
    isProject: false,
    linkedProviders: [],
    syncState: "unlinked",
    ...rest,
  };
}

describe("task workspace presentation", () => {
  it("hides descendants of collapsed parents for hierarchical task views", () => {
    const tasks = [
      task({ id: "project", title: "父项目", isProject: true }),
      task({ id: "project-child", title: "项目子任务", depth: 1 }),
      task({ id: "markdown-parent", title: "父任务" }),
      task({ id: "markdown-child", title: "子任务", depth: 1 }),
      task({ id: "sibling", title: "同级任务" }),
    ];

    const filtered = filterCollapsedTaskDescendants(tasks, {
      collapsedTaskIds: new Set(["project", "markdown-parent"]),
      parentIds: new Map([["markdown-child", "markdown-parent"]]),
      taskIdsWithChildren: new Set(["project", "markdown-parent"]),
      query: "",
    });

    expect(filtered.map((item) => item.id)).toEqual(["project", "markdown-parent", "sibling"]);
  });

  it("keeps descendants visible while searching", () => {
    const tasks = [
      task({ id: "parent", title: "父任务" }),
      task({ id: "child", title: "匹配的子任务", depth: 1 }),
    ];

    expect(filterCollapsedTaskDescendants(tasks, {
      collapsedTaskIds: new Set(["parent"]),
      parentIds: new Map([["child", "parent"]]),
      taskIdsWithChildren: new Set(["parent"]),
      query: "匹配",
    })).toBe(tasks);
  });

  it("filters across title, document and library while respecting status and source", () => {
    const tasks = [
      task({ id: "craft", title: "准备发布", documentTitle: "北辰项目" }),
      task({ id: "dida", title: "购买耗材", provider: "dida365", libraryName: "工作清单" }),
      task({ id: "done", title: "旧任务", completed: true, status: "completed" }),
    ];

    expect(filterAndSortTasks(tasks, { query: "北辰", status: "open", source: "craft", sort: "default", ascending: true }).map((item) => item.id)).toEqual(["craft"]);
    expect(filterAndSortTasks(tasks, { query: "工作清单", status: "open", source: "dida365", sort: "default", ascending: true }).map((item) => item.id)).toEqual(["dida"]);
  });

  it("sorts parent units while keeping their visible children attached", () => {
    const tasks = [
      task({ id: "z", title: "Z 项目", isProject: true }),
      task({ id: "z-child", title: "子任务", depth: 1 }),
      task({ id: "a", title: "A 项目", isProject: true }),
      task({ id: "a-child", title: "另一个子任务", depth: 1 }),
    ];
    const sorted = filterAndSortTasks(tasks, { query: "", status: "all", source: "all", sort: "title", ascending: true });
    expect(sorted.map((item) => item.id)).toEqual(["a", "a-child", "z", "z-child"]);
  });

  it("summarizes and groups tasks in one stable provider order", () => {
    const tasks = [
      task({ id: "craft", title: "Craft", syncState: "linked" }),
      task({ id: "dida", title: "滴答", provider: "dida365", completed: true, status: "completed" }),
      task({ id: "obsidian", title: "Obsidian", provider: "obsidian" }),
    ];

    expect(summarizeTasks(tasks)).toEqual({ total: 3, projects: 0, open: 2, completed: 1, abandoned: 0, linked: 1, craft: 1, dida365: 1, obsidian: 1 });
    expect(groupTasksByProvider(tasks).map((group) => [group.provider, group.tasks.map((item) => item.id)])).toEqual([
      ["dida365", ["dida"]],
      ["craft", ["craft"]],
      ["obsidian", ["obsidian"]],
    ]);
  });
});

it("separates abandoned tasks from open and completed history", () => {
  const tasks = [
    task({ id: "open", title: "open" }),
    task({ id: "done", title: "done", status: "completed", completed: true }),
    task({ id: "abandoned", title: "abandoned", status: "abandoned", completed: false }),
  ];
  const select = (status: "open" | "completed" | "abandoned" | "all") =>
    filterAndSortTasks(tasks, { query: "", status, source: "all", sort: "default", ascending: true }).map(t => t.id);
  expect(select("open")).toEqual(["open"]);
  expect(select("completed")).toEqual(["done"]);
  expect(select("abandoned")).toEqual(["abandoned"]);
  expect(select("all")).toHaveLength(3);
  expect(summarizeTasks(tasks)).toMatchObject({ open: 1, completed: 1, abandoned: 1 });
});
it("defaults to pending while preserving explicit saved filters", () => {
  expect(restoreTaskStatusFilter(undefined)).toBe("open");
  expect(restoreTaskStatusFilter("invalid")).toBe("open");
  for (const state of ["all", "open", "completed", "abandoned"]) {
    expect(restoreTaskStatusFilter(state)).toBe(state);
  }
});

it("finds verified linked sources once and counts project containers separately", () => {
  const linked = task({ id: "linked", title: "One action", provider: "craft", sourceRefs: [
    { provider: "craft", libraryId: "craft", documentId: "doc", sourceId: "block" },
    { provider: "dida365", libraryId: "account", documentId: "remote", sourceId: "remote" },
  ] });
  const project = task({ id: "project", title: "Project", isProject: true });
  const rows = [project, linked];
  expect(filterAndSortTasks(rows, { query: "", status: "all", source: "dida365", sort: "default", ascending: true })).toEqual([linked]);
  expect(summarizeTasks(rows)).toMatchObject({ total: 1, projects: 1, open: 1, craft: 1, dida365: 1 });
  expect(groupTasksByProvider(rows).flatMap(g => g.tasks).filter(t => t.id === "linked")).toHaveLength(1);
});
