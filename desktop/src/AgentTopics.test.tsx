// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentTopics} from "./AgentTopics";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async()=>()=>{})}));
const anchor={kind:"note" as const,libraryId:"notes",documentId:"source",pageId:null};
const detail={topic:{id:"topic-one",revision:1,methodVersion:"method-fixed",config:{title:"材料复核",defaultQuestion:"原目标",parameters:{period:"2026-10",outputPreference:"简短"},sourceRule:{membership:"fixedNotes",anchor},archived:false}},method:{id:"method-fixed",content:{name:"hub-statistics",files:{"SKILL.md":"已保存的完整方法正文","references/quality.md":"旧版完整引用"}}},methodCompatible:true,methodUnavailableReason:null,history:[{period:"2026-10",workId:"original",configRevision:1,goal:"原目标",state:"completed",hasReport:true}],scopePolicy:"原工作当前授权",methodPolicy:"绑定不等于采用"};
let host:HTMLDivElement,root:Root;
const openWork=vi.fn(async(_id:string,_source?:unknown,_draft?:string)=>{});
const reply=async(_command:string,{args}:{args:Record<string,unknown>})=>{
 if(args.action==="topicList")return {topics:[{id:"topic-one",revision:1,title:"材料复核",parameters:{period:"2026-10"}}],nextOffset:null};
 if(args.action==="topicWorkNavigation")return {workId:args.workId,source:{anchor,title:"实际笔记",path:"Draft.md",libraryName:"隔离笔记"}};
 if(args.action==="status")return {work:{id:args.id,anchor,goal:"原目标",revision:1,authorizationVersion:1,state:"completed"},run:{id:"published",state:"completed"},conversation:{messages:[],hasEarlier:false},history:[],analysisArtifacts:[],sleepDatasets:[]};
 if(args.action==="skills")return {skills:[{name:"hub-statistics",title:"材料统计",origin:"builtin",available:true},{name:"custom",title:"自定义",origin:"user",available:true}]};
 return structuredClone(detail);
};
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset().mockImplementation(reply);openWork.mockClear();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function render(){await act(async()=>root.render(<AgentTopics anchor={anchor} work={{id:"original",revision:1,report:{},state:"completed"}} disabled={false} onOpenWork={openWork}/>));}
async function open(){await act(async()=>{host.querySelector("details")!.open=true;await new Promise(resolve=>setTimeout(resolve,0));});}
const button=(text:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent===text)!;
async function click(text:string){await act(async()=>button(text).click());}
async function edit(label:string,value:string){const field=[...host.querySelectorAll("label")].find(l=>l.textContent?.startsWith(label))!.querySelector("input,textarea")!;await act(async()=>{Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});}
it("loads only on opening and reads the original work without starting analysis",async()=>{
 await render();expect(invoke).not.toHaveBeenCalled();await open();await click("材料复核 · 2026-10");
 expect(host.textContent).toContain("不能仅凭绑定推定采用");await click("打开原工作，查看成果与数据");expect(openWork).toHaveBeenCalledExactlyOnceWith("original",expect.objectContaining({anchor}));
 expect(invoke.mock.calls.every(([command,{args}])=>command==="agent_investigation"&&["topicList","topicOpen","status","topicWorkNavigation"].includes(args.action))).toBe(true);
});
it("preserves saved method bytes, keyboard focus and explicit method replacement",async()=>{
 await render();await open();await click("材料复核 · 2026-10");await click("设置");
 expect(host.textContent).toContain("已保存的完整方法正文");expect(host.textContent).toContain("旧版完整引用");expect(host.querySelector("pre")?.getAttribute("tabindex")).toBe("0");
 await click("设置");expect([...host.querySelectorAll("option")].some(o=>o.value==="custom")).toBe(false);
 await edit("默认月份","2026-11");await click("保存专题设置（不启动分析）");
 const update=invoke.mock.calls.find(([,v])=>v.args.action==="topicUpdate")![1].args;expect(update.period).toBe("2026-11");expect(update).not.toHaveProperty("skill");
 const summary=host.querySelector("summary")!;await act(async()=>{host.querySelector("details")!.open=true;const b=button("关闭");b.focus();b.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));});expect(host.querySelector("details")!.open).toBe(false);expect(document.activeElement).toBe(summary);
});
it("keeps uncertain saves gated and retries the exact original request identity",async()=>{
 await render();await open();await click("从当前成果保存专题");await edit("专题名称","新专题");
 let attempts:Record<string,unknown>[]=[];invoke.mockImplementation(async(command,args)=>{if(args.args.action==="topicCreate"){attempts.push(args.args);if(attempts.length===1)throw new Error("transport lost");}return reply(command,args);});
 await click("保存专题设置（不启动分析）");expect(host.textContent).toContain("结果待核对");expect(button("保存专题设置（不启动分析）").disabled).toBe(true);expect(host.querySelector("input")?.disabled).toBe(true);
 await click("核对并重试同一次保存");expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);expect(attempts[0].clientRequestId).toMatch(/^topic-/);
 expect(host.textContent).not.toContain("结果待核对");
});
it("retains local fields after a conflict until explicitly reading the saved version",async()=>{
 await render();await open();await click("材料复核 · 2026-10");await click("设置");await edit("专题名称","未提交标题");
 invoke.mockImplementation(async(command,args)=>{if(args.args.action==="topicUpdate")throw new Error("专题配置已在另一处变化");return reply(command,args);});
 await click("保存专题设置（不启动分析）");expect(host.querySelector<HTMLInputElement>('input[maxlength="100"]')?.value).toBe("未提交标题");expect(host.textContent).toContain("另一处变化");
 await click("放弃本地编辑，读取已保存版本");expect(host.querySelector<HTMLInputElement>('input[maxlength="100"]')?.value).toBe("材料复核");
});
it("rejects a mismatched topic source identity instead of opening another source",async()=>{
 await render();await open();invoke.mockImplementation(async(command,args)=>args.args.action==="topicOpen"?{...structuredClone(detail),topic:{...detail.topic,config:{...detail.topic.config,sourceRule:{membership:"fixedNotes",anchor:{...anchor,documentId:"wrong"}}}}}:reply(command,args));
 await click("材料复核 · 2026-10");expect(host.textContent).toContain("来源锚点不一致");expect(openWork).not.toHaveBeenCalled();
});
it("keeps two periods on their original works and provides four pages plus keyboard return",async()=>{
 invoke.mockImplementation(async(command,args)=>{
  if(args.args.action==="topicOpen")return {...structuredClone(detail),history:[{period:"2026-11",workId:"next-period",configRevision:1,goal:"下一周期尚未运行",state:"ready",hasReport:false},...detail.history]};
  return reply(command,args);
 });
 await render();await open();await click("材料复核 · 2026-10");
 expect([...host.querySelectorAll('nav[aria-label="专题页面"] button')].map(b=>b.textContent)).toEqual(["成果","数据","历史","设置"]);
 expect(invoke.mock.calls.some(([,v])=>v.args.action==="status"&&v.args.id==="next-period")).toBe(true);
 await click("数据");expect(host.textContent).toContain("尚无已保存的数据集或图表");
 const original=host.querySelector<HTMLButtonElement>('[data-topic-work="original"]')!;
 await act(async()=>{original.focus();original.click();});
 expect(invoke.mock.calls.some(([,v])=>v.args.action==="status"&&v.args.id==="original")).toBe(true);
 await click("返回周期列表");expect(document.activeElement).toBe(original);expect(openWork).not.toHaveBeenCalled();
 expect(invoke.mock.calls.every(([,v])=>["topicList","topicOpen","status","topicWorkNavigation"].includes(v.args.action))).toBe(true);
});
it("creates an empty topic without a prior report or model request",async()=>{
 await act(async()=>root.render(<AgentTopics anchor={anchor} disabled={false} onOpenWork={openWork}/>));await open();
 expect(button("从当前成果保存专题").disabled).toBe(true);await click("新建空专题（不运行）");await edit("默认问题","只核对当前笔记");
 await click("保存专题设置（不启动分析）");const args=invoke.mock.calls.find(([,v])=>v.args.action==="topicCreateEmpty")![1].args;
 expect(args.anchor).toEqual(anchor);expect(args.defaultQuestion).toBe("只核对当前笔记");expect(args).not.toHaveProperty("workId");expect(openWork).not.toHaveBeenCalled();
 expect(invoke.mock.calls.every(([,v])=>["topicList","skills","topicCreateEmpty","status"].includes(v.args.action))).toBe(true);
});
it("previews actual period notes and requires explicit consent before creating a ready work",async()=>{
 invoke.mockImplementation(async(command,args)=>{
  if(args.args.action==="topicWorkPreview")return {topicId:"topic-one",revision:1,period:"2026-10",fingerprint:"preview-one",methodVersion:"method-fixed",defaultQuestion:"原目标",notes:[{title:"实际笔记",sourcePath:"Draft.md",locator:anchor,version:{hash:"v1"}}]};
  if(args.args.action==="topicCreateWork")return {...structuredClone(detail),openedWorkId:"new-ready"};
  return reply(command,args);
 });
 await render();await open();await click("材料复核 · 2026-10");await click("核对本期工作与范围（不运行）");expect(host.textContent).toContain("实际笔记");
 expect(button("创建本期工作并打开（暂不调用模型）").disabled).toBe(true);expect(openWork).not.toHaveBeenCalled();
 await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await click("创建本期工作并打开（暂不调用模型）");
 const args=invoke.mock.calls.find(([,v])=>v.args.action==="topicCreateWork")![1].args;expect(args).toMatchObject({topicId:"topic-one",period:"2026-10",expectedPreview:"preview-one",confirmedScope:true});
 expect(openWork).toHaveBeenCalledExactlyOnceWith("new-ready",expect.objectContaining({anchor}));expect(invoke.mock.calls.some(([,v])=>["respond","run","message","configureAssistant"].includes(v.args.action))).toBe(false);
});
it("opens the existing period work without consent or a replacement work and preserves uncertain creation identity",async()=>{
 let existing=true,attempts:Record<string,unknown>[]=[];
 invoke.mockImplementation(async(command,args)=>{
  if(args.args.action==="topicWorkPreview")return existing?{topicId:"topic-one",revision:1,period:"2026-10",existingWorkId:"original"}:{topicId:"topic-one",revision:1,period:"2026-10",fingerprint:"preview-two",methodVersion:"method-fixed",notes:[{title:"固定笔记",sourcePath:"Draft.md",locator:anchor,version:{hash:"v1"}}]};
  if(args.args.action==="topicCreateWork"){attempts.push(args.args);throw new Error("lost create reply");}return reply(command,args);
 });
 await render();await open();await click("材料复核 · 2026-10");await click("核对本期工作与范围（不运行）");expect(host.textContent).toContain("累计用量保留");
 await click("打开本期原工作（不运行）");expect(openWork).toHaveBeenCalledExactlyOnceWith("original",expect.objectContaining({anchor}));expect(host.querySelector('input[type="checkbox"]')).toBeNull();
 existing=false;await open();await click("核对本期工作与范围（不运行）");await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await click("创建本期工作并打开（暂不调用模型）");
 expect(host.textContent).toContain("结果待核对");expect(button("核对本期工作与范围（不运行）").disabled).toBe(true);await click("核对并重试同一次保存");expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
});
it("closes only the citation on Escape before the native Topic dismiss listener",async()=>{
 const excerpt={title:"Draft",sourcePath:"Draft.md",content:"数量17",startChar:0,endChar:4,totalChars:4,truncated:false};
 invoke.mockImplementation(async(command,args)=>{
  if(args.args.action==="status")return {work:{id:"original",anchor,goal:"原目标",state:"completed",revision:1,authorizationVersion:1},run:{id:"published",state:"completed"},recordVersion:1,conversation:{messages:[{id:"published",role:"assistant",createdAt:1,runId:"published",report:{status:"completed",summary:"原结果",findings:[],nextSteps:[],questions:[],limitations:[],waitCondition:"",prose:{markdown:"数量17。[1]",citations:[{evidenceId:"e1",quote:"数量17"}]}},evidence:[excerpt]}],hasEarlier:false}};
  if(args.args.action==="source")return {excerpt};return reply(command,args);
 });
 await render();await open();await click("材料复核 · 2026-10");
 const cite=host.querySelector<HTMLButtonElement>(".agent-inline-citation")!;await act(async()=>{cite.focus();cite.click();});
 const source=host.querySelector<HTMLElement>('[aria-label="专题引用原文"]')!;expect(source).not.toBeNull();expect(document.activeElement).toBe(source);
 await act(async()=>source.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
 expect(host.querySelector<HTMLDetailsElement>(".agent-topics")!.open).toBe(true);expect(host.querySelector('[aria-label="专题引用原文"]')).toBeNull();expect(document.activeElement).toBe(cite);
});
it("keeps the Topic anchor separate from its new month's actual Work and uses verified navigation",async()=>{
 const nextAnchor={...anchor,documentId:"november-note"};
 const value={...structuredClone(detail),topic:{...detail.topic,revision:2,config:{...detail.topic.config,parameters:{...detail.topic.config.parameters,period:"2026-11"},sourceRule:{...detail.topic.config.sourceRule,periodDirectory:"daily"}}},history:[{period:"2026-11",workId:"november-work",anchor:nextAnchor,configRevision:2,goal:"核对11月笔记",state:"ready",hasReport:false},...detail.history]};
 invoke.mockImplementation(async(command,args)=>{
  if(args.args.action==="topicOpen"||args.args.action==="topicBind")return value;
  if(args.args.action==="status"&&args.args.id==="november-work")return {work:{id:"november-work",anchor:nextAnchor,goal:"核对11月笔记",revision:1,authorizationVersion:1,state:"ready"},run:null,conversation:{messages:[],hasEarlier:false}};
  if(args.args.action==="topicWorkNavigation")return {workId:args.args.workId,source:{anchor:nextAnchor,title:"2026-11-01",path:"daily/2026-11-01.md",libraryName:"隔离笔记"}};
  return reply(command,args);
 });
 await render();await open();await click("材料复核 · 2026-10");expect(host.textContent).toContain("核对11月笔记");expect(host.textContent).not.toContain("笔记身份不一致");
 await click("将专题固定方法用于本期下一轮（不运行）");expect(invoke.mock.calls.find(([,v])=>v.args.action==="topicBind")![1].args).toMatchObject({workId:"november-work",period:"2026-11",expectedWorkRevision:1,expectedRevision:2});
 await click("进入原工作继续或保存（此处不执行）");expect(openWork).toHaveBeenCalledExactlyOnceWith("november-work",expect.objectContaining({anchor:nextAnchor,title:"2026-11-01"}));
});
it("saves explicit month directory rules and labels member previews as unread metadata",async()=>{
 invoke.mockImplementation(async(command,args)=>{
  if(args.args.action==="topicWorkPreview")return {topicId:"topic-one",revision:1,period:"2026-10",fingerprint:"month-preview",methodVersion:"method-fixed",scope:{kind:"periodManifest",totalMembers:2,dateCoverage:{directoryMembers:4,unknownDateMembers:1}},notes:[{title:"日记一",sourcePath:"daily/2026-10-01.md",locator:anchor,version:{hash:"v1"}}]};
  return reply(command,args);
 });
 await render();await open();await click("材料复核 · 2026-10");await click("设置");
 const select=[...host.querySelectorAll("label")].find(l=>l.textContent?.startsWith("来源选择规则"))!.querySelector("select")!;
 await act(async()=>{select.value="period";select.dispatchEvent(new Event("change",{bubbles:true}));});await edit("日记目录","daily");await click("保存专题设置（不启动分析）");
 expect(invoke.mock.calls.find(([,v])=>v.args.action==="topicUpdate")![1].args.periodDirectory).toBe("daily");
 await click("核对本期工作与范围（不运行）");expect(host.textContent).toContain("正文尚未读取");expect(host.textContent).toContain("日期不明1篇");expect(host.textContent).toContain("共2篇");expect(openWork).not.toHaveBeenCalled();
});

it("verifies original-work navigation before forwarding an editable row correction, without persisting or running",async()=>{
 invoke.mockImplementation(async(command,{args})=>args.action==="status"?{...await reply(command,{args}),sleepDatasets:[{datasetId:"saved-data",revision:2,state:"current",content:{inclusionRule:"主睡眠",dateRule:"固定日",coverage:{material:{read:1,matched:1},dates:{uniqueDates:1},metric:{accepted:1}},rows:[{rowId:"row-correct",eventDate:"2026-10-01",rawValue:"7小时",normalizedValue:7,timezone:"Asia/Shanghai",valueKind:"exact",reviewState:"accepted_for_analysis",ambiguity:"",exclusionReason:"",reviewBasis:{kind:"modelReview",reason:"旧抽取"},evidenceRefs:[]}]}}]}:reply(command,{args}));
 await render();await open();await click("材料复核 · 2026-10");await click("数据");
 await act(async()=>{const data=host.querySelector<HTMLDetailsElement>(".agent-chart details")!;data.open=true;data.dispatchEvent(new Event("toggle"));});
 await click("纠正这条记录");
 expect(invoke).toHaveBeenLastCalledWith("agent_investigation",{args:{action:"topicWorkNavigation",topicId:"topic-one",workId:"original"}});
 expect(openWork).toHaveBeenCalledWith("original",{anchor,title:"实际笔记",path:"Draft.md",libraryName:"隔离笔记"},expect.stringContaining("saved-data 第 2 版的记录 row-correct"));
 expect(invoke.mock.calls.every(([,v])=>["topicList","topicOpen","status","topicWorkNavigation"].includes(v.args.action))).toBe(true);
});
