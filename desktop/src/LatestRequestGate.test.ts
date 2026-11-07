import { describe, expect, it } from "vitest";
import { LatestRequestGate } from "./LatestRequestGate";

describe("LatestRequestGate", () => {
  it("invalidates an active request as soon as input changes", () => {
    const gate = new LatestRequestGate();
    const oldRequest = gate.begin();
    expect(gate.isCurrent(oldRequest)).toBe(true);

    gate.invalidate();
    expect(gate.isCurrent(oldRequest)).toBe(false);
  });

  it("accepts only the newest overlapping request", () => {
    const gate = new LatestRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });
});
