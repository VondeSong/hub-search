// @vitest-environment jsdom
import { act, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSearchResultData } from "./useSearchResultData";
import { useResultContextMemory } from "./useResultContextMemory";
import type { SearchResult } from "./SearchTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
const filters = { craft: true, task: true, pdf: true, media: true, attachment: true };
const normalize = (value: unknown) => value as SearchResult[];
const row = (id: string) => ({ id, libraryId: "OS", entityKey: `document:OS:${id}`, title: id }) as SearchResult;

it("keeps an open editor when data refresh and navigation memory see the same reordered rows", async () => {
  vi.useFakeTimers(); invoke.mockReset();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let choose: (index: number) => void = () => {}; let editorUnmounts = 0;
  function Editor() { useEffect(() => () => { editorUnmounts++; }, []); return <span>editing original note</span>; }
  function Sample({ revision }: { revision: number }) {
    const [, setError] = useState("");
    const data = useSearchResultData({ query: "", spaceIds: null, folderId: "", updatedAfter: null, sourceFilters: filters, searchScope: "all", recentPageLimit: 100, recentTaskLimit: 100, ready: true, hasSpaces: true, syncing: false, isComposing: false, refreshRevision: revision, normalizeResults: normalize, setError });
    choose = data.setSelectedIndex;
    const memory = useResultContextMemory("original-note-save", data.results, data.selectedIndex, data.resultsCurrent && !data.searching, data.setSelectedIndex, true);
    const selected = data.results[data.selectedIndex];
    return <div ref={memory.ref}><output>{selected?.id}</output>{selected?.id === "original" && <Editor />}</div>;
  }
  try {
    invoke.mockResolvedValueOnce([row("other"), row("original")]);
    await act(async () => { root.render(<StrictMode><Sample revision={0} /></StrictMode>); });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    await act(async () => choose(1)); editorUnmounts = 0;
    invoke.mockResolvedValueOnce([row("original"), row("other")]);
    await act(async () => { root.render(<StrictMode><Sample revision={1} /></StrictMode>); });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(host.querySelector("output")?.textContent).toBe("original");
    expect(host.textContent).toContain("editing original note");
    expect(editorUnmounts).toBe(0);
  } finally { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); }
});
