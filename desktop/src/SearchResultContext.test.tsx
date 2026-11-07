// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { middleEllipsis, SearchResultContext } from "./SearchResultContext";

it("shortens the middle while preserving the source and leaf, and restores the complete path with enough space", () => {
  const path = "Obsidian / Main / 00_Journals / 2026 / 01 / 2026-01-31.md";
  const measure = (text: string) => Array.from(text).length * 8;
  const compact = middleEllipsis(path, 280, measure);
  expect(compact).toContain("…");
  expect(compact.startsWith("Obsidian")).toBe(true);
  expect(compact.endsWith("2026-01-31.md")).toBe(true);
  expect(measure(compact)).toBeLessThanOrEqual(280);
  expect(middleEllipsis(path, 1000, measure)).toBe(path);
});

it("does not split emoji while shortening a path", () => {
  const short = middleEllipsis("📚资料库 / 很长很长的目录 / 项目记录😀", 12, text => Array.from(text).length);
  expect(short.startsWith("📚")).toBe(true);
  expect(short.endsWith("😀")).toBe(true);
  expect(short).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

it("renders an actual update date and an accessible complete path; missing dates are not invented", () => {
  const html = renderToStaticMarkup(<SearchResultContext path="Main / Notes" modifiedAt={1769817600} />);
  expect(html).toContain('aria-label="Main / Notes"');
  expect(html).toContain("更新于");
  expect(html).toContain("2026年1月31日");
  expect(html).toContain('<time dateTime="2026-01-31T00:00:00.000Z">');
  expect(renderToStaticMarkup(<SearchResultContext path="Main" />)).toContain("更新日期未知");
  expect(renderToStaticMarkup(<SearchResultContext path="Main" modifiedAt={NaN} />)).not.toContain("Invalid");
});
