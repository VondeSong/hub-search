// @vitest-environment jsdom
import {act,useState} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {AgentImages,type ImageGrant} from "./AgentImages";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
let host:HTMLDivElement,root:Root;
const grant=(n:number):ImageGrant=>({libraryId:"notes",documentId:"doc",sourceItemId:`image${n}`,inputVersion:`v${n}`,blobHash:String(n).repeat(64)});
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);vi.mocked(invoke).mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function click(text:string){await act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent===text)!.click();});}
it("lists metadata and updates the shared picker draft without granting model access",async()=>{
 const change=vi.fn();vi.mocked(invoke).mockResolvedValue({images:[{grant:grant(1),title:"图片一",mime:"image/png"}],hasMore:false});
 await act(async()=>root.render(<AgentImages current={[]} selected={[]} disabled={false} onChange={change}/>));await click("查找缓存图片");expect(change).not.toHaveBeenCalled();expect(host.querySelector("img")).toBeNull();
 await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
 expect(change).toHaveBeenCalledExactlyOnceWith([grant(1)]);
 expect(vi.mocked(invoke).mock.calls.every(([,p])=>(p as {args:{action:string}}).args.action==="imageMaterials")).toBe(true);
});
it("keeps the withdrawal warning for previously granted images",async()=>{
 const current=[grant(1)];
 function Picker() {
  const [selected,setSelected]=useState(current);
  return <AgentImages current={current} selected={selected} disabled={false} onChange={setSelected}/>;
 }
 vi.mocked(invoke).mockResolvedValue({images:[],hasMore:false});
 await act(async()=>root.render(<Picker/>));await click("移除原图");
 expect(host.textContent).toContain("旧回答将不可用");
});
it("running work cannot change scope and the ninth image cannot be selected",async()=>{
 const change=vi.fn(),selected=Array.from({length:8},(_,i)=>grant(i+1));vi.mocked(invoke).mockResolvedValue({images:[...selected,grant(9)].map((g,n)=>({grant:g,title:`图${n+1}`,mime:"image/png"})),hasMore:true});await act(async()=>root.render(<AgentImages current={selected} selected={selected} disabled={false} onChange={change}/>));await click("查找缓存图片");expect(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[8].disabled).toBe(true);expect(host.textContent).toContain("缩小标题范围");await act(async()=>root.render(<AgentImages current={selected} selected={selected} disabled={true} onChange={change}/>));expect([...host.querySelectorAll("button")].every(b=>b.disabled)).toBe(true);expect(change).not.toHaveBeenCalled();
});
