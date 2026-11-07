// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MobileAppEntry } from "./MobileAppEntry";

it("fits the keyboard viewport, restores its height, and ignores pinch zoom", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 900, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 900);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MobileAppEntry filtersOpen={false} previewOpen={false} style={{}}><input /></MobileAppEntry>));
    const main = host.querySelector("main")!;
    await act(async () => { viewport.height = 500; viewport.dispatchEvent(new Event("resize")); });
    expect(main.classList.contains("mobile-keyboard-open")).toBe(true);
    expect(main.style.getPropertyValue("--mobile-viewport-height")).toBe("500px");
    await act(async () => { viewport.scale = 2; viewport.height = 250; viewport.dispatchEvent(new Event("resize")); });
    expect(main.style.getPropertyValue("--mobile-viewport-height")).toBe("500px");
    await act(async () => { viewport.scale = 1; viewport.height = 900; viewport.dispatchEvent(new Event("resize")); });
    expect(main.classList.contains("mobile-keyboard-open")).toBe(false);
    expect(main.style.getPropertyValue("--mobile-viewport-height")).toBe("900px");
    await act(async () => root.unmount());
    viewport.height = 500;
    viewport.dispatchEvent(new Event("resize"));
    expect(host.childElementCount).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
