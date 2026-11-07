// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentActivity,type ActivityRun} from "./AgentActivity";
import {AgentConversation,type Report} from "./AgentDelivery";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
let host:HTMLDivElement,root:Root;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const activity=(text:string):ActivityRun=>({runId:"failed",revision:1,state:"failed",running:false,startedAt:1,finishedAt:2000,steps:0,events:[{id:"answer",kind:"unpublishedAnswer",state:"unverified",label:text,createdAt:2}]});
async function expand(){const details=host.querySelector<HTMLDetailsElement>("details.agent-tool-result")!;await act(async()=>{details.open=true;details.dispatchEvent(new Event("toggle"));});}
it("CN05 unverified final is findable while process is collapsed and renders only on demand",async()=>{
 const text="中🙂".repeat(17000)+"完整尾句";await act(async()=>root.render(<AgentActivity value={activity(text)}/>));
 expect(host.textContent).toContain("查看未发布的模型答复");expect(host.querySelector("pre")).toBeNull();await expand();
 expect(host.querySelector("pre")!.textContent).toBe(text);expect(host.textContent).toContain("不代表操作已执行或目标已完成");
});
it("CN05 unverified text cannot load images, execute HTML or activate links",async()=>{
 const text='<script>alert(1)</script> ![image](https://example.org/x) [link](https://example.org/)';await act(async()=>root.render(<AgentActivity value={activity(text)}/>));await expand();
 expect(host.querySelector("pre")!.textContent).toBe(text);expect(host.querySelector("script,img,a")).toBeNull();
});
it("CN05 valid long published answers preserve their tail in restored conversation",async()=>{
 const text="正常答复。".repeat(6000)+"最终句完整保留";const report:Report={status:"completed",summary:text,findings:[],nextSteps:[],questions:[],limitations:[],waitCondition:"",prose:{markdown:text,citations:[]}};
 await act(async()=>root.render(<AgentConversation conversation={{messages:[{id:"saved",role:"assistant",runId:"run",createdAt:1,report}],hasEarlier:false}} revoked={false} onOpenCitation={vi.fn()}/>));
 expect(host.querySelector(".agent-answer")!.textContent).toBe(text);expect(host.textContent).not.toContain("未发布");
});
it("CN05 explicit progress clipping notice remains visible",async()=>{
 const value=activity("");value.events=[{id:"progress",kind:"message",state:"completed",label:"已展示的过程。\n\n（过程消息超过显示上限，后续内容未展示。）",createdAt:1}];await act(async()=>root.render(<AgentActivity value={value}/>));
 expect(host.textContent).toContain("后续内容未展示");expect(host.textContent).not.toContain("查看未发布");
});
