// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileDocumentDock } from "./MobileDocumentDock";
import type { SearchResult } from "./SearchTypes";

const {invoke,load,save,pending,tasks} = vi.hoisted(() => ({invoke:vi.fn(),load:vi.fn(),save:vi.fn(),pending:vi.fn(),tasks:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("./CloudAgentDrafts",()=>({
  loadComposerDrafts:load,
  saveComposerDraft:save,
  updateComposerDraft:async(binding:string,thread:string,updater:(state:{draft?:unknown;hasPendingOutbox:boolean})=>unknown)=>{
    const hasPendingOutbox=Boolean(await pending(binding));
    const drafts=await load(binding);
    const next=updater({draft:drafts.get(thread),hasPendingOutbox});
    await save(binding,thread,next);
    return next;
  },
}));
vi.mock("./CloudAgentMedia", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CloudAgentMedia")>();
  return { ...actual, outbox: pending };
});
vi.mock("./MobileInsightTasks",()=>({mobileTasks:tasks,MobileTaskForm:()=>null}));
const documentResult={title:"资料",documentId:"item",provider:"obsidian",libraryId:"os",libraryName:"OS",path:"目录",snippet:"命中段落"} as SearchResult;
const original={text:"已有草稿",attachments:[],skillVersion:"",skillPaths:[]};
const materialKey={kind:"document" as const,id:"item",libraryId:"os"};
const material={id:"snapshot",title:"资料",text:"全文",source:"OS",sha256:"hash"};
const keyedMaterial={...material,key:materialKey};
let root:Root, host:HTMLDivElement;
const agents=vi.fn(), capture=vi.fn(), task=vi.fn();
beforeEach(async()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  vi.resetAllMocks(); pending.mockResolvedValue(undefined);load.mockResolvedValue(new Map([["new",original]]));
  tasks.mockReturnValue([]); invoke.mockImplementation(async(_cmd,args)=>args.action?.op==="config"?{binding:"device"}:material);
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  await act(async()=>root.render(<MobileDocumentDock document={documentResult} body="全文" onAgents={agents} onCapture={capture} onTask={task}/>));
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const tap=(label:string)=>act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent===label)!.click();});
it("attaches the selected document with key and manual context mode to the existing unsent draft",async()=>{
  await tap("问助手");
  expect(invoke.mock.calls.map(row=>row[1].action.op)).toEqual(["config","material"]);
  expect(save).toHaveBeenCalledWith("device","new",{...original,material:keyedMaterial,materials:[keyedMaterial],contextMode:"manual"});
  expect(agents).toHaveBeenCalledOnce();
});
it("appends additional keyed documents into multi-select draft, dedupes repeats, and guards 48 KB overflow",async()=>{
  const existingKeyed={id:"other-id",title:"已有资料",text:"旧正文",source:"Craft",sha256:"h0",key:{kind:"document" as const,id:"doc-0",libraryId:"craft"}};
  load.mockResolvedValue(new Map([["new",{...original,material:existingKeyed,materials:[existingKeyed],contextMode:"manual"}]]));
  await tap("问助手");
  expect(save).toHaveBeenLastCalledWith("device","new",{
    ...original,
    material:existingKeyed,
    materials:[existingKeyed,keyedMaterial],
    contextMode:"manual",
  });
  expect(agents).toHaveBeenCalledTimes(1);

  save.mockClear(); agents.mockClear();
  load.mockResolvedValue(new Map([["new",{...original,material:existingKeyed,materials:[existingKeyed,keyedMaterial],contextMode:"manual"}]]));
  await tap("问助手");
  expect(save).toHaveBeenLastCalledWith("device","new",{
    ...original,
    material:existingKeyed,
    materials:[existingKeyed,keyedMaterial],
    contextMode:"manual",
  });

  save.mockClear(); agents.mockClear();
  const hugeKeyed={...existingKeyed,text:"a".repeat(47990)};
  load.mockResolvedValue(new Map([["new",{...original,material:hugeKeyed,materials:[hugeKeyed],contextMode:"manual"}]]));
  await tap("问助手");
  expect(save).not.toHaveBeenCalled(); expect(agents).not.toHaveBeenCalled();
  expect(host.textContent).toContain("48 KB");

  // Replacing an existing same-key material with a grown snapshot must also enforce 48 KB.
  save.mockClear(); agents.mockClear();
  const grownSameKey={...material,text:"b".repeat(47995)};
  invoke.mockImplementation(async(_cmd,args)=>args.action?.op==="config"?{binding:"device"}:grownSameKey);
  load.mockResolvedValue(new Map([["new",{...original,material:existingKeyed,materials:[existingKeyed,keyedMaterial],contextMode:"manual"}]]));
  await tap("问助手");
  expect(save).not.toHaveBeenCalled(); expect(agents).not.toHaveBeenCalled();
  expect(host.textContent).toContain("48 KB");
});
it("does not mutate draft or navigate if unmounted before material read finishes",async()=>{
  let releaseMaterial!:(value:unknown)=>void;
  invoke.mockImplementation(async(_cmd,args)=>args.action?.op==="config"?{binding:"device"}:new Promise(r=>{releaseMaterial=r;}));
  await act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent==="问助手")!.click();});
  await act(async()=>{await Promise.resolve();});
  await act(async()=>root.unmount());
  root=createRoot(host);
  await act(async()=>releaseMaterial(material));
  expect(save).not.toHaveBeenCalled();
  expect(agents).not.toHaveBeenCalled();
});
it("preserves a legacy unkeyed draft material and a pending send",async()=>{
  load.mockResolvedValue(new Map([["new",{...original,material:{...material,id:"other"}}]]));
  await tap("问助手");expect(save).not.toHaveBeenCalled();expect(agents).not.toHaveBeenCalled();
  pending.mockResolvedValue({thread:"previous"});await tap("问助手");expect(host.textContent).toContain("待核对");
});
it("keeps the passage and source with the journal and card, and reopens the correct task",async()=>{
  await tap("记想法");expect(capture).toHaveBeenCalledWith("《资料》\nOS / 目录\n命中段落");
  await tap("提炼卡");await tap("提炼卡");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("create_flashcard_draft",expect.objectContaining({answer:"命中段落",sourceTitle:"资料",sourcePath:"OS / 目录"}));
  const id='document:'+JSON.stringify(["obsidian","os","item"]);tasks.mockReturnValue([{id}]);
  await tap("转任务");expect(task).toHaveBeenCalledWith(id);
});
