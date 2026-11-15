// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useModalFocus } from "./useModalFocus";

function Harness() {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  const modalRef = useRef<HTMLElement>(null);
  const nestedRef = useRef<HTMLElement>(null);
  useModalFocus({ active: open, containerRef: modalRef, onDismiss: () => setOpen(false), suspended: nested });
  useModalFocus({ active: nested, containerRef: nestedRef, onDismiss: () => setNested(false) });
  return <>
    <button id="opener" onClick={() => setOpen(true)}>打开</button>
    {open && <section ref={modalRef} tabIndex={-1} role="dialog">
      <button id="first" data-modal-initial-focus>第一个</button>
      <button id="nested-opener" onClick={() => setNested(true)}>预览</button>
      <button id="last">最后一个</button>
    </section>}
    {nested && <section ref={nestedRef} tabIndex={-1} role="dialog" aria-label="预览">
      <button id="nested-close" data-modal-initial-focus onClick={() => setNested(false)}>关闭预览</button>
    </section>}
  </>;
}

describe("useModalFocus", () => {
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

  it("cycles Tab inside the modal and restores the opening control", async () => {
    await act(async () => root.render(<Harness />));
    const opener = container.querySelector<HTMLButtonElement>("#opener")!;
    opener.focus();
    await act(async () => opener.click());
    expect(document.activeElement?.id).toBe("first");

    container.querySelector<HTMLButtonElement>("#last")!.focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement?.id).toBe("first");

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("dismisses only the top layer when dialogs are nested", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => container.querySelector<HTMLButtonElement>("#opener")!.click());
    const nestedOpener = container.querySelector<HTMLButtonElement>("#nested-opener")!;
    nestedOpener.focus();
    await act(async () => nestedOpener.click());
    expect(document.activeElement?.id).toBe("nested-close");

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(container.querySelector('[aria-label="预览"]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.activeElement?.id).toBe("nested-opener");
  });

  it("consumes Android Back only in the top modal, then releases the route", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => container.querySelector<HTMLButtonElement>("#opener")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>("#nested-opener")!.click());
    const nestedBack = new Event("hub:native-back", { cancelable: true });
    await act(async () => window.dispatchEvent(nestedBack));
    expect(nestedBack.defaultPrevented).toBe(true);
    expect(container.querySelector('[aria-label="预览"]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    await act(async () => window.dispatchEvent(new Event("hub:native-back", { cancelable: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const routeBack = new Event("hub:native-back", { cancelable: true });
    window.dispatchEvent(routeBack); expect(routeBack.defaultPrevented).toBe(false);
  });

  it("leaves an HTML dialog above the modal for the native cancel handler", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => container.querySelector<HTMLButtonElement>("#opener")!.click());
    const top = document.createElement("dialog"); top.open = true; document.body.append(top);
    try {
      const back = new Event("hub:native-back", { cancelable: true }); window.dispatchEvent(back);
      expect(back.defaultPrevented).toBe(false); expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    } finally { top.remove(); }
  });
});
