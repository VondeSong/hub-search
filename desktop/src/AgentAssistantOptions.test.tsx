// @vitest-environment jsdom
import { act } from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentAssistantOptions,defaultAssistantOptions,type AssistantOptions} from "./AgentAssistantOptions";
import {resetCodexSuiteForTests} from "./CodexSuite";
const {invoke,runtime}=vi.hoisted(()=>({invoke:vi.fn(),runtime:{loaded:true,loading:false,settings:{provider:"codex",model:"actual-global",reasoningEffort:"high",fast:false,maxConcurrent:2}}}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("./CodexSuite",async importOriginal=>({...await importOriginal<object>(),useCodexSuite:()=>runtime}));
let host:HTMLDivElement,root:Root;
const save=vi.fn(async()=>{});
beforeEach(()=>{resetCodexSuiteForTests();localStorage.clear();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset().mockImplementation(async (_command,{args})=>({models:[{id:"real-model",name:"实际模型",reasoningLevels:["low","high"],defaultReasoning:"high",fastDescription:"提供方支持 Fast"}].map(model=>args.provider==="deepseek"?{...model,id:"deepseek-real",name:"DeepSeek 实际模型"}:model)}));save.mockReset();save.mockResolvedValue();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function render(section:"model"|"connection"="model",canAuto=true,value:AssistantOptions=defaultAssistantOptions,disabled=false){await act(async()=>root.render(<AgentAssistantOptions section={section} value={value} disabled={disabled} canAuto={canAuto} onSave={save}/>));}
const button=(text:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent?.includes(text)&&!b.textContent?.includes("DeepSeek"))!;
const workspaceFields=()=>[...host.querySelectorAll('.agent-connection-explanation input[type="checkbox"]')].filter(input=>/独立工作区|工作区子任务/.test(input.closest("label")?.textContent??"")) as HTMLInputElement[];
const modelSummary=()=>host.querySelector<HTMLElement>(".agent-option-model > summary")!;
const modelDetails=()=>host.querySelector<HTMLDetailsElement>(".agent-option-model")!;

it("shows the actual default level while resetting preserves an omitted override",async()=>{
 const options:AssistantOptions={model:{provider:"codex",model:"real-model",reasoningEffort:"",fast:false,maxConcurrent:2},autoFlashcardInbox:false};
 await render("model",true,options);await open("effort");
 expect(modelSummary().textContent).toBe("实际模型");expect(host.querySelector('.agent-effort-levels [aria-pressed=true]')?.textContent).toContain("高");
 await click("跟随模型默认");expect(save).toHaveBeenLastCalledWith(options);
});
async function click(text:string){await act(async()=>button(text).click());}
it("grants workspace and delegation only after applying and revokes them together",async()=>{
 await render("connection");
 const fields=workspaceFields;
 expect(fields()).toHaveLength(2);expect(fields()[1].disabled).toBe(true);
 await act(async()=>fields()[0].click());expect(save).not.toHaveBeenCalled();
 await act(async()=>fields()[1].click());await click("应用到本对话");
 expect(save).toHaveBeenLastCalledWith({...defaultAssistantOptions,nativeCapabilities:{workspace:true,multiAgent:true}});
 await render("connection",true,{...defaultAssistantOptions,nativeCapabilities:{workspace:true,multiAgent:true}});
 await act(async()=>fields()[0].click());await click("应用到本对话");
 expect(save).toHaveBeenLastCalledWith(defaultAssistantOptions);
});
async function open(which:"model"|"effort"="model"){await act(async()=>{const d=host.querySelector<HTMLDetailsElement>(`.agent-option-${which}`)||host.querySelector("details")!;d.open=true;d.dispatchEvent(new Event("toggle"));});}
it("preloads the actual catalog and reuses it on opening, then saves only this conversation",async()=>{
 await render();expect(modelSummary().textContent).toContain("actual-global");expect(invoke).toHaveBeenCalledTimes(2);
 await open();expect(invoke).toHaveBeenCalledWith("model_runtime",{args:{action:"models",provider:"codex"}});
 expect(invoke).toHaveBeenCalledTimes(2);
 await click("实际模型");expect(save).toHaveBeenCalledExactlyOnceWith({model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:false,maxConcurrent:2},autoFlashcardInbox:false});
 expect(invoke.mock.calls.every(([,a])=>a.args.action!=="save")).toBe(true);
});
it("keeps model on catalog failure and offers retry",async()=>{
 invoke.mockRejectedValue(new Error("目录暂不可用"));await render();await open();
 expect(host.querySelector('[role="alert"]')?.textContent).toContain("目录暂不可用");expect(save).not.toHaveBeenCalled();
 expect(modelSummary().textContent).toContain("actual-global");
 invoke.mockResolvedValue({models:[{id:"available",name:"可用"}]});await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="刷新可用模型"]')!.click());
 expect(host.textContent).toContain("可用");expect(host.querySelector('[role="alert"]')).toBeNull();
});
it("keeps the menu and current model on failed save",async()=>{
 await render();await open();save.mockRejectedValueOnce(new Error("保存失败"));await click("实际模型");
 expect(modelDetails().open).toBe(true);expect(host.textContent).toContain("保存失败");expect(modelSummary().textContent).toContain("actual-global");
 await click("实际模型");expect(modelDetails().open).toBe(true);
 expect(host.querySelector('[role="alert"]')).toBeNull();
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="关闭模型选择"]')!.click());
 expect(modelDetails().open).toBe(false);expect(document.activeElement).toBe(modelSummary());
});
it("groups providers without applying disabled choices",async()=>{
 await render("model",true,defaultAssistantOptions,true);await open();expect(host.querySelector('[aria-label="OpenAI 模型"]')).not.toBeNull();expect(host.querySelector('[aria-label="DeepSeek 模型"]')).not.toBeNull();await click("实际模型");expect(save).not.toHaveBeenCalled();
});
it("MCP remains explicit and absent from the regular model picker",async()=>{
 await render();expect(host.textContent).not.toContain("Hub 工具调用方式");
 await render("connection",true,{...defaultAssistantOptions,webSearch:"cached"});
 const diagnostics=host.querySelector<HTMLDetailsElement>(".agent-diagnostics")!;
 expect(diagnostics.open).toBe(false);
 const select=diagnostics.querySelector("select")!;
 expect(select.value).toBe("native");
 await act(async()=>{diagnostics.open=true;select.value="mcp";select.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(save).not.toHaveBeenCalled();expect(host.textContent).toContain("累计预算");
 await click("应用到本对话");
 expect(save).toHaveBeenLastCalledWith({...defaultAssistantOptions,webSearch:"cached",externalMcp:true});
});
it("revokes native grants in the draft when selecting the alternative MCP channel",async()=>{
 await render("connection",true,{...defaultAssistantOptions,nativeCapabilities:{workspace:true,multiAgent:true}});
 const select=host.querySelector<HTMLSelectElement>(".agent-diagnostics select")!;
 await act(async()=>{select.value="mcp";select.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(save).not.toHaveBeenCalled();
 expect(workspaceFields().every(field=>!field.checked&&field.disabled)).toBe(true);
 await click("应用到本对话");expect(save).toHaveBeenLastCalledWith({...defaultAssistantOptions,externalMcp:true});
 await act(async()=>{select.value="native";select.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(workspaceFields().every(field=>!field.checked)).toBe(true);
});
it("returns to inherited settings without replacing other options",async()=>{
 await render("model",true,{model:{model:"local",provider:"codex",reasoningEffort:"high",fast:false,maxConcurrent:2},autoFlashcardInbox:true,externalMcp:true});
 await click("跟随全局模型设置");expect(save).toHaveBeenCalledWith({model:null,autoFlashcardInbox:true,externalMcp:true});
});

it("chooses a supported effort once without changing global settings",async()=>{
 await render("model",true,{model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:true,maxConcurrent:2},autoFlashcardInbox:false});const count=invoke.mock.calls.length;await open("effort");
 await act(async()=>host.querySelector<HTMLButtonElement>('.agent-effort-levels button')!.click());expect(save).toHaveBeenCalledExactlyOnceWith({model:{provider:"codex",model:"real-model",reasoningEffort:"low",fast:true,maxConcurrent:2},autoFlashcardInbox:false});expect(invoke.mock.calls.length).toBe(count);
});

it("does not fetch again after closing, reopening or starting another conversation",async()=>{
 await render();await open();await act(async()=>{modelDetails().open=false;});await open();
 await act(async()=>root.unmount());root=createRoot(host);await render();await open();
 expect(invoke).toHaveBeenCalledTimes(2);expect(host.textContent).toContain("实际模型");
});

it("keeps a cached list usable after a failed refresh and never hides the effective model",async()=>{
 await render();await open();invoke.mockRejectedValueOnce(new Error("连接暂不可用"));
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="刷新可用模型"]')!.click());
 expect(host.textContent).toContain("连接暂不可用");expect(button("实际模型")).toBeDefined();expect(modelSummary().textContent).toContain("actual-global");expect(save).not.toHaveBeenCalled();
});

it("keeps the accepted effort selected on failed save and allows retry",async()=>{
 await render("model",true,{model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:false,maxConcurrent:2},autoFlashcardInbox:false});await open("effort");save.mockRejectedValueOnce(new Error("保存失败"));const choice=host.querySelector<HTMLButtonElement>('.agent-effort-levels button')!;
 await act(async()=>choice.click());expect(host.querySelector('.agent-effort-levels [aria-pressed=true]')?.textContent).toContain("高");expect(host.querySelector('.agent-effort-menu [role="alert"]')?.textContent).toContain("保存失败");await act(async()=>choice.click());expect(save).toHaveBeenCalledTimes(2);
});
it("uses adjacent independent model and effort triggers without changing settings",async()=>{
 await render("model",true,{model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:false,maxConcurrent:2},autoFlashcardInbox:false});await open();
 expect(host.querySelectorAll("details:not([hidden]) > summary")).toHaveLength(2);
 expect(modelSummary().textContent).toBe("实际模型");
 expect(modelDetails().open).toBe(true);
 await open("effort");
 expect(modelDetails().open).toBe(false);expect(host.querySelector<HTMLDetailsElement>(".agent-option-effort")!.open).toBe(true);
 expect(host.querySelector('[aria-label="推理强度"]')).not.toBeNull();expect(save).not.toHaveBeenCalled();
});

it("reference fast toggle preserves model and effort and saves only this conversation",async()=>{
 await render("model",true,{model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:false,maxConcurrent:2},autoFlashcardInbox:false});await open("effort");
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="快速模式"]')!.click());
 expect(save).toHaveBeenCalledExactlyOnceWith({model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:true,maxConcurrent:2},autoFlashcardInbox:false});
 expect(host.querySelector<HTMLDetailsElement>(".agent-option-effort")!.open).toBe(true);
 expect(host.querySelectorAll(".agent-effort-levels button")).toHaveLength(2);
});
