// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {AgentLibraryScope,readLibraryDrop} from "./AgentLibraryScope";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn(async()=>[{id:"one",name:"库一"},{id:"two",name:"库二"}])}));
it("validates library drag payloads and deduplicates library ids",()=>{
 expect(readLibraryDrop('[{"id":"one","name":"库一"},{"id":"one","name":"库一"}]')).toEqual([{id:"one",name:"库一"}]);
 for(const raw of ['null','[]','{}','[{"id":"","name":"x"}]','[{"id":"one"}]'])expect(()=>readLibraryDrop(raw)).toThrow();
});
it("selects explicit library ids for all libraries and allows individual selection",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const change=vi.fn();
 try{
 await act(async()=>root.render(<AgentLibraryScope selected={[]} disabled={false} onChange={change}/>));
 const inputs=host.querySelectorAll<HTMLInputElement>('input');
 await act(async()=>inputs[0].click());expect(change).toHaveBeenLastCalledWith([{id:"one",name:"库一"},{id:"two",name:"库二"}]);
 await act(async()=>inputs[2].click());expect(change).toHaveBeenLastCalledWith([{id:"two",name:"库二"}]);
 }finally{await act(async()=>root.unmount());host.remove();}
});
