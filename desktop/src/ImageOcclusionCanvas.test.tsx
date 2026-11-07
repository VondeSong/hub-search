// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageOcclusionCanvas } from "./ImageOcclusionCanvas";

describe("ImageOcclusionCanvas media loading", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps focused review media eager by default", async () => {
    await act(async () => root.render(<ImageOcclusionCanvas imageUrl="asset:test.png" occlusions={[]} />));
    const image = container.querySelector("img")!;
    expect(image.getAttribute("loading")).toBe("eager");
    expect(image.getAttribute("decoding")).toBe("async");
  });

  it("allows database thumbnails to defer loading", async () => {
    await act(async () => root.render(<ImageOcclusionCanvas imageUrl="asset:test.png" occlusions={[]} loading="lazy" />));
    expect(container.querySelector("img")?.getAttribute("loading")).toBe("lazy");
  });
});
