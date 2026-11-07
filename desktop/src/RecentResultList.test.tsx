// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentResultList } from "./RecentResultList";
import type { SearchResult } from "./SearchTypes";
import { asPageFavorite, pageFavoriteKey } from "./PageFavorites";

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

const completedTask: SearchResult = {
  id: "task-1", entityKey: "dida365:task-1", documentId: "task-1", contentType: "task",
  sourceType: "task", provider: "dida365", libraryId: "dida", libraryName: "滴答清单",
  spaceId: "dida", spaceName: "滴答清单", title: "已经处理的任务", path: "项目 A",
  taskStatus: 2, snippet: "", matchTerms: [], matchField: "title", matchCount: 1, subMatches: [],
};

describe("RecentResultList task presentation", () => {
  it("does not dim saved pages or starred recent entries when their search snippets are empty", async () => {
    const page = { ...completedTask, provider: "craft" as const, taskStatus: undefined, id: "page", documentId: "page", entityKey: "page", snippet: "原页面的正文摘要" };
    const saved = asPageFavorite(page);
    expect(saved.snippet).toBe("");
    const starred = { ...page, id: "starred", documentId: "starred", entityKey: "starred", snippet: "" };
    const empty = { ...page, id: "empty", documentId: "empty", entityKey: "empty", snippet: "" };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<RecentResultList
      recentGroups={[{ key: "recent", label: "", entries: [{ result: saved, index: 0 }, { result: starred, index: 1 }, { result: empty, index: 2 }] }]}
      favoriteIds={new Set([pageFavoriteKey(starred)])}
      selectedIndex={0} isMobileLayout={false} semanticRecentDates={false}
      onHoverResult={vi.fn()} onSelectResult={vi.fn()} onOpenResult={vi.fn()} onContextResult={vi.fn()}
      onPrepareResultLink={vi.fn()} onDragResult={vi.fn()} onToggleFavorite={vi.fn()}
      renderLibraryIcon={() => <span aria-hidden="true" />}
    />));
    const rows = container.querySelectorAll(".recent-item");
    expect(rows[0].classList.contains("empty-content")).toBe(false);
    expect(rows[1].classList.contains("empty-content")).toBe(false);
    expect(rows[2].classList.contains("empty-content")).toBe(true);
    expect(container.querySelectorAll(".recent-item.empty-content")).toHaveLength(1);
  });
  it("dims empty rows and renders completed tasks with a struck title and preview-style icon", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<RecentResultList
      recentGroups={[{ key: "tasks", label: "", entries: [{ result: completedTask, index: 0 }] }]}
      selectedIndex={-1}
      isMobileLayout={false}
      semanticRecentDates={false}
      onHoverResult={vi.fn()}
      onSelectResult={vi.fn()}
      onOpenResult={vi.fn()}
      onContextResult={vi.fn()}
      onPrepareResultLink={vi.fn()}
      onDragResult={vi.fn()}
      renderLibraryIcon={() => <span aria-hidden="true" />}
    />));

    const row = container.querySelector(".recent-item");
    expect(row?.classList.contains("empty-content")).toBe(true);
    expect(row?.classList.contains("task-completed")).toBe(true);
    expect(row?.querySelector(".recent-title-text")?.textContent).toBe("已经处理的任务");
    expect(row?.querySelector('[aria-label="已完成"] svg circle')).not.toBeNull();
    expect(row?.querySelector('[aria-label="已完成"] svg path')).not.toBeNull();
    expect(row?.querySelector(".dida-result-status")?.textContent).toBe("");
  });
});
