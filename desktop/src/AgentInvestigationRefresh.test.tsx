// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentInvestigation } from "./AgentInvestigation";
import type { SearchResult } from "./SearchTypes";
import type { TimedEvent } from "./useAgentUiTiming";

const { invoke, bridge, visibility } = vi.hoisted(() => ({ invoke: vi.fn(), bridge: { receive: null as null | ((event: { payload: TimedEvent }) => void) },visibility:{value:true} }));
vi.mock("./CodexSuite",async importOriginal=>({...await importOriginal<object>(),loadCodexSuiteModels:vi.fn(async()=>[]),cachedCodexSuiteModels:()=>[],useCodexSuite:()=>({loaded:true,loading:false,settings:{model:"fixture-model",provider:"codex",reasoningEffort:"medium",fast:false,maxConcurrent:2}})}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, ...args: unknown[]) => command === "list_libraries" ? Promise.resolve([]) : invoke(command, ...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, receive) => {
  if (name !== "agent-work-updated") return () => {};
  bridge.receive=receive;
  return () => { if (bridge.receive === receive) bridge.receive=null; };
}) }));
vi.mock("./WindowVisibility", () => ({ useDocumentVisible: () => visibility.value }));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: { desktop: true, localVault: true } }));
let host: HTMLDivElement, root: Root;
const result: SearchResult = { id:"hit",entityKey:"page:notes:doc",provider:"obsidian",libraryId:"notes",libraryName:"资料",spaceId:"notes",spaceName:"资料",documentId:"doc",contentType:"markdown",sourceType:"note",title:"原文",path:"原文.md",snippet:"",matchTerms:[],matchField:"",matchCount:0,subMatches:[] };
const view = (recordVersion=1, summary="已有报告") => ({work:{id:"work",goal:"核对资料",state:"completed",grant:{libraryIds:[]},report:{status:"completed",summary,findings:[],nextSteps:[],questions:[],limitations:[],waitCondition:""}},evidence:[],decisions:[],run:{id:"run",usage:{}},validity:"",recordVersion});
const statusCalls=()=>invoke.mock.calls.filter(([,value])=>value.args.action==="status").length;
async function open() {
  await act(async()=>root.render(<AgentInvestigation result={result}/>));
  const button=[...document.body.querySelectorAll<HTMLButtonElement>("button")].find(value=>(value.getAttribute("aria-label")||value.textContent)?.includes("调查这篇笔记"))!;
  await act(async()=>button.click());
  expect(bridge.receive).toBeTypeOf("function");
}
async function notify(publicHasText?: boolean) {
  await act(async()=>bridge.receive!({payload:{workId:"work",runId:"run",eventCategory:publicHasText===undefined?"state":"publicStream",publicKind:"message",publicHasText}}));
}
beforeEach(()=>{
  vi.useFakeTimers(); Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  visibility.value=true;
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  invoke.mockReset().mockImplementation(async (_command,{args})=>args.action==="list"?{works:[{id:"work",goal:"核对资料",state:"completed"}]}:view());
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();bridge.receive=null;vi.useRealTimers();});

it("requests an actual public-content snapshot immediately instead of waiting for a trailing status timer",async()=>{
  await open();const before=statusCalls();
  await notify(true);
  expect(statusCalls()).toBe(before+1);
});

it("refreshes persisted working notes from the same authoritative state-event snapshot",async()=>{
  const snapshot=(revision:number,text:string)=>({...view(revision),work:{...view(revision).work,revision:7,authorizationVersion:2},
    workingState:{schemaVersion:1,revision,sequence:String(revision),entries:[{entryId:"entry",kind:"observation",value:text,status:"proposed",evidenceRefs:[]}],pendingTargets:[],unresolvedQuestions:[]}});
  invoke.mockImplementation(async (_command,{args})=>args.action==="list"?{works:[{id:"work",goal:"核对资料",state:"completed"}]}:snapshot(1,"已保存的旧工作笔记"));
  await open();expect(document.body.textContent).toContain("已保存的旧工作笔记");
  invoke.mockImplementation(async()=>snapshot(2,"已保存的较新工作笔记"));
  await notify(false);await act(async()=>vi.advanceTimersByTimeAsync(60));
  expect(document.body.textContent).toContain("已保存的较新工作笔记");expect(document.body.textContent).not.toContain("已保存的旧工作笔记");
  expect(document.body.textContent).toContain("第 2 版");
});

it("keeps one status projection in flight and follows it with the later public event",async()=>{
  await open();const before=statusCalls();let active=0,maximum=0;
  const pending:((value:ReturnType<typeof view>)=>void)[]=[];
  invoke.mockImplementation((_command,{args})=>args.action!=="status"?Promise.resolve(view()):new Promise(resolve=>{active++;maximum=Math.max(maximum,active);pending.push(value=>{active--;resolve(value);});}));
  await notify(true);await act(async()=>vi.advanceTimersByTimeAsync(60));
  await notify(true);await act(async()=>vi.advanceTimersByTimeAsync(60));
  expect(maximum).toBe(1);
  await act(async()=>pending[0](view(2,"先前快照")));
  expect(statusCalls()).toBe(before+2);
  await act(async()=>pending[1](view(3,"最新公开内容")));
  expect(document.body.textContent).toContain("最新公开内容");
  expect(active).toBe(0);
});

it("does not postpone state refresh indefinitely under a continuous notification burst",async()=>{
  await open();const before=statusCalls();
  await notify();await act(async()=>vi.advanceTimersByTimeAsync(30));
  await notify();await act(async()=>vi.advanceTimersByTimeAsync(30));
  expect(statusCalls()).toBe(before+1);
});

it("keeps an empty public event in the state-notification class",async()=>{
  await open();const before=statusCalls();
  await notify(false);expect(statusCalls()).toBe(before);
  await act(async()=>vi.advanceTimersByTimeAsync(60));
  expect(statusCalls()).toBe(before+1);
});

it("rejects a status response predating an explicit source revalidation",async()=>{
  await open();
  const pending:((value:ReturnType<typeof view>)=>void)[]=[];
  invoke.mockImplementation(()=>new Promise(resolve=>pending.push(resolve)));
  await notify(true);
  visibility.value=false;await act(async()=>root.render(<AgentInvestigation result={result}/>));
  visibility.value=true;await act(async()=>root.render(<AgentInvestigation result={result}/>));
  expect(pending).toHaveLength(2);
  await act(async()=>pending[0](view(2,"已撤权的旧正文")));
  expect(document.body.textContent).not.toContain("已撤权的旧正文");
  const denied={...view(3),work:{...view(3).work,state:"expired",report:null},validity:"来源已撤权"};
  await act(async()=>pending[1](denied as unknown as ReturnType<typeof view>));
  expect(document.body.textContent).not.toContain("已有报告");
  expect(document.body.textContent).toContain("来源已撤权");
});
