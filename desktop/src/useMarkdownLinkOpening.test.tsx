// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useMarkdownLinkOpening } from "./useMarkdownLinkOpening";
import type { SearchResult } from "./SearchTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
it("reads Craft subpages inside the mobile preview while keeping desktop and external opening", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"), root = createRoot(host);
  const selected = { id: "result", entityKey: "parent", provider: "craft", spaceId: "space", libraryId: "space", documentId: "document", blockId: "document", title: "Parent", documentTitle: "Parent" } as SearchResult;
  const openResult = vi.fn(), openExternalLink = vi.fn().mockResolvedValue(undefined), previewInApp = vi.fn();
  let open: ReturnType<typeof useMarkdownLinkOpening>;
  function Harness({ mobile }: { mobile: boolean }) {
    open = useMarkdownLinkOpening({ previewSelected: selected, openResult, openExternalLink, showOperationStatus: vi.fn(), previewInApp: mobile ? previewInApp : undefined });
    return null;
  }
  try {
    await act(async () => root.render(<Harness mobile />));
    act(() => open!("#craft-subpage=child", "Child page"));
    expect(previewInApp).toHaveBeenCalledWith(expect.objectContaining({ documentId: "document", blockId: "child", pageId: "child", title: "Child page", id: "craft-subpage:space:document:child", entityKey: "craft-subpage:space:document:child" }));
    expect(openResult).not.toHaveBeenCalled(); expect(openExternalLink).not.toHaveBeenCalled();
    act(() => open!("https://docs.craft.do/help"));
    expect(openExternalLink).toHaveBeenCalledWith("https://docs.craft.do/help");
    await act(async () => root.render(<Harness mobile={false} />));
    act(() => open!("#craft-subpage=child"));
    expect(openResult).toHaveBeenCalledWith(expect.objectContaining({ id: "", pageId: "child" }), "preview");
  } finally { await act(async () => root.unmount()); }
});
