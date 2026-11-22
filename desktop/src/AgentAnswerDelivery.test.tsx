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
it("keeps answer actions beside copy, bound to each historical answer without an author banner",async()=>{
 const chosen=vi.fn();
 const messages=['first','second'].map(id=>({id,role:'assistant' as const,runId:id,createdAt:1,report:{status:'completed',summary:id,findings:[],nextSteps:[],questions:[],limitations:[],waitCondition:'',prose:{markdown:id,citations:[]}}}));
 await act(async()=>root.render(<AgentConversation conversation={{messages,hasEarlier:false}} revoked={false} onOpenCitation={vi.fn()} renderActions={message=><div className="agent-answer-destinations"><button onClick={()=>chosen(message.runId)}>插入页面</button></div>}/>));
 expect(host.querySelector('.agent-message-author')).toBeNull();
 const toolbars=host.querySelectorAll('.agent-answer-toolbar');expect(toolbars).toHaveLength(2);
 expect(toolbars[1].querySelector('[aria-label="复制回答"]')).not.toBeNull();
 await act(async()=>toolbars[1].querySelector<HTMLButtonElement>('.agent-answer-destinations button')!.click());
 expect(chosen).toHaveBeenCalledExactlyOnceWith('second');
});
it("lists each available source once while inline citations retain their own quote",async()=>{
 const source={title:"装配说明",sourcePath:"工程/装配说明",content:"评审稿与版本记录",startChar:0,endChar:8,totalChars:8,truncated:false};
 const report:Report={status:"completed",summary:"核对版本",findings:[],nextSteps:[],questions:[],limitations:[],waitCondition:"",
  prose:{markdown:"依据 [1] 和 [2]。失效引用 [3]。",citations:[
   {evidenceId:"e1",quote:"评审稿"},{evidenceId:"e1",quote:"版本记录"},{evidenceId:"e2",quote:"旧来源"}
  ]}};
 const open=vi.fn();
 await act(async()=>root.render(<AgentConversation conversation={{messages:[{id:"answer",role:"assistant",runId:"run",createdAt:1,report,evidence:[source]}],hasEarlier:false}} revoked={false} onOpenCitation={open}/>));
 const sources=host.querySelector('[aria-label="回答来源"]')!;
 expect(sources.querySelectorAll("button")).toHaveLength(1);
 expect(sources.textContent).toContain("装配说明");
 await act(async()=>sources.querySelector("button")!.click());
 await act(async()=>host.querySelectorAll<HTMLButtonElement>(".agent-inline-citation")[1].click());
 expect(open.mock.calls).toEqual([["run",0,"评审稿"],["run",0,"版本记录"]]);
 expect(host.querySelectorAll<HTMLButtonElement>(".agent-inline-citation")[2].disabled).toBe(true);
});

it("copies the settled public process summary without the answer or unpublished draft",async()=>{
 const writeText=vi.fn().mockResolvedValue(undefined);
 const clipboard=Object.getOwnPropertyDescriptor(navigator,"clipboard");
 Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
 try {
  const value:ActivityRun={...activity("尚未核验的草稿"),events:[
   {id:"read",kind:"context",state:"completed",label:"已读取授权材料",createdAt:1},
   ...activity("尚未核验的草稿").events,
   {id:"final",kind:"answer",state:"completed",label:"正式回答",createdAt:3},
  ]};
  await act(async()=>root.render(<AgentActivity value={value}/>));
  await act(async()=>host.querySelector<HTMLButtonElement>(".agent-runtime-toggle")!.click());
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="复制工作过程摘要"]')!.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith("已读取授权材料");
 } finally {
  if(clipboard)Object.defineProperty(navigator,"clipboard",clipboard);
  else Reflect.deleteProperty(navigator,"clipboard");
 }
});

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
 expect(host.querySelector(".agent-answer > p")!.textContent).toBe(text);expect(host.textContent).not.toContain("未发布");
});
it.each(["legacy","metadata"])("CN05 %s progress clipping remains visible while collapsed without duplicating the expanded notice",async format=>{
 const value=activity("");value.events=[{id:"progress",kind:"message",state:"completed",label:format==="legacy"?"已展示的过程。\n\n（过程消息超过显示上限，后续内容未展示。）":"已展示的过程。",truncated:format==="metadata"?true:undefined,createdAt:1}];await act(async()=>root.render(<AgentActivity value={value}/>));
 const toggle=host.querySelector<HTMLButtonElement>('.agent-activity-toggle')!;
 expect(toggle.getAttribute('aria-expanded')).toBe('false');
 expect(host.querySelector('[aria-label="过程显示限制"][role="status"]')?.textContent).toContain("后续内容未展示");
 expect(host.textContent).not.toContain("已展示的过程");expect(host.textContent).not.toContain("查看未发布");
 await act(async()=>toggle.click());
 expect(host.textContent).toContain("已展示的过程");
 expect(host.textContent?.match(/后续内容未展示/g)).toHaveLength(1);
 await act(async()=>toggle.click());
 expect(host.textContent?.match(/后续内容未展示/g)).toHaveLength(1);
 expect(host.querySelector('.agent-activity-events')).toBeNull();
});
it("CN05 does not infer clipped progress from a normal message or a clipped answer",async()=>{
 const value=activity("");value.events=[{id:"progress",kind:"message",state:"completed",label:"过程完整展示。",createdAt:1},{id:"answer",kind:"unpublishedAnswer",state:"unverified",truncated:true,label:"只保留的答复预览",createdAt:2}];
 await act(async()=>root.render(<AgentActivity value={value}/>));
 expect(host.querySelector('[aria-label="过程显示限制"]')).toBeNull();
 expect(host.textContent).not.toContain("后续内容未展示");
 expect(host.textContent).toContain("查看未发布的模型答复");
 await expand();expect(host.textContent).toContain("仅保留了部分回答预览");
});
