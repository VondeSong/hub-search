import { describe, expect, it } from "vitest";
import { sampleTimes, uploadSize } from "./CloudAgentMedia";

describe("Agents media limits", () => {
  it("selects ordered times inside the short video and respects the attachment budget", () => {
    expect(sampleTimes(3, 6)).toEqual([0.5, 1.5, 2.5]);
    expect(sampleTimes(12, 2)).toEqual([3, 9]);
    expect(sampleTimes(31, 6)).toEqual([]);
    expect(sampleTimes(5, 0)).toEqual([]);
  });

  it("counts decoded bytes including base64 padding", () => {
    expect(uploadSize([
      { name: "a.png", mime: "image/png", data: "YQ==" },
      { name: "b.jpg", mime: "image/jpeg", data: "YWI=" },
    ])).toBe(3);
  });
});
