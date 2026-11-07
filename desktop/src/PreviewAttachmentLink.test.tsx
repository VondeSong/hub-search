// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { PreviewAttachmentLink } from "./PreviewMarkdown";

afterEach(() => { vi.unstubAllGlobals(); invoke.mockReset(); });

async function clickAttachment(outcome: boolean | Error) {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
  invoke.mockImplementation((command: string) => command === "open_craft_attachment"
    ? outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
    : Promise.resolve({ title: "本地文档.pdf", mimeType: "application/pdf", size: 100 }));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); const fallback = vi.fn();
  await act(async () => root.render(<PreviewAttachmentLink href="https://r.craft.do/expired" label="文档.pdf"
    provider="craft" spaceId="space" documentId="page" onOpen={fallback} />));
  await act(async () => host.querySelector("a")!.click());
  return { host, root, fallback };
}

it("opens the local Craft file without opening its expired cloud URL", async () => {
  const { host, root, fallback } = await clickAttachment(true);
  expect(invoke).toHaveBeenCalledWith("open_craft_attachment", { spaceId: "space", documentId: "page", source: "https://r.craft.do/expired" });
  expect(fallback).not.toHaveBeenCalled();
  await act(async () => root.unmount()); host.remove();
});

it("keeps the existing link action when no local file is available", async () => {
  const { host, root, fallback } = await clickAttachment(false);
  expect(fallback).toHaveBeenCalledWith("https://r.craft.do/expired");
  await act(async () => root.unmount()); host.remove();
});

it("shows a local opening error without silently switching to the cloud", async () => {
  const { host, root, fallback } = await clickAttachment(new Error("无法打开附件"));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("无法打开附件");
  expect(fallback).not.toHaveBeenCalled();
  await act(async () => root.unmount()); host.remove();
});
