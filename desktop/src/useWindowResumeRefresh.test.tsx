// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowResumeRefresh } from "./useWindowResumeRefresh";

function Probe({ refresh }: { refresh: () => Promise<void> }) {
  useWindowResumeRefresh(refresh);
  return null;
}

describe("useWindowResumeRefresh", () => {
  let root: Root;
  let container: HTMLDivElement;
  let hidden = false;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("coalesces visibility and focus events from one window restore", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<Probe refresh={refresh} />));

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTimeAsync(80));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores focus events while the document is hidden", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<Probe refresh={refresh} />));
    hidden = true;
    window.dispatchEvent(new Event("focus"));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(refresh).not.toHaveBeenCalled();
  });
});
