import { describe, expect, it } from "vitest";
import { nextProgressiveCount, progressiveSlice } from "./ProgressiveRendering";

describe("progressive rendering", () => {
  it("renders only the current window without changing the source collection", () => {
    const cards = Array.from({ length: 150 }, (_, index) => `card-${index}`);
    expect(progressiveSlice(cards, 60)).toHaveLength(60);
    expect(cards).toHaveLength(150);
    expect(progressiveSlice(cards, 200)).toBe(cards);
  });

  it("grows by one page and stops at the available total", () => {
    expect(nextProgressiveCount(60, 150, 60)).toBe(120);
    expect(nextProgressiveCount(120, 150, 60)).toBe(150);
  });
});
