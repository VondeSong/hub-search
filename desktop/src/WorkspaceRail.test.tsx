// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "./SearchTypes";
import { WorkspaceRail } from "./WorkspaceRail";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

const spaces: LibrarySummary[] = [
  { id: "car", provider: "craft", name: "Car", connected: true, documentCount: 75, excludedPaths: [] },
  { id: "main", provider: "obsidian", name: "Main", connected: true, documentCount: 1343, excludedPaths: [] },
];

describe("WorkspaceRail", () => {
  it("exposes exact library switching, all-libraries, and management actions", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const selectAll = vi.fn();
    const selectLibrary = vi.fn();
    const toggleLibrary = vi.fn();
    const togglePanel = vi.fn();
    const selectView = vi.fn();
    const manageLibraries = vi.fn();

    await act(async () => root.render(
      <WorkspaceRail
        onTogglePanel={togglePanel}
        activeView="home"
        spaces={spaces}
        selectedLibraryIds={null}
        renderLibraryIcon={(space) => <i data-icon={space.id} />}
        favoriteCount={3}
        taskOpenCount={4}
        journalCount={5}
        historyCount={6}
        tagCount={7}
        flashcardDueCount={8}
        onSelectView={selectView}
        onSelectAllLibraries={selectAll}
        onSelectLibrary={selectLibrary}
        onToggleLibrary={toggleLibrary}
        onManageLibraries={manageLibraries}
      />,
    ));

    const allButton = container.querySelector<HTMLButtonElement>('button[aria-label="全部资料库"]')!;
    const carButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Car · Craft"]')!;
    for(const [button,expected] of [[allButton,spaces.map(({id,name})=>({id,name}))],[carButton,[{id:"car",name:"Car"}]]] as const){
      const transfer={effectAllowed:"none",setData:vi.fn()};
      const drag=new Event("dragstart",{bubbles:true});Object.defineProperty(drag,"dataTransfer",{value:transfer});
      expect(button.draggable).toBe(true);button.dispatchEvent(drag);
      expect(transfer.effectAllowed).toBe("copy");
      expect(transfer.setData).toHaveBeenCalledWith("application/x-hub-agent-libraries",JSON.stringify(expected));
    }
    const manageButton = container.querySelector<HTMLButtonElement>('button[aria-label="设置"]')!;
    const tagsButton = container.querySelector<HTMLButtonElement>('button[aria-label="标签，7"]')!;
    const panelButton = container.querySelector<HTMLButtonElement>(".workspace-panel-toggle")!;
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    expect(allButton.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll("[data-icon]")).toHaveLength(2);
    expect(container.querySelector('img[src="/icons/hub.png"]')).toBeNull();
    panelButton.click();
    expect(togglePanel).toHaveBeenCalledOnce();
    expect(panelButton.dispatchEvent(contextMenu)).toBe(false);
    expect(contextMenu.defaultPrevented).toBe(true);

    carButton.click();
    manageButton.click();
    allButton.click();
    tagsButton.click();
    expect(selectLibrary).toHaveBeenCalledWith("car");
    expect(manageLibraries).toHaveBeenCalledOnce();
    expect(selectAll).toHaveBeenCalledOnce();
    expect(selectView).toHaveBeenCalledWith("tags");
    expect(container.querySelector('.workspace-library-multiselect')).toBeNull();
    await act(async () => carButton.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
    expect(toggleLibrary).toHaveBeenLastCalledWith("car");
    expect(selectLibrary).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll(".workspace-library-check")).toHaveLength(0);
    await act(async () => carButton.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    expect(toggleLibrary).toHaveBeenCalledTimes(2);

    await act(async () => root.render(
      <WorkspaceRail
        activeView="tags"
        spaces={spaces.map(space => space.id === "car" ? { ...space, connected: false } : space)}
        selectedLibraryIds={["main"]}
        renderLibraryIcon={(space) => <i data-icon={space.id} />}
        favoriteCount={3}
        taskOpenCount={4}
        journalCount={5}
        historyCount={6}
        tagCount={7}
        flashcardDueCount={8}
        onSelectView={selectView}
        onSelectAllLibraries={selectAll}
        onSelectLibrary={selectLibrary}
        onManageLibraries={manageLibraries}
      />,
    ));
    expect(container.querySelector('button[aria-label^="Main · Obsidian"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('button[aria-label="全部资料库"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('button[aria-label="标签，7"]')?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelectorAll(".library-status-badge")).toHaveLength(1);
    const disconnectedCar = container.querySelector<HTMLButtonElement>('button[aria-label^="Car · Craft"]')!;
    expect(disconnectedCar.title).toContain("连接未恢复");
    expect(disconnectedCar.disabled).toBe(false);
    await act(async () => disconnectedCar.click());
    expect(selectLibrary).toHaveBeenLastCalledWith("car");


    await act(async () => root.unmount());
  });
});
