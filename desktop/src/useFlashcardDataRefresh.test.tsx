// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
import { useFlashcardDataRefresh } from "./useFlashcardDataRefresh";

function Consumer({ refresh }: { refresh: () => Promise<unknown> }) { useFlashcardDataRefresh(refresh); return null; }
afterEach(() => { delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });
describe("committed flashcard sync updates", () => {
  it("coalesces overlapping events and reads the latest data after the in-flight refresh", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const detach = vi.fn();
    listenMock.mockResolvedValue(detach);
    let finish!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Consumer refresh={refresh} />));
    const listener = listenMock.mock.calls.find(([event]) => event === "flashcards-data-changed")![1];
    await act(async () => { listener({}); listener({}); finish(); });
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    expect(detach).toHaveBeenCalledOnce();
    await listener({});
    expect(refresh).toHaveBeenCalledTimes(2);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
