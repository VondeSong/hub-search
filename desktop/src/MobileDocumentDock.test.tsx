// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileDocumentDock } from "./MobileDocumentDock";
import type { SearchResult } from "./SearchTypes";

const {invoke,load,save,pending,tasks} = vi.hoisted(() => ({invoke:vi.fn(),load:vi.fn(),save:vi.fn(),pending:vi.fn(),tasks:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("./CloudAgentDrafts",()=>({loadComposerDrafts:load,saveComposerDraft:save}));
vi.mock("./CloudAgentMedia",()=>({outbox:pending}));
vi.mock("./MobileInsightTasks",()=>({mobileTasks:tasks,MobileTaskForm:()=>null}));
const documentResult={title:"资料",documentId:"item",provider:"obsidian",libraryId:"os",libraryName:"OS",path:"目录",snippet:"命中段落"} as SearchResult;
const original={text:"已有草稿",attachments:[],skillVersion:"",skillPaths:[]};
const material={id:"snapshot",title:"资料",text:"全文",source:"OS",sha256:"hash"};
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
it("attaches the selected document to the existing unsent draft",async()=>{
  await tap("问助手");
  expect(invoke.mock.calls.map(row=>row[1].action.op)).toEqual(["config","material"]);
  expect(save).toHaveBeenCalledWith("device","new",{...original,material});
  expect(agents).toHaveBeenCalledOnce();
});
it("preserves a different draft material and a pending send",async()=>{
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
