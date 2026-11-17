import { expect, it } from "vitest";
import { filterMobileFavorites, matchesMobileCollection } from "./MobileCollectionSearch";
import type { SearchResult } from "./SearchTypes";

it("filters only supplied favorites and preserves result identity for preview selection", () => {
  const first = { id: "a", title: "Hub 项目", snippet: "移动端原型", libraryName: "Main" } as SearchResult;
  const second = { id: "b", title: "阅读", snippet: "正文", libraryName: "Archive" } as SearchResult;
  const results = [first, second];
  expect(filterMobileFavorites(results, " HUB 移动端 ")).toEqual([first]);
  expect(filterMobileFavorites(results, "main")[0]).toBe(first);
  expect(filterMobileFavorites(results, "不存在")).toEqual([]);
  expect(filterMobileFavorites(results, "")).toEqual(results);
  expect(results).toHaveLength(2);
});

it("searches label names without treating punctuation as a regular expression", () => {
  expect(matchesMobileCollection("c++", "C++ 学习")).toBe(true);
  expect(matchesMobileCollection("项目", "生活日志")).toBe(false);
  expect(matchesMobileCollection("[", "项目")).toBe(false);
});
