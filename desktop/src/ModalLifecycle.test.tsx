// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { CreateJournalDialog } from "./CreateJournalDialog";
import { useModalFocus } from "./useModalFocus";

it.each(["commands", "journal"])("isolates %s keyboard focus and restores the opening control", async kind => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), background = document.createElement("button");
  background.textContent = "background"; document.body.append(background, host); background.focus();
  const root = createRoot(host); const close = vi.fn();
  try {
    await act(async () => root.render(kind === "commands"
      ? <CommandPalette open mode="commands" commands={[]} shortcutGroups={[]} onModeChange={() => undefined} onClose={close} />
      : <CreateJournalDialog date="2026-10-11" spaces={[]} creating={false} onClose={close} onCreate={() => undefined} />));
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(background.hasAttribute("inert")).toBe(true);
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
    const last = buttons[buttons.length - 1]; last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => last.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(true); expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    expect(document.activeElement).toBe(background); expect(background.hasAttribute("inert")).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); background.remove(); delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; }
});

it("keeps nested modal ownership and excludes hidden and collapsed controls from the focus loop", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const outerClose = vi.fn(), innerClose = vi.fn();
  function Inner() {
    const ref = useRef<HTMLElement>(null); useModalFocus({ active: true, containerRef: ref, onDismiss: innerClose });
    return <section ref={ref} role="dialog" tabIndex={-1}><div hidden><button>hidden</button></div><details><summary>folded</summary><button>collapsed</button></details><button>inner last</button></section>;
  }
  function Outer({ nested }: { nested: boolean }) {
    const ref = useRef<HTMLElement>(null); useModalFocus({ active: true, containerRef: ref, onDismiss: outerClose });
    return <section ref={ref} role="dialog" tabIndex={-1}><button>open inner</button>{nested && <Inner />}</section>;
  }
  try {
    await act(async () => root.render(<Outer nested={false} />));
    const opening = host.querySelector<HTMLButtonElement>("button")!;
    expect(document.activeElement).toBe(opening);
    await act(async () => root.render(<Outer nested />));
    expect(document.activeElement?.textContent).toBe("folded");
    const last = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "inner last")!;
    last.focus(); await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement?.textContent).toBe("folded");
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(innerClose).toHaveBeenCalledTimes(1); expect(outerClose).not.toHaveBeenCalled();
    await act(async () => root.render(<Outer nested={false} />));
    expect(document.activeElement).toBe(opening); expect(opening.hasAttribute("inert")).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; }
});
