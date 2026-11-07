import { describe, expect, it } from "vitest";
import {
  beginExternalOpen,
  externalLinkTarget,
  externalOpenSuccessMessage,
  finishExternalOpen,
  isCraftHttpsUrl,
} from "./ExternalLinkOpening";

describe("external link opening", () => {
  it("identifies supported targets and rejects unsafe protocols", () => {
    expect(externalLinkTarget("https://example.com/article")?.label).toBe("example.com");
    expect(externalLinkTarget("obsidian://open?vault=Main")?.application).toBe("Obsidian");
    expect(externalLinkTarget("craftdocs://open?blockId=1")?.application).toBe("Craft");
    expect(externalLinkTarget("https://docs.craft.do/editor/d/space/doc")?.application).toBe("Craft");
    expect(externalLinkTarget("javascript:alert(1)")).toBeNull();
  });

  it("recognizes only official Craft HTTPS hosts", () => {
    expect(isCraftHttpsUrl("https://docs.craft.do/editor/d/space/doc?s=secret#block")).toBe(true);
    expect(isCraftHttpsUrl("https://craft.do/page")).toBe(true);
    expect(isCraftHttpsUrl("http://docs.craft.do/page")).toBe(false);
    expect(isCraftHttpsUrl("https://craft.do.example.com/page")).toBe(false);
  });

  it("reports slow Hub handoff without implying that the webpage finished loading", () => {
    const target = externalLinkTarget("https://example.com")!;
    expect(externalOpenSuccessMessage(target, 220)).toBe("已交给浏览器打开 · example.com");
    expect(externalOpenSuccessMessage(target, 1_240)).toBe("已交给浏览器打开 · example.com · Hub 响应 1.2 秒");
  });

  it("blocks duplicate opens until the trailing cooldown ends", () => {
    const gate = { pending: false, cooldownUntil: 0 };
    expect(beginExternalOpen(gate, 1_000)).toBe(true);
    expect(beginExternalOpen(gate, 1_001)).toBe(false);
    finishExternalOpen(gate, 1_400);
    expect(beginExternalOpen(gate, 2_199)).toBe(false);
    expect(beginExternalOpen(gate, 2_200)).toBe(true);
  });
});
