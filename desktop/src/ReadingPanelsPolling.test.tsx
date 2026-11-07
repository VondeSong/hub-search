// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { ReadingAttachments } from "./ReadingAttachments";
import { ReadingCopies } from "./ReadingCopies";

it.each(["attachments", "copies"])("pauses collapsed %s and ignores the prior item's delayed status", async kind => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const row = (key: string) => kind === "attachments" ? [{ url: `https://test.invalid/${key}`, local: false, canUpload: false, state: "ready", error: "" }] : [{ device: key, deviceLabel: key, local: false, observedAt: null, copies: [] }];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const render = async (itemKey: string) => act(async () => root.render(kind === "attachments" ? <ReadingAttachments itemKey={itemKey} /> : <ReadingCopies itemKey={itemKey} />));
  invokeMock.mockReset(); invokeMock.mockImplementation(async (_command, args) => row(args.key));
  try {
    await render("A"); expect(invokeMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(invokeMock).toHaveBeenCalledTimes(1);
    const details = host.querySelector("details")!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(15000); });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    let finish!: (value: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await render("B");
    await act(async () => { finish(row("A")); await Promise.resolve(); });
    expect(invokeMock.mock.calls[invokeMock.mock.calls.length - 1][1].key).toBe("B");
    expect(host.querySelector(kind === "attachments" ? "li strong" : "section strong")?.textContent).toBe("B");
    expect(host.querySelector("details")!.open).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); Reflect.deleteProperty(document, "hidden"); delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; }
});

it.each(["attachments", "copies"])("refreshes collapsed %s on real changes and coalesces hidden changes until visible", async kind => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const rows = kind === "attachments" ? [{ url: "https://test.invalid/fixture", local: false, canUpload: false, state: "ready", error: "" }] : [{ device: "fixture", deviceLabel: "fixture", local: false, observedAt: null, copies: [] }];
  const eventName = kind === "attachments" ? "hub:reading-cache-changed" : "hub:reading-data-changed";
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  invokeMock.mockReset(); invokeMock.mockResolvedValue(rows);
  try {
    await act(async () => root.render(kind === "attachments" ? <ReadingAttachments itemKey="A" /> : <ReadingCopies itemKey="A" />));
    expect(host.querySelector("details")?.open).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    invokeMock.mockResolvedValue([]);
    await act(async () => window.dispatchEvent(new Event(eventName)));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("");

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      for (let index = 0; index < 3; index++) window.dispatchEvent(new Event(eventName));
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    invokeMock.mockRejectedValue("fixture read failure");
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(host.textContent).toContain("fixture read failure");
    expect(host.querySelector("details")?.open).toBe(false);
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); Reflect.deleteProperty(document, "hidden");
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

it("keeps attachment actions usable after their cache-change notification refreshes status", async () => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  invokeMock.mockReset();
  invokeMock.mockImplementation(async command => command === "reading_attachment_status" ? [{ url: "https://test.invalid/fixture", local: true, canUpload: false, canPin: true, state: "ready", error: "" }] : undefined);
  try {
    await act(async () => root.render(<ReadingAttachments itemKey="A" />));
    const details = host.querySelector("details")!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    const pin = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "离线保留")!;
    await act(async () => pin.click());
    expect(invokeMock.mock.calls.some(([command]) => command === "pin_reading_attachment")).toBe(true);
    expect(invokeMock.mock.calls.filter(([command]) => command === "reading_attachment_status")).toHaveLength(3);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "离线保留")?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(document, "hidden");
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

it.each(["attachments", "copies"])("reads the latest %s after returning A→B→A while the first A is pending", async kind => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const rows = (label: string) => kind === "attachments" ? [{ url: `https://test.invalid/${label}`, local: false, canUpload: false, state: "ready", error: "" }] : [{ device: label, deviceLabel: label, local: false, observedAt: null, copies: [] }];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const render = async (itemKey: string) => act(async () => root.render(kind === "attachments" ? <ReadingAttachments itemKey={itemKey} /> : <ReadingCopies itemKey={itemKey} />));
  let finish!: (value: unknown) => void;
  invokeMock.mockReset(); invokeMock.mockResolvedValue(rows("latest-A")); invokeMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  try {
    await render("A"); await render("B"); await render("A");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await act(async () => finish(rows("obsolete-A")));
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls.map(([, args]) => args.key)).toEqual(["A", "A"]);
    expect(host.textContent).toContain("latest-A"); expect(host.textContent).not.toContain("obsolete-A");
    expect(host.querySelector("details")?.open).toBe(false);
  } finally {
    await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(document, "hidden");
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

it.each(["attachments", "copies"])("loads %s after StrictMode repeats setup and cleanup", async kind => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const rows = kind === "attachments" ? [{ url: "https://test.invalid/strict-mode", local: false, canUpload: false, state: "ready", error: "" }] : [{ device: "strict-mode", deviceLabel: "strict-mode", local: false, observedAt: null, copies: [] }];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  invokeMock.mockReset(); invokeMock.mockResolvedValue(rows);
  try {
    await act(async () => root.render(<StrictMode>{kind === "attachments" ? <ReadingAttachments itemKey="A" /> : <ReadingCopies itemKey="A" />}</StrictMode>));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("strict-mode");
    expect(host.querySelector("details")?.open).toBe(false);
  } finally {
    await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(document, "hidden");
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
