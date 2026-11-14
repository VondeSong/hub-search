// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { AgentActiveTopic,AgentResearchTopics,researchGrant,type ResearchGrant,type ResearchTopic } from "./AgentResearch";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root;
const manual:ResearchGrant={libraryIds:["manual"],notes:[{kind:"note",libraryId:"a",documentId:"manual",pageId:null}],readingItemKeys:[]};
const topic:ResearchTopic={id:"topic",revision:1,title:"复用研究",pinned:true,policy:"materials-only",skills:["source-review"],grant:{libraryIds:["topic"],notes:[{kind:"note",libraryId:"a",documentId:"topic",pageId:null}],readingItemKeys:[]}};
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("keeps hand selections separate and only merges them for an explicitly included turn",()=>{
 const original=structuredClone(manual);
 expect(researchGrant(manual,topic.grant)).toEqual({...topic.grant,sources:[]});
 expect(researchGrant(manual,topic.grant,true).libraryIds).toEqual(["topic","manual"]);
 expect(manual).toEqual(original);
 const reordered={pageId:null,documentId:"manual",libraryId:"a",kind:"note" as const};
 expect(researchGrant(manual,{...manual,notes:[reordered]},true).notes).toHaveLength(1);
 expect(researchGrant(manual).libraryIds).toEqual(["manual"]);
});
it("requires confirmation after a topic loses a source and cannot apply an entirely missing scope",async()=>{
 const apply=vi.fn(async()=>{}),close=vi.fn();
 invoke.mockImplementation(async(_,{args})=>args.action==="researchTopics"?{topics:[topic]}:{grant:{libraryIds:[],notes:[],readingItemKeys:[]},unavailable:[{reason:"资料库已停用"}]});
 await act(async()=>root.render(<AgentResearchTopics open saveMode={false} config={{grant:manual,policy:"material-first",skills:[]}} disabled={false} onApply={apply} onClose={close}/>));
 await act(async()=>[...host.querySelectorAll("button")].find(b=>b.textContent?.includes(topic.title))!.click());
 expect(apply).not.toHaveBeenCalled();
 expect([...host.querySelectorAll("button")].find(b=>b.textContent?.includes("确认仅使用剩余资料"))!.disabled).toBe(true);
 expect(host.textContent).toContain("编辑专题资料范围");
 expect(host.textContent).not.toContain("用当前选择的资料修复专题");
 expect(close).not.toHaveBeenCalled();
});
it("reviews an available topic and applies only after explicit confirmation",async()=>{
 const apply=vi.fn(async()=>{}),close=vi.fn();
 invoke.mockImplementation(async(_,{args})=>args?.action==="researchTopics"?{topics:[topic]}:{grant:topic.grant,unavailable:[],changed:[],versions:[]});
 await act(async()=>root.render(<AgentResearchTopics open saveMode={false} config={{grant:manual,policy:"material-first",skills:[]}} disabled={false} onApply={apply} onClose={close}/>));
 await act(async()=>host.querySelector<HTMLButtonElement>('.agent-topic-list button')!.click());
 expect(apply).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==="应用到当前对话")!.click());
 expect(apply).toHaveBeenCalledWith(expect.objectContaining({id:topic.id,grant:topic.grant}));expect(close).toHaveBeenCalledOnce();
});
it("removes a topic source or skill locally without overwriting the saved topic or manual materials",async()=>{
 const original=structuredClone(topic),originalManual=structuredClone(manual),change=vi.fn();
 invoke.mockResolvedValue([]);
 await act(async()=>root.render(<AgentActiveTopic topic={topic} disabled={false} onChange={change} onCancel={()=>{}}/>));
 await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label^="从当前专题移除材料"]')!.click());
 expect(change.mock.calls[0][0].grant.notes).toEqual([]);
 await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label^="从当前专题移除技能"]')!.click());
 expect(change.mock.calls[1][0].skills).toEqual([]);
 expect(topic).toEqual(original);expect(manual).toEqual(originalManual);
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==='saveResearchTopic')).toBe(false);
});

function editableTopicCalls(failSave=false,failSavedReview=false,missingOriginal=false){
 let saved=false;
 invoke.mockImplementation(async(command,payload)=>{
  if(command==="list_libraries")return [{id:"topic",name:"专题库",provider:"craft"},{id:"extra",name:"扩展库",provider:"craft"},{id:"manual",name:"手选库",provider:"craft"}];
  const args=payload?.args;
  if(args?.action==="researchTopics")return {topics:[topic]};
  if(args?.action==="materials")return {notes:[{locator:topic.grant.notes[0],title:"原专题页面",path:"Topic.md",libraryName:"专题库"},{locator:{kind:"note",libraryId:"extra",documentId:"added",pageId:null},title:"新增专题页面",path:"Added.md",libraryName:"扩展库"}],total:2,nextOffset:null,snapshot:"topic-pages"};
  if(args?.action==="saveResearchTopic"){
   if(failSave)throw new Error("专题已在其他位置更新，请重新核对");
   saved=true;
   return {...args.topic,revision:2};
  }
  if(args?.action==="checkResearchTopic"){
   if(saved&&failSavedReview)throw new Error("资料版本核对失败");
   if(!saved&&missingOriginal)return {grant:{libraryIds:[],notes:[],readingItemKeys:[]},unavailable:[{reason:"原专题资料已不可用"}],changed:[],versions:[]};
   return {grant:args.topic.grant,unavailable:[],changed:[],versions:[]};
  }
  throw new Error(`Unexpected topic action ${args?.action}`);
 });
}
const findButton=(text:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent===text)!;

it("edits a separate topic scope, rechecks the saved revision, and applies only after confirmation",async()=>{
 const apply=vi.fn(async()=>{}),original=structuredClone(topic),originalManual=structuredClone(manual);
 editableTopicCalls();
 await act(async()=>root.render(<AgentResearchTopics initialId={topic.id} open saveMode={false} config={{grant:manual,policy:"material-first",skills:[]}} disabled={false} onApply={apply} onClose={()=>{}}/>));
 await act(async()=>findButton("编辑专题资料范围").click());
 expect(host.textContent).toContain("这里只编辑专题配置");
 expect(document.activeElement).toBe(host.querySelector('[aria-label="按标题或路径查找"]'));
 const added=()=>[...host.querySelectorAll<HTMLLabelElement>(".agent-material-choice")].find(l=>l.textContent?.includes("新增专题页面"))!.querySelector<HTMLInputElement>("input")!;
 await act(async()=>added().click());
 await act(async()=>host.querySelector<HTMLInputElement>('[aria-label="允许查找 扩展库"]')!.click());
 expect(host.querySelector<HTMLInputElement>('[aria-label="允许查找 手选库"]')!.checked).toBe(false);
 expect(topic).toEqual(original);expect(manual).toEqual(originalManual);expect(apply).not.toHaveBeenCalled();
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="saveResearchTopic")).toBe(false);
 await act(async()=>findButton("保存资料并重新核对").click());
 const save=invoke.mock.calls.find(([,p])=>p?.args?.action==="saveResearchTopic")![1].args.topic;
 expect(save).toMatchObject({id:topic.id,revision:1,policy:topic.policy,skills:topic.skills,grant:{libraryIds:["topic","extra"],notes:[topic.grant.notes[0],{kind:"note",libraryId:"extra",documentId:"added",pageId:null}]}});
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="checkResearchTopic").slice(-1)[0]?.[1].args.topic.revision).toBe(2);
 expect(apply).not.toHaveBeenCalled();expect(topic).toEqual(original);expect(manual).toEqual(originalManual);
 await act(async()=>findButton("应用到当前对话").click());
 expect(apply).toHaveBeenCalledWith(expect.objectContaining({revision:2,grant:save.grant}));
});

it("discards cancelled scope edits and keeps a rejected save editable without applying it",async()=>{
 const apply=vi.fn(async()=>{}),original=structuredClone(topic);
 editableTopicCalls(true);
 await act(async()=>root.render(<AgentResearchTopics initialId={topic.id} open saveMode={false} config={{grant:manual,policy:"material-first",skills:[]}} disabled={false} onApply={apply} onClose={()=>{}}/>));
 await act(async()=>findButton("编辑专题资料范围").click());
 await act(async()=>host.querySelector<HTMLInputElement>('[aria-label="允许查找 扩展库"]')!.click());
 await act(async()=>findButton("取消修改").click());
 expect(document.activeElement).toBe(findButton("编辑专题资料范围"));
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="saveResearchTopic")).toBe(false);
 await act(async()=>findButton("编辑专题资料范围").click());
 expect(host.querySelector<HTMLInputElement>('[aria-label="允许查找 扩展库"]')!.checked).toBe(false);
 await act(async()=>host.querySelector<HTMLInputElement>('[aria-label="允许查找 扩展库"]')!.click());
 await act(async()=>findButton("保存资料并重新核对").click());
 expect(host.querySelector('[role="alert"]')?.textContent).toContain("专题已在其他位置更新");
 expect(host.querySelector<HTMLInputElement>('[aria-label="允许查找 扩展库"]')!.checked).toBe(true);
 expect(topic).toEqual(original);expect(apply).not.toHaveBeenCalled();
});

it("keeps the newly saved topic in the list but cannot apply when its fresh review fails",async()=>{
 const apply=vi.fn(async()=>{});
 editableTopicCalls(false,true);
 await act(async()=>root.render(<AgentResearchTopics initialId={topic.id} open saveMode={false} config={{grant:manual,policy:"material-first",skills:[]}} disabled={false} onApply={apply} onClose={()=>{}}/>));
 await act(async()=>findButton("编辑专题资料范围").click());
 await act(async()=>findButton("保存资料并重新核对").click());
 expect(host.querySelector('[role="alert"]')?.textContent).toContain("资料版本核对失败");
 expect(host.querySelector('.agent-topic-list')).not.toBeNull();
 expect([...host.querySelectorAll("button")].some(b=>b.textContent==="应用到当前对话")).toBe(false);
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="saveResearchTopic")).toHaveLength(1);
 expect(apply).not.toHaveBeenCalled();
});

it("repairs an entirely unavailable topic inside its editor without adding anything to the conversation",async()=>{
 const apply=vi.fn(async()=>{}),originalManual=structuredClone(manual);
 editableTopicCalls(false,false,true);
 await act(async()=>root.render(<AgentResearchTopics initialId={topic.id} open saveMode={false} config={{grant:manual,policy:"material-first",skills:[]}} disabled={false} onApply={apply} onClose={()=>{}}/>));
 expect(findButton("确认仅使用剩余资料").disabled).toBe(true);
 await act(async()=>findButton("编辑专题资料范围").click());
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="移除材料 topic"]')!.click());
 await act(async()=>host.querySelector<HTMLInputElement>('[aria-label="允许查找 专题库"]')!.click());
 expect(findButton("保存资料并重新核对").disabled).toBe(true);
 await act(async()=>[...host.querySelectorAll<HTMLLabelElement>(".agent-material-choice")].find(l=>l.textContent?.includes("新增专题页面"))!.querySelector<HTMLInputElement>("input")!.click());
 await act(async()=>findButton("保存资料并重新核对").click());
 const saved=invoke.mock.calls.find(([,p])=>p?.args?.action==="saveResearchTopic")![1].args.topic;
 expect(saved.grant.libraryIds).toEqual([]);expect(saved.grant.notes).toEqual([{kind:"note",libraryId:"extra",documentId:"added",pageId:null}]);
 expect(findButton("应用到当前对话").disabled).toBe(false);
 expect(manual).toEqual(originalManual);expect(apply).not.toHaveBeenCalled();
});
