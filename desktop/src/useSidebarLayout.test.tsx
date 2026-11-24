// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useSidebarLayout } from "./useSidebarLayout";
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
function Sample({view = "tasks"}: {view?: string}) {
  const layout = useSidebarLayout(view);
  return <div className="unified-shell"><button className="workspace-panel-toggle" onClick={layout.togglePanel}>toggle</button><output>{layout.mode}:{String(layout.panelExpanded)}:{layout.sidebarWidth}</output><div className="context-sidebar-resizer" role="separator" tabIndex={0} onPointerDown={layout.resizeSidebar} onKeyDown={layout.resizeSidebarWithKeyboard} onDoubleClick={layout.resetSidebarWidth}/><aside className="task-module-sidebar"><button>view</button></aside></div>;
}
function pointerEvent(type: string, clientX: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 }, pointerId: { value: 1 }, pointerType: { value: "mouse" }, clientX: { value: clientX },
  });
  return event;
}
async function exercise(narrow: boolean) {
  vi.stubGlobal("matchMedia", () => ({ matches: narrow, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; }); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  localStorage.setItem("hub.sidebar.mode", "standard");
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  await act(async () => root.render(<Sample />));
  return { host, root, toggle: host.querySelector<HTMLButtonElement>(".workspace-panel-toggle")! };
}
it("returns to the user's expanded layout after leaving focus", async () => {
  const {host,root,toggle}=await exercise(false);
  try {
    await act(async()=>toggle.click()); expect(host.querySelector("output")!.textContent).toBe("focus:false:240");
    await act(async()=>toggle.click()); expect(host.querySelector("output")!.textContent).toBe("standard:true:240");
  } finally { await act(async()=>root.unmount()); host.remove(); }
});

it("temporarily collapses navigation for the docked assistant and allows reopening it", async () => {
  const { host, root, toggle } = await exercise(false);
  const status = () => host.querySelector("output")!.textContent;
  const dock = async (open: boolean) => {
    await act(async () => { document.body.classList.toggle("agent-sidebar-open", open); });
  };
  try {
    await dock(true);
    expect(status()).toBe("focus:false:240");
    expect(localStorage.getItem("hub.sidebar.mode")).toBe("standard");
    await dock(false);
    expect(status()).toBe("standard:true:240");

    await dock(true);
    await act(async () => toggle.click());
    expect(status()).toBe("standard:true:240");
    await dock(false);
    await dock(true);
    expect(status()).toBe("focus:false:240");
  } finally {
    await dock(false);
    await act(async () => root.unmount());
    host.remove();
  }
});

it("keeps the library navigation width separate from other workspaces", async () => {
  localStorage.setItem("hub.sidebar.context-width-v1", "362");
  const {host,root}=await exercise(false);
  try {
    expect(host.querySelector("output")!.textContent).toBe("standard:true:362");
    await act(async()=>root.render(<Sample view="libraries"/>));
    expect(host.querySelector("output")!.textContent).toBe("standard:true:248");
    const separator=host.querySelector<HTMLElement>(".context-sidebar-resizer")!;
    await act(async()=>separator.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true})));
    expect(localStorage.getItem("hub.library-browse.navigation-width-v1")).toBe("256");
    expect(localStorage.getItem("hub.sidebar.context-width-v1")).toBe("362");
    await act(async()=>root.render(<Sample view="tasks"/>));
    expect(host.querySelector("output")!.textContent).toBe("standard:true:362");
    await act(async()=>root.render(<Sample view="libraries"/>));
    expect(host.querySelector("output")!.textContent).toBe("standard:true:256");
    await act(async()=>separator.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})));
    expect(host.querySelector("output")!.textContent).toBe("standard:true:248");
    expect(localStorage.getItem("hub.sidebar.context-width-v1")).toBe("362");
  } finally {await act(async()=>root.unmount());host.remove();}
});
it("opens a narrow panel without changing the saved mode and returns focus on Escape", async () => {
  const {host,root,toggle}=await exercise(true);
  try {
    await act(async()=>toggle.click()); expect(host.querySelector("output")!.textContent).toBe("standard:true:240");
    expect(localStorage.getItem("hub.sidebar.mode")).toBe("standard");
    await act(async()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
    expect(host.querySelector("output")!.textContent).toBe("standard:false:240"); expect(document.activeElement).toBe(toggle);
  } finally { await act(async()=>root.unmount()); host.remove(); }
});
it("resizes the contextual sidebar with the keyboard and persists the width", async () => {
  const {host,root}=await exercise(false);
  try {
    const separator = host.querySelector<HTMLElement>(".context-sidebar-resizer")!;
    await act(async()=>separator.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true})));
    expect(host.querySelector("output")!.textContent).toBe("standard:true:248");
    expect(localStorage.getItem("hub.sidebar.context-width-v1")).toBe("248");
    await act(async()=>separator.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true})));
    expect(host.querySelector("output")!.textContent).toBe("standard:true:240");
  } finally { await act(async()=>root.unmount()); host.remove(); }
});
it("resizes the contextual sidebar by dragging and keeps the final width", async () => {
  const {host,root}=await exercise(false);
  try {
    const separator = host.querySelector<HTMLElement>(".context-sidebar-resizer")!;
    await act(async()=>separator.dispatchEvent(pointerEvent("pointerdown",240)));
    expect(document.body.classList.contains("resizing-context-sidebar")).toBe(true);
    await act(async()=>window.dispatchEvent(pointerEvent("pointermove",304)));
    expect(host.querySelector("output")!.textContent).toBe("standard:true:304");
    await act(async()=>window.dispatchEvent(pointerEvent("pointerup",304)));
    expect(localStorage.getItem("hub.sidebar.context-width-v1")).toBe("304");
    expect(document.body.classList.contains("resizing-context-sidebar")).toBe(false);
  } finally { await act(async()=>root.unmount()); host.remove(); }
});
