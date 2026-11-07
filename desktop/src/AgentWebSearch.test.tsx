// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentAssistantOptions,type AssistantOptions} from "./AgentAssistantOptions";
import {AgentWebSources,publicWebHref} from "./AgentWebSources";
import {AgentConversation,type Report} from "./AgentDelivery";
import {AgentActivity,type ActivityRun} from "./AgentActivity";
const {runtime}=vi.hoisted(()=>({runtime:{loaded:true,settings:{provider:"codex",model:"test"}}}));
vi.mock("./CodexSuite",()=>({useCodexSuite:()=>runtime}));
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
let host:HTMLDivElement,root:Root;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});runtime.settings.provider="codex";host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const initial:AssistantOptions={model:null,autoFlashcardInbox:false,externalMcp:true};
function select(){return Array.from(host.querySelectorAll("select")).find(s=>s.closest("label")?.textContent?.startsWith("联网搜索"))!;}
async function choose(value:string){await act(async()=>{select().value=value;select().dispatchEvent(new Event("change",{bubbles:true}));});}
async function apply(){await act(async()=>Array.from(host.querySelectorAll("button")).find(b=>b.textContent==="应用到本对话")!.click());}
it("CN04 web search is explicit, preserves other settings and saves off again",async()=>{
 const save=vi.fn().mockResolvedValue(undefined);await act(async()=>root.render(<AgentAssistantOptions section="connection" value={initial} disabled={false} canAuto={false} onSave={save}/>));
 expect(select().value).toBe("disabled");expect(save).not.toHaveBeenCalled();await choose("live");await apply();expect(save).toHaveBeenLastCalledWith({...initial,webSearch:"live"});
 await act(async()=>root.render(<AgentAssistantOptions section="connection" value={{...initial,webSearch:"live"}} disabled={false} canAuto={false} onSave={save}/>));
 await choose("disabled");await apply();expect(save).toHaveBeenLastCalledWith(initial);
});
it("CN04 unsupported provider can turn search off and failed saves remain visible",async()=>{
 runtime.settings.provider="deepseek";const save=vi.fn().mockRejectedValue(new Error("保存失败"));await act(async()=>root.render(<AgentAssistantOptions section="connection" value={{...initial,webSearch:"cached"}} disabled={false} canAuto={false} onSave={save}/>));
 expect(select().disabled).toBe(false);expect(select().querySelector<HTMLOptionElement>('[value="live"]')!.disabled).toBe(true);
 await choose("disabled");await apply();expect(host.querySelector('[role="alert"]')?.textContent).toContain("保存失败");expect(select().value).toBe("disabled");
});
it("CN04 restored web sources have safe clickable links and explicit provenance",async()=>{
 const report:Report={status:"completed",summary:"文章",findings:[],nextSteps:[],questions:[],limitations:[],waitCondition:"",prose:{markdown:"参考[官方文章](https://example.org/a)",citations:[],webSources:[{url:"https://example.org/a",title:"官方文章",provenance:"providerAccess"},{url:"https://example.org/b",title:"候选资料",provenance:"modelReference"}]}};
 await act(async()=>root.render(<AgentConversation conversation={{messages:[{id:"saved",role:"assistant",runId:"run",createdAt:1,report}],hasEarlier:false}} revoked={false} onOpenCitation={vi.fn()}/>));
 expect(host.textContent).toContain("网页来源 · 2");expect(host.textContent).toContain("Codex 有网页访问记录");expect(host.textContent).toContain("引用链接（无可匹配的联网记录）");expect(host.textContent).toContain("尚未保存 Hub 原文快照");expect(host.querySelectorAll('a[href="https://example.org/a"]')).toHaveLength(2);expect(host.querySelector("img")).toBeNull();
});
it("CN04 unsafe restored links are never activated",async()=>{
 for(const url of ["javascript:alert(1)","https://u:p@example.org/a","https://127.0.0.1","https://x.local","https://[::1]","https://example.org:444"," https://example.org"])expect(publicWebHref(url)).toBeUndefined();
 await act(async()=>root.render(<AgentWebSources sources={[{url:"javascript:alert(1)",title:"<img src=x>",provenance:"modelReference"}]}/>));expect(host.querySelector("a")).toBeNull();expect(host.querySelector("img")).toBeNull();expect(host.textContent).toContain("链接不可用");
});
it("CN04 native web activity remains visible without claiming full-text reading",async()=>{
 const value:ActivityRun={runId:"run",revision:1,state:"completed",running:false,startedAt:1,finishedAt:1001,steps:0,events:[{id:"w",kind:"webSearch",state:"completed",label:"Codex 访问网页",url:"https://example.org/a",createdAt:1}]};
 value.events.push({id:"empty",kind:"webSearch",state:"completed",label:"Codex 搜索网页： ",createdAt:2},{id:"failed",kind:"webSearch",state:"failed",label:"Codex 搜索网页：新闻",createdAt:3});
 await act(async()=>root.render(<AgentActivity value={value}/>));await act(async()=>host.querySelector<HTMLButtonElement>("button")!.click());
 expect(host.textContent).not.toContain("调用已结束");expect(host.textContent).not.toContain("搜索网页： ·");
 expect(host.textContent).toContain("搜索网页 · 未完成");
 const explanation=Array.from(host.querySelectorAll("details")).filter(d=>d.querySelector("summary")?.textContent==="联网记录说明");
 expect(explanation).toHaveLength(1);expect(explanation[0].open).toBe(false);expect(explanation[0].textContent).toContain("返回结果数不是已读全文数");
 expect(host.querySelector('a[href="https://example.org/a"]')).not.toBeNull();
});

it("shows batch outcomes and separate details without turning unknown web actions into searches",async()=>{
 const value:ActivityRun={runId:"batch",revision:1,state:"completed",running:false,startedAt:1,finishedAt:1001,steps:3,events:[
  {id:"open",kind:"webSearch",state:"completed",label:"查阅网页资料",action:"other",resultCount:6,errorCount:1,sourceRefs:[{url:"https://www.archives.gov/electoral-college/2016",title:"2016 Results"},{url:"https://127.0.0.1/private",title:"Unsafe"}],createdAt:2},
  {id:"search",kind:"webSearch",state:"completed",label:"搜索网页 · 2 条查询",action:"search",queries:["first query","second query"],createdAt:3},
  {id:"find",kind:"webSearch",state:"completed",label:"在网页内查找",action:"findInPage",pattern:"65,853,514",createdAt:4}
 ]};
 await act(async()=>root.render(<AgentActivity value={value}/>));
 expect(host.querySelector('.agent-activity-toggle')?.textContent).toBe('工作过程 · 1 秒');
 await act(async()=>host.querySelector<HTMLButtonElement>('.agent-activity-toggle')!.click());
 const summaries=Array.from(host.querySelectorAll('.agent-activity-step summary')).map(s=>s.textContent);
 expect(summaries[0]).toBe('查阅网页资料 · 1 项未获取');
 expect(summaries[1]).not.toContain('first query');
 expect(host.querySelectorAll('[aria-label="本批搜索词"] li')).toHaveLength(2);
 expect(host.textContent).toContain('65,853,514');
 expect(host.querySelector('a[href="https://www.archives.gov/electoral-college/2016"]')).not.toBeNull();
 expect(host.querySelector('a[href*="127.0.0.1"]')).toBeNull();
 expect(Array.from(host.querySelectorAll('.agent-activity-step details')).every(d=>!(d as HTMLDetailsElement).open)).toBe(true);
});

it("distinguishes returned sources from legacy access and unmatched links",async()=>{
 await act(async()=>root.render(<AgentWebSources sources={[
  {url:"https://example.org/result",title:"Returned",provenance:"providerResult"},
  {url:"https://example.org/legacy",title:"Legacy",provenance:"providerAccess"},
  {url:"https://example.org/unmatched",title:"Unmatched",provenance:"modelReference"}
 ]}/>));
 const rows=Array.from(host.querySelectorAll('li')).map(li=>li.textContent);
 expect(rows).toEqual(['Returned · 联网工具返回的来源','Legacy · Codex 有网页访问记录','Unmatched · 引用链接（无可匹配的联网记录）']);
 expect(host.textContent).toContain('不代表已完整读取');
 expect(host.textContent).toContain('无匹配记录也不代表未访问');
});

it("keeps old empty web records readable without claiming a search or successful fetch",async()=>{
 const value:ActivityRun={runId:"legacy",revision:1,state:"completed",running:false,startedAt:1,finishedAt:1001,steps:0,events:[{id:"empty",kind:"webSearch",state:"completed",label:"Codex 搜索网页：",action:"other",createdAt:1},{id:"old-search",kind:"webSearch",state:"completed",label:"Codex 搜索网页：first query；second query",action:"search",createdAt:2}]};
 await act(async()=>root.render(<AgentActivity value={value}/>));
 await act(async()=>host.querySelector<HTMLButtonElement>('.agent-activity-toggle')!.click());
 expect(host.querySelector('.agent-activity-step summary')?.textContent).toBe('查阅网页资料');
 expect(host.textContent).toContain('这条记录未提供逐项返回结果');
 expect(Array.from(host.querySelectorAll('.agent-activity-step summary'))[1]?.textContent).toBe('搜索网页');
 expect(host.textContent).toContain('first query；second query');
});

it("shows partial web errors in the collapsed live status too",async()=>{
 const value:ActivityRun={runId:"live",revision:1,state:"investigating",running:true,startedAt:1,steps:0,events:[{id:"web",kind:"webSearch",state:"completed",label:"访问网页",action:"openPage",resultCount:5,errorCount:1,createdAt:1}]};
 await act(async()=>root.render(<AgentActivity value={value}/>));
 expect(host.querySelector('.agent-live-status')?.textContent).toBe('访问网页 · 1 项未获取');
 expect(host.querySelector('.agent-live-status .lucide-triangle-alert')).not.toBeNull();
 expect(host.querySelector('.agent-live-status .agent-spinning')).toBeNull();
});

it("distinguishes affected batches from failed pages and retains safe reasons without inventing missing details",async()=>{
 const value:ActivityRun={runId:"errors",revision:1,state:"completed",running:false,startedAt:1,steps:0,events:[
  {id:"1",kind:"webSearch",state:"completed",label:"查阅网页资料",errorCount:1,resultCount:8,errors:[{refId:"one",url:"https://example.org/a",reason:"访问超时"}],createdAt:1},
  {id:"2",kind:"webSearch",state:"completed",label:"查阅网页资料",errorCount:2,resultCount:7,errors:[{refId:"two",url:"https://127.0.0.1/private",reason:"网站拒绝访问（403）"},{refId:"three"}],createdAt:2},
  {id:"3",kind:"reasoning",state:"completed",label:"继续核对可用来源",createdAt:3}
 ]};
 await act(async()=>root.render(<AgentActivity value={value}/>));
 await act(async()=>host.querySelector<HTMLButtonElement>('.agent-activity-toggle')!.click());
 expect(host.querySelector('.agent-activity-group')).toBeNull();
 expect(Array.from(host.querySelectorAll('.agent-web-activity > summary')).map(e=>e.textContent)).toEqual(['查阅网页资料 · 1 项未获取','查阅网页资料 · 2 项未获取']);
 expect(host.textContent).toContain('访问超时');
 expect(host.textContent).toContain('当前展示记录未包含具体原因');
 expect(host.textContent).toContain('继续核对可用来源');
 expect(host.querySelector('a[href="https://example.org/a"]')).not.toBeNull();
 expect(host.querySelector('a[href*="127.0.0.1"]')).toBeNull();
});


it("puts partial errors ahead of folded sources and labels the recorded operation",async()=>{
 const value:ActivityRun={runId:"read",revision:1,state:"completed",running:false,startedAt:1,steps:0,events:[{id:"web",kind:"webSearch",state:"completed",label:"在网页内查找",action:"findInPage",pattern:"Mary",resultCount:2,errorCount:1,errors:[{refId:"error",url:"https://example.org/denied",reason:"网站拒绝访问（403）"}],sourceRefs:[{url:"https://example.org/read",title:"已返回来源"}],createdAt:1}]};
 await act(async()=>root.render(<AgentActivity value={value}/>));
 await act(async()=>host.querySelector<HTMLButtonElement>('.agent-activity-toggle')!.click());
 const batch=host.querySelector('.agent-web-activity')!;
 expect(batch.querySelector('summary')?.textContent).toContain('在网页内查找');
 const list=Array.from(batch.querySelectorAll<HTMLDetailsElement>('details')).find(d=>d.querySelector('summary')?.textContent==='返回来源 · 1')!;
 expect(list.open).toBe(false);
 expect(list.querySelector('summary')?.textContent).toBe('返回来源 · 1');
 expect(batch.querySelector('.agent-process-failure')!.compareDocumentPosition(list)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(batch.textContent).toContain('网站拒绝访问（403）');
 await act(async()=>list.querySelector('summary')!.click());
 expect(list.open).toBe(true);
 expect(list.querySelector('a')?.getAttribute('href')).toBe('https://example.org/read');
});
