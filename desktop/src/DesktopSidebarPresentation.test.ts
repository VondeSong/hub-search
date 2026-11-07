import { describe, expect, it } from "vitest";
import {
  buildSidebarTagNavigation,
  filterSidebarTags,
  splitTagPath,
  type SidebarTagSummary,
} from "./DesktopSidebarPresentation";

function tag(name: string, count: number, normalizedName = name.toLocaleLowerCase()): SidebarTagSummary {
  return { name, normalizedName, count };
}

describe("DesktopSidebarPresentation", () => {
  it("builds fixed, hierarchy, custom, cleanup, and recent sections without duplicates", () => {
    const tags = [
      tag("固定", 12, "fixed"),
      tag("项目 / Alpha", 8, "alpha"),
      tag("项目 / Beta", 3, "beta"),
      tag("常用", 7, "common"),
      tag("分组", 5, "custom"),
      tag("最近", 2, "recent"),
      tag("孤立", 1, "single"),
    ];
    const result = buildSidebarTagNavigation(
      tags,
      ["fixed"],
      ["fixed", "custom", "common", "recent"],
      [{ id: "group", name: "工作", tagIds: ["custom"] }],
    );

    expect(result.favoriteTagItems.map((item) => item.normalizedName)).toEqual(["fixed"]);
    expect(result.tagGroups.map((group) => [group.name, group.tags.map(({ tag: item }) => item.normalizedName)])).toEqual([
      ["项目", ["alpha", "beta"]],
    ]);
    expect(result.customGroupTagItems.get("group")?.map((item) => item.normalizedName)).toEqual(["custom"]);
    expect(result.commonTags.map((item) => item.normalizedName)).toEqual(["common", "recent", "single"]);
    expect(result.recentTagItems).toEqual([]);
    expect(result.cleanupTags.map((item) => item.normalizedName)).toEqual(["single"]);
  });

  it("keeps recent tag order while excluding tags already visible elsewhere", () => {
    const tags = [
      tag("固定", 20, "fixed"),
      ...Array.from({ length: 8 }, (_, index) => tag(`常用 ${index + 1}`, 19 - index, `common-${index + 1}`)),
      tag("最近 A", 2, "recent-a"),
      tag("最近 B", 2, "recent-b"),
    ];
    const result = buildSidebarTagNavigation(tags, ["fixed"], ["recent-b", "fixed", "recent-a"], []);

    expect(result.recentTagItems.map((item) => item.normalizedName)).toEqual(["recent-b", "recent-a"]);
    expect(result.commonTags).toHaveLength(8);
  });

  it("normalizes hierarchy labels and searches case-insensitively", () => {
    expect(splitTagPath(tag(" 项目／ Alpha / 设计 ", 2))).toEqual({ group: "项目", label: "Alpha / 设计" });
    expect(filterSidebarTags([tag("Deep Work", 3), tag("阅读", 2)], " deep ").map((item) => item.name)).toEqual(["Deep Work"]);
    expect(filterSidebarTags([tag("Deep Work", 3)], "   ")).toEqual([]);
  });
});
