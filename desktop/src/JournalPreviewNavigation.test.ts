import { beforeEach, expect, it, vi } from "vitest";
import { readAdjacentJournalPreview } from "./JournalPreviewNavigation";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const dates = [{ date: "2026-10-13" }, { date: "2026-10-07" }, { date: "2026-10-06" }, { date: "2026-09-30" }];
const record = (date: string, id = "source-page", library = "car") => ({
  id, entityKey: `${library}:${id}`, documentId: "original-document", blockId: "original-block", provider: "obsidian",
  libraryId: library, libraryName: "Car", spaceId: library, spaceName: "Car", title: date.replace(/-/g, "."),
  journalDate: date, documentTitle: "原始标题", snippet: "**真实内容**", path: "原始/路径", sourceType: "obsidian_note", contentType: "document",
});
beforeEach(() => { invokeMock.mockReset(); });

it("chooses the nearest older date and forwards the active scope and query", async () => {
  const scope = ["car", "archive"];
  invokeMock.mockResolvedValue({ items: [record("2026-10-07")] });
  const result = await readAdjacentJournalPreview("2026-10-13", 1, dates, scope, "车辆");
  expect(invokeMock).toHaveBeenCalledExactlyOnceWith("journal_page", {
    spaceIds: ["car", "archive"], options: { from: "2026-10-07", to: "2026-10-07", query: "车辆", limit: 1, offset: 0, ascending: true },
  });
  expect(scope).toEqual(["car", "archive"]); expect(result?.journalDate).toBe("2026-10-07");
});
it("chooses the nearest newer date despite newest-first summary order", async () => {
  invokeMock.mockResolvedValue({ items: [record("2026-10-07")] });
  const result = await readAdjacentJournalPreview("2026-10-06", -1, dates, null, "");
  expect(invokeMock.mock.calls[0][1].options.from).toBe("2026-10-07"); expect(result?.journalDate).toBe("2026-10-07");
  expect(invokeMock.mock.calls[0][1].spaceIds).toBeNull();
});
it.each([1, -1] as const)("finds the nearest direction %s when the current day is absent from summary", async direction => {
  const expected = direction === 1 ? "2026-10-07" : "2026-10-13";
  invokeMock.mockResolvedValue({ items: [record(expected)] });
  await readAdjacentJournalPreview("2026-10-10", direction, dates, [], "scope");
  expect(invokeMock.mock.calls[0][1].options.from).toBe(expected); expect(invokeMock.mock.calls[0][1].spaceIds).toEqual([]);
});
it("skips days filtered out by query and does not reread duplicate dates", async () => {
  invokeMock.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: [record("2026-09-30")] });
  const result = await readAdjacentJournalPreview("2026-10-13", 1, [...dates, { date: "2026-10-07" }], ["car"], "匹配文本");
  expect(invokeMock.mock.calls.map(([, args]) => args.options.from)).toEqual(["2026-10-07", "2026-10-06", "2026-09-30"]);
  expect(invokeMock.mock.calls.every(([, args]) => args.options.query === "匹配文本")).toBe(true);
  expect(result?.journalDate).toBe("2026-09-30");
});
it("preserves actual source identity, date and open-navigation fields while normalizing display text", async () => {
  invokeMock.mockResolvedValue({ items: [record("2026-10-07")] });
  const result = await readAdjacentJournalPreview("2026-10-13", 1, dates, null, "");
  expect(result).toMatchObject({ id: "source-page", entityKey: "car:source-page", documentId: "original-document", blockId: "original-block", provider: "obsidian", libraryId: "car", spaceId: "car", journalDate: "2026-10-07", title: "2026.10.07", documentTitle: "原始标题", path: "原始/路径", snippet: "真实内容" });
});
it("returns null when every candidate is filtered out or no adjacent date exists", async () => {
  invokeMock.mockResolvedValue({ items: [] });
  expect(await readAdjacentJournalPreview("2026-10-13", 1, dates, null, "missing")).toBeNull();
  expect(invokeMock).toHaveBeenCalledTimes(3); invokeMock.mockClear();
  expect(await readAdjacentJournalPreview("2026-10-13", -1, dates, null, "")).toBeNull();
  expect(invokeMock).not.toHaveBeenCalled();
});
it("propagates read errors so preview controls can expose retry instead of skipping a failed day", async () => {
  const error = new Error("资料库读取失败"); invokeMock.mockRejectedValue(error);
  await expect(readAdjacentJournalPreview("2026-10-13", 1, dates, null, "")).rejects.toThrow("资料库读取失败");
  expect(invokeMock).toHaveBeenCalledTimes(1);
});
