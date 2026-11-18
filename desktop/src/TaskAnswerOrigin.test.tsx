// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentPanelContext} from "./StandaloneAgentLauncher";
import {TaskAnswerOrigin} from "./TaskAnswerOrigin";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root;
const open=vi.fn();
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset();open.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function render(objectId:string){await act(async()=>root.render(<AgentPanelContext.Provider value={open}><TaskAnswerOrigin provider="dida365" libraryId="daily" objectId={objectId}/></AgentPanelContext.Provider>));}
it("returns to the recorded Work without creating a conversation or starting a model",async()=>{
  invoke.mockResolvedValue([{workId:"original",runId:"answer"}]);
  await render("saved-task");await act(async()=>host.querySelector<HTMLButtonElement>("button")!.click());
  expect(open).toHaveBeenCalledWith({workId:"original"});
  expect(invoke.mock.calls).toEqual([["agent_investigation",{args:{action:"answerTaskOrigins",libraryId:"daily",objectId:"saved-task"}}]]);
});
it("discards a delayed result after the selected task changes",async()=>{
  let resolve!:(v:unknown)=>void;
  invoke.mockReturnValueOnce(new Promise(r=>{resolve=r;})).mockResolvedValueOnce([]);
  await render("task-a");await render("task-b");
  await act(async()=>resolve([{workId:"wrong-old-work",runId:"a"}]));
  expect(host.querySelector("button")).toBeNull();expect(open).not.toHaveBeenCalled();
});
