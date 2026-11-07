// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { TagLibraryFilter } from "./TagLibraryFilter";
import type { LibrarySummary } from "./SearchTypes";

it("narrows all libraries to one, combines libraries, deselects and restores all", async () => {
  const libraries: LibrarySummary[] = ["Main", "Car", "XV"].map((name) => ({ id: name, name, provider: "craft", connected: true, documentCount: 1, excludedPaths: [] }));
  let selected: string[] | null = null;
  function Harness() {
    const [ids, setIds] = useState<string[] | null>(null);
    selected = ids;
    return <TagLibraryFilter libraries={libraries} selectedIds={ids} onChange={setIds} />;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    const click = async (index: number) => { await act(async () => container.querySelectorAll("button")[index].click()); };
    await click(1);
    expect(selected).toEqual(["Main"]);
    expect(container.querySelectorAll("button")[1].getAttribute("aria-pressed")).toBe("true");
    await click(2);
    expect(selected).toEqual(["Main", "Car"]);
    await click(1);
    expect(selected).toEqual(["Car"]);
    await click(2);
    expect(selected).toBeNull();
    await click(3);
    await click(0);
    expect(selected).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
