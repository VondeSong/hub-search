import { describe, expect, it } from "vitest";
import { journalEntryTitle, journalScopeTitle } from "./JournalPresentation";
import type { SearchResult } from "./SearchTypes";
const entry = (title: string, snippet: string) => ({ title, snippet, provider: "craft", libraryName: "Car" }) as SearchResult;
describe("Journal readable titles", () => {
  it("removes redundant dates, markup and incomplete import tags from display copy", () => {
    const original = entry("2026.10.07", '2026.10.07 <page>复盘 **线束方案**</page>');
    expect(journalEntryTitle(original)).toBe("复盘 线束方案");
    expect(original.snippet).toContain("<page>");
    expect(journalEntryTitle(entry("2026.10.07", "2026.10.07 <pag"))).toBe("Car 的日志");
    expect(journalEntryTitle(entry("2026.10.07", "2026.10.07 Video </cont"))).toBe("Video");
  });
  it("preserves descriptive titles and readable Markdown link labels", () => {
    expect(journalEntryTitle(entry("2026.10.07 设计复盘", "其他正文"))).toBe("设计复盘");
    expect(journalEntryTitle(entry("2026.10.07", "[设计参考](https://example.com)"))).toBe("设计参考");
  });
  it("names each supported date scope", () => {
    expect(journalScopeTitle("")).toBe("全部日志");
    expect(journalScopeTitle("2026-10")).toBe("2026年10月");
    expect(journalScopeTitle("2026-10-07")).toBe("10月7日");
  });
});
