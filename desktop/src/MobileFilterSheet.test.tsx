// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileFilterSheet } from "./MobileFilterSheet";

function Harness() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("不限");
  return <><button id="trigger" onClick={() => setOpen(current => !current)}>筛选</button>
    <MobileFilterSheet open={open} onClose={() => setOpen(false)}><button id="choose" onClick={() => setValue("最近 7 天")}>{value}</button></MobileFilterSheet>
  </>;
}
describe("mobile filter sheet", () => {
  let host: HTMLDivElement, root: Root;
  let frames: Map<number, FrameRequestCallback>, id: number, now: number;
  async function tick(count = 1) {
    for (let index = 0; index < count; index++) await act(async () => {
      now += 16;
      const callbacks = [...frames.values()]; frames.clear();
      callbacks.forEach(callback => callback(now));
    });
  }
  async function click(selector: string) { await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click()); }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    frames = new Map(); id = 0; now = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
  it("retains chosen filters and returns focus to the trigger on Escape", async () => {
    await act(async () => root.render(<Harness />));
    const trigger = host.querySelector<HTMLButtonElement>("#trigger")!; trigger.focus();
    await click("#trigger"); await tick(70); await click("#choose");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(trigger);
    expect(host.querySelector(".mobile-filter-layer")?.hasAttribute("inert")).toBe(true);
    await tick(70); await click("#trigger");
    expect(host.querySelector("#choose")?.textContent).toBe("最近 7 天");
  });
  it("reverses an unfinished closing spring from its current position", async () => {
    await act(async () => root.render(<Harness />));
    await click("#trigger"); await tick(70);
    await click(".mobile-filter-heading button"); await tick(4);
    const panel = host.querySelector<HTMLElement>(".mobile-filter-sheet")!;
    const midClose = panel.style.transform;
    expect(midClose).not.toBe("translateY(0px)");
    await click("#trigger");
    expect(panel.style.transform).toBe(midClose);
    await tick(70);
    expect(panel.style.transform).toBe("translateY(0px)");
    expect(host.querySelector<HTMLDivElement>(".mobile-filter-layer")!.hidden).toBe(false);
  });
  it("keeps disclosure feedback without translation when reduced motion is requested", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    await act(async () => root.render(<Harness />));
    await click("#trigger");
    expect(host.querySelector<HTMLElement>(".mobile-filter-sheet")!.style.transform).toBe("translateY(0px)");
    expect(frames.size).toBe(0);
    await click(".mobile-filter-heading button");
    expect(host.querySelector<HTMLDivElement>(".mobile-filter-layer")!.hidden).toBe(true);
  });
  it("tracks a downward drag and dismisses without clearing its child state", async () => {
    await act(async () => root.render(<Harness />));
    await click("#trigger"); await tick(70); await click("#choose");
    const grabber = host.querySelector<HTMLElement>(".mobile-filter-grabber")!;
    grabber.setPointerCapture = vi.fn();
    const pointer = async (type: string, y: number, time: number) => {
      const event = new MouseEvent(type, { clientY: y, button: 0, bubbles: true });
      Object.defineProperties(event, { pointerId: { value: 1 }, timeStamp: { value: time } });
      await act(async () => grabber.dispatchEvent(event));
    };
    await pointer("pointerdown", 100, 100);
    await pointer("pointermove", 320, 250);
    expect(host.querySelector<HTMLElement>(".mobile-filter-sheet")!.style.transform).toBe("translateY(220px)");
    await pointer("pointerup", 320, 260); await tick(70);
    expect(host.querySelector<HTMLDivElement>(".mobile-filter-layer")!.hidden).toBe(true);
    expect(host.querySelector("#choose")?.textContent).toBe("最近 7 天");
  });
});
