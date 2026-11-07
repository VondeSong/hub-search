// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AgentNativeInput, type NativeInput } from "./AgentNativeInput";

let host:HTMLDivElement,root:Root;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const value:NativeInput={key:"request-key",runId:"run",state:"pending",isBlocking:true,questions:[{id:"scope",header:"范围",question:"使用哪些材料？",isOther:true,options:[{label:"已选材料",description:"使用当前授权的材料"},{label:"仅当前笔记",description:"缩小读取范围"}]}]};
it.each([ ["answered","回复已保存，等待发送"], ["sent","回复已发送，等待助手处理"] ] as const)("core_input distinguishes persisted and sent answers (%s)",async(state,label)=>{
 const answer=vi.fn();await act(async()=>root.render(<AgentNativeInput value={{...value,state}} disabled={false} onAnswer={answer}/>));
 expect(host.querySelector("summary")?.textContent).toBe(label);expect(host.querySelector("form")).toBeNull();expect(answer).not.toHaveBeenCalled();
});
async function choose(text:string){await act(async()=>{const select=host.querySelector("select")!;select.value=text;select.dispatchEvent(new Event("change",{bubbles:true}));});}
async function write(text:string){await act(async()=>{const input=host.querySelector("textarea")!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,text);input.dispatchEvent(new Event("input",{bubbles:true}));});}
function button(label:string){return Array.from(host.querySelectorAll("button")).find(b=>b.textContent===label)!;}

it("CN03 requires an explicit choice and maps it to the native question id",async()=>{
 const answer=vi.fn().mockResolvedValue(undefined);await act(async()=>root.render(<AgentNativeInput value={value} disabled={false} onAnswer={answer}/>));
 expect(host.querySelector("select")!.value).toBe("");expect(button("提交回答").disabled).toBe(true);expect(answer).not.toHaveBeenCalled();
 await choose("1");expect(document.getElementById(host.querySelector("select")!.getAttribute("aria-describedby")!)?.textContent).toBe("缩小读取范围");expect(host.textContent).toContain("缩小读取范围");await act(async()=>button("提交回答").click());expect(answer).toHaveBeenCalledExactlyOnceWith({scope:"仅当前笔记"},false);expect(host.textContent).toContain("回复已保存");expect(host.querySelector("form")).toBeNull();
});
it("CN03 supports custom and free text without inventing answers",async()=>{
 const answer=vi.fn().mockResolvedValue(undefined);await act(async()=>root.render(<AgentNativeInput value={value} disabled={false} onAnswer={answer}/>));
 await choose("custom");expect(button("提交回答").disabled).toBe(true);await write("只比较两份已选材料");await act(async()=>button("提交回答").click());expect(answer).toHaveBeenCalledWith({scope:"只比较两份已选材料"},false);
 await act(async()=>root.render(<AgentNativeInput key="new" value={{...value,key:"new",questions:[{id:"goal",header:"目标",question:"需要什么结果？"}]}} disabled={false} onAnswer={answer}/>));
 expect(host.querySelector("select")).toBeNull();expect(host.querySelector("textarea")!.maxLength).toBe(700);expect(button("提交回答").disabled).toBe(true);
});
it("CN03 cancel sends an empty answer map and repeated clicks do not submit twice",async()=>{
 let finish!:()=>void;const answer=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));await act(async()=>root.render(<AgentNativeInput value={value} disabled={false} onAnswer={answer}/>));
 const cancel=button("暂不回答");await act(async()=>{cancel.click();cancel.click();});expect(answer).toHaveBeenCalledExactlyOnceWith({},true);expect(host.querySelectorAll("button:disabled")).toHaveLength(2);await act(async()=>finish());expect(host.textContent).toContain("回复已保存");expect(host.textContent).not.toContain("回答已保存");
});
it("CN03 rejected submissions retain the answer and allow a deliberate retry",async()=>{
 const answer=vi.fn().mockRejectedValueOnce(new Error("提交未完成，请重试")).mockResolvedValue(undefined);await act(async()=>root.render(<AgentNativeInput value={value} disabled={false} onAnswer={answer}/>));
 await choose("0");await act(async()=>button("提交回答").click());expect(host.querySelector('[role="alert"]')?.textContent).toContain("请重试");expect(host.querySelector("select")!.value).toBe("0");await act(async()=>button("提交回答").click());expect(answer).toHaveBeenCalledTimes(2);
});
it("CN03 closing a request removes answer controls and explains how to continue",async()=>{
 const answer=vi.fn();await act(async()=>root.render(<AgentNativeInput value={value} disabled={false} onAnswer={answer}/>));await choose("0");
 await act(async()=>root.render(<AgentNativeInput value={{...value,state:"closed"}} disabled={false} onAnswer={answer}/>));expect(host.querySelector("button")).toBeNull();expect(host.textContent).toContain("请发送新消息");expect(answer).not.toHaveBeenCalled();
});

it.each([false,true])("keeps keyboard focus after saving without stealing from another control (%s)",async moved=>{
 let finish!:()=>void;const answer=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 await act(async()=>root.render(<AgentNativeInput value={value} disabled={false} onAnswer={answer}/>));
 const outside=document.createElement("button");document.body.append(outside);
 try {
  await act(async()=>{button("暂不回答").focus();button("暂不回答").click();});
  if(moved)outside.focus();
  await act(async()=>finish());
  expect(document.activeElement).toBe(moved?outside:host.querySelector("summary"));
 } finally {outside.remove();}
});
