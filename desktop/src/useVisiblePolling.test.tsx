// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useVisiblePolling } from "./useVisiblePolling";

it("waits for an old enabled generation before starting its replacement", async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let finish!: () => void;
  const task = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  function Poller({ enabled }: { enabled: boolean }) { useVisiblePolling(task, enabled, 1000); return null; }
  try {
    await act(async () => root.render(<Poller enabled />));
    await act(async () => root.render(<Poller enabled={false} />));
    await act(async () => root.render(<Poller enabled />));
    expect(task).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await Promise.resolve(); });
    expect(task).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(5000); });
    expect(task).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(task).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.useRealTimers();
    Reflect.deleteProperty(document, "hidden");
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
