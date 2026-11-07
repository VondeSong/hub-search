// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PreviewRenderer } from "./PreviewRenderer";
import type { SearchResult } from "./SearchTypes";

it("scrolls encoded Markdown and local wiki block links to the invisible target", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const selected = { provider: "obsidian", documentTitle: "Note", documentId: "note", spaceId: "vault", matchTerms: [] } as unknown as SearchResult;
  const onOpenLink = vi.fn();
  try {
    await act(async () => root.render(<PreviewRenderer selected={selected}
      markdown={"正文\n\n^block-id\n\n[跳转](#^block-id)\n\n[[#^block-id|定位]]"}
      matchTerms={[]} hasSectionContext={false} onOpenLink={onOpenLink} />));
    const target = document.getElementById("^block-id")!;
    expect(target).toBeTruthy();
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    const links = host.querySelectorAll("a");
    expect(links.length).toBe(2);
    links.forEach(link => link.click());
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(onOpenLink).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("^block-id");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
