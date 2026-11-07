// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceChrome, loadSidebarMode } from "./WorkspaceChrome";
import { useWorkspaceSession } from "./useWorkspaceSession";
import { WorkspaceFilterSummary } from "./WorkspaceFilterSummary";

let root: Root;
let container: HTMLDivElement;
async function mount(element: React.ReactNode) {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(element));
}
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); localStorage.clear(); });
const props = {
  mode: "compact" as const, view: "tasks" as const, onModeChange: vi.fn(),
  spaces: [{ id: "main", name: "Main", provider: "craft", connected: true, documentCount: 10, excludedPaths: [] }] as const,
  selectedLibraryIds: null, onToggleLibrary: vi.fn(), onSelectAll: vi.fn(), onManage: vi.fn(),
};
describe("workspace navigation", () => {
  it("validates the saved layout mode", () => {
    expect(loadSidebarMode()).toBe("compact");
    localStorage.setItem("hub.sidebar.mode", "focus"); expect(loadSidebarMode()).toBe("focus");
    localStorage.setItem("hub.sidebar.mode", "invalid"); expect(loadSidebarMode()).toBe("compact");
  });
  it("cycles compact to standard to focus to compact", async () => {
    await mount(<WorkspaceChrome {...props} spaces={[{ ...props.spaces[0], excludedPaths: [] }]} />);
    await act(async () => container.querySelector<HTMLButtonElement>('.workspace-mode-cycle')!.click());
    expect(props.onModeChange).toHaveBeenCalledWith("standard");
    await act(async () => root.render(<WorkspaceChrome {...props} spaces={[]} mode="standard" />));
    await act(async () => container.querySelector<HTMLButtonElement>('.workspace-mode-cycle')!.click());
    expect(props.onModeChange).toHaveBeenCalledWith("focus");
    await act(async () => root.render(<WorkspaceChrome {...props} spaces={[]} mode="focus" />));
    await act(async () => container.querySelector<HTMLButtonElement>('.workspace-mode-cycle')!.click());
    expect(props.onModeChange).toHaveBeenCalledWith("compact");
  });
  it("removes duplicate view and scope breadcrumbs while retaining layout controls", async () => {
    await mount(<WorkspaceChrome {...props} spaces={[{ ...props.spaces[0], excludedPaths: [] }]} />);
    expect(container.textContent).not.toContain("全部资料库");
    expect(container.textContent).not.toContain("任务");
    expect(container.querySelector('.workspace-mode-cycle')).not.toBeNull();
    expect(container.querySelector('.workspace-mode-dots')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
  });
  it("makes the independent flashcard scope explicit", async () => {
    await mount(<WorkspaceChrome {...props} spaces={[]} view="flashcards" />);
    expect(container.querySelector('#flashcards-chrome-actions')?.nextElementSibling?.className).toBe('workspace-mode-cycle');
    expect(container.querySelector('.workspace-panel-toggle')).toBeNull();
    expect(container.querySelector('[title="选择当前内容范围"]')).toBeNull();
  });
  it("retains ephemeral module state after unmount", async () => {
    function Sample() { const [value, set] = useWorkspaceSession("test.query", "initial"); return <button onClick={() => set("retained")}>{value}</button>; }
    await mount(<Sample />);
    await act(async () => container.querySelector("button")!.click());
    await act(async () => root.render(<div />));
    await act(async () => root.render(<Sample />));
    expect(container.textContent).toBe("retained");
  });
  it("exposes individual filter removal and reset", async () => {
    const clear = vi.fn(), reset = vi.fn();
    await mount(<WorkspaceFilterSummary filters={[{ label: "待完成", clear }]} onReset={reset} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除筛选：待完成"]')!.click());
    await act(async () => container.querySelectorAll("button")[1].click());
    expect(clear).toHaveBeenCalledOnce(); expect(reset).toHaveBeenCalledOnce();
  });
});
