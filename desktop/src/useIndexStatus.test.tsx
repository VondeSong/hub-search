// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useIndexStatus } from "./useIndexStatus";

function Probe() {
  useIndexStatus(true, null);
  return null;
}

describe("useIndexStatus polling", () => {
  let root: Root;
  let container: HTMLDivElement;
  let hidden = false;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    invokeMock.mockReset().mockResolvedValue({ documentCount: 1 });
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

  it("pauses while hidden and refreshes immediately when visible again", async () => {
    await act(async () => root.render(<Probe />));
    await act(async () => Promise.resolve());
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(invokeMock).toHaveBeenCalledTimes(2);

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    expect(invokeMock).toHaveBeenCalledTimes(2);

    hidden = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => Promise.resolve());
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("does not overlap polls when a status request is slow", async () => {
    let resolveRequest: ((value: { documentCount: number }) => void) | undefined;
    invokeMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; }));

    await act(async () => root.render(<Probe />));
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => resolveRequest?.({ documentCount: 1 }));
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
