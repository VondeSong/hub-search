// @vitest-environment jsdom

import { act, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DesktopTagsWorkspace, isTopicFormattingArtifact } from "./DesktopTagsWorkspace";
import { EMPTY_TAG_TAXONOMY } from "./TagTaxonomy";
import type { SearchResult } from "./SearchTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ proposals: [], nextCursor: null })) }));
vi.mock("./StandaloneAgentLauncher", async () => {
  const { createContext } = await import("react");
  return { AgentPanelContext: createContext(null), AgentTagRequestContext: createContext(null) };
});
vi.mock("./TagAssignmentInbox", () => ({ TagAssignmentInbox: () => null }));
vi.mock("./TagGovernanceInbox", () => ({ TagGovernanceInbox: () => null }));

const first = { normalizedName: "first", name: "首个主题", count: 2 };
const neighbor = { normalizedName: "next", name: "相邻主题", count: 1 };
const hidden = { normalizedName: "^blockid", name: "^blockId", count: 1 };
const firstNote = { id: "1", title: "首个主题的真实结果", provider: "obsidian", snippet: "首个主题的原文片段" } as SearchResult;
const nextNote = { id: "2", title: "第二个主题的真实结果", provider: "obsidian", snippet: "第二个主题的原文片段" } as SearchResult;
type Props = ComponentProps<typeof DesktopTagsWorkspace>;

it("keeps node clicks in the graph, refreshes the preview, and rewinds the trail", async () => {
  const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  let finishQuery: () => void;
  function Harness() {
    const [topic, select] = useState<typeof first>();
    const [ready, setReady] = useState(true);
    finishQuery = () => setReady(true);
    return <DesktopTagsWorkspace workspaceRef={{ current: null }} catalog={{ tags: [first, neighbor, hidden], groups: [], properties: {}, favorites: [], recent: [], cleanupCount: 0, onCloseCleanup: () => {}, onSearch: () => {}, onCreate: () => null }}
      data={{ selectedCollectionTag: topic, contextReady: ready, selectedTagTaxonomy: EMPTY_TAG_TAXONOMY, selectedIndex: 0,
        onSelectCollectionTag: (next: typeof first) => { select(next); setReady(false); },
        results: !ready || topic === first ? [firstNote] : [nextNote],
        selectedTagRelated: [topic === first ? neighbor : first],
      } as Props["data"]} preview={{} as Props["preview"]} />;
  }
  try {
    await act(async () => root.render(<Harness />));
    expect(host.querySelector(".dossier-title")?.textContent).toBe(first.name);
    expect(host.querySelector(".master-scroll")?.textContent).not.toContain(hidden.name);
    await act(async () => finishQuery());
    await act(async () => host.querySelectorAll<HTMLButtonElement>(".mode-btn")[1].click());
    expect(host.querySelector(".graph-preview-card h2")?.textContent).toBe(first.name);
    expect(host.querySelector(".g-node.center small")?.textContent).toBe("1 篇");
    expect(host.querySelector('[aria-label="代表笔记"] .section-cap .mono')?.textContent).toBe("1 篇");
    expect(host.querySelector(".graph-preview-card")?.textContent).toContain(firstNote.title);
    await act(async () => host.querySelector<HTMLButtonElement>("button.g-node:not(.center)")!.click());
    expect(host.querySelector(".graph-preview-card h2")?.textContent).toBe(neighbor.name);
    expect(host.querySelector(".g-node.center small")).toBeNull();
    expect(host.querySelector(".graph-preview-card")?.textContent).not.toContain(firstNote.title);
    expect([...host.querySelectorAll(".crumb-btn")].map(button => button.textContent)).toEqual([first.name, neighbor.name]);
    await act(async () => finishQuery());
    expect(host.querySelector(".graph-preview-card")?.textContent).toContain(nextNote.title);
    await act(async () => host.querySelector<HTMLButtonElement>(".crumb-btn")!.click());
    expect(host.querySelector(".graph-preview-card h2")?.textContent).toBe(first.name);
    expect(host.querySelectorAll(".crumb-btn")).toHaveLength(1);
    await act(async () => host.querySelector<HTMLButtonElement>(".preview-foot .btn-primary")!.click());
    expect(host.querySelector(".dossier-title")?.textContent).toBe(first.name);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
  }
});

it("hides formatting artifacts and keeps legitimate tags with only one document", () => {
  expect(isTopicFormattingArtifact(hidden)).toBe(true);
  expect(isTopicFormattingArtifact({ name: "+BEGIN_NOTE", normalizedName: "+begin_note", count: 1 })).toBe(true);
  expect(isTopicFormattingArtifact(neighbor)).toBe(false);
});
