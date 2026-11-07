import { describe, expect, it } from "vitest";
import { defaultTagColor, parseTagUserProperties, resolveTagColor, TAG_COLOR_PALETTE } from "./TagProperties";

describe("tag properties", () => {
  it("assigns a stable default palette color", () => {
    const color = defaultTagColor("movie");
    expect(TAG_COLOR_PALETTE).toContain(color as typeof TAG_COLOR_PALETTE[number]);
    expect(defaultTagColor("movie")).toBe(color);
  });

  it("keeps valid stored values and removes invalid ones", () => {
    expect(parseTagUserProperties(JSON.stringify({
      movie: { color: "#12abEF", description: "  电影资料  " },
      invalid: { color: "red" },
    }))).toEqual({ movie: { color: "#12ABEF", description: "电影资料" } });
  });

  it("prefers a customized color", () => {
    expect(resolveTagColor({ movie: { color: "#112233" } }, "movie")).toBe("#112233");
  });
});
