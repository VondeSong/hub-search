import { describe, expect, it } from "vitest";
import { tagCleanupReason } from "./DesktopSidebar";
import type { SidebarTagSummary } from "./DesktopSidebar";

function tag(name: string, count: number): SidebarTagSummary {
  return { name, normalizedName: name.toLocaleLowerCase(), count };
}

describe("tagCleanupReason", () => {
  it("flags formatting artifacts before low usage", () => {
    expect(tagCleanupReason(tag("tag`", 1))).toBe("格式异常");
  });

  it("flags values that look like color tokens", () => {
    expect(tagCleanupReason(tag("a0c0e0", 3))).toBe("疑似颜色值");
  });

  it("flags tags used only once", () => {
    expect(tagCleanupReason(tag("movie", 1))).toBe("仅使用 1 次");
  });

  it("keeps established tags out of cleanup", () => {
    expect(tagCleanupReason(tag("结构学", 12))).toBeNull();
  });
});
