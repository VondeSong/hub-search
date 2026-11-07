// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { AgentMaterials, type AgentMaterial, type NoteLocator } from "./AgentMaterials";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const anchor: NoteLocator = { kind: "note", libraryId: "a", documentId: "one", pageId: null };
const extra: AgentMaterial = { locator: { ...anchor, libraryId: "b", documentId: "two" }, title: "另一库笔记", path: "学习.md", libraryName: "B库" };
let host: HTMLDivElement, root: Root;
function Subject() { const [selected, setSelected] = useState<AgentMaterial[]>([]); return <AgentMaterials anchor={anchor} selected={selected} disabled={false} onChange={setSelected} />; }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset().mockResolvedValue({ notes: [extra], total: 21, nextOffset: 20, snapshot: "same" }); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function open() { await act(async () => root.render(<Subject />)); expect(invoke).not.toHaveBeenCalled(); await act(async () => { host.querySelector("summary")!.click(); await new Promise(r => setTimeout(r, 0)); }); }
it("discovers notes on demand and selects exact cross-library locators without starting a model", async () => {
 await open(); expect(invoke).toHaveBeenCalledExactlyOnceWith("agent_investigation", { args: { action: "materials", query: { query: "", offset: 0, limit: 20 } } });
 await act(async () => host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click()); expect(host.querySelector("summary")!.textContent).toContain("2");
 expect(invoke.mock.calls.every(([, p]) => p.args.action === "materials")).toBe(true);
 await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="移除材料 另一库笔记"]')!.click()); expect(host.querySelector("summary")!.textContent).not.toContain("2");
});
it("does not silently reselect a removed initial page in a new draft",async()=>{
 invoke.mockResolvedValue({notes:[{...extra,locator:anchor,title:"原页面"}],total:1,nextOffset:null,snapshot:"removed"});
 const change=vi.fn();await act(async()=>root.render(<AgentMaterials embedded anchor={anchor} anchorIncluded={false} selected={[]} disabled={false} onChange={change}/>));
 const choice=host.querySelector<HTMLInputElement>('.agent-material-choice input')!;
 expect(choice.checked).toBe(false);expect(choice.disabled).toBe(false);await act(async()=>choice.click());
 expect(change).toHaveBeenCalledWith([expect.objectContaining({locator:anchor})]);
});
it("binds subsequent pages to the first snapshot and clears stale results on failure", async () => {
 await open(); await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "下一页")!.click());
 expect(invoke).toHaveBeenLastCalledWith("agent_investigation", { args: { action: "materials", query: { query: "", offset: 20, limit: 20, expectedSnapshot: "same" } } });
 invoke.mockRejectedValueOnce(new Error("清单已经变化")); await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "下一页")!.click());
 expect(host.querySelector('[role="alert"]')?.textContent).toContain("重新查找"); expect(host.querySelector('[type="checkbox"]')).toBeNull();
});
it("keeps existing authorization checked and locked while selecting only explicit additions", async () => {
 invoke.mockResolvedValue({notes:[{...extra,locator:anchor,title:"原材料"},extra],total:2,nextOffset:null,snapshot:"same"});
 const change=vi.fn();
 await act(async()=>root.render(<AgentMaterials anchor={anchor} retained={[anchor]} selected={[]} disabled={false} onChange={change}/>));
 await act(async()=>{host.querySelector("summary")!.click();await new Promise(r=>setTimeout(r,0));});
 const choices=host.querySelectorAll<HTMLInputElement>('[type="checkbox"]');
 expect(choices[0].checked).toBe(true);expect(choices[0].disabled).toBe(true);
 await act(async()=>choices[1].click());expect(change).toHaveBeenCalledExactlyOnceWith([extra]);
 expect(host.textContent).toContain("随下一条消息发送");
});
it("withdraws only an explicit extra note and offers a no-analysis confirmation",async()=>{
 invoke.mockResolvedValue({notes:[{...extra,locator:anchor,title:"锚点"},extra],total:2,nextOffset:null,snapshot:"same"});
 const confirm=vi.fn();
 function Withdrawal(){const [removed,setRemoved]=useState<NoteLocator[]>([]);return <AgentMaterials anchor={anchor} retained={[anchor,extra.locator]} selected={[]} disabled={false} onChange={()=>{throw Error("must not add notes")}} removed={removed} onRemove={setRemoved} onWithdraw={confirm}/>;}
 await act(async()=>root.render(<Withdrawal/>));await act(async()=>{host.querySelector("summary")!.click();await new Promise(r=>setTimeout(r,0));});
 expect(host.querySelector('[aria-label="撤回授权 锚点"]')).toBeNull();
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="撤回授权 另一库笔记"]')!.click());
 expect(host.querySelector("summary")!.textContent).toContain("待撤回 1");
 expect(host.querySelectorAll<HTMLInputElement>('[type="checkbox"]')[1].checked).toBe(false);
 await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent?.includes("确认撤回所选授权"))!.click());expect(confirm).toHaveBeenCalledOnce();
});
it("does not offer per-note withdrawal of a whole-library grant or the anchor parent",async()=>{
 invoke.mockResolvedValue({notes:[extra,{...extra,locator:anchor,title:"父文档"}],total:2,nextOffset:null,snapshot:"same"});
 await act(async()=>root.render(<AgentMaterials anchor={{...anchor,pageId:"child"}} retained={[anchor,extra.locator]} libraryIds={[extra.locator.libraryId]} selected={[]} disabled={false} onChange={()=>{}} onRemove={()=>{}}/>));
 await act(async()=>{host.querySelector("summary")!.click();await new Promise(r=>setTimeout(r,0));});
 expect(host.querySelector('[aria-label^="撤回授权"]')).toBeNull();
});

it("finishes selection without sending or granting materials",async()=>{
 const done=vi.fn();await act(async()=>root.render(<AgentMaterials embedded selected={[extra]} disabled={false} onChange={()=>{}} onDone={done}/>));
 expect(host.querySelector('footer')?.textContent).toContain('已选 1 份');
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='完成选择')!.click());
 expect(done).toHaveBeenCalledOnce();expect(invoke.mock.calls.every(([,p])=>p.args.action==='materials')).toBe(true);
});
it("does not apply an older lookup after the query changes",async()=>{
 let resolve!:(p:unknown)=>void;invoke.mockImplementationOnce(()=>new Promise(r=>{resolve=r}));
 await act(async()=>root.render(<AgentMaterials embedded selected={[]} disabled={false} onChange={()=>{}}/>));
 const input=host.querySelector<HTMLInputElement>('input[type=search]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'new');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>resolve({notes:[extra],total:1,nextOffset:null,snapshot:'old'}));
 expect(host.querySelector('.agent-material-choice')).toBeNull();
});
