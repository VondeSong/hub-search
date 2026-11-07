import { expect, it } from "vitest";
import { findTaskForResult, isTaskPreviewResult } from "./TaskResultIdentity";
import { taskSearchResult } from "./TaskWorkspaceResult";
import type { UnifiedTask } from "./TaskWorkspacePresentation";

const task: UnifiedTask = {
  id: "hub-task", provider: "craft", libraryId: "craft", libraryName: "Craft", sourceId: "block", documentId: "page",
  documentTitle: "Page", title: "Same title", status: "open", completed: false, parentTaskId: "", parentPageId: "page",
  isAllDay: false, path: "", depth: 0, isProject: false, linkedProviders: ["craft", "dida365"], syncState: "linked",
  sourceRefs: [{ provider: "craft", libraryId: "craft", documentId: "page", sourceId: "block" },
    { provider: "dida365", libraryId: "dida-account", documentId: "dida-task", sourceId: "dida-task" }],
};
const dida = { ...taskSearchResult(task), provider: "dida365" as const, contentType: "dida_task", sourceType: "dida_task",
  libraryId: "dida-account", spaceId: "dida-account", documentId: "dida-task", blockId: "dida-task" };

it.each(["task", "dida_task", "document", "markdown_section"])("recognizes %s Dida search results as task previews", contentType => {
  expect(isTaskPreviewResult({ ...dida, contentType })).toBe(true);
});

it("resolves a linked secondary source by its exact source identity", () => {
  const similar = { ...task, id: "other-task", sourceRefs: [{ ...task.sourceRefs![1], libraryId: "other-account" }] };
  expect(findTaskForResult([similar, task], dida)).toBe(task);
  expect(findTaskForResult([task], { ...dida, spaceId: "other-account" })).toBeUndefined();
  expect(findTaskForResult([task], { ...dida, documentId: "another-task" })).toBeUndefined();
  expect(findTaskForResult([task], { ...dida, provider: "craft" })).toBeUndefined();
});

it("matches Craft task blocks without granting an ordinary page a task control", () => {
  expect(findTaskForResult([task], taskSearchResult(task))).toBe(task);
  const indexedBlock = { ...taskSearchResult(task), contentType: "markdown_section", sourceType: "craft_page" };
  expect(findTaskForResult([task], indexedBlock)).toBe(task);
  expect(findTaskForResult([task], { ...indexedBlock, blockId: "ordinary-heading-block" })).toBeUndefined();
  expect(findTaskForResult([task], { ...taskSearchResult(task), blockId: "different-block" })).toBeUndefined();
  expect(isTaskPreviewResult({ ...taskSearchResult(task), contentType: "craft_subpage", sourceType: "craft_page" })).toBe(false);
});

it("keeps attachment, OCR and PDF previews out of task status controls", () => {
  expect(findTaskForResult([task], { ...dida, sourceItemId: "attachment" })).toBeUndefined();
  for (const contentType of ["pdf_page", "pdf_ocr", "image_ocr"]) {
    expect(isTaskPreviewResult({ ...dida, contentType })).toBe(false);
  }
});

it("retains read-only status controls for generic project and line-task previews", () => {
  for (const current of [
    { ...task, isProject: true, sourceId: "craft-project-page:page" },
    { ...task, sourceId: "page:line:4" },
    { ...task, provider: "obsidian" as const, sourceId: "note:line:3" },
  ]) {
    const selected = taskSearchResult(current);
    expect(findTaskForResult([current], selected)).toBe(current);
    expect(findTaskForResult([current], { ...selected, spaceId: "other-library" })).toBeUndefined();
    expect(findTaskForResult([current], { ...selected, blockId: "other-block" })).toBeUndefined();
  }
});
