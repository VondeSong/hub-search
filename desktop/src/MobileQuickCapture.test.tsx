// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {MobileQuickCapture} from "./MobileQuickCapture";
vi.mock("./QuickJournal",()=>({QuickJournal:()=> <><textarea aria-label="正文"/><input type="file"/></>}));
let host:HTMLDivElement,root:Root;
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement("div");document.body.append(host);root=createRoot(host);vi.stubGlobal("innerHeight",840);vi.stubGlobal("visualViewport",Object.assign(new EventTarget(),{height:840,scale:1}));HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();vi.restoreAllMocks();delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
it("keeps blank sheet clicks open, closes the backdrop and restores the opener focus",async()=>{
 const close=vi.fn(),opener=document.createElement("button");document.body.append(opener);opener.focus();
 await act(async()=>root.render(<MobileQuickCapture onClose={close} onSaved={vi.fn()} onSyncSettings={vi.fn()}/>));
 const dialog=document.querySelector("dialog")!;vi.spyOn(dialog,"getBoundingClientRect").mockReturnValue({left:0,right:390,top:200,bottom:840}as DOMRect);
 await act(async()=>dialog.dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:10,clientY:250})));expect(close).not.toHaveBeenCalled();
 await act(async()=>dialog.dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:10,clientY:100})));expect(close).toHaveBeenCalledOnce();
 await act(async()=>root.render(null));expect(document.activeElement).toBe(opener);opener.remove();
});
it("moves above a visual-viewport keyboard and treats Escape as a request to close",async()=>{
 const close=vi.fn();await act(async()=>root.render(<MobileQuickCapture onClose={close} onSaved={vi.fn()} onSyncSettings={vi.fn()}/>));
 await act(async()=>{Object.assign(window.visualViewport!,{height:420});window.visualViewport!.dispatchEvent(new Event("resize"));});
 const dialog=document.querySelector("dialog")!;expect(dialog.style.getPropertyValue("--capture-keyboard-inset")).toBe("420px");expect(dialog.classList.contains("keyboard-open")).toBe(true);
 const cancel=new Event("cancel",{cancelable:true});await act(async()=>dialog.dispatchEvent(cancel));expect(cancel.defaultPrevented).toBe(true);expect(close).toHaveBeenCalledOnce();
});
it("keeps the sheet open when its file picker emits a bubbling cancel",async()=>{
 const close=vi.fn();await act(async()=>root.render(<MobileQuickCapture onClose={close} onSaved={vi.fn()} onSyncSettings={vi.fn()}/>));
 await act(async()=>document.querySelector('dialog input[type="file"]')!.dispatchEvent(new Event("cancel",{bubbles:true})));
 expect(close).not.toHaveBeenCalled();expect(document.querySelector("dialog")?.open).toBe(true);
});
