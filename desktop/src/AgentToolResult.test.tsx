// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AgentToolResult, type ToolResultScope } from "./AgentToolResult";
import { AgentActivity } from "./AgentActivity";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
let host:HTMLDivElement,root:Root;
const ref={recordId:"record",sha256:"a".repeat(64),utf8Bytes:12000};
const scope:ToolResultScope={workId:"work",currentWorkRevision:7,authorizationVersion:2};
const mock=vi.mocked(invoke);
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);mock.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
function page(content:string,start=0,total=Array.from(content).length){const end=start+Array.from(content).length;return {kind:"historicalToolResult",recordId:ref.recordId,sha256:ref.sha256,content,startChar:start,endChar:end,totalChars:total,nextStartChar:end<total?end:null,historical:true,currentEvidence:false};}
function button(text:string){const found=Array.from(host.querySelectorAll("button")).find(b=>b.textContent===text);if(!found)throw new Error("missing "+text);return found;}
async function render(s=scope){await act(async()=>root.render(<AgentToolResult value={ref} scope={s}/>));}
async function click(text:string){await act(async()=>button(text).click());}
async function showTechnical(){
  const disclosure=host.querySelector<HTMLDetailsElement>("details")!;
  expect(disclosure.open).toBe(false);
  expect(host.querySelector("pre")).toBeNull();
  await act(async()=>{disclosure.open=true;disclosure.dispatchEvent(new Event("toggle"));});
}

it("reads complete material through the authorized read-only entry and renders plain text",async()=>{
  mock.mockResolvedValue(page('<script>do not execute</script> 历史🙂'));
  await render();await click("查看完整工具记录");
  expect(mock).toHaveBeenCalledExactlyOnceWith("agent_investigation",{args:{action:"readToolResult",id:"work",expectedWorkRevision:7,expectedAuthorizationVersion:2,recordId:"record",expectedSha256:ref.sha256,startChar:0,maxChars:4000}});
  await showTechnical();
  expect(host.querySelector("pre")?.textContent).toContain("<script>");expect(host.querySelector("script")).toBeNull();
  button("返回工作过程").focus();await click("返回工作过程");
  expect(host.querySelector("pre")).toBeNull();expect(document.activeElement).toBe(button("查看完整工具记录"));
});
it("uses bounded Unicode pagination and retains the current authorization for each page",async()=>{
  mock.mockResolvedValueOnce(page("🙂".repeat(4000),0,4005)).mockResolvedValueOnce(page("尾部🙂文字",4000,4005)).mockResolvedValueOnce(page("🙂".repeat(4000),0,4005));
  await render();await click("查看完整工具记录");await showTechnical();await click("下一段");
  expect(mock.mock.calls[1][1]).toMatchObject({args:{startChar:4000,maxChars:4000,expectedWorkRevision:7}});
  expect(button("下一段").disabled).toBe(true);expect(host.querySelector("pre")?.textContent).toBe("尾部🙂文字");
  await click("上一段");expect(mock.mock.calls[2][1]).toMatchObject({args:{startChar:0}});
});
it("discards delayed text after closing or changing Work authorization",async()=>{
  let resolve!:(v:unknown)=>void;mock.mockReturnValue(new Promise(r=>{resolve=r}));
  await render();await click("查看完整工具记录");await click("返回工作过程");
  await act(async()=>resolve(page("must stay hidden")));expect(host.textContent).not.toContain("must stay hidden");
  mock.mockReturnValue(new Promise(r=>{resolve=r}));await click("查看完整工具记录");
  await render({...scope,authorizationVersion:3});await act(async()=>resolve(page("old authorization secret")));
  expect(host.textContent).not.toContain("old authorization secret");expect(host.querySelector("pre")).toBeNull();
});
it("hides the previous page on an actual source failure and does not run a business action",async()=>{
  mock.mockResolvedValueOnce(page("x".repeat(4000),0,4010)).mockRejectedValueOnce("来源已变化，未返回正文");
  await render();await click("查看完整工具记录");await showTechnical();await click("下一段");
  expect(host.querySelector("pre")).toBeNull();expect(host.querySelector('[role="alert"]')?.textContent).toContain("来源已变化");
  expect(mock.mock.calls.every(([,args])=>(args as {args:{action:string}}).args.action==="readToolResult")).toBe(true);
});
it("rejects mismatched identity or impossible range rather than showing the payload",async()=>{
  mock.mockResolvedValue({...page("wrong record"),recordId:"different"});await render();await click("查看完整工具记录");
  expect(host.querySelector("pre")).toBeNull();expect(host.textContent).toContain("记录身份或读取范围不一致");
  mock.mockResolvedValue({...page("broken page"),nextStartChar:0});await click("重新核对记录");
  expect(host.querySelector("pre")).toBeNull();expect(host.textContent).toContain("记录身份或读取范围不一致");
});
it("offers expansion only for a complete result with the current Work scope",async()=>{
  const base={runId:"r",revision:1,state:"completed",running:false,startedAt:1,finishedAt:1,steps:1,events:[{id:"1",kind:"tool" as const,state:"completed",label:"读取原文",createdAt:1,resultRef:ref}]};
  await act(async()=>root.render(<AgentActivity value={{...base,...scope}}/>));await act(async()=>host.querySelector<HTMLButtonElement>(".agent-activity-toggle")!.click());
  expect(button("查看完整工具记录")).toBeTruthy();
  await act(async()=>root.render(<AgentActivity value={{...base,...scope,validity:"来源已变化"}}/>));
  expect(Array.from(host.querySelectorAll("button")).some(b=>b.textContent==="查看完整工具记录")).toBe(false);
});

it("shows the authorized source separately from collapsed technical JSON",async()=>{
 mock.mockResolvedValue({...page('{"metadata":true}'),sourcePreview:{title:"原文标题",content:"<script>正文</script>",totalChars:19,truncated:false}});
 await render();await click("查看完整工具记录");
 expect(host.querySelector('[aria-label="读取的原文片段"]')?.textContent).toContain("原文标题");
 expect(host.querySelector('details')?.open).toBe(false);
 expect(host.querySelector('script')).toBeNull();
 expect(host.querySelector("pre")).toBeNull();
});

it("renders historical skill instructions as Markdown without executing links or confusing them with evidence",async()=>{
 mock.mockResolvedValue({...page('{"kind":"skillInstructions"}'),methodPreview:{title:"资料分析与核对",content:"**核对来源**\n\n- Hub 原文使用编号\n- 网页使用链接\n\n<script>unsafe</script>![image](https://example.org/a.png)[open](javascript:alert(1))",totalChars:150,truncated:false}});
 await render();await click("查看完整工具记录");
 const preview=host.querySelector('[aria-label="读取的技能说明"]')!;
 expect(preview.querySelector('strong')?.textContent).toBe('资料分析与核对');
 expect(preview.querySelectorAll('li')).toHaveLength(2);
 expect(preview.textContent).toContain('不代表已核对事实');
 expect(host.querySelector('details')?.open).toBe(false);
 expect(host.querySelector('[aria-label="读取的原文片段"]')).toBeNull();
 expect(preview.querySelector('script,img,a')).toBeNull();
 await render({...scope,authorizationVersion:3});
 expect(host.querySelector('[aria-label="读取的技能说明"]')).toBeNull();
});
