// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentTopicWork} from "./AgentTopicWork";
const {invoke,events}=vi.hoisted(()=>({invoke:vi.fn(),events:{handler:undefined as undefined|((event:{payload:{workId:string;eventCategory:string}})=>void)}}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async(_name,handler)=>{events.handler=handler;return()=>{if(events.handler===handler)events.handler=undefined;};})}));
const anchor={kind:"note" as const,libraryId:"notes",documentId:"source",pageId:null};
const evidence={title:"Draft",sourcePath:"Draft.md",content:"数量17。",startChar:0,endChar:5,totalChars:5,truncated:false};
const report={status:"completed",summary:"保存成果",findings:[],nextSteps:[],questions:[],limitations:["合成资料"],waitCondition:"",prose:{markdown:"原发布成果：数量17。 [1]",citations:[{evidenceId:"e1",quote:"数量17"}]}};
const snapshot=(id="original")=>({work:{id,anchor,goal:"同事项继续核对",state:"failed",revision:2,authorizationVersion:1,report:{...report,summary:"不得冒用最近失败运行的报告"}},run:{id:"latest-failed-run",state:"failed",error:"受控失败保留"},recordVersion:10,conversation:{messages:[{id:"initial",role:"user" as const,createdAt:1,text:"原目标"},{id:"published",role:"assistant" as const,runId:"actual-published-run",createdAt:2,report,evidence:[evidence],artifactState:"current" as const,validity:"这是上一轮已交付结果，不代表本次完成"}],hasEarlier:true,nextCursor:"earlier-cursor"},analysisArtifacts:[],sleepDatasets:[],history:[]});
let host:HTMLDivElement,root:Root;
const back=vi.fn(),open=vi.fn(async(_id:string,_draft?:string)=>{});
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset().mockImplementation(async(_command,{args})=>args.action==="source"?{excerpt:evidence}:snapshot(args.id));events.handler=undefined;back.mockClear();open.mockClear();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();});
async function render(page:"成果"|"数据"|"历史"="成果",workId="original",disabled=false){await act(async()=>root.render(<AgentTopicWork workId={workId} anchor={anchor} page={page} disabled={disabled} onBack={back} onOpenWork={open}/>));}
const button=(name:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent===name)!;
const citation=()=>host.querySelector<HTMLButtonElement>(".agent-inline-citation")!;
it("keeps actual published run/source ownership after a newer failure and supports keyboard source return",async()=>{
 await render();expect(host.textContent).toContain("受控失败保留");expect(host.textContent).toContain("原发布成果");expect(host.textContent).not.toContain("不得冒用");
 await act(async()=>{citation().focus();citation().click();});
 expect(invoke).toHaveBeenLastCalledWith("agent_investigation",{args:{action:"source",id:"original",runId:"actual-published-run",evidenceIndex:0,quote:"数量17"}});
 const source=host.querySelector<HTMLElement>('[aria-label="专题引用原文"]')!;expect(source.textContent).toContain("数量17");expect(document.activeElement).toBe(source);
 await act(async()=>source.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));expect(host.querySelector('[aria-label="专题引用原文"]')).toBeNull();expect(document.activeElement).toBe(citation());
 expect(invoke.mock.calls.every(([command,{args}])=>command==="agent_investigation"&&["status","source"].includes(args.action))).toBe(true);
});
it("renders existing dataset and provenance rather than inventing a table from report prose",async()=>{
 const value={...snapshot(),sleepDatasets:[{datasetId:"data-original",revision:1,state:"current",content:{inclusionRule:"主睡眠",dateRule:"按起床日",coverage:{material:{read:1,matched:1},dates:{uniqueDates:1},metric:{accepted:1}},rows:[{rowId:"row1",eventDate:"2026-10-01",rawValue:"7小时",normalizedValue:7,timezone:"Asia/Shanghai",reviewState:"accepted_for_analysis",ambiguity:"",exclusionReason:"",reviewBasis:{kind:"modelReview",reason:"受控数据"},evidenceRefs:[{itemIndex:0,start:0,end:3,text:"7小时"}]}]}}]};
 invoke.mockResolvedValue(value);await render("数据");const details=host.querySelector("details")!;
 await act(async()=>{details.open=true;await new Promise(resolve=>setTimeout(resolve,0));});
 expect(host.textContent).toContain("7小时");expect(host.textContent).toContain("固定材料 1");expect(host.textContent).not.toContain("原发布成果");
 expect(host.querySelector("caption")?.textContent).toContain("主睡眠候选事件");expect(host.querySelectorAll("select")).toHaveLength(3);
 expect(host.querySelector('tr[data-row-id="row1"]')?.textContent).toContain("类型未记录");
 await act(async()=>button("纠正这条记录").click());expect(open).toHaveBeenCalledWith("original",expect.stringContaining("data-original 第 1 版的记录 row1"));
 expect(open.mock.calls[0]?.[1]).toContain("我的纠正：");
 expect(invoke.mock.calls.every(([,v])=>v.args.action==="status")).toBe(true);
});
it("hides revoked content immediately and rejects an already pending source response",async()=>{
 vi.useFakeTimers();let resolveSource!:(v:unknown)=>void;let current=snapshot();
 invoke.mockImplementation(async(_c,{args})=>args.action==="source"?new Promise(resolve=>{resolveSource=resolve;}):current);
 await render();await act(async()=>citation().click());expect(host.textContent).toContain("正在按当前授权");
 current={...snapshot(),work:{...snapshot().work,state:"revoked"}};
 await act(async()=>events.handler!({payload:{workId:"original",eventCategory:"state"}}));expect(host.textContent).not.toContain("原发布成果");
 await act(async()=>{await vi.advanceTimersByTimeAsync(61);resolveSource({excerpt:{...evidence,content:"晚到内容不得显示"}});});
 expect(host.textContent).toContain("授权已撤回");expect(host.textContent).not.toContain("晚到内容");expect(host.textContent).not.toContain("原发布成果");
});
it("ignores stale snapshots when the selected period's work changes",async()=>{
 let finish!:(v:unknown)=>void;invoke.mockImplementation(async(_c,{args})=>args.id==="original"?new Promise(resolve=>{finish=resolve;}):{...snapshot("other"),work:{...snapshot("other").work,goal:"新的周期原工作"}});
 await render();await render("成果","other");expect(host.textContent).toContain("新的周期原工作");
 await act(async()=>finish({...snapshot(),work:{...snapshot().work,goal:"旧请求不得覆盖"}}));expect(host.textContent).not.toContain("旧请求不得覆盖");
});
it("validates paged history identity and authority before appending it",async()=>{
 invoke.mockImplementation(async(_c,{args})=>args.action==="historyPage"?{workId:"wrong",workRevision:2,authorizationVersion:1,conversation:{messages:[{id:"private",role:"user",text:"别的工作不得显示",createdAt:0}],hasEarlier:false}}:snapshot());
 await render("历史");await act(async()=>button("查看更早记录").click());
 expect(invoke).toHaveBeenLastCalledWith("agent_investigation",{args:{action:"historyPage",id:"original",before:"earlier-cursor",expectedRevision:2,expectedAuthorizationVersion:1}});
 expect(host.textContent).toContain("历史返回身份或授权版本不一致");expect(host.textContent).not.toContain("别的工作不得显示");expect(host.textContent).toContain("原发布成果");
});
it("rejects wrong note identity, keeps original-work navigation explicit and respects active-work disabling",async()=>{
 invoke.mockResolvedValue({...snapshot(),work:{...snapshot().work,anchor:{...anchor,documentId:"wrong"}}});await render();expect(host.textContent).toContain("笔记身份不一致");expect(host.textContent).not.toContain("原发布成果");
 invoke.mockResolvedValue(snapshot());await render("成果","next",true);expect(host.textContent).toContain("笔记身份不一致");
 invoke.mockImplementation(async(_c,{args})=>snapshot(args.id));await render("成果","owned",true);expect(button("进入原工作继续或保存（此处不执行）").disabled).toBe(true);expect(open).not.toHaveBeenCalled();
 await render("成果","owned",false);await act(async()=>button("进入原工作继续或保存（此处不执行）").click());expect(open).toHaveBeenCalledExactlyOnceWith("owned");
 await act(async()=>button("返回周期列表").click());expect(back).toHaveBeenCalledOnce();
});
it("keeps report and citation focus mounted during unchanged polling including a pending source reply",async()=>{
 vi.useFakeTimers();let finishStatus!:(v:unknown)=>void,finishSource!:(v:unknown)=>void;let statuses=0;
 invoke.mockImplementation(async(_command,{args})=>args.action==="source"?new Promise(resolve=>{finishSource=resolve;}):++statuses===1?snapshot():new Promise(resolve=>{finishStatus=resolve;}));
 await render();const node=host.querySelector(".agent-report"),cite=citation();await act(async()=>{cite.focus();cite.click();});
 await act(async()=>vi.advanceTimersByTimeAsync(30_001));expect(host.querySelector(".agent-report")).toBe(node);expect(host.textContent).toContain("正在按当前授权");
 await act(async()=>finishSource({excerpt:evidence}));expect(host.textContent).toContain("第1–5字符");await act(async()=>finishStatus(snapshot()));expect(host.querySelector(".agent-report")).toBe(node);
 await act(async()=>host.querySelector<HTMLElement>('[aria-label="专题引用原文"]')!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));expect(document.activeElement).toBe(cite);
});
it("clears the retained view and source if a refresh fails instead of presenting stale authority",async()=>{
 await render();await act(async()=>citation().click());expect(host.textContent).toContain("原发布成果");invoke.mockRejectedValue(new Error("当前授权核对失败"));
 await act(async()=>button("重新核对当前状态").click());expect(host.textContent).toContain("当前授权核对失败");expect(host.textContent).not.toContain("原发布成果");expect(host.querySelector('[aria-label="专题引用原文"]')).toBeNull();
});
