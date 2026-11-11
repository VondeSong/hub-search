// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentPopover } from "./useAgentPopover";

let host: HTMLDivElement, root: Root;
let resized: () => void;
const disconnect = vi.fn();
function Menu({ composer = true }: { composer?: boolean }) {
  const popover = useAgentPopover();
  const menu = <details ref={popover.ref}><summary>菜单</summary><button>返回</button></details>;
  return composer ? <div className="agent-body"><div className="agent-composer"><div className="agent-composer-controls">{menu}</div></div></div> : menu;
}
function ExternalTriggerMenu() {
  const trigger=useRef<HTMLButtonElement>(null);
  const popover=useAgentPopover({triggerRef:trigger});
  return <><button ref={trigger} onClick={()=>{if(popover.ref.current)popover.ref.current.open=!popover.ref.current.open;}}>更多</button><details ref={popover.ref}><summary>历史</summary><button>内容</button></details></>;
}
it("does not dismiss an external toggle before its click and therefore reopen it",async()=>{
  await act(async()=>root.render(<ExternalTriggerMenu/>));
  const trigger=host.querySelector('button')!,menu=host.querySelector('details')!;
  await act(async()=>trigger.click());expect(menu.open).toBe(true);
  await act(async()=>{trigger.dispatchEvent(new Event('pointerdown',{bubbles:true}));trigger.focus();trigger.click();});
  expect(menu.open).toBe(false);
  await act(async()=>trigger.click());expect(menu.open).toBe(true);
  await act(async()=>document.body.dispatchEvent(new Event('pointerdown',{bubbles:true})));expect(menu.open).toBe(false);
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  disconnect.mockReset();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<Menu />));
  const body = host.querySelector<HTMLElement>(".agent-body")!;
  const controls = host.querySelector<HTMLElement>(".agent-composer-controls")!;
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 70, 438, 480));
  const position = vi.spyOn(controls, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 330, 400, 32));
  const details = host.querySelector("details")!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  return { details, position };
}
it("keeps a long menu below the actual scroll clip when work controls take space", async () => {
  const { details } = await render();
  expect(details.style.getPropertyValue("--agent-popover-room")).toBe("252px");
  expect(details.open).toBe(true);
});
it("updates available space after a resize without replacing the open menu or its focus", async () => {
  const { details, position } = await render();
  const button = host.querySelector("button")!;
  button.focus();
  position.mockReturnValue(new DOMRect(0, 230, 400, 32));
  resized();
  expect(details.style.getPropertyValue("--agent-popover-room")).toBe("152px");
  expect(document.activeElement).toBe(button);
  position.mockReturnValue(new DOMRect(0, 150, 400, 32));
  window.dispatchEvent(new Event("resize"));
  expect(details.style.getPropertyValue("--agent-popover-room")).toBe("72px");
});
it("still closes with Escape and restores the trigger rather than submitting", async () => {
  const { details } = await render();
  const button = host.querySelector("button")!;
  button.focus();
  await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(details.open).toBe(false);
  expect(document.activeElement).toBe(host.querySelector("summary"));
});
it("keeps internal interaction open and dismisses on outside pointer, focus, or window blur", async () => {
 const {details}=await render();const inside=host.querySelector('button')!,outside=document.createElement('button');document.body.append(outside);
 try{
  await act(async()=>{inside.focus();inside.dispatchEvent(new Event('pointerdown',{bubbles:true}));});expect(details.open).toBe(true);
  await act(async()=>outside.dispatchEvent(new Event('pointerdown',{bubbles:true})));expect(details.open).toBe(false);
  await act(async()=>{details.open=true;outside.focus();});expect(details.open).toBe(false);
  await act(async()=>{details.open=true;window.dispatchEvent(new Event('blur'));});expect(details.open).toBe(false);
 }finally{outside.remove();}
});
it("does not reposition non-composer disclosures and disconnects observers on unmount", async () => {
  await act(async () => root.render(<Menu composer={false} />));
  const details = host.querySelector("details")!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  expect(details.style.getPropertyValue("--agent-popover-room")).toBe("");
  await act(async () => root.render(null));
  expect(disconnect).toHaveBeenCalledOnce();
});

it("fits header menus to the actual floating panel and follows panel height changes", async () => {
  function HeaderMenu({ mounted = true }: { mounted?: boolean }) {
    const popover = useAgentPopover();
    return <aside className="agent-panel"><header className="agent-panel-header">
      {mounted && <details ref={popover.ref}><summary>历史</summary><button>关闭</button></details>}
    </header></aside>;
  }
  await act(async () => root.render(<HeaderMenu mounted={false} />));
  await act(async () => root.render(<HeaderMenu />));
  const panel = host.querySelector<HTMLElement>(".agent-panel")!;
  const header = host.querySelector<HTMLElement>(".agent-panel-header")!;
  const details = host.querySelector("details")!;
  const panelBox = vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 300, 440, 380));
  vi.spyOn(header, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 300, 440, 62));
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  expect(details.style.getPropertyValue("--agent-header-popover-room")).toBe("310px");
  panelBox.mockReturnValue(new DOMRect(0, 300, 440, 250));
  resized();
  expect(details.style.getPropertyValue("--agent-header-popover-room")).toBe("180px");
  expect(details.open).toBe(true);
});
