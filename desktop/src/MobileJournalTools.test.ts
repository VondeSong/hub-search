// @vitest-environment jsdom
import { expect, it } from "vitest";
import { compareJournalItems, emptyJournalScope, journalSearchMatches, withJournalTags } from "./MobileJournalTools";
import type { QuickJournalItem } from "./JournalRecords";

const item = (id: string, date: string, text = "", modifiedAt?: number): QuickJournalItem => ({ record: { version: 1, id, date, text, attachments: [] }, body: text, modifiedAt, applied: true, uploaded: true, libraryId: "os", path: "", namespace: "ns" });
it("sorts dates and actual edit timestamps in either direction while keeping pins first", () => {
  const a = item("a", "2026-11-15", "", 3), b = item("b", "2026-11-16", "", 1);
  expect(compareJournalItems(a, b, "date-desc", [])).toBeGreaterThan(0);
  expect(compareJournalItems(a, b, "date-asc", [])).toBeLessThan(0);
  expect(compareJournalItems(a, b, "edit-desc", [])).toBeLessThan(0);
  expect(compareJournalItems(a, b, "edit-asc", [])).toBeGreaterThan(0);
  expect(compareJournalItems(a, b, "date-desc", ["a"])).toBeLessThan(0);
});
it("uses local Monday boundaries and an inclusive custom date range", () => {
  const scope = { ...emptyJournalScope(), period: "week" as const };
  expect(journalSearchMatches(item("a", "2026-11-15"), scope, "2026-11-16")).toBe(false);
  expect(journalSearchMatches(item("b", "2026-11-16"), scope, "2026-11-16")).toBe(true);
  const custom = { ...scope, period: "custom" as const, start: "2026-10-31", end: "2026-11-01" };
  expect(journalSearchMatches(item("c", "2026-11-01"), custom)).toBe(true);
  expect(journalSearchMatches(item("d", "2026-11-02"), custom)).toBe(false);
});
it("combines chosen tag rules and attachment conditions without accepting unrelated attachments", () => {
  const value = item("a", "2026-11-15", "正文 #work https://example.com");
  value.record.attachments = [{ hash: "a", name: "photo.png", image: true, size: 1 }];
  const scope = { ...emptyJournalScope(), tagMode: "include" as const, tags: ["work"], more: ["images", "links"] as Array<"images" | "links"> };
  expect(journalSearchMatches(value, scope)).toBe(true);
  expect(journalSearchMatches(value, { ...scope, tagMode: "exclude" })).toBe(false);
  expect(journalSearchMatches(value, { ...scope, more: ["audio"] })).toBe(false);
});
it("shows past anniversaries and never includes today's record in that preset", () => {
  const scope = { ...emptyJournalScope(), period: "anniversary" as const };
  expect(journalSearchMatches(item("a", "2025-11-16"), scope, "2026-11-16")).toBe(true);
  expect(journalSearchMatches(item("b", "2026-11-16"), scope, "2026-11-16")).toBe(false);
});
it("adds only missing valid tags without changing the existing body", () => {
  expect(withJournalTags("原文\n#work", "#work #新标签 #新标签")).toBe("原文\n#work\n#新标签");
  expect(() => withJournalTags("原文", "#bad,tag")).toThrow("有效标签");
  expect(withJournalTags("#work", "work")).toBe("#work");
});
