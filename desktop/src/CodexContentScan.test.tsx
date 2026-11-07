// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {CodexContentScan} from "./CodexContentScan";
import {refreshCodexSuite,resetCodexSuiteForTests,type CodexSettings} from "./CodexSuite";
import type {WindowVisibility} from "./WindowVisibility";
const {invoke,listen}=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn()}));vi.mock("@tauri-apps/api/core",()=>({invoke}));vi.mock("@tauri-apps/api/event",()=>({listen}));
let host:HTMLDivElement,root:Root; let settings:CodexSettings;let revision:number;
const run={runId:"r",status:"active",stale:false,totalEntities:50,entitiesRead:2,charsRead:500,maxEntities:30,maxChars:15000,counts:{recorded:2,unread:48,read:0}};
beforeEach(()=>{localStorage.clear();resetCodexSuiteForTests();revision=1;settings={model:"",reasoningEffort:"",fast:false,maxConcurrent:2};Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);
invoke.mockReset().mockImplementation(async(command, {args})=>{if(command==="model_runtime")return {settings,jobs:[],revision};if(args.action==="definition_models")return {models:[]};if(args.action==="scan_status")return {run:null};if(args.action==="scan_generate")return {run,submitted:[],unjudged:[],errors:[],pauseReason:"预算已用尽",coverage:"未覆盖全部正文",newEntitiesRead:2,newCharsRead:500};throw Error("Unexpected action");});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetCodexSuiteForTests();Reflect.deleteProperty(window,"__TAURI_INTERNALS__");vi.restoreAllMocks();vi.useRealTimers();listen.mockReset();});
const click=async()=>{const b=Array.from(host.querySelectorAll("button")).find(b=>b.textContent?.includes("逐篇检查"))!;await act(async()=>b.click());};
it("starts directly and refreshes assignment review without clipboard",async()=>{
  const event=vi.fn();window.addEventListener("hub-tag-scan-updated",event);
  await act(async()=>root.render(<CodexContentScan tagId="focus"/>));expect(host.textContent).toContain("用模型 开始逐篇检查");await click();
  expect(invoke).toHaveBeenCalledWith("tag_assignment",{args:{action:"scan_generate",tag:"focus",model:"",reasoningEffort:"",fast:false}});
  expect(event).toHaveBeenCalledTimes(1);expect(host.textContent).toContain("预算已用尽");window.removeEventListener("hub-tag-scan-updated",event);
});
it("pins an existing task and uses selected model effort and Fast",async()=>{
  settings={model:"test",reasoningEffort:"high",fast:true,maxConcurrent:2};
  const base=invoke.getMockImplementation()!;invoke.mockImplementation((c,p)=>p.args.action==="definition_models"?Promise.resolve({models:[{id:"test",name:"Test",reasoningLevels:["high"],fastDescription:"2x speed, increased usage"}]}):p.args.action==="scan_status"?Promise.resolve({run}):base(c,p));
  await act(async()=>root.render(<CodexContentScan tagId="focus" runId="r"/>));await click();
  expect(invoke).toHaveBeenCalledWith("tag_assignment",{args:{action:"scan_generate",tag:"focus",runId:"r",model:"test",reasoningEffort:"high",fast:true}});
});
it("does not run stale tasks",async()=>{
  const base=invoke.getMockImplementation()!;invoke.mockImplementation((c,p)=>p.args.action==="scan_status"?Promise.resolve({run:{...run,stale:true}}):base(c,p));
  await act(async()=>root.render(<CodexContentScan tagId="focus"/>));await click();
  expect(host.textContent).toContain("定义或范围已变化");expect(invoke.mock.calls.some(([,p])=>p.args.action==="scan_generate")).toBe(false);
});
it("uses the latest shared suite and ignores stale local preferences",async()=>{
  localStorage.setItem("hub.codex.definition.model.v1","old-model");
  await act(async()=>root.render(<CodexContentScan tagId="focus"/>));
  settings={model:"gpt-6-astra",reasoningEffort:"high",fast:true,maxConcurrent:2};
  revision++;await act(async()=>refreshCodexSuite());
  await click();
  expect(invoke).toHaveBeenCalledWith("tag_assignment",{args:{action:"scan_generate",tag:"focus",model:"gpt-6-astra",reasoningEffort:"high",fast:true}});
  expect(host.querySelector('[aria-label="选择模型和推理强度"]')).toBeNull();
  expect(host.textContent).toContain("gpt-6-astra");
});

it("pauses scan progress queries on native hide while the original generation continues and disposes polling on unmount",async()=>{
  vi.useFakeTimers();Object.defineProperty(window,"__TAURI_INTERNALS__",{configurable:true,value:{}});
  vi.spyOn(document,"hidden","get").mockReturnValue(false);
  let visibility!:(event:{payload:WindowVisibility})=>void;const unlisten=vi.fn();
  const shown:WindowVisibility={revision:"1",visible:true,minimized:false,foreground:true};
  listen.mockImplementation(async(_name,handler)=>{visibility=handler;return unlisten;});
  let finish!:(value:unknown)=>void;const base=invoke.getMockImplementation()!;
  invoke.mockImplementation((command,p)=>command==="get_window_visibility"?Promise.resolve(shown):p.args.action==="scan_generate"?new Promise(resolve=>{finish=resolve;}):base(command,p));
  await act(async()=>root.render(<CodexContentScan tagId="focus"/>));await click();
  const polls=()=>invoke.mock.calls.filter(([,p])=>p?.args?.action==="scan_status").length;
  expect(polls()).toBe(1);
  await act(async()=>visibility({payload:{...shown,revision:"2",visible:false}}));
  await act(async()=>vi.advanceTimersByTimeAsync(15000));expect(polls()).toBe(1);
  expect(host.textContent).toContain("模型正在逐篇检查");
  expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="scan_generate")).toHaveLength(1);
  await act(async()=>visibility({payload:{...shown,revision:"3"}}));
  expect(polls()).toBe(2);
  await act(async()=>root.render(null));const atUnmount=polls();
  await act(async()=>vi.advanceTimersByTimeAsync(15000));expect(polls()).toBe(atUnmount);expect(unlisten).toHaveBeenCalledOnce();
  await act(async()=>finish({run,submitted:[],unjudged:[],errors:[],pauseReason:"",coverage:"",newEntitiesRead:2,newCharsRead:500}));
  expect(polls()).toBe(atUnmount);
  expect(invoke.mock.calls.some(([,p])=>p?.args?.action?.includes("cancel"))).toBe(false);
});
