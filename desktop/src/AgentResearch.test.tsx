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
 expect(host.textContent).toContain("用当前选择的资料修复专题");
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
