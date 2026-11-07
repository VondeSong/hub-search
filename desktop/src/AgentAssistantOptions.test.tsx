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
beforeEach(()=>{resetCodexSuiteForTests();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset().mockResolvedValue({models:[{id:"real-model",name:"实际模型",reasoningLevels:["low","high"],defaultReasoning:"high"}]});save.mockReset();save.mockResolvedValue();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function render(section:"model"|"permissions"|"connection"="model",canAuto=true,value:AssistantOptions=defaultAssistantOptions,disabled=false){await act(async()=>root.render(<AgentAssistantOptions section={section} value={value} disabled={disabled} canAuto={canAuto} onSave={save}/>));}
const button=(text:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent?.includes(text))!;

it("labels omitted reasoning as default and resetting never claims an explicit catalog effort",async()=>{
 const options:AssistantOptions={model:{provider:"codex",model:"real-model",reasoningEffort:"",fast:false,maxConcurrent:2},autoFlashcardInbox:false};
 await render("model",true,options);await open();
 expect(host.querySelector("summary")?.textContent).toContain("实际模型 · 默认");
 expect(host.querySelector('[aria-label="推理强度"]')?.getAttribute("aria-valuetext")).toBe("默认");
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="恢复模型默认推理强度"]')!.click());
 expect(save).toHaveBeenLastCalledWith(options);
 expect(host.querySelector('.agent-effort-heading strong')?.textContent).toBe("默认");
});
async function click(text:string){await act(async()=>button(text).click());}
async function open(){await act(async()=>{const d=host.querySelector("details")!;d.open=true;d.dispatchEvent(new Event("toggle"));});}
it("preloads the actual catalog and reuses it on opening, then saves only this conversation",async()=>{
 await render();expect(host.querySelector("summary")?.textContent).toContain("actual-global");expect(invoke).toHaveBeenCalledTimes(1);
 await open();expect(invoke).toHaveBeenCalledWith("model_runtime",{args:{action:"models",provider:"codex"}});
 expect(invoke).toHaveBeenCalledTimes(1);
 await click("实际模型");expect(save).toHaveBeenCalledExactlyOnceWith({model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:false,maxConcurrent:2},autoFlashcardInbox:false});
 expect(invoke.mock.calls.every(([,a])=>a.args.action!=="save")).toBe(true);
});
it("stages expanded saving permission until explicit confirmation, and hides it for reading sources",async()=>{
 await render("permissions");await click("自动导入闪卡收件箱");
 expect(save).not.toHaveBeenCalled();expect(host.textContent).toContain("仍需审核后才能复习");
 await click("确认本对话的自动导入授权");expect(save).toHaveBeenCalledExactlyOnceWith({model:null,autoFlashcardInbox:true});
 await render("permissions",false);expect(button("自动导入闪卡收件箱")).toBeUndefined();
});
it("keeps model on catalog failure and offers retry",async()=>{
 invoke.mockRejectedValue(new Error("目录暂不可用"));await render();await open();
 expect(host.querySelector('[role="alert"]')?.textContent).toContain("目录暂不可用");expect(save).not.toHaveBeenCalled();
 expect(host.querySelector("summary")?.textContent).toContain("actual-global");
 invoke.mockResolvedValue({models:[{id:"available",name:"可用"}]});await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="刷新可用模型"]')!.click());
 expect(host.textContent).toContain("可用");expect(host.querySelector('[role="alert"]')).toBeNull();
});
it("dismisses without changing settings and restores focus",async()=>{
 await render("permissions");const details=host.querySelector("details")!,summary=host.querySelector("summary")!;
 await open();await act(async()=>{summary.focus();host.querySelector<HTMLButtonElement>('[aria-label="关闭对话设置"]')!.click();});
 expect(details.open).toBe(false);expect(document.activeElement).toBe(summary);
 await open();await act(async()=>{summary.focus();summary.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));});
 expect(details.open).toBe(false);expect(document.activeElement).toBe(summary);
 await open();await act(async()=>document.body.dispatchEvent(new Event("pointerdown",{bubbles:true})));expect(details.open).toBe(false);expect(save).not.toHaveBeenCalled();
});
it("keeps the menu and current model on failed save",async()=>{
 await render();await open();save.mockRejectedValueOnce(new Error("保存失败"));await click("实际模型");
 expect(host.querySelector("details")!.open).toBe(true);expect(host.textContent).toContain("保存失败");expect(host.querySelector("summary")?.textContent).toContain("actual-global");
 await click("实际模型");expect(host.querySelector("details")!.open).toBe(false);
});
it("provider tab is browsing only; disabled model choices cannot apply",async()=>{
 await render("model",true,defaultAssistantOptions,true);await open();await click("Codex");await click("DeepSeek");
 expect(host.textContent).toContain("暂仅支持文字分析");expect(save).not.toHaveBeenCalled();await click("实际模型");expect(save).not.toHaveBeenCalled();
});
it("MCP remains explicit and absent from the regular model picker",async()=>{
 await render();expect(host.textContent).not.toContain("工具连接");await render("connection");
 const select=host.querySelector("select")!;await act(async()=>{select.value="mcp";select.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(save).not.toHaveBeenCalled();expect(host.textContent).toContain("累计预算");await click("应用到本对话");expect(save).toHaveBeenLastCalledWith({model:null,autoFlashcardInbox:false,externalMcp:true});
});
it("returns to inherited settings without replacing other options",async()=>{
 await render("model",true,{model:{model:"local",provider:"codex",reasoningEffort:"high",fast:false,maxConcurrent:2},autoFlashcardInbox:true,externalMcp:true});
 await click("默认");expect(save).toHaveBeenCalledWith({model:null,autoFlashcardInbox:true,externalMcp:true});
});

it.each(["pointer","keyboard"])("changes supported reasoning with one %s commit without reloading or changing global settings",async method=>{
 await render("model",true,{model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:true,maxConcurrent:2},autoFlashcardInbox:false});const count=invoke.mock.calls.length;
 await act(async()=>{const d=host.querySelector<HTMLDetailsElement>(".agent-option-model")!;d.open=true;d.dispatchEvent(new Event("toggle"));});
 const range=host.querySelector<HTMLInputElement>('[aria-label="推理强度"]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(range,"0");range.dispatchEvent(new Event("input",{bubbles:true}));});
 expect(save).not.toHaveBeenCalled();await act(async()=>range.dispatchEvent(method==="pointer"?new Event("pointerup",{bubbles:true}):new KeyboardEvent("keyup",{key:"ArrowLeft",bubbles:true})));
 expect(save).toHaveBeenCalledExactlyOnceWith({model:{provider:"codex",model:"real-model",reasoningEffort:"low",fast:true,maxConcurrent:2},autoFlashcardInbox:false});
 expect(invoke.mock.calls.length).toBe(count);expect(host.querySelector<HTMLDetailsElement>(".agent-option-model")!.open).toBe(true);
});

it("does not fetch again after closing, reopening or starting another conversation",async()=>{
 await render();await open();await act(async()=>{host.querySelector("details")!.open=false;});await open();
 await act(async()=>root.unmount());root=createRoot(host);await render();await open();
 expect(invoke).toHaveBeenCalledTimes(1);expect(host.textContent).toContain("实际模型");
});

it("keeps a cached list usable after a failed refresh and never hides the effective model",async()=>{
 await render();await open();invoke.mockRejectedValueOnce(new Error("连接暂不可用"));
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="刷新可用模型"]')!.click());
 expect(host.textContent).toContain("保留上次模型列表");expect(button("实际模型")).toBeDefined();expect(host.querySelector("summary")?.textContent).toContain("actual-global");expect(save).not.toHaveBeenCalled();
});

it("restores the saved reasoning value when saving fails, then allows retry",async()=>{
 await render("model",true,{model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:false,maxConcurrent:2},autoFlashcardInbox:false});
 await act(async()=>{const d=host.querySelector<HTMLDetailsElement>(".agent-option-model")!;d.open=true;d.dispatchEvent(new Event("toggle"));});
 const range=host.querySelector<HTMLInputElement>('[aria-label="推理强度"]')!;
 save.mockRejectedValueOnce(new Error("保存失败"));
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(range,"0");range.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>range.dispatchEvent(new Event("pointerup",{bubbles:true})));
 expect(range.value).toBe("1");expect(range.getAttribute("aria-valuetext")).toBe("高");
 expect(host.querySelector('.agent-effort-menu [role="alert"]')?.textContent).toContain("保存失败");
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(range,"0");range.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>range.dispatchEvent(new Event("pointerup",{bubbles:true})));
 expect(save).toHaveBeenCalledTimes(2);expect(range.value).toBe("0");
});
it("Escape during text composition does not dismiss preferences",async()=>{
 await render("permissions");await open();const summary=host.querySelector("summary")!;
 await act(async()=>{summary.focus();summary.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",isComposing:true,bubbles:true}));});
 expect(host.querySelector("details")!.open).toBe(true);expect(save).not.toHaveBeenCalled();
});

it("uses one trigger for model and effort and navigates between both pages",async()=>{
 await render("model",true,{model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:false,maxConcurrent:2},autoFlashcardInbox:false});await open();
 expect(host.querySelectorAll("details > summary")).toHaveLength(1);
 expect(host.querySelector("summary")?.textContent).toContain("实际模型 · 高");
 expect(host.querySelector('[aria-label="推理强度"]')).not.toBeNull();
 await click("实际模型");expect(button("返回推理设置")).toBeDefined();expect(save).not.toHaveBeenCalled();
 await click("返回推理设置");expect(host.querySelector('[aria-label="推理强度"]')).not.toBeNull();
});

it("reference fast toggle preserves model and effort and saves only this conversation",async()=>{
 await render("model",true,{model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:false,maxConcurrent:2},autoFlashcardInbox:false});await open();
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="快速模式"]')!.click());
 expect(save).toHaveBeenCalledExactlyOnceWith({model:{provider:"codex",model:"real-model",reasoningEffort:"high",fast:true,maxConcurrent:2},autoFlashcardInbox:false});
 expect(host.querySelector("details")!.open).toBe(true);
 expect(host.querySelectorAll(".agent-effort-ticks span")).toHaveLength(2);
});
