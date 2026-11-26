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
  panelExpanded: true, view: "tasks" as const, onTogglePanel: vi.fn(),
  spaces: [{ id: "main", name: "Main", provider: "craft", connected: true, documentCount: 10, excludedPaths: [] }] as const,
  selectedLibraryIds: null, onToggleLibrary: vi.fn(), onSelectAll: vi.fn(), onManage: vi.fn(),
};
describe("workspace navigation", () => {
  it("validates the saved layout mode", () => {
    expect(loadSidebarMode()).toBe("standard");
    localStorage.setItem("hub.sidebar.mode", "focus"); expect(loadSidebarMode()).toBe("focus");
    localStorage.setItem("hub.sidebar.mode", "compact"); expect(loadSidebarMode()).toBe("standard");
    localStorage.setItem("hub.sidebar.mode", "invalid"); expect(loadSidebarMode()).toBe("standard");
  });
  it("uses one control to expand and collapse the global sidebar", async () => {
    const onTogglePanel = vi.fn();
    await mount(<WorkspaceChrome {...props} spaces={[]} onTogglePanel={onTogglePanel} />);
    const control = () => container.querySelector<HTMLButtonElement>(".workspace-mode-cycle")!;
    expect(control().getAttribute("aria-label")).toBe("收起全局侧边栏");
    expect(control().getAttribute("aria-expanded")).toBe("true");
    await act(async () => control().click());
    await act(async () => root.render(<WorkspaceChrome {...props} spaces={[]} onTogglePanel={onTogglePanel} panelExpanded={false} />));
    expect(control().getAttribute("aria-label")).toBe("展开全局侧边栏");
    expect(control().getAttribute("aria-expanded")).toBe("false");
    await act(async () => control().click());
    expect(onTogglePanel).toHaveBeenCalledTimes(2);
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
