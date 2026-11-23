// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useSplitPanePercent } from "./useSplitPanePercent";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  window.localStorage.clear();
  document.body.classList.remove("resizing-panes");
});

function SplitHarness({ storageKey }: { storageKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const split = useSplitPanePercent({
    storageKey,
    defaultPercent: 44,
    minPercent: 28,
    maxPercent: 66,
    containerRef: ref,
  });
  return (
    <div ref={ref} className="split-host">
      <div
        className="pane-resizer"
        role="separator"
        tabIndex={0}
        aria-valuenow={Math.round(split.percent)}
        data-percent={String(split.percent)}
        onPointerDown={split.onPointerDown}
        onKeyDown={split.onKeyDown}
        onDoubleClick={split.onDoubleClick}
      />
    </div>
  );
}

describe("useSplitPanePercent", () => {
  it("supports keyboard resize, double-click reset, pointer drag clamping, and persistence", async () => {
    const storageKey = "hub.test.split-percent.v1";
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<SplitHarness storageKey={storageKey} />));
    const host = container.querySelector<HTMLDivElement>(".split-host")!;
    host.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const sep = container.querySelector<HTMLDivElement>(".pane-resizer")!;
    expect(sep.dataset.percent).toBe("44");

    // Keyboard ArrowLeft widens right pane by 2%
    await act(async () => {
      sep.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(sep.dataset.percent).toBe("46");
    expect(window.localStorage.getItem(storageKey)).toBe("46");

    // Keyboard Home clamps to minPercent (28)
    await act(async () => {
      sep.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(sep.dataset.percent).toBe("28");

    // Double click resets to default (44)
    await act(async () => {
      sep.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(sep.dataset.percent).toBe("44");
    expect(window.localStorage.getItem(storageKey)).toBe("44");

    // Pointer drag to clientX=200 => right pane = 44% + (560-200)/1000 = 80%, clamped to maxPercent=66
    await act(async () => {
      sep.dispatchEvent(new MouseEvent("pointerdown", { clientX: 560, bubbles: true }));
    });
    // Bare pointerdown must not start resizing or flash resizing-panes yet
    expect(document.body.classList.contains("resizing-panes")).toBe(false);
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, bubbles: true }));
    });
    expect(document.body.classList.contains("resizing-panes")).toBe(true);
    expect(sep.dataset.percent).toBe("66");
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 200, bubbles: true }));
    });
    expect(document.body.classList.contains("resizing-panes")).toBe(false);
    expect(sep.dataset.percent).toBe("66");
    expect(window.localStorage.getItem(storageKey)).toBe("66");

    await act(async () => root.unmount());
  });

  it("keeps width unchanged on off-center single click and sub-threshold jitter so double-click resets reliably", async () => {
    const storageKey = "hub.test.split-click-stability.v1";
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<SplitHarness storageKey={storageKey} />));
    const host = container.querySelector<HTMLDivElement>(".split-host")!;
    host.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const sep = container.querySelector<HTMLDivElement>(".pane-resizer")!;
    // Simulate a 6px hit zone whose right edge aligns with the 58% reader pane (left=414, right=420)
    sep.getBoundingClientRect = () => ({
      left: 414,
      top: 0,
      right: 420,
      bottom: 600,
      width: 6,
      height: 600,
      x: 414,
      y: 0,
      toJSON: () => ({}),
    });

    // Drag to 58% first (start at 416, move left by 140px => 44% + 14% = 58%)
    sep.getBoundingClientRect = () => ({
      left: 554,
      top: 0,
      right: 560,
      bottom: 600,
      width: 6,
      height: 600,
      x: 554,
      y: 0,
      toJSON: () => ({}),
    });
    await act(async () => {
      sep.dispatchEvent(new MouseEvent("pointerdown", { clientX: 556, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 416, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 416, bubbles: true }));
    });
    expect(sep.dataset.percent).toBe("58");
    expect(window.localStorage.getItem(storageKey)).toBe("58");

    // Divider is now at [414, 420]. Off-center single click at clientX=415 (no pointermove) must NOT drift!
    sep.getBoundingClientRect = () => ({
      left: 414,
      top: 0,
      right: 420,
      bottom: 600,
      width: 6,
      height: 600,
      x: 414,
      y: 0,
      toJSON: () => ({}),
    });
    await act(async () => {
      sep.dispatchEvent(new MouseEvent("pointerdown", { clientX: 415, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 415, bubbles: true }));
    });
    expect(document.body.classList.contains("resizing-panes")).toBe(false);
    expect(sep.dataset.percent).toBe("58");
    expect(window.localStorage.getItem(storageKey)).toBe("58");

    // Off-center click with 2px micro-jitter (< 3px threshold) followed by second click + dblclick resets cleanly
    await act(async () => {
      sep.dispatchEvent(new MouseEvent("pointerdown", { clientX: 415, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 417, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 417, bubbles: true }));
    });
    expect(sep.dataset.percent).toBe("58");

    await act(async () => {
      sep.dispatchEvent(new MouseEvent("pointerdown", { clientX: 416, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 416, bubbles: true }));
      sep.dispatchEvent(new MouseEvent("dblclick", { clientX: 416, bubbles: true }));
    });
    expect(sep.dataset.percent).toBe("44");
    expect(window.localStorage.getItem(storageKey)).toBe("44");

    await act(async () => root.unmount());
  });
});
