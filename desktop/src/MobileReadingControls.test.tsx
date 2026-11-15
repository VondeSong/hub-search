// @vitest-environment jsdom
import {act} from "react";import{createRoot,type Root}from"react-dom/client";import{beforeEach,afterEach,it,expect,vi}from"vitest";
import{MobileReadingControls}from"./MobileReadingControls";import{defaultCollectionView}from"./CollectionViews";
let root:Root,node:HTMLElement;
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;node=document.createElement("div");document.body.append(node);root=createRoot(node);HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.restoreAllMocks();delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
it("keeps source/media edits staged on cancel and applies them together without changing the query",async()=>{
 const view={...defaultCollectionView(),query:"保留关键词"};const change=vi.fn();await act(async()=>root.render(<MobileReadingControls view={view} onChange={change} count={12} tags={["日常"]} onSync={()=>{}}/>));
 await act(async()=>(node.querySelector('[aria-label="阅读筛选"]')as HTMLElement).click());
 const source=document.querySelector<HTMLSelectElement>('[aria-label="阅读来源"]')!;await act(async()=>{source.value="dida";source.dispatchEvent(new Event("change",{bubbles:true}));});expect(change).not.toHaveBeenCalled();
 await act(async()=>document.querySelector("dialog")!.dispatchEvent(new Event("cancel",{cancelable:true})));await act(async()=>new Promise(r=>setTimeout(r,30)));expect(change).not.toHaveBeenCalled();
 await act(async()=>(node.querySelector('[aria-label="阅读筛选"]')as HTMLElement).click());expect(document.querySelector<HTMLSelectElement>('[aria-label="阅读来源"]')!.value).toBe("all");
 await act(async()=>{const select=document.querySelector<HTMLSelectElement>('[aria-label="阅读来源"]')!;select.value="telegram";select.dispatchEvent(new Event("change",{bubbles:true}));});
 await act(async()=>([...document.querySelectorAll("dialog button")].find(b=>b.textContent==="应用筛选")as HTMLElement).click());expect(change).toHaveBeenLastCalledWith(expect.objectContaining({source:"telegram"}));expect(change.mock.calls[0][0]).not.toHaveProperty("query");
});
