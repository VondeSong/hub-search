// @vitest-environment jsdom
import { act } from "react";
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
