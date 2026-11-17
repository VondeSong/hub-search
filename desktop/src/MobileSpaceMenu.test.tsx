// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileHeader } from "./MobileHeader";
import { OPEN_QUICK_JOURNAL } from "./QuickJournalEvents";

vi.mock("./JournalVoice", () => ({ JournalCaptureButton: () => <button>快速记录</button> }));
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function open() {
  const settings = vi.fn(), libraries = vi.fn(), connections = vi.fn(), appearance = vi.fn();
  await act(async () => root.render(<MobileHeader title="浏览" onSettings={settings} spaceActions={{ onLibraries: libraries, onConnections: connections, onAppearance: appearance }}/>));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="空间与设置"]')!;
  trigger.focus();
  await act(async () => trigger.click());
  return { trigger, settings, libraries, connections, appearance };
}

it.each(["Escape", "hub:native-back"])("dismisses the space menu with %s without opening settings or leaving the page", async key => {
  const { trigger, settings } = await open();
  expect(host.inert || host.hasAttribute("inert")).toBe(true);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => {
    if (key === "Escape") document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    else window.dispatchEvent(new Event(key, { cancelable: true }));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(settings).not.toHaveBeenCalled();
});

it.each([["资料库", "libraries"], ["连接总览", "connections"], ["外观与阅读", "appearance"], ["设置", "settings"]] as const)("routes %s once and closes the menu", async (label, action) => {
  const callbacks = await open();
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.mobile-space-menu nav button')].find(b => b.textContent === label)!.click());
  expect(callbacks[action]).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("opens the existing quick-capture draft flow without saving a record", async () => {
  const capture = vi.fn(); window.addEventListener(OPEN_QUICK_JOURNAL, capture);
  try {
    await open();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.mobile-space-menu nav button')].find(b => b.textContent === "快速速记")!.click());
    expect(capture).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally { window.removeEventListener(OPEN_QUICK_JOURNAL, capture); }
});
