// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DeferredVideo } from "./DeferredVideo";

it("pauses loaded video when a toggle collapses or the document hides without resuming it automatically", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<details open><summary>Media</summary><DeferredVideo src="video.mp4" /></details>));
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    const details = host.querySelector("details")!;
    pause.mockClear(); details.open = false;
    await act(async () => details.dispatchEvent(new Event("toggle")));
    expect(pause).toHaveBeenCalled();
    pause.mockClear(); Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(pause).toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { configurable: true, value: false }); details.open = true;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); details.dispatchEvent(new Event("toggle")); });
    expect(play).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); Reflect.deleteProperty(document, "hidden"); delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; }
});
