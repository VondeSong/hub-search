import { describe, expect, it, vi } from "vitest";
import { filterCommandItems, type CommandPaletteItem } from "./CommandPaletteTypes";

const command = (id: string, label: string, description: string, keywords: string[] = []): CommandPaletteItem => ({
  id,
  label,
  description,
  keywords,
  category: "navigation",
  run: vi.fn(),
});

describe("filterCommandItems", () => {
  const items = [
    command("favorites", "打开收藏", "浏览收藏内容", ["star"]),
    command("sync", "同步资料库", "更新当前索引", ["refresh"]),
    command("preview", "切换预览", "显示或隐藏预览窗格"),
  ];

  it("returns every command for an empty query", () => {
    expect(filterCommandItems(items, "")).toEqual(items);
  });

  it("matches labels, descriptions and aliases", () => {
    expect(filterCommandItems(items, "收藏").map((item) => item.id)).toEqual(["favorites"]);
    expect(filterCommandItems(items, "索引").map((item) => item.id)).toEqual(["sync"]);
    expect(filterCommandItems(items, "refresh").map((item) => item.id)).toEqual(["sync"]);
  });

  it("ranks label prefixes ahead of description matches", () => {
    const ranked = filterCommandItems([
      command("description", "刷新内容", "切换预览"),
      command("label", "切换资料库", "选择来源"),
    ], "切换");
    expect(ranked.map((item) => item.id)).toEqual(["label", "description"]);
  });
});
