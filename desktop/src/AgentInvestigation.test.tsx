import { AgentPanelProvider, StandaloneAgentLauncher,AgentFlashcardMaterial,AgentCitationBody,AgentBrowsingContext } from "./StandaloneAgentLauncher";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentInvestigation, ReadingInvestigation, StandaloneInvestigation, investigationAnchor } from "./AgentInvestigation";
import * as fileInputs from "./AgentFileInputs";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import type { AgentActions } from "./AgentTagAction";
import type { Conversation, Progress, HistoricalDelivery } from "./AgentDelivery";
import type { ActivityRun } from "./AgentActivity";
import type { Lifecycle } from "./AgentLifecycle";
import reportEntryFixture from "./AgentReportContinuation.fixture.json";
import { WorkspaceRail } from "./WorkspaceRail";
import { SearchHeaderActions } from "./SearchHeaderActions";
import { resetCodexAccountsForTests } from "./CodexAccounts";

const { invoke, visibility, libraryInventory } = vi.hoisted(() => ({ invoke: vi.fn(), visibility: {value:true}, libraryInventory: {value: [] as LibrarySummary[]} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command:string,...args:unknown[]) => command === "list_libraries" ? Promise.resolve(libraryInventory.value) : command === "model_runtime" && (args[0] as {args?:{action?:string}})?.args?.action === "codexAccounts" ? Promise.resolve({selected:"desktop",accounts:[],current:{label:"t***@example.invalid",scopeId:"a".repeat(64),kind:"chatgpt",plan:"plus"}}) : invoke(command,...args) }));
vi.mock("./WindowVisibility", () => ({ useDocumentVisible: () => visibility.value, isWindowVisible:()=>visibility.value, subscribeWindowVisibility:()=>()=>{} }));
vi.mock("./CodexSuite",async importOriginal=>({...await importOriginal<object>(),loadCodexSuiteModels:vi.fn(async()=>[]),cachedCodexSuiteModels:()=>[],useCodexSuite:()=>({loaded:true,loading:false,settings:{model:"fixture-model",provider:"codex",reasoningEffort:"medium",fast:false,maxConcurrent:2}})}));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: { desktop: true, localVault: true } }));
let host: HTMLDivElement, root: Root;
const result: SearchResult = { id: "hit", entityKey: "page:notes:doc", provider: "obsidian", libraryId: "notes", libraryName: "工作笔记", spaceId: "notes", spaceName: "工作笔记", documentId: "doc", contentType: "markdown", sourceType: "note", title: "安装方案", path: "安装方案.md", snippet: "", matchTerms: [], matchField: "", matchCount: 0, subMatches: [] };
const noteLibrary: LibrarySummary = {id:"notes",provider:"obsidian",name:"工作笔记",connected:true,documentCount:1,excludedPaths:[]};
const report = { status: "needsDecision", summary: "先验证现有接口", findings: [{ text: "历史记录要求保持 M6", citations: [{ evidenceId: "e1", quote: "保持 M6" }] }], nextSteps: [{ action: "测量孔位", reason: "缺少公差结果", citations: [] }], questions: ["是否保留现有固定架？"], limitations: ["来源为本地缓存"], waitCondition: "" };
const makeView = (state = "completed") => ({ work: { id: "work-1", goal: "核对安装方案", state, grant: { libraryIds: [] }, report: state === "completed" ? report : null }, evidence: [{ title: "历史决定", sourcePath: "历史决定.md", content: "保持 M6", startChar: 0, endChar: 5, totalChars: 5, truncated: false }], decisions: [] as { text: string; author: string }[], run: { usage: { modelCalls: 2, entitiesRead: 2, bodyChars: 100 } }, validity: "", runActive: state === "investigating", actionActive: false, actions: undefined as AgentActions | undefined });

// Positive admission below is a UI mock, never a change to the saved Work budget.
function reportEntry(admitted:boolean,state="failed") {
  const snapshot=structuredClone(reportEntryFixture);
  snapshot.work.state=state;
  Object.assign(snapshot.lifecycle,{state,requiresExplicitResume:["paused","cancelled"].includes(state),
    canResume:admitted && ["paused","cancelled"].includes(state),executionModes:{quick:admitted,deep:admitted},reason:admitted?"":snapshot.lifecycle.reason});
  current=snapshot as unknown as typeof current;
  invoke.mockImplementation(async (_,{args})=>args.action==="list" ? {works:[{id:snapshot.work.id,goal:snapshot.work.goal,state}]} : current);
  return snapshot;
}
async function openReportEntry() {
  const anchor=reportEntryFixture.work.anchor;
  await act(async()=>root.render(<AgentInvestigation result={{...result,libraryId:anchor.libraryId,spaceId:anchor.libraryId,documentId:anchor.documentId,title:"受控睡眠复核",documentTitle:"受控睡眠复核"}}/>));
  await click("调查这篇笔记");
}

it.each(["insufficientEvidence","needsDecision"])("offers explicit external continuation for a partial report (%s)",async status=>{
  const snapshot=reportEntry(true,"completed");
  Object.assign(snapshot.work,{report:{...report,status}});
  Object.assign(snapshot,{workingState:{revision:1,entries:[],pendingTargets:[],unresolvedQuestions:[]}});
  await openReportEntry();
  expect(button("建立一次性连接").disabled).toBe(false);
  expect(invoke.mock.calls.some(([,v])=>["prepareExternalWork","respond","create"].includes(v?.args?.action))).toBe(false);
});

it.each(["completed","revoked"])("does not offer external continuation after completion or withdrawal (%s)",async state=>{
  const snapshot=reportEntry(true,state);
  Object.assign(snapshot.work,{report:{...report,status:state==="completed"?"completed":"insufficientEvidence"}});
  Object.assign(snapshot,{workingState:{revision:1,entries:[],pendingTargets:[],unresolvedQuestions:[]}});
  await openReportEntry();expect(button("建立一次性连接")).toBeUndefined();
});

it.each(["failed","paused"])("report-only entry sends the exact saved identities without a new goal (%s, mocked admission)",async state=>{
  const snapshot=reportEntry(true,state);await openReportEntry();
  const trigger=button("仅补交报告");expect(trigger.disabled).toBe(false);trigger.focus();expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("type")).toBe("button");expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
  await act(async()=>trigger.click());
  const expectedAction=state==="paused"?"resume":"respond";
  const calls=invoke.mock.calls.filter(([,v])=>v?.args?.action===expectedAction);expect(calls).toHaveLength(1);
  const args=calls[0][1].args,chart=snapshot.analysisArtifacts[0];
  expect(args.id).toBe(snapshot.work.id);
  expect(args.reportContinuation).toEqual({expectedWorkRevision:2,expectedAuthorizationVersion:1,artifactId:chart.artifactId,artifactRevision:2,expectedContentHash:chart.content.contentHash});
  if(state==="paused")expect(args).toMatchObject({expectedControlRevision:snapshot.lifecycle.controlRevision,expectedWorkRevision:2,expectedRunId:null,commandId:expect.any(String)});
  expect(invoke.mock.calls.some(([,v])=>["create","message","decision","goalRevision"].includes(v?.args?.action))).toBe(false);
  expect(current.work).toEqual(snapshot.work);expect(snapshot.analysisArtifacts[0].content.data.rows[0]).toMatchObject({value:7,sampleCount:2});
});

it("report-only entry preserves the actual exhausted saved quota and sends no request",async()=>{
  reportEntry(false);await openReportEntry();
  const trigger=button("仅补交报告");expect(trigger.disabled).toBe(true);
  expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toContain(reportEntryFixture.lifecycle.reason);
  await act(async()=>trigger.click());expect(invoke.mock.calls.some(([,v])=>["respond","resume","message"].includes(v?.args?.action))).toBe(false);
});

it("report-only entry does not switch providers or assume missing budget permission",async()=>{
  const snapshot=reportEntry(true);snapshot.modelSelection.provider="deepseek";
  Object.assign(snapshot.assistantOptions.model,{provider:"deepseek"});
  await openReportEntry();expect(button("仅补交报告").disabled).toBe(true);expect(document.body.textContent).toContain("请先在本事项选择 Codex");
  expect(invoke.mock.calls.some(([,v])=>v?.args?.action==="configureAssistant")).toBe(false);
});

it.each(["stale","missing-hash","multiple","delivered"])("report-only entry hides an ambiguous or invalid offer (%s)",async condition=>{
  const snapshot=reportEntry(true);
  if(condition==="stale")snapshot.analysisArtifacts[0].state="stale";
  if(condition==="missing-hash")Reflect.deleteProperty(snapshot.analysisArtifacts[0].content,"contentHash");
  if(condition==="multiple")snapshot.analysisArtifacts.push({...snapshot.analysisArtifacts[0],artifactId:"another-chart"});
  if(condition==="delivered")Object.assign(snapshot.work,{report});
  await openReportEntry();expect(button("仅补交报告")).toBeUndefined();
});

it("report-only entry retains saved results after a stale-request rejection without retry",async()=>{
  const snapshot=reportEntry(true);const original=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(...args)=>{if(args[1].args.action==="respond")throw new Error("报告接续的目标或授权已变化，请刷新后重试");return original(...args);});
  await openReportEntry();await click("仅补交报告");
  expect(document.body.textContent).toContain("报告接续的目标或授权已变化");
  expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==="respond")).toHaveLength(1);
  expect(snapshot.work.revision).toBe(2);expect(snapshot.analysisArtifacts[0].revision).toBe(2);
  expect(snapshot.analysisArtifacts[0].content.data.rows[0].value).toBe(7);
});

it("report-only entry refuses missing admission metadata",async()=>{
  const snapshot=reportEntry(true);Reflect.deleteProperty(snapshot,"lifecycle");
  await openReportEntry();expect(button("仅补交报告").disabled).toBe(true);
  await click("仅补交报告");
  expect(invoke.mock.calls.some(([,v])=>["respond","resume","configureAssistant"].includes(v?.args?.action))).toBe(false);
});

it.each(["insufficientEvidence","needsDecision"])("external report continuation stays available for a saved partial result (%s)",async status=>{
 const snapshot=reportEntry(true);Object.assign(snapshot.work,{report:{...report,status}});
 Object.assign(snapshot,{workingState:{revision:1,entries:[],pendingTargets:[],unresolvedQuestions:[]}});
 await openReportEntry();expect(button("建立一次性连接").disabled).toBe(false);
 expect(invoke.mock.calls.some(([,v])=>["respond","resume","create","prepareExternalWork"].includes(v?.args?.action))).toBe(false);
});

it.each(["completed","revoked"])("external report continuation does not reopen a completed or revoked result (%s)",async state=>{
 const snapshot=reportEntry(true,state);Object.assign(snapshot.work,{report:{...report,status:state==="completed"?"completed":"insufficientEvidence"}});
 Object.assign(snapshot,{workingState:{revision:1,entries:[],pendingTargets:[],unresolvedQuestions:[]}});
 await openReportEntry();expect(button("建立一次性连接")).toBeUndefined();
});
let current: ReturnType<typeof makeView> & { lifecycle?:Lifecycle; activity?:ActivityRun[]; recordVersion?:number; progress?: Progress | null; history?: HistoricalDelivery[]; conversation?: Conversation; assistantOptions?: {model:null;autoFlashcardInbox:boolean}; draftRequest?: {runId:string;kind:string} | null };
beforeEach(() => {
  resetCodexAccountsForTests();
  sessionStorage.clear();
  localStorage.removeItem("hub.agent.preferences.v1");
  localStorage.removeItem("hub.agent.panel.width.v1");
  localStorage.removeItem("hub.agent.panel.height.v1");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); current = makeView(); visibility.value=true; libraryInventory.value=[];
  invoke.mockReset().mockImplementation(async (command, { args }) => {
    expect(command).toBe("agent_investigation");
    if (args.action === "list") return { works: [] };
    if (args.action === "create") { current = { ...makeView("ready"), work: { ...makeView("ready").work, goal: args.goal } }; return current; }
    if (args.action === "respond") { current = makeView(); return current; }
    if (args.action === "decision") { current = { ...makeView("interrupted"), decisions: [{ text: args.text, author: "user" }] }; return current; }
    if (args.action === "cancel") { current = makeView("interrupted"); return current; }
    if (args.action === "revoke") { current = makeView("revoked"); return current; }
    return current;
  });
});
afterEach(async () => { await act(async () => root.unmount()); resetCodexAccountsForTests(); host.remove(); document.body.style.direction = ""; Reflect.deleteProperty(document.body, "clientWidth"); vi.useRealTimers(); });
const button = (text: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(item => (item.getAttribute("aria-label") || item.textContent)?.includes(text))!;
async function openDialogueDetails() {
  const menu=document.body.querySelector<HTMLDetailsElement>(".agent-dialogue-details")!;
  const sections=menu.querySelector<HTMLElement>(".agent-details-sections")!;
  if (!menu.open || sections.hidden) await act(async()=>document.body.querySelector<HTMLButtonElement>('.agent-header-end button[aria-label="对话详情"]')!.click());
  expect(menu.open).toBe(true);expect(sections.hidden).toBe(false);
}
async function openHistory() {
  const menu=document.body.querySelector<HTMLDetailsElement>(".agent-dialogue-details")!;
  if (menu.open && menu.querySelector<HTMLElement>(".agent-history-container")!.hidden) {
    await act(async()=>menu.querySelector<HTMLButtonElement>('.agent-details-heading button[aria-label="关闭对话详情"]')!.click());
  }
  if (!menu.open) await act(async()=>menu.querySelector<HTMLElement>(":scope > summary")!.click());
  expect(menu.open).toBe(true);expect(menu.querySelector<HTMLElement>(".agent-history-container")!.hidden).toBe(false);
}
async function revealButton(text:string) {
  const target=button(text);expect(target,text).toBeDefined();
  if (target.closest(".agent-details-sections")) {
    await openDialogueDetails();
    const parents:HTMLDetailsElement[]=[];
    for(let parent=target.parentElement;parent;parent=parent.parentElement) if(parent instanceof HTMLDetailsElement) parents.unshift(parent);
    for(const details of parents) if(!details.open) await act(async()=>details.querySelector<HTMLElement>(":scope > summary")!.click());
    expect(target.closest("[hidden]")).toBeNull();
  }
  return target;
}
const click = async (text: string) => { const target=await revealButton(text);await act(async () => target.click()); };
async function selectTaskMode(label:"标准"|"扩展") {
  const menu=document.body.querySelector<HTMLDetailsElement>(".agent-task-mode")!;
  await act(async()=>menu.querySelector<HTMLElement>(":scope > summary")!.click());
  expect(menu.open).toBe(true);
  const choice=[...menu.querySelectorAll<HTMLButtonElement>(".agent-mode-choice")].find(item=>item.querySelector("strong")?.textContent===label)!;
  await act(async()=>choice.click());
  expect(menu.open).toBe(false);expect(menu.querySelector(".agent-mode-badge")?.textContent).toBe(label);
}
const fill = async (name: string, value: string) => {
  const input = document.body.querySelector<HTMLTextAreaElement>(`[name="${name}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};
it.each(["mcp","web"])("cn07c binds a standalone %s-only choice before the first model call",async kind=>{
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command,p)=>p?.args?.action==="discoverMcpService"?Promise.resolve({server:"openai_docs",catalogSha256:"a".repeat(64),tools:[{name:"search_openai_docs",title:"Search OpenAI Docs"}],blockedToolCount:0}):original(command,p));
  await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));await fill("investigationGoal","查询官方说明");await openAddPage("更多设置");
  await act(async()=>{const details=document.body.querySelector<HTMLDetailsElement>(".agent-menu-advanced")!;details.open=true;});
  if(kind==="mcp") {await click("发现 / 刷新");await act(async()=>document.body.querySelector<HTMLInputElement>('.agent-connection-settings fieldset input[type="checkbox"]')!.click());}
  else {await act(async()=>{const select=[...document.body.querySelectorAll<HTMLSelectElement>(".agent-connection-settings select")].find(s=>s.parentElement?.textContent?.startsWith("联网搜索"))!;select.value="cached";select.dispatchEvent(new Event("change",{bubbles:true}));});}
  await click("应用到本对话");expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="configureAssistant")).toBe(false);
  await act(async()=>document.body.querySelector<HTMLFormElement>(".agent-composer form")!.requestSubmit());
  const calls=invoke.mock.calls.map(([,p])=>p.args).filter(a=>["create","configureAssistant","respond"].includes(a.action));
  expect(calls.map(a=>a.action)).toEqual(["create","configureAssistant","respond"]);
  expect(calls[1].options.model).toBeNull();expect(calls[1].options).toHaveProperty(kind==="mcp"?"mcpServices":"webSearch");
});
it("pages older global conversations without changing the selected Work or draft",async()=>{
  const works=Array.from({length:20},(_,i)=>({id:`work-${i+1}`,goal:`保存对话 ${i+1}`,state:"completed"}));
  const cursor={updatedAt:100,id:"work-20",anchor:null};
  Object.assign(current.work,{anchor:{kind:"note",libraryId:"notes",documentId:"doc",pageId:null}});
  invoke.mockImplementation(async(_,{args})=>{
    if(args.action==="list")return args.before?{works:[works[19],{id:"older-work",goal:"更早的独立对话",state:"completed"}],nextCursor:null}:{works,nextCursor:cursor};
    return args.id==="older-work"?{...current,work:{...current.work,id:"older-work",goal:"更早的独立对话"}}:current;
  });
  await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
  await fill("investigationGoal","尚未发送的草稿");
  const sections=document.querySelector<HTMLElement>(".agent-details-sections")!;
  await openHistory();
  expect(document.querySelectorAll(".agent-history-row")).toHaveLength(20);
  expect(sections.hidden).toBe(true);
  expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==="list")).toHaveLength(1);
  await click("关闭对话历史");expect(document.querySelector<HTMLDetailsElement>(".agent-dialogue-details")!.open).toBe(false);
  await openDialogueDetails();expect(document.querySelector(".agent-details-sections")).toBe(sections);expect(sections.hidden).toBe(false);
  await openHistory();expect(document.querySelectorAll(".agent-history-row")).toHaveLength(20);
  expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==="list")).toHaveLength(1);
  await click("加载更多对话");
  expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==="list")[1][1].args).toEqual({action:"list",anchor:null,query:"",archived:false,before:cursor});
  expect(document.querySelectorAll(".agent-history-row")).toHaveLength(21);
  expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("尚未发送的草稿");
  expect(document.querySelector(".agent-history-more")).toBeNull();
  await click("更早的独立对话");
  expect(invoke.mock.calls.some(([,v])=>v?.args?.action==="status"&&v.args.id==="older-work")).toBe(true);
  expect(invoke.mock.calls.some(([,v])=>["create","message","respond","resume"].includes(v?.args?.action))).toBe(false);
});
it("keeps the history cursor and existing choices after a page fails, then retries once",async()=>{
  const cursor={updatedAt:100,id:"work-1",anchor:null};let attempts=0;
  invoke.mockImplementation(async(_,{args})=>{
    if(args.action!=="list")return current;
    if(!args.before)return {works:[{id:"work-1",goal:current.work.goal,state:"completed"}],nextCursor:cursor};
    attempts++;if(attempts===1)throw Error("读取暂时失败");
    return {works:[{id:"older",goal:"较早对话",state:"completed"}],nextCursor:null};
  });
  await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
  await openHistory();await click("加载更多对话");expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("读取暂时失败");
  expect(document.querySelectorAll(".agent-history-row")).toHaveLength(1);
  await click("重试加载更多对话");expect(attempts).toBe(2);expect(document.querySelector(".agent-history-more")).toBeNull();
  expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==="list"&&v.args.before).map(([,v])=>v.args.before)).toEqual([cursor,cursor]);
});
it("arranges and cancels context compaction without starting a model or discarding the report",async()=>{
 Object.assign(current,{work:{...current.work,revision:1,authorizationVersion:1},contextCompaction:{canRequest:true,pending:false,latestLifecycle:null}});
 invoke.mockImplementation(async(_,{args})=>{
  if(args.action==="list")return {works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]};
  if(args.action==="requestContextCompaction"){
   expect(args.expectedWorkRevision).toBe(1);expect(args.expectedAuthorizationVersion).toBe(1);
   Object.assign(current,{contextCompaction:{canRequest:false,pending:true,operationId:args.operationId,latestLifecycle:null}});
  }
  if(args.action==="cancelContextCompaction")Object.assign(current,{contextCompaction:{canRequest:true,pending:false,latestLifecycle:null}});
  return current;
 });
 await open();await click("下次继续时整理上下文");expect(button("取消整理安排")).toBeTruthy();
 expect(document.body.textContent).toContain("先验证现有接口");await click("取消整理安排");
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond" || p?.args?.action==="resume")).toBe(false);
});
it("shows an acknowledged compaction as waiting rather than completed",async()=>{
 Object.assign(current,{contextCompaction:{canRequest:false,pending:false,latestLifecycle:{state:"acknowledged",hostRequested:true,completionProven:false}}});
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]}:current);
 await open();expect(document.body.textContent).toContain("请求已接收，等待整理完成");expect(document.body.textContent).not.toContain("上下文整理已完成");
});
it("reading investigations grant only the explicit item and do not assume a note or whole library", async () => {
  await act(async () => root.render(<ReadingInvestigation itemKey="reading-1" />));
  expect(invoke).not.toHaveBeenCalled(); await click("调查这篇阅读材料");
  expect(document.body.querySelector('[type="checkbox"]')).toBeNull();
  await fill("investigationGoal", "核对这份阅读材料"); await click("开始调查");
  const create = invoke.mock.calls.find(([, { args }]) => args.action === "create")![1].args;
  expect(create.anchor).toEqual({ kind: "reading", itemKey: "reading-1" });
  expect(create.grant).toEqual({ libraryIds: [], notes: [], readingItemKeys: ["reading-1"] });
});
async function openAddPage(label:string){
 if(label==="使用技能"){await click("添加技能");return;}
 if(label==="资料范围"){await click("搜索范围：");return;}
 if(label==="从笔记库添加"){await click("添加资料");return;}
 const menu=document.body.querySelector<HTMLDetailsElement>(".agent-add-menu")!;
 if(menu.open){if(!menu.querySelector(".agent-add-choices"))await click("返回");}else await act(async()=>menu.querySelector<HTMLElement>(":scope > summary")!.click());
 await click(label);
}
async function open() { await act(async () => root.render(<AgentInvestigation result={result} />)); await click("调查这篇笔记"); }

it("keeps scope inside the primary materials panel and removes the duplicate plus-menu entry",async()=>{
 await open();
 await act(async()=>{const d=document.body.querySelector<HTMLDetailsElement>('.agent-add-menu')!;d.open=true;d.dispatchEvent(new Event('toggle'));});
 expect(document.body.querySelector('.agent-add-choices')?.textContent).not.toContain('资料范围');
 await click('添加资料');
 const advanced=document.body.querySelector<HTMLDetailsElement>('.agent-material-advanced')!;
 expect(advanced.open).toBe(false);
 expect(advanced.textContent).toContain('整个资料库');
 await act(async()=>advanced.querySelector('summary')!.click());
 expect(advanced.open).toBe(true);
 expect(invoke.mock.calls.some(([,p])=>['create','message','source'].includes(p?.args?.action))).toBe(false);
});

it("renders removable skill chips, preserves question text and sends only retained skill directives",async()=>{
 const base=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,payload)=>payload.args.action==='skills'?{skills:[
  {name:'hub-research',title:'资料分析与核对',description:'核对资料',available:true,allowImplicitInvocation:true,origin:'builtin',unavailableReasons:[]},
  {name:'hub-statistics',title:'材料统计与覆盖核对',description:'统计资料',available:true,allowImplicitInvocation:true,origin:'builtin',unavailableReasons:[]}
 ],diagnostics:[],directory:'test'}:base(command,payload));
 await open();await fill('investigationGoal','保留我的问题');
 await openAddPage('使用技能');await click('查看技能 资料分析与核对');await click('添加到本次对话');
 expect(document.body.querySelector('.agent-selected-skills')?.textContent).toContain('资料分析与核对');
 expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe('保留我的问题');
 await openAddPage('使用技能');await click('查看技能 材料统计与覆盖核对');await click('添加到本次对话');
 await click('移除技能 资料分析与核对');await fill('investigationGoal','修改后的问题');
 expect(document.body.querySelector('.agent-selected-skills')?.textContent).not.toContain('资料分析与核对');
 await click('开始调查');
 expect(invoke.mock.calls.find(([,p])=>p?.args?.action==='create')?.[1].args.goal).toBe('$hub-statistics 修改后的问题');
});

it("distinguishes native sessions from unknown response rounds and cached input",async()=>{
  current=Object.assign(makeView(),{run:{id:"native-usage",usage:{modelCalls:0,agentSessions:1,entitiesRead:2,bodyChars:1733}},activity:[{runId:"native-usage",native:true,state:"completed",running:false,revision:1,startedAt:1,steps:4,events:[],measurement:{turnTokens:{inputTokens:165046,cachedInputTokens:118528,uncachedInputTokens:46518,outputTokens:1514}}}]});
  invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:current);
  await open();
  expect(document.body.textContent).toContain("本轮 Agent 会话：1；模型响应轮次：未返回");
  expect(document.body.textContent).toContain("本轮输入 165,046 Token，其中缓存输入 118,528、未缓存输入 46,518");
  expect(document.body.textContent).not.toContain("本轮已调用 0 次");
});
it("keeps a failed conversation recoverable without starting another model automatically",async()=>{
 current=Object.assign(makeView("failed"),{run:{id:"prepare-failed",error:"准备资料失败，尚未启动模型：规则容量超过限制",usage:{modelCalls:0,entitiesRead:1,bodyChars:2942}}});
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:current);
 await open();
 expect(document.body.querySelector('[aria-label="本轮恢复说明"]')?.textContent).toContain("问题与资料选择保留");
 expect(document.body.textContent).toContain("尚未启动模型");
 expect(document.body.textContent).toContain("继续调查");
 expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==="respond")).toHaveLength(0);
});
it("reads a saved report with a hidden composer and returns by Escape without closing the Work or starting a model",async()=>{
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:current);
 await open();await fill("investigationGoal","保留这个追问草稿");await click("专注阅读报告");
 const panel=document.body.querySelector<HTMLElement>('.agent-panel')!;
 expect(panel.dataset.agentReading).toBe("true");
 expect(document.body.querySelector<HTMLElement>('.agent-composer')?.hidden).toBe(true);
 expect(document.activeElement?.getAttribute('aria-label')).toBe('对话与报告');
 expect(panel.textContent).toContain('历史记录要求保持 M6');
 await act(async()=>panel.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 expect(panel.dataset.agentReading).toBe("false");expect(panel.hidden).toBe(false);
 expect(document.body.querySelector<HTMLElement>('.agent-composer')?.hidden).toBe(false);
 expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe('保留这个追问草稿');
 expect(document.activeElement).toBe(document.body.querySelector('.agent-header-end button[aria-label="对话详情"]'));
 expect(invoke.mock.calls.some(([,v])=>["respond","resume","create"].includes(v?.args?.action))).toBe(false);
});
it("opens recovery details above a stable composer while reading a saved report",async()=>{
 Object.assign(current,{lifecycle:{schemaVersion:1,controlRevision:1,workRevision:1,activeRunId:null,state:'paused',requiresExplicitResume:true,canResume:false,recoveryMode:'fresh',runsUsed:2,runLimit:2,unresolvedActions:1,reason:'需先核对已提交的保存结果',recordedUsage:{},usageCompleteness:'incomplete',unmeasuredRunIds:['old']}});
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:Array.from({length:5},(_,i)=>({id:i===0?current.work.id:`older-${i}`,goal:current.work.goal,state:current.work.state}))}:current);
 await open();await click("专注阅读报告");
 const controls=document.body.querySelector<HTMLDetailsElement>('.agent-work-controls')!;
 expect(controls.open).toBe(false);
 expect(controls.closest('.agent-panel-header')).not.toBeNull();
 expect(controls.closest('.agent-body')).toBeNull();
 expect(document.querySelector('.agent-task-notice')?.textContent).toContain('任务已暂停');
 await click('查看任务详情');
 expect(controls.open).toBe(true);expect(controls.closest('[hidden]')).toBeNull();
 expect(document.querySelector<HTMLDetailsElement>('.agent-dialogue-details')?.open).toBe(true);
 expect(document.activeElement).toBe(controls.querySelector('summary'));
 expect(controls.textContent).toContain('需先核对已提交的保存结果');
 expect(controls.textContent).toContain('用量');
 await openHistory();expect(document.querySelector<HTMLElement>('.agent-details-sections')?.hidden).toBe(true);
 await click('查看任务详情');await act(async()=>{await new Promise(r=>setTimeout(r,10));});
 expect(controls.closest('[hidden]')).toBeNull();expect(document.activeElement).toBe(controls.querySelector('summary'));
 expect(invoke.mock.calls.some(([,v])=>["respond","resume","create"].includes(v?.args?.action))).toBe(false);
});
it("returns from focused reading to the original text without leaving the narrow-window body hidden",async()=>{
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:current);
 await open();await click("专注阅读报告");await click("查看正文");
 const panel=document.body.querySelector<HTMLElement>('.agent-panel')!;
 expect(panel.dataset.agentReading).toBe('false');expect(panel.dataset.agentSourceVisible).toBe('true');
 await click('返回对话');expect(panel.dataset.agentSourceVisible).toBe('false');
 expect(invoke.mock.calls.some(([,v])=>["respond","resume","create"].includes(v?.args?.action))).toBe(false);
});
it("opens a Topic period on its actual note and returns to the originating Work without model dispatch",async()=>{
 const originalAnchor={documentId:"doc",kind:"note",pageId:null,libraryId:"notes"};
 const nextAnchor={documentId:"november",kind:"note",pageId:null,libraryId:"notes"};
 const original={...makeView(),work:{...makeView().work,anchor:originalAnchor}};
 const next={...makeView("ready"),work:{...makeView("ready").work,id:"november-work",goal:"11月复盘",anchor:nextAnchor,grant:{libraryIds:[],notes:[nextAnchor]}}};
 invoke.mockImplementation(async(_command,{args})=>{
  if(args.action==="list")return {works:args.anchor?.documentId==="doc"?[{id:"work-1",goal:"核对安装方案",state:"completed"}]:[]};
  if(args.action==="status")return args.id==="november-work"?next:original;
  if(args.action==="topicList")return {topics:[{id:"topic-one",revision:2,title:"月度专题",parameters:{period:"2026-11"}}],nextOffset:null};
  if(args.action==="topicOpen")return {topic:{id:"topic-one",revision:2,methodVersion:"method-fixed",config:{title:"月度专题",defaultQuestion:"本月复盘",parameters:{period:"2026-11",outputPreference:""},sourceRule:{anchor:originalAnchor,membership:"fixedNotes",periodDirectory:"daily"},archived:false}},method:{id:"method-fixed",content:{name:"hub-research",files:{"SKILL.md":"固定方法"}}},methodCompatible:true,history:[{period:"2026-11",workId:"november-work",anchor:nextAnchor,configRevision:2,goal:"11月复盘",state:"ready",hasReport:false}],scopePolicy:"实际本期范围",methodPolicy:"绑定不等于加载"};
  if(args.action==="topicWorkNavigation")return {workId:"november-work",source:{anchor:nextAnchor,title:"2026-11-01",path:"daily/2026-11-01.md",libraryName:"工作笔记"}};
  return original;
 });
 await open();await act(async()=>document.querySelector<HTMLDetailsElement>(".agent-dialogue-details")!.querySelector("summary")!.click());
 await act(async()=>{document.querySelector<HTMLDetailsElement>(".agent-topics")!.open=true;await new Promise(resolve=>setTimeout(resolve,0));});
 await click("月度专题 · 2026-11");await click("进入原工作继续或保存");
 expect(document.body.textContent).toContain("正在讨论「2026-11-01」");expect(document.body.textContent).toContain("11月复盘");
 expect(invoke.mock.calls.some(([,v])=>v?.args?.action==="status" && v.args.id==="november-work")).toBe(true);
 await click("返回专题所在工作");expect(document.body.textContent).toContain("核对安装方案");expect(document.body.textContent).not.toContain("本期工作与实际笔记锚点不一致");
 expect(invoke.mock.calls.some(([,v])=>["respond","resume","create","message"].includes(v?.args?.action))).toBe(false);
});

const quotaLifecycle = (quick:boolean,deep:boolean):Lifecycle => ({schemaVersion:1,controlRevision:1,workRevision:1,activeRunId:null,state:"completed",requiresExplicitResume:false,canResume:false,recoveryMode:"newRunWithRevalidatedContext",runsUsed:1,runLimit:null,unresolvedActions:0,reason:"",recordedUsage:{},executionModes:{quick,deep}});
it("blocks standalone model draft controls while keeping deterministic report preview available",async()=>{
 current={...makeView(),actions:{items:[],tagOptions:["范围"],flashcardDecks:[],obsidianEditAvailable:true,obsidianReportTarget:{path:"Note.md",libraryId:"notes",documentId:"doc"},standaloneModelDrafts:{allowed:false,reason:"独立草稿分析尚未接入已固定额度，未启动模型"}}};
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]}:current);
 await open();
 expect(button("准备笔记修改").disabled).toBe(true);expect(button("准备补标建议").disabled).toBe(true);
 expect(document.body.textContent).toContain("独立草稿分析尚未接入已固定额度");
 await act(async()=>{const input=document.body.querySelector<HTMLTextAreaElement>('[name="obsidianEditInstruction"]')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"不得调用模型");input.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>document.body.querySelector<HTMLTextAreaElement>('[name="obsidianEditInstruction"]')!.form!.requestSubmit());
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="prepareObsidianEdit")).toBe(false);
 await click("预览追加当前报告");
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="prepareObsidianReportSave")).toHaveLength(1);
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond")).toBe(false);
});
it.each([true,false])("uses committed message quota to save only even when pre-send eligibility was %s",async wasEligible=>{
 current={...makeView(),lifecycle:quotaLifecycle(wasEligible,wasEligible)};
 invoke.mockImplementation(async(_,{args})=>{
  if(args.action==="list")return {works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]};
  if(args.action==="message"){current={...current,lifecycle:quotaLifecycle(false,false)};return current;}
  if(args.action==="respond")throw Error("quota must prevent dispatch");return current;
 });
 await open();await fill("investigationGoal","以后核对这条补充");await click(wasEligible?"发送追问":"保存补充");
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="message")).toHaveLength(1);
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond")).toBe(false);
 expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("");
 expect(document.body.textContent).toContain("保存补充，不启动运行");
 expect(document.body.textContent).toContain("旧成果与历史仍可查看");
});
it("keeps an unsaved supplement after commit failure without reporting saved or dispatching",async()=>{
 current={...makeView(),lifecycle:quotaLifecycle(false,false)};
 invoke.mockImplementation(async(_,{args})=>{
  if(args.action==="list")return {works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]};
  if(args.action==="message")throw Error("补充提交失败，结果未确认");return current;
 });
 await open();await fill("investigationGoal","必须保留的未保存要求");await click("保存补充");
 expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("必须保留的未保存要求");
 expect(document.body.textContent).toContain("补充提交失败，结果未确认");
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond")).toBe(false);
});
it("honours per-mode admission and starts only the permitted mode after a fresh message",async()=>{
 current={...makeView("failed"),lifecycle:quotaLifecycle(true,false)};
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]}:current);
 await open();
 await selectTaskMode("扩展");
 expect(button("继续调查").disabled).toBe(true);await click("继续调查");
 await fill("investigationGoal","深度额度不足时仅保存");await click("保存补充");
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond")).toBe(false);
 await selectTaskMode("标准");
 expect(button("继续调查").disabled).toBe(false);
 await fill("investigationGoal","在同事项既有标准额度内处理");await click("发送追问");
 const calls=invoke.mock.calls.filter(([,p])=>p?.args?.action==="respond");expect(calls).toHaveLength(1);expect(calls[0][1].args.mode).toBe("quick");
});

function historyFixture():typeof current {
 const snapshot=makeView();Object.assign(snapshot.work,{revision:4,authorizationVersion:1});
 return {...snapshot,recordVersion:100,conversation:{messages:[{id:"work-1-goal",role:"user",text:"原始目标不可重复",createdAt:0},{id:"latest-answer",role:"assistant",runId:"latest-run",report:{...report,summary:"最新回答保留"},createdAt:9}],hasEarlier:true,nextCursor:"oldest-visible"}};
}
function earlierFixture() {
 return {workId:"work-1",workRevision:4,authorizationVersion:1,conversation:{messages:[{id:"work-1-goal",role:"user" as const,text:"原始目标不可重复",createdAt:0},{id:"older-answer",role:"assistant" as const,runId:"older-run",report:{...report,summary:"OLDER_HISTORY_VISIBLE"},createdAt:1}],hasEarlier:false,nextCursor:null}};
}
it("reads earlier history in the same Work without starting a model or duplicating the goal",async()=>{
 current=historyFixture();
 invoke.mockImplementation(async(_,{args})=>args.action==="list" ? {works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]} : args.action==="historyPage" ? earlierFixture() : current);
 await open();await click("查看更早记录");
 const messages=document.body.querySelector('.agent-messages')!;
 expect(messages.textContent).toContain("OLDER_HISTORY_VISIBLE");expect(messages.textContent).toContain("最新回答保留");
 expect(messages.textContent?.split("原始目标不可重复")).toHaveLength(2);
 expect(invoke.mock.calls.find(([,p])=>p?.args?.action==="historyPage")![1].args).toEqual({action:"historyPage",id:"work-1",before:"oldest-visible",expectedRevision:4,expectedAuthorizationVersion:1});
 expect(button("查看更早记录")).toBeUndefined();expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond")).toBe(false);
});
it.each([false,true])("discards delayed history after revocation including an uncertain outcome: %s",async uncertain=>{
 current=historyFixture();let release:(value:unknown)=>void=()=>{};let revokeStarted=false;
 invoke.mockImplementation(async(_,{args})=>{
  if(args.action==="list")return {works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]};
  if(args.action==="historyPage")return new Promise(resolve=>{release=resolve});
  if(args.action==="revoke"){revokeStarted=true;if(uncertain)throw Error("撤权回执丢失");current={...current,work:{...current.work,state:"revoked",report:null}};}
  if(args.action==="status"&&revokeStarted&&uncertain)throw Error("状态读取也失败");
  return current;
 });
 await open();await click("查看更早记录");await click("撤回来源授权");
 await act(async()=>{release(earlierFixture());await new Promise(resolve=>setTimeout(resolve,0));});
 expect(document.body.textContent).not.toContain("OLDER_HISTORY_VISIBLE");expect(document.body.querySelector('.agent-messages')).toBeNull();
 if(uncertain)expect(document.body.textContent).toContain("结果待核对");
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="historyPage")).toHaveLength(1);expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond")).toBe(false);
});
it("history read failure preserves the latest answer and permits one explicit read retry",async()=>{
 current=historyFixture();let fail=true;
 invoke.mockImplementation(async(_,{args})=>{
  if(args.action==="list")return {works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]};
  if(args.action==="historyPage"){if(fail)throw Error("历史读取连接中断");return earlierFixture();}return current;
 });
 await open();await click("查看更早记录");expect(document.body.textContent).toContain("历史读取连接中断");expect(document.body.textContent).toContain("最新回答保留");
 fail=false;await click("查看更早记录");expect(document.body.textContent).toContain("OLDER_HISTORY_VISIBLE");expect(document.body.textContent).not.toContain("历史读取连接中断");
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="historyPage")).toHaveLength(2);expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond")).toBe(false);
});
it("discards delayed history when the user switches to another Work",async()=>{
 current=historyFixture();let release:(value:unknown)=>void=()=>{};
 const other={...historyFixture(),work:{...historyFixture().work,id:"work-2",goal:"第二事项"},conversation:{messages:[{id:"work-2-goal",role:"user" as const,text:"第二事项当前内容",createdAt:0}],hasEarlier:false}};
 invoke.mockImplementation(async(_,{args})=>{
  if(args.action==="list")return {works:[{id:"work-1",goal:"第一事项",state:"completed"},{id:"work-2",goal:"第二事项",state:"completed"}]};
  if(args.action==="historyPage")return new Promise(resolve=>{release=resolve});
  if(args.action==="status"&&args.id==="work-2"){current=other;return other;}return current;
 });
 await open();await click("查看更早记录");
 await click("第二事项");
 await act(async()=>{release(earlierFixture());await new Promise(resolve=>setTimeout(resolve,0));});
 expect(document.body.querySelector('.agent-messages')?.textContent).toContain("第二事项当前内容");expect(document.body.textContent).not.toContain("OLDER_HISTORY_VISIBLE");
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond")).toBe(false);
});

it("adds selected materials with the same Work request before continuing and preserves the draft on rejection",async()=>{
 const fallback=invoke.getMockImplementation()!;
 const original={kind:"note",libraryId:"notes",documentId:"doc",pageId:null};
 const extra={locator:{...original,documentId:"second"},title:"新增材料",path:"second.md",libraryName:"工作笔记"};
 let reject=true;
 invoke.mockImplementation(async(command,params)=>{
   const args=params.args;
   if(args.action==="materials")return {notes:[extra],total:1,nextOffset:null,snapshot:"same"};
   if(args.action==="respond") {current=makeView();Object.assign(current.work,{revision:1,grant:{libraryIds:[],notes:[original]}});return current;}
   if(args.action==="message") {if(reject)throw new Error("事项版本已变化");return {...current,work:{...current.work,revision:2,grant:{libraryIds:[],notes:[original,extra.locator]},report:null}};}
   return fallback(command,params);
 });
 await open();await fill("investigationGoal","原要求保持");await click("开始调查");
 await openAddPage("从笔记库添加");
 await act(async()=>document.body.querySelector<HTMLInputElement>(".agent-material-choice input")!.click());
 await click("关闭添加菜单");await fill("investigationGoal","合并新材料，修订原成果");await click("发送追问");
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="respond")).toHaveLength(1);
 expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("合并新材料，修订原成果");
 const first=invoke.mock.calls.find(([,p])=>p?.args?.action==="message")![1].args;
 expect(first).toMatchObject({id:"work-1",expectedRevision:1,addNotes:[extra.locator]});
 reject=false;await click("发送追问");
 const messages=invoke.mock.calls.filter(([,p])=>p?.args?.action==="message");
 expect(messages[1][1].args.clientMessageId).toBe(first.clientMessageId);
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="create")).toHaveLength(1);
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="respond")).toHaveLength(2);
});
it("confirms withdrawal without a model and holds the shared outcome gate after two transport failures",async()=>{
 const fallback=invoke.getMockImplementation()!;
 const a={kind:"note",libraryId:"notes",documentId:"doc",pageId:null};
 const b={...a,documentId:"extra"};const material={locator:b,title:"附加材料",path:"extra.md",libraryName:"工作笔记"};
 let failStatus=false;let withdrawn=false;
 invoke.mockImplementation(async(command,params)=>{
   const args=params.args;
   if(args.action==="materials")return {notes:[material],total:1,nextOffset:null,snapshot:"same"};
   if(args.action==="respond"){current=makeView();Object.assign(current.work,{revision:1,grant:{libraryIds:[],notes:[a,b]}});return current;}
   if(args.action==="message"){withdrawn=true;failStatus=true;throw Error("回执连接中断");}
   if(args.action==="status"&&failStatus)throw Error("读取也失败");
   if(args.action==="status"&&withdrawn){current={...current,work:{...current.work,report:null}};Object.assign(current.work,{revision:2,grant:{libraryIds:[],notes:[a]}});return current;}
   return fallback(command,params);
 });
 await open();await fill("investigationGoal","原要求");await click("开始调查");
 await openAddPage("从笔记库添加");
 await click("撤回授权 附加材料");await click("确认撤回所选授权");
 const sent=invoke.mock.calls.find(([,p])=>p?.args?.action==="message")![1].args;
 expect(sent).toMatchObject({id:"work-1",expectedRevision:1,removeNotes:[b]});
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="respond")).toHaveLength(1);
 expect(document.body.textContent).toContain("结果待核对");
 expect(button("确认撤回所选授权").disabled).toBe(true);
 await click("确认撤回所选授权");expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="message")).toHaveLength(1);
 failStatus=false;await click("核对当前结果");
 expect(document.body.querySelector('[aria-label="操作结果待核对"]')).toBeNull();
 expect(document.body.textContent).not.toContain("待撤回 1");
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="respond")).toHaveLength(1);
});
function resizePointer(type: string, clientX: number, pointerId = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: pointerId }, clientX: { value: clientX } });
  return event;
}
async function openResizeDock(initialWidth = 1000) {
  let width = initialWidth;
  host.className = "preview-pane";
  Object.defineProperty(document.body, "clientWidth", { configurable: true, get: () => width });
  await act(async () => root.render(<div className="preview-card"><AgentInvestigation result={result} /></div>));
  await click("调查这篇笔记");
  return {
    separator: document.body.querySelector<HTMLElement>('[aria-label="调整助手宽度"]')!,
    resize: async (next: number) => { width = next; await act(async () => window.dispatchEvent(new Event("resize"))); },
    width: () => Number.parseInt(document.body.style.getPropertyValue("--agent-panel-width")),
  };
}
it("drags the floating panel height, clamps to the viewport and keeps the draft",async()=>{
 await openResizeDock();await fill("investigationGoal","拖拽高度时保留草稿");
 const edge=document.body.querySelector<HTMLElement>('[aria-label="调整助手高度"]')!;
 const value=()=>Number.parseInt(document.body.style.getPropertyValue('--agent-panel-height'));
 const pointer=(type:string,y:number,id=1)=>{const event=resizePointer(type,0,id);Object.defineProperty(event,'clientY',{value:y});return event;};
 const initial=value();await act(async()=>edge.dispatchEvent(pointer('pointerdown',400)));
 await act(async()=>window.dispatchEvent(pointer('pointermove',320,2)));expect(value()).toBe(initial);
 await act(async()=>window.dispatchEvent(pointer('pointermove',320)));expect(value()).toBe(initial+80);
 await act(async()=>window.dispatchEvent(pointer('pointermove',-2000)));expect(value()).toBe(window.innerHeight-24);
 await act(async()=>window.dispatchEvent(pointer('pointermove',2000)));expect(value()).toBe(320);
 await act(async()=>window.dispatchEvent(pointer('pointercancel',2000)));expect(document.body.classList.contains('resizing-agent-panel-height')).toBe(false);
 await act(async()=>window.dispatchEvent(pointer('pointermove',200)));expect(value()).toBe(320);
 await act(async()=>edge.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true})));expect(value()).toBe(330);
 await act(async()=>edge.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));expect(value()).toBe(initial);
 expect(document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("拖拽高度时保留草稿");
 await click("关闭助手");expect(document.body.style.getPropertyValue('--agent-panel-height')).toBe('');
});
it("restores both dimensions in a newly mounted floating assistant and respects a smaller viewport",async()=>{
 const dock=await openResizeDock();
 const height=document.body.querySelector<HTMLElement>('[aria-label="调整助手高度"]')!;
 await act(async()=>dock.separator.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',shiftKey:true,bubbles:true})));
 await act(async()=>height.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',shiftKey:true,bubbles:true})));
 const savedWidth=dock.width(),savedHeight=Number.parseInt(document.body.style.getPropertyValue('--agent-panel-height'));
 expect(localStorage.getItem('hub.agent.panel.width.v1')).toBe(String(savedWidth));
 expect(localStorage.getItem('hub.agent.panel.height.v1')).toBe(String(savedHeight));
 await act(async()=>root.render(null));const next=await openResizeDock();
 expect(next.width()).toBe(savedWidth);expect(Number.parseInt(document.body.style.getPropertyValue('--agent-panel-height'))).toBe(savedHeight);
 await next.resize(400);expect(next.width()).toBe(376);expect(localStorage.getItem('hub.agent.panel.width.v1')).toBe(String(savedWidth));
 await next.resize(1000);expect(next.width()).toBe(savedWidth);
});
it("ignores invalid persisted panel dimensions without preventing the assistant from opening",async()=>{
 localStorage.setItem('hub.agent.panel.width.v1','NaN');localStorage.setItem('hub.agent.panel.height.v1','-20');
 const dock=await openResizeDock();expect(dock.width()).toBe(440);
 expect(Number.parseInt(document.body.style.getPropertyValue('--agent-panel-height'))).toBe(Math.max(320,Math.round(window.innerHeight/2)));
});
it("resizes the assistant from its divider, clamps to the viewport limits and releases the drag", async () => {
  const dock = await openResizeDock();
  expect(dock.separator.getAttribute("aria-valuenow")).toBe("440");
  await act(async () => dock.separator.dispatchEvent(resizePointer("pointerdown", 600)));
  await act(async () => window.dispatchEvent(resizePointer("pointermove", 400, 2)));
  expect(dock.width()).toBe(440);
  await act(async () => window.dispatchEvent(resizePointer("pointermove", 400)));
  expect(dock.width()).toBe(640);
  await openAddPage("更多设置");
  expect([...document.body.querySelectorAll<HTMLInputElement>('[type="range"]')].map(input => input.value)).toEqual(["640"]);
  await act(async () => window.dispatchEvent(resizePointer("pointermove", 900)));
  expect(dock.width()).toBe(140);
  await act(async () => window.dispatchEvent(resizePointer("pointerup", 900)));
  expect(document.body.classList.contains("resizing-agent-panel")).toBe(false);
  await act(async () => window.dispatchEvent(resizePointer("pointermove", 400)));
  expect(dock.width()).toBe(140);
  await act(async () => dock.separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(dock.width()).toBe(440);
  expect(invoke.mock.calls.map(([, { args }]) => args.action)).toEqual(["list", "list"]);
});
it("keeps divider, sliders and keyboard adjustment aligned when the viewport becomes narrower", async () => {
  const dock = await openResizeDock();
  await act(async () => dock.separator.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(dock.width()).toBe(976);
  await dock.resize(720);
  expect(dock.width()).toBe(696);
  expect(dock.separator.getAttribute("aria-valuemax")).toBe("696");
  await act(async () => dock.separator.dispatchEvent(resizePointer("pointerdown", 600)));
  await act(async () => window.dispatchEvent(resizePointer("pointermove", 610)));
  expect(dock.width()).toBe(686);
  await act(async () => window.dispatchEvent(resizePointer("pointerup", 610)));
  await act(async () => dock.separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(dock.width()).toBe(0);
  await act(async () => dock.separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true })));
  expect(dock.width()).toBe(40);
  await act(async () => dock.separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(dock.width()).toBe(440);
});
it("ends a cancelled or closed divider drag without losing the conversation draft", async () => {
  const dock = await openResizeDock(); await fill("investigationGoal", "保留这条未发送草稿");
  await act(async () => dock.separator.dispatchEvent(resizePointer("pointerdown", 600)));
  await act(async () => window.dispatchEvent(resizePointer("pointermove", 560)));
  await act(async () => window.dispatchEvent(resizePointer("pointercancel", 560)));
  expect(document.body.classList.contains("resizing-agent-panel")).toBe(false);
  expect(dock.width()).toBe(480);
  await act(async () => dock.separator.dispatchEvent(resizePointer("pointerdown", 600)));
  await click("关闭助手");
  expect(document.body.classList.contains("resizing-agent-panel")).toBe(false);
  await act(async () => window.dispatchEvent(resizePointer("pointermove", 400)));
  await click("调查这篇笔记");
  expect(dock.width()).toBe(480);
  expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("保留这条未发送草稿");
  expect(invoke.mock.calls.some(([, { args }]) => args.action === "respond")).toBe(false);
});
it("mirrors divider movement for an RTL preview", async () => {
  document.body.style.direction = "rtl";
  const dock = await openResizeDock();
  await act(async () => dock.separator.dispatchEvent(resizePointer("pointerdown", 600)));
  await act(async () => window.dispatchEvent(resizePointer("pointermove", 640)));
  expect(dock.width()).toBe(480);
  await act(async () => window.dispatchEvent(resizePointer("pointerup", 640)));
  await act(async () => dock.separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(dock.width()).toBe(490);
});
it("grants only explicitly selected extra documents across libraries before the first model run",async()=>{
 const fallback=invoke.getMockImplementation()!;
 const other={locator:{kind:"note",libraryId:"other",documentId:"two",pageId:null},title:"另一份材料",path:"two.md",libraryName:"另一库"};
 invoke.mockImplementation(async(command,params)=>params.args.action==="materials"?{notes:[other],total:1,nextOffset:null,snapshot:"snapshot"}:fallback(command,params));
 await open();await openAddPage("从笔记库添加");
 await act(async()=>document.body.querySelector<HTMLInputElement>(".agent-material-choice input")!.click());
 await click("关闭添加菜单");await fill("investigationGoal","比较这两篇材料");await click("开始调查");
 const create=invoke.mock.calls.find(([,p])=>p?.args?.action==="create")![1].args;
 expect(create.grant.libraryIds).toEqual([]);expect(create.grant.notes).toEqual([{kind:"note",libraryId:"notes",documentId:"doc",pageId:null},other.locator]);
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="respond")).toHaveLength(1);
});
it("sends an additional user instruction into the active native turn without starting another run",async()=>{
  vi.useFakeTimers();
  let finish:(value:typeof current)=>void=()=>{};
  const fallback=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command,params)=>{
    if(params.args.action==='respond'){
      current={...makeView('investigating'),activity:[{runId:'native-run',revision:1,state:'investigating',running:true,native:true,canSteer:true,startedAt:Date.now(),steps:0,events:[]} ]};
      return await new Promise<typeof current>(resolve=>{finish=resolve;});
    }
    if(params.args.action==='followup') return current;
    return fallback(command,params);
  });
  await open();await fill('investigationGoal','整理这篇笔记');await click('开始调查');
  await act(async()=>vi.advanceTimersByTime(1600));
  expect(button('追加要求')).toBeUndefined();
  expect(button('停止本轮').textContent).toBe('');
  expect(button('停止本轮').querySelector('svg')).not.toBeNull();
  expect(button('停止本轮').getAttribute('type')).toBe('button');
  expect(document.body.querySelector<HTMLElement>('.agent-status')?.hidden).toBe(true);
  await fill('investigationGoal','请同时核对日期范围');await click('追加要求');
  expect(invoke.mock.calls.find(([,p])=>p?.args?.action==='followup')?.[1].args).toMatchObject({id:'work-1',deliveryMode:'steer',text:'请同时核对日期范围'});
  expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==='respond')).toHaveLength(1);
  expect(button('停止本轮')).toBeDefined();
  await act(async()=>finish(makeView()));
});
it("opens the original-note editor without starting an investigation or a model call", async () => {
  await open();
  await click("修改这篇 Obsidian 笔记");
  const actions = invoke.mock.calls.filter(([command]) => command === "agent_investigation").map(([, { args }]) => args.action);
  expect(actions).toEqual(["list", "list", "create", "list"]);
  const create = invoke.mock.calls.find(([, { args }]) => args.action === "create")![1].args;
  expect(create.anchor).toEqual({ kind: "note", libraryId: "notes", documentId: "doc", pageId: null });
  expect(create.grant.libraryIds).toEqual([]);
  expect(actions).not.toContain("respond");
  expect(document.body.querySelector<HTMLDetailsElement>(".agent-more-tools")?.open).toBe(true);
  expect(document.body.querySelector<HTMLDetailsElement>(".agent-dialogue-details")?.open).toBe(true);
  expect(document.body.querySelector<HTMLElement>(".agent-details-sections")?.hidden).toBe(false);
  expect(document.body.querySelector(".agent-more-tools")?.closest("[hidden]")).toBeNull();
});
it("opens a separate assistant, fills suggestions without sending, and restores focus and draft after Escape", async () => {
  await open();
  const panel = document.body.querySelector<HTMLElement>('[aria-label="Hub 助手"]')!;
  expect(host.contains(panel)).toBe(false);
  expect(document.activeElement?.getAttribute("name")).toBe("investigationGoal");
  expect(panel.querySelector(".agent-context")?.textContent).toContain("安装方案");
  await click("概括主要内容");
  const input = panel.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!;
  expect(input.value).toContain("概括当前材料");
  expect(invoke.mock.calls.map(([, { args }]) => args.action)).toEqual(["list", "list"]);
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(panel.hidden).toBe(true);
  expect(document.activeElement).toBe(document.body.querySelector(".agent-floating-launcher"));
  await click("调查这篇笔记");
  expect(panel.hidden).toBe(false);
  expect(input.value).toContain("概括当前材料");
  expect(invoke.mock.calls.map(([, { args }]) => args.action)).toEqual(["list", "list"]);
});
it("keeps settings collapsed until requested and preserves the explicit library choice while reopening", async () => {
  libraryInventory.value=[noteLibrary];
  await open();
  expect(document.body.querySelector(".agent-settings")).toBeNull();
  await openAddPage("资料范围");
  const settings = document.body.querySelector<HTMLElement>(".agent-settings")!;
  expect(settings.closest('.agent-add-menu')).not.toBeNull();
  expect(settings.textContent).toContain('这里决定助手可以读取哪些资料');
  expect(settings.querySelector('[type="range"]')).toBeNull();
  const picker=document.body.querySelector<HTMLInputElement>('[aria-label="允许查找 工作笔记"]')!;
  expect(picker.checked).toBe(false);
  await act(async () => picker.click());
  expect(settings.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(true);
  await click("关闭助手"); await click("调查这篇笔记");
  await openAddPage("资料范围");
  expect(document.body.querySelector<HTMLInputElement>('.agent-settings [type="checkbox"]')!.checked).toBe(true);
  expect(document.body.querySelector<HTMLInputElement>('[aria-label="允许查找 工作笔记"]')!.checked).toBe(true);
  expect(document.body.querySelector(".agent-scope-trigger")?.textContent).toContain("工作笔记");
  expect(invoke.mock.calls.some(([, { args }]) => args.action === "respond")).toBe(false);
});
it("switching the source preserves the active conversation and draft until the user starts with the new material", async () => {
  await open(); await fill("investigationGoal", "旧资料的问题");
  await act(async () => root.render(<AgentInvestigation result={{ ...result, documentId: "other", title: "另一篇材料" }} compact />));
  expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("旧资料的问题");
  expect(document.body.querySelector(".agent-context")?.textContent).toContain("安装方案");
  await click("用当前材料新建对话");
  expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("");
  expect(document.body.querySelector(".agent-context")?.textContent).toContain("另一篇材料");
});
it("the header new-conversation action uses the current page and does not auto-open its old Work",async()=>{
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:"old-work",goal:"已保存的旧对话",state:"completed"}]}:current);
 await open();const statusBefore=invoke.mock.calls.filter(([,p])=>p?.args?.action==="status").length;
 await act(async()=>root.render(<AgentInvestigation result={{...result,documentId:"new-page",title:"正在浏览的页面"}}/>));
 await click("新对话");
 expect(document.body.querySelector('.agent-context')?.textContent).toContain("正在浏览的页面");
 expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("");
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="list").slice(-1)[0][1].args.anchor).toBeNull();
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="status")).toHaveLength(statusBefore);
 expect(document.body.textContent).not.toContain("先验证现有接口");
 expect(invoke.mock.calls.some(([,p])=>["create","respond","revoke","cancelGoal"].includes(p?.args?.action))).toBe(false);
});
it("removes and reattaches the pending page without reading it or discarding the typed question",async()=>{
 await open();await fill("investigationGoal","保留这段问题");await click("移除当前页面");
 expect(document.body.querySelector('.agent-pending-materials')).toBeNull();expect(button("开始调查").disabled).toBe(false);
 expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("保留这段问题");
 expect(invoke.mock.calls.some(([,p])=>["create","respond","source"].includes(p?.args?.action))).toBe(false);
 await act(async()=>{const d=document.body.querySelector<HTMLDetailsElement>('.agent-add-menu')!;d.open=true;d.dispatchEvent(new Event('toggle'));});
 await click("添加资料");await click("添加当前页面");expect(document.body.querySelector('.agent-context')?.textContent).toContain("安装方案");expect(button("开始调查").disabled).toBe(false);
});
it("draft scope shows no material after removal and restores the explicit page",async()=>{
 await open();await fill("investigationGoal","保留问题");await click("移除当前页面");await openAddPage("资料范围");
 const summary=()=>document.body.querySelector('.agent-material-advanced > .agent-note')!.textContent;
 expect(summary()).toContain("未添加资料，可直接对话");expect(summary()).not.toContain("安装方案");
 expect(button("开始调查").disabled).toBe(false);
 await click("返回");await click("添加资料");await click("添加当前页面");await openAddPage("资料范围");
 expect(summary()).toContain("当前范围：安装方案，另有 0 份资料");expect(button("开始调查").disabled).toBe(false);
 expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("保留问题");
 expect(invoke.mock.calls.some(([,p])=>["create","respond","revoke","source"].includes(p?.args?.action))).toBe(false);
});
it("draft scope counts the replacement primary only once and follows remaining selected notes",async()=>{
 const notes=["替换资料","第二份资料"].map((title,index)=>({locator:{kind:"note",libraryId:"other",documentId:`replacement-${index}`,pageId:null},title,path:`${index}.md`,libraryName:"其他库"}));
 const base=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,payload)=>payload.args.action==="materials"?{notes,total:2,nextOffset:null,snapshot:"replacement"}:base(command,payload));
 await open();await click("移除当前页面");await openAddPage("从笔记库添加");
 await act(async()=>document.body.querySelector<HTMLInputElement>('.agent-material-choice input')!.click());
 await click("返回");await openAddPage("资料范围");
 const summary=()=>document.body.querySelector('.agent-material-advanced > .agent-note')!.textContent;
 expect(summary()).toContain("当前范围：替换资料，另有 0 份资料");expect(summary()).not.toContain("安装方案");
 await click("返回");await click("添加资料");
 await act(async()=>document.body.querySelectorAll<HTMLInputElement>('.agent-material-choice input')[1].click());
 await click("返回");await openAddPage("资料范围");expect(summary()).toContain("当前范围：替换资料，另有 1 份资料");
 await click("移除材料 替换资料");await openAddPage("资料范围");expect(summary()).toContain("当前范围：第二份资料，另有 0 份资料");
 await click("移除材料 第二份资料");await openAddPage("资料范围");expect(summary()).toContain("未添加资料");
 expect(invoke.mock.calls.some(([,p])=>["create","respond","revoke","source"].includes(p?.args?.action))).toBe(false);
});
it("a replacement pending note becomes the actual request anchor and excludes the removed page",async()=>{
 const other={locator:{kind:"note",libraryId:"other",documentId:"replacement",pageId:null},title:"替换资料",path:"替换.md",libraryName:"其他库"};
 const base=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,payload)=>{
  if(payload.args.action==="materials")return {notes:[other],total:1,nextOffset:null,snapshot:"replacement"};
  if(payload.args.action==="create")throw new Error("合成夹具：在模型前停止");
  return base(command,payload);
 });
 await open();await click("移除当前页面");await openAddPage("从笔记库添加");
 await act(async()=>document.body.querySelector<HTMLInputElement>('.agent-material-choice input')!.click());
 await click("关闭添加菜单");await fill("investigationGoal","概括替换资料");await click("开始调查");
 const sent=invoke.mock.calls.find(([,p])=>p?.args?.action==="create")![1].args;
 expect(sent.anchor).toEqual(other.locator);expect(sent.grant).toMatchObject({libraryIds:[],notes:[other.locator]});
 expect(document.body.querySelector('.agent-pending-materials')?.textContent).not.toContain("安装方案");
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond")).toBe(false);
 await click("移除材料 替换资料");expect(button("开始调查").disabled).toBe(false);
});
it("keeps historical authorization out of pending attachments and removes the permanent shortcut hint",async()=>{
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]}:current);
 await open();expect(document.body.querySelector('.agent-composer .agent-pending-materials')).toBeNull();
 expect(document.body.querySelector('.agent-composer')?.textContent).not.toContain("Ctrl+Enter");
 expect(document.body.querySelector('.agent-send')?.getAttribute('aria-keyshortcuts')).toContain('Control+Enter');
 expect(invoke.mock.calls.some(([,p])=>["revoke","message","respond"].includes(p?.args?.action))).toBe(false);
});
it("mounts the assistant independently and toggles the sidebar without replacing the document", async () => {
  host.className = "preview-pane";
  await open();
  const panel = document.body.querySelector(".agent-panel")!;
  expect(panel.parentElement).toBe(document.body);
  await click("展开为侧边栏");
  expect(document.body.classList.contains("agent-sidebar-open")).toBe(true);
  expect(host.querySelector(".agent-launcher")?.getAttribute("aria-controls")).toBe(panel.id);
  await click("关闭助手");
  expect(document.activeElement).toBe(document.body.querySelector(".agent-floating-launcher"));
});
it("binds preflight memory before the first model call and stops if binding fails", async () => {
  for (const reject of [false, true]) {
    await act(async () => root.unmount()); root = createRoot(host);
    invoke.mockReset().mockImplementation(async (command, { args }) => {
      if (command === 'shared_memory') {
        if (args.action === 'selectScope' && reject) throw new Error('范围绑定失败');
        return { configured: true, entries: [], projects: [], selection: { projectId: '', enabled: false } };
      }
      if (args.action === 'list') return { works: [] };
      return makeView(args.action === 'create' ? 'ready' : 'completed');
    });
    await open();
    const memory = Array.from(document.body.querySelectorAll('details')).find(detail => detail.querySelector('summary')?.textContent?.includes('记忆'))!;
    await act(async () => { memory.open = true; memory.dispatchEvent(new Event('toggle')); });
    await act(async () => memory.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
    await fill('investigationGoal', '沿用当前项目决定'); await click('开始调查');
    const calls = invoke.mock.calls.map(([command, { args }]) => `${command}:${args.action}`);
    expect(calls).toContain('shared_memory:selectScope');
    if (reject) {
      expect(calls).not.toContain('agent_investigation:respond');
      expect(document.body.textContent).toContain('范围绑定失败');
    } else expect(calls.indexOf('shared_memory:selectScope')).toBeLessThan(calls.indexOf('agent_investigation:respond'));
  }
});

it("does not analyze automatically and defaults to an exact note grant", async () => {
  libraryInventory.value=[noteLibrary];
  await act(async () => root.render(<AgentInvestigation result={result} />));
  expect(invoke).not.toHaveBeenCalled();
  await click("调查这篇笔记");
  expect(invoke.mock.calls.map(([, { args }]) => args.action)).toEqual(["list", "list"]);
  await openAddPage("资料范围");
  expect(document.body.querySelector<HTMLInputElement>('[aria-label="允许查找 工作笔记"]')!.checked).toBe(false);
  expect(document.body.querySelector<HTMLInputElement>('.agent-settings [type="checkbox"]')!.checked).toBe(false);
  await fill("investigationGoal", "核对安装方案"); await click("开始调查");
  const create = invoke.mock.calls.find(([, { args }]) => args.action === "create")![1].args;
  expect(create.grant).toEqual({ libraryIds: [], notes: [{ kind: "note", libraryId: "notes", documentId: "doc", pageId: null }], readingItemKeys: [] });
  expect(document.body.textContent).toContain("历史记录要求保持 M6");
  expect(document.body.textContent).not.toContain("建议本身不会执行业务操作");
  expect(document.body.querySelector('[role="status"]')).not.toBeNull();
});
it("whole-library access requires the user's explicit checkbox selection", async () => {
  libraryInventory.value=[noteLibrary];
  await open(); await fill("investigationGoal", "查找相关记录");
  await openAddPage("资料范围");
  const checkbox=document.body.querySelector<HTMLInputElement>('[aria-label="允许查找 工作笔记"]')!;
  expect(checkbox.checked).toBe(false);
  expect(invoke.mock.calls.some(([, { args }]) => ["create","message","respond"].includes(args.action))).toBe(false);
  await act(async () => checkbox.click());
  expect(document.body.querySelector<HTMLInputElement>('.agent-settings [type="checkbox"]')!.checked).toBe(true);
  await click("开始调查");
  const calls=invoke.mock.calls.map(([, { args }])=>args);
  expect(calls.find(args=>args.action==="create").grant).toEqual({libraryIds:[],notes:[investigationAnchor(result)],readingItemKeys:[]});
  const bindings=calls.filter(args=>args.action==="message"&&args.setLibraryIds);
  expect(bindings).toHaveLength(1);expect(bindings[0].setLibraryIds).toEqual(["notes"]);
  // The host's setLibraryIds operation binds note/task and attachment scopes
  // together; this must finish before the first model response is requested.
  expect(calls.indexOf(bindings[0])).toBeLessThan(calls.findIndex(args=>args.action==="respond"));
});
it("loads an existing interrupted work without starting a model", async () => {
  current = makeView("interrupted");
  invoke.mockImplementation(async (_, { args }) => args.action === "list" ? { works: [{ id: "work-1", goal: current.work.goal, state: "interrupted" }] } : current);
  await open();
  expect(document.body.textContent).toContain("已中断，可继续");
  expect(button("继续调查")).toBeTruthy();
  expect(invoke.mock.calls.some(([, { args }]) => args.action === "respond")).toBe(false);
});
it.each([
  { initialState: "ready", label: "继续调查", action: "respond", kind: "continue" },
  { initialState: "paused", label: "恢复并继续", action: "resume", kind: "resume" },
])("records native UI timing for a prepared work's $kind action", async ({ initialState, label, action, kind }) => {
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  current = makeView(initialState);
  Object.assign(current, { nativeTiming: { hostEpochMs: Date.now(), projectionMs: 1 } });
  if (action === "resume") Object.assign(current, { lifecycle: { schemaVersion: 1, controlRevision: 1, workRevision: 1, activeRunId: null, state: "paused", requiresExplicitResume: true, canResume: true, recoveryMode: "newRun", runsUsed: 1, runLimit: 8, unresolvedActions: 0, reason: "用户停止", recordedUsage: {} } });
  invoke.mockImplementation(async (_, { args }) => {
    if (args.action === "list") return { works: [{ id: "work-1", goal: current.work.goal, state: initialState }] };
    if (args.action === "uiTimingClock") return { hostEpochMs: performance.timeOrigin + performance.now() };
    if (args.action === action) current = Object.assign(makeView(), { run: { id: "continued-run", usage: {} }, nativeTiming: { hostEpochMs: Date.now(), projectionMs: 1 } });
    return current;
  });
  try {
    await open(); await click(label);
    for (let i = 0; i < 2; i++) {
      const pending = [...frames.values()]; frames.clear();
      await act(async () => pending.forEach(fn => fn(performance.now())));
    }
    const timings = invoke.mock.calls.filter(([, { args }]) => args.action === "uiTiming");
    expect(timings).toHaveLength(1);
    const args = timings[0][1].args;
    expect(args.id).toBe("work-1"); expect(args.runId).toBe("continued-run");
    expect(args.sample.kind).toBe(kind);
    expect(args.sample.uiFirstFeedbackMs).toBeTypeOf("number");
    expect(args.sample.uiDoneMs).toBeGreaterThanOrEqual(args.sample.uiSubmitMs);
  } finally { vi.unstubAllGlobals(); }
});
const partial: Progress = { runId: "run-partial", state: "interrupted", evidence: [{ evidenceId: "e1", excerpt: { title: "接口人矩阵", sourcePath: "接口人矩阵.md", content: "功放接口由设备组核对", startChar: 0, endChar: 11, totalChars: 11, truncated: false } }], candidates: [{ title: "功放安装示例", snippet: "连接安装与信号接口" }], intents: [{ turn: 1, message: "查找设备之间的接口关系" }], searches: [{ query: "功放", count: 1 }, { query: "不存在的资料", count: 0 }], withheld: 0, validity: "" };
it("shows persisted material before run controls after the final model call fails", async () => {
  current = { ...makeView("interrupted"), progress: partial };
  invoke.mockImplementation(async (_, { args }) => args.action === "list" ? { works: [{ id: "work-1", goal: current.work.goal, state: current.work.state }] } : current);
  await open();
  expect(document.body.textContent).toContain("已取得的材料");
  expect(document.body.textContent).toContain("功放安装示例");
  expect(document.body.textContent).toContain("功放接口由设备组核对");
  expect(document.body.textContent).toContain("不存在的资料”：未命中");
  expect(document.body.textContent).toContain("尚未形成完整结论");
  expect(document.body.textContent).not.toContain("查明的情况");
  expect(document.body.querySelector(".agent-conversation")?.textContent).toContain("功放安装示例");
  expect(document.body.querySelector(".agent-dialogue-details")?.textContent).toContain("来源范围与本轮用量");
  expect(invoke.mock.calls.some(([, { args }]) => args.action === "respond")).toBe(false);
});
it("keeps prior delivered evidence in a labeled history while a new run is pending", async () => {
  current = { ...makeView("interrupted"), history: [{ runId: "old-run", createdAt: 1000, report, evidence: makeView().evidence, validity: "你已补充或纠正决定；这是当时的结果，需要重新核对" }] };
  invoke.mockImplementation(async (_, { args }) => args.action === "list" ? { works: [{ id: "work-1", goal: current.work.goal, state: current.work.state }] } : current);
  await open();
  expect(document.body.querySelector(".agent-history")?.textContent).toContain("历史记录要求保持 M6");
  expect(document.body.querySelector(".agent-history")?.textContent).toContain("这是当时的结果");
  expect(document.body.querySelector(".agent-citation summary")?.textContent).toContain("历史决定");
  expect(document.body.querySelector(".agent-body > .agent-report")).toBeNull();
});
it("hides partial and historical text after revocation even if an older snapshot still contains it", async () => {
  current = { ...makeView("revoked"), progress: partial, history: [{ runId: "old-run", createdAt: 1000, report, evidence: makeView().evidence, validity: "历史结果" }] };
  invoke.mockImplementation(async (_, { args }) => args.action === "list" ? { works: [{ id: "work-1", goal: current.work.goal, state: current.work.state }] } : current);
  await open();
  expect(document.body.textContent).not.toContain("功放安装示例");
  expect(document.body.textContent).not.toContain("功放接口由设备组核对");
  expect(document.body.textContent).not.toContain("历史记录要求保持 M6");
  expect(document.body.querySelector(".agent-progress")).toBeNull();
  expect(document.body.querySelector(".agent-history")).toBeNull();
});
it("shows host recovery within the current budget without starting another frontend run", async () => {
  const original=invoke.getMockImplementation()!;
  let recovered=false;
  invoke.mockImplementation(async (command, options) => {
    const value=await original(command,options);
    if(options.args.action==="respond") recovered=true;
      return recovered && ["respond","status"].includes(options.args.action) ? {...value,run:{usage:{modelCalls:4,modelRetries:1,outputRepairs:1,entitiesRead:2,bodyChars:100}}} : value;
  });
  await open(); await fill("investigationGoal","核对方案"); await click("开始调查");
  expect(document.body.textContent).toContain("模型超时后已重试 1 次，计入本轮调用次数与总时限");
    expect(document.body.textContent).toContain("结果核验后已纠错 1 次，计入本轮调用次数与总时限");
    expect(document.body.textContent).toContain("本轮已调用 4 次");
  expect(invoke.mock.calls.filter(([, {args}])=>args.action==="respond")).toHaveLength(1);
});
it("explicitly confirmed messages remain decisions while using the same input and automatically continuing", async () => {
  await open(); await fill("investigationGoal", "核对方案"); await click("开始调查");
  await fill("investigationGoal", "保留现有固定架");
  await openAddPage("更多设置");
  const confirmed=document.body.querySelector<HTMLInputElement>('.agent-confirm-message input')!;
  await act(async()=>confirmed.click()); await click("发送追问");
  expect(invoke).toHaveBeenCalledWith("agent_investigation", { args: { action: "decision", id: "work-1", text: "保留现有固定架" } });
  expect(invoke.mock.calls.filter(([, {args}])=>args.action==="respond")).toHaveLength(2);
  expect(document.body.querySelector('[name="investigationDecision"]')).toBeNull();
});
it("prepares a business draft and submits only its explicit confirmation, then refreshes the real status", async () => {
  const payload = { tag: "验证", decision: "recommend_add", quote: "保持 M6", rationale: "有明确的接口约束", risks: "需复核", confidence: 0.8, reconsiderationReason: "" };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, options) => {
    if (options.args.action === "prepareTagProposal") {
      current = { ...makeView(), actions: { tagOptions: ["验证"], items: [{ id: "a-1", state: "prepared", payload, confirmationToken: "bound-token" }] } };
      return current;
    }
    if (options.args.action === "submitTagProposal") {
      current = { ...makeView("expired"), actions: { tagOptions: ["验证"], items: [{ id: "a-1", state: "verified", payload, receipt: { goalCompleted: false, result: { proposal: { proposalId: "p-1", tag: "验证", status: "pending" } } }, currentProposal: { proposalId: "p-1", tag: "验证", status: "pending" } }] } };
      return current;
    }
    const value = await original(command, options);
    if (options.args.action === "respond") { current = { ...value, actions: { tagOptions: ["验证"], items: [] } }; return current; }
    return value;
  });
  await open(); await fill("investigationGoal", "核对方案"); await click("开始调查");
  await act(async () => { const select = document.body.querySelector<HTMLSelectElement>('[name="agentActionTag"]')!; select.value = "验证"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click("准备补标建议");
  expect(invoke.mock.calls.some(([, { args }]) => args.action === "submitTagProposal")).toBe(false);
  expect(document.body.textContent).toContain("有明确的接口约束");
  await click("提交「验证」到待审核");
  expect(invoke).toHaveBeenCalledWith("agent_investigation", { args: { action: "submitTagProposal", id: "work-1", actionId: "a-1", confirmationToken: "bound-token" } });
  expect(document.body.textContent).toContain("标签审核状态：待审核");
  expect(document.body.textContent).not.toContain("历史记录要求保持 M6");
  expect(document.body.textContent).toContain("需要重新核对来源");
});
it("keeps stop and revoke available while preparing a business draft", async () => {
  let finish!: () => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, options) => {
    if (options.args.action === "prepareTagProposal") {
      current = { ...current, actionActive: true };
      return new Promise(resolve => { finish = () => resolve(current); });
    }
    const value = await original(command, options);
    if (options.args.action === "respond") { current = { ...value, actions: { tagOptions: ["验证"], items: [] } }; return current; }
    return value;
  });
  await open(); await fill("investigationGoal", "核对方案"); await click("开始调查");
  await act(async () => { const select = document.body.querySelector<HTMLSelectElement>('[name="agentActionTag"]')!; select.value = "验证"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click("准备补标建议");
  expect(button("停止本轮").disabled).toBe(false);
  expect(button("撤回来源授权").disabled).toBe(false);
  expect(document.body.textContent).toContain("正在处理补标建议");
  await click("撤回来源授权");
  await act(async () => finish());
  expect(document.body.textContent).toContain("授权已撤回");
  expect(invoke.mock.calls.some(([, { args }]) => args.action === "submitTagProposal")).toBe(false);
});
it("restores keyboard focus to the announced receipt even when the work state stays unchanged", async () => {
  const payload = { tag: "验证", decision: "recommend_add", quote: "保持 M6", rationale: "接口约束", risks: "", confidence: 0.8, reconsiderationReason: "" };
  current = { ...makeView("interrupted"), actions: { tagOptions: ["验证"], items: [{ id: "a-1", state: "prepared", payload, confirmationToken: "bound-token" }] } };
  invoke.mockImplementation(async (_, { args }) => {
    if (args.action === "list") return { works: [{ id: "work-1", goal: current.work.goal, state: current.work.state }] };
    if (args.action === "submitTagProposal") current = { ...current, actions: { tagOptions: ["验证"], items: [{ id: "a-1", state: "verified", payload, receipt: { goalCompleted: false, result: { proposal: { proposalId: "p-1", tag: "验证", status: "pending" } } }, currentProposal: { proposalId: "p-1", tag: "验证", status: "pending" } }] } };
    return current;
  });
  await open();
  const submit=await revealButton("提交「验证」");
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
  submit.focus();expect(document.activeElement).toBe(submit);
  await click("提交「验证」");
  expect(document.activeElement).toBe(document.body.querySelector('[role="status"]'));
  expect(document.activeElement?.textContent).toContain("补标提交结果已核验");
});
it("keeps stop available while the native model invocation is pending", async () => {
  let finish!: () => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, options) => {
    if (options.args.action === "respond") { current = makeView("investigating"); return new Promise(resolve => { finish = () => resolve(current); }); }
    return original(command, options);
  });
  await open(); await fill("investigationGoal", "核对方案"); await click("开始调查");
  expect(button("停止本轮").disabled).toBe(false); await click("停止本轮");
  expect(invoke).toHaveBeenCalledWith("agent_investigation", { args: { action: "cancel", id: "work-1" } });
  await act(async () => finish());
  expect(document.body.textContent).toContain("已中断，可继续");
});
it("withdraws the source grant without changing source business objects", async () => {
  await open(); await fill("investigationGoal", "核对方案"); await click("开始调查"); await click("撤回来源授权");
  expect(document.body.textContent).toContain("授权已撤回");
  expect(invoke.mock.calls.every(([command]) => command === "agent_investigation")).toBe(true);
});
it.each(["paused","cancelled","failed"])("verifies lifecycle before reporting a late run error after stop (%s)",async state=>{
 let rejectRun!:(reason:Error)=>void;
 const base=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,options)=>{
  if(options.args.action==="respond") {current=makeView("investigating");return new Promise((_,reject)=>{rejectRun=reject;});}
  if(options.args.action==="cancel") {current=makeView(state);return current;}
  return base(command,options);
 });
 await open();await fill("investigationGoal","停止竞态验收");await click("开始调查");await click("停止本轮");
 await act(async()=>rejectRun(new Error("调查已结束")));
 expect(document.querySelector('.agent-error')?.textContent?.includes("调查已结束")||false).toBe(state==="failed");
 expect(current.work.state).toBe(state);
});
it("does not guess unknown task or attachment identities and preserves exact Craft pages", () => {
  expect(investigationAnchor({ ...result, contentType: "task" })).toBeNull();
  expect(investigationAnchor({ ...result, sourceItemId: "attachment", contentType: "pdf_page" })).toBeNull();
  expect(investigationAnchor({ ...result, provider: "craft", pageId: "child" })).toMatchObject({pageId:"child"});
  expect(investigationAnchor({ ...result, provider: "craft", blockId: "search-child" })).toMatchObject({pageId:"search-child"});
  expect(investigationAnchor({ ...result, provider: "craft", blockId: "block", pageId: "explicit-page" })).toMatchObject({pageId:"explicit-page"});
});
it("task investigation uses the exact source identity, including project and markdown aliases", async () => {
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command,options)=>{const value=await original(command,options);return options.args.action==="list"?value:{...value,actions:{tagOptions:["材料标签"],items:[]}};});
  const task={...result,contentType:"task",sourceType:"craft_task",provider:"craft" as const,taskSourceId:"craft-project-page:child",blockId:"display-page"};
  expect(investigationAnchor(task)).toEqual({kind:"task",libraryId:"notes",sourceId:"craft-project-page:child"});
  await act(async()=>root.render(<AgentInvestigation result={task}/>));await click("调查这项任务");
  await fill("investigationGoal","核对任务状态");await click("开始调查");
  expect(invoke.mock.calls.find(([,{args}])=>args.action==="create")![1].args.grant).toEqual({libraryIds:[],notes:[],readingItemKeys:[],sources:[{kind:"task",libraryId:"notes",sourceId:"craft-project-page:child"}]});
  expect(document.body.textContent).not.toContain("希望记住什么");
  expect(document.body.textContent).not.toContain("准备补标建议");
});
it("opens ordinary Craft markdown search blocks as notes instead of dropping the investigation entry", async () => {
  const note = { ...result, provider: "craft" as const, contentType: "markdown_section", sourceType: "craft_page", blockId: "note-section" };
  expect(investigationAnchor(note)).toEqual({kind:"note",libraryId:"notes",documentId:"doc",pageId:"note-section"});
  await act(async()=>root.render(<AgentInvestigation result={note}/>));
  await click("调查这篇笔记");
  expect(document.body.textContent).toContain("希望助手做什么");
  expect(invoke.mock.calls.some(([, {args}])=>args.action==="respond")).toBe(false);
});
it("attachment investigation grants only the selected chunk and leaves qualification to the host", async () => {
  const attachment={...result,id:"pdf:p1:0",sourceItemId:"pdf",pageNumber:1,contentType:"pdf_page"};
  await act(async()=>root.render(<AgentInvestigation result={attachment}/>));await click("调查这个附件片段");
  expect(invoke.mock.calls.some(([,{args}])=>args.action==="respond")).toBe(false);
  await fill("investigationGoal","核对附件条件");await click("开始调查");
  const created=invoke.mock.calls.find(([,{args}])=>args.action==="create")![1].args;
  expect(created.grant.libraryIds).toEqual([]);expect(created.grant.sources).toEqual([created.anchor]);expect(created.anchor).toEqual({kind:"attachment",libraryId:"notes",documentId:"doc",sourceItemId:"pdf",chunkId:"pdf:p1:0",pageNumber:1});
  expect(created.grant.attachmentLibraryIds).toBeUndefined();
});
it("revalidates when returning to a visible panel and hides results whose sources changed", async () => {
  await open(); await fill("investigationGoal", "核对方案"); await click("开始调查");
  const modelCalls = invoke.mock.calls.filter(([, {args}]) => args.action === "respond").length;
  visibility.value=false;
  await act(async () => root.render(<AgentInvestigation result={result}/>));
  current=makeView("expired");
  visibility.value=true;
  await act(async () => root.render(<AgentInvestigation result={result}/>));
  expect(document.body.textContent).toContain("需要重新核对来源");
  expect(document.body.textContent).not.toContain("历史记录要求保持 M6");
  expect(invoke.mock.calls.filter(([, {args}]) => args.action === "respond")).toHaveLength(modelCalls);
});
it("hides partial and historical bodies if source revalidation fails on return", async () => {
  current = { ...makeView("interrupted"), progress: partial, history: [{ runId: "old-run", createdAt: 1000, report, evidence: makeView().evidence, validity: "历史结果" }] };
  let rejectStatus = false;
  invoke.mockImplementation(async (_, { args }) => {
    if (args.action === "list") return { works: [{ id: "work-1", goal: current.work.goal, state: current.work.state }] };
    if (args.action === "status" && rejectStatus) throw new Error("来源核验失败");
    return current;
  });
  await open();
  expect(document.body.textContent).toContain("功放接口由设备组核对");
  expect(document.body.textContent).toContain("历史记录要求保持 M6");
  visibility.value = false;
  await act(async () => root.render(<AgentInvestigation result={result}/>));
  rejectStatus = true;
  visibility.value = true;
  await act(async () => root.render(<AgentInvestigation result={result}/>));
  expect(document.body.textContent).toContain("来源核验失败");
  expect(document.body.textContent).not.toContain("功放接口由设备组核对");
  expect(document.body.textContent).not.toContain("历史记录要求保持 M6");
  expect(invoke.mock.calls.some(([, {args}]) => args.action === "respond")).toBe(false);
});

it("continues three turns in one input, preserves every reply, and reopens the thread without another model run", async () => {
  const messages:Conversation["messages"]=[];
  let created=false, turns=0;
  invoke.mockImplementation(async(_, {args})=>{
    if(args.action==="list") return {works:created?[{id:"work-1",goal:"核对安装方案",state:current.work.state}]:[]};
    if(args.action==="create") {created=true;messages.push({id:"u0",role:"user",text:args.goal,createdAt:0});current={...makeView("ready"),conversation:{messages:[...messages],hasEarlier:false}};}
    if(args.action==="message") {messages.push({id:`u${turns}`,role:"user",text:args.text,createdAt:turns});current={...makeView("ready"),conversation:{messages:[...messages],hasEarlier:false}};}
    if(args.action==="respond") {turns++;messages.push({id:`a${turns}`,role:"assistant",runId:`run-${turns}`,report:{...report,summary:`第 ${turns} 轮回答`},evidence:makeView().evidence,createdAt:turns});current={...makeView(),conversation:{messages:[...messages],hasEarlier:false}};}
    return current;
  });
  await open();await fill("investigationGoal","核对安装方案");await click("开始调查");
  for(const text of ["解释第一点","结合前文再概括一次"]) {await fill("investigationGoal",text);await click("发送追问");}
  expect(document.body.querySelectorAll('[aria-label="你的消息"]')).toHaveLength(3);
  expect(document.body.querySelectorAll('[aria-label="助手回答"]')).toHaveLength(3);
  expect(document.body.textContent).toContain("第 1 轮回答");expect(document.body.textContent).toContain("第 3 轮回答");
  const requests=invoke.mock.calls.filter(([, {args}])=>args.action==="message");
  expect(requests).toHaveLength(2);expect(requests[0][1].args.clientMessageId).toBeTruthy();
  expect(invoke.mock.calls.some(([, {args}])=>args.action==="decision")).toBe(false);
  await act(async()=>root.unmount());root=createRoot(host);await open();
  expect(document.body.querySelectorAll('[aria-label="助手回答"]')).toHaveLength(3);
  expect(invoke.mock.calls.filter(([, {args}])=>args.action==="respond")).toHaveLength(3);
});

it("retains an unsent follow-up after a transport failure and reuses its request identity when retried", async()=>{
  const original=invoke.getMockImplementation()!;
  let attempts=0;
  invoke.mockImplementation(async(command,options)=>{
    if(options.args.action==="message") {if(attempts++===0) throw new Error("连接暂时中断");return makeView("ready");}
    return original(command,options);
  });
  await open();await fill("investigationGoal","核对方案");await click("开始调查");
  await fill("investigationGoal","继续解释");await click("发送追问");
  expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("继续解释");
  await click("发送追问");
  const requests=invoke.mock.calls.filter(([, {args}])=>args.action==="message");
  expect(requests[0][1].args.clientMessageId).toBe(requests[1][1].args.clientMessageId);
});

it("opens a citation through its exact run, highlights the quote, and hides it on revocation",async()=>{
  current={...makeView(),conversation:{messages:[{id:"answer",role:"assistant",runId:"run-cited",report,evidence:makeView().evidence,createdAt:1}],hasEarlier:false}};
  invoke.mockImplementation(async(_, {args})=>{
    if(args.action==="list") return {works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]};
    if(args.action==="source") return {excerpt:{...makeView().evidence[0],content:"原文前后文：保持 M6，先检查公差。"}};
    if(args.action==="revoke") current={...current,work:{...current.work,state:"revoked"}};
    return current;
  });
  await open();await click("查看引用原文");
  expect(invoke).toHaveBeenCalledWith("agent_investigation",{args:{action:"source",id:"work-1",runId:"run-cited",evidenceIndex:0,quote:"保持 M6"}});
  expect(document.body.querySelector('.agent-source-preview mark')?.textContent).toBe("保持 M6");
  await click("撤回来源授权");expect(document.body.querySelector('.agent-source-preview')).toBeNull();
  expect(document.body.querySelector('.agent-messages')).toBeNull();
});
it("returns focus inside the assistant when closing a citation so Escape exits reading instead of hiding Hub",async()=>{
 current={...makeView(),conversation:{messages:[{id:'answer',role:'assistant',runId:'run-cited',report,evidence:makeView().evidence,createdAt:1}],hasEarlier:false}};
 invoke.mockImplementation(async(_,{args})=>args.action==='list'?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:args.action==='source'?{excerpt:makeView().evidence[0]}:current);
 await open();await click('专注阅读报告');await click('查看引用原文');
 const close=button('关闭引用原文');close.focus();await act(async()=>close.click());
 const conversation=document.body.querySelector<HTMLElement>('[aria-label="对话与报告"]')!;
 expect(document.activeElement).toBe(conversation);expect(conversation.closest('[data-hub-keyboard-scope]')).not.toBeNull();
 const escaped=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});
 await act(async()=>document.activeElement!.dispatchEvent(escaped));
 expect(escaped.defaultPrevented).toBe(true);expect(document.body.querySelector<HTMLElement>('.agent-panel')?.hidden).toBe(false);
 expect(document.body.querySelector<HTMLElement>('.agent-panel')?.dataset.agentReading).toBe('false');
 expect(invoke.mock.calls.some(([,v])=>['respond','resume','create'].includes(v?.args?.action))).toBe(false);
});
it.each(["cached","pending","uncertain"])("scopes cached and pending citations to current note authorization: %s",async(mode)=>{
 const a={kind:"note",libraryId:"notes",documentId:"doc",pageId:null};const b={...a,documentId:"extra"};
 current={...makeView(),conversation:{messages:[{id:"answer",role:"assistant",runId:"run-cited",report,evidence:makeView().evidence,createdAt:1}],hasEarlier:false}};
 Object.assign(current.work,{revision:2,grant:{libraryIds:[],notes:[a,b]}});
 let releaseSource:(value:unknown)=>void=()=>{};
 let failedScope=false;
 const excerpt={...makeView().evidence[0],content:"WITHDRAWN_PREVIEW_B_SECRET 保持 M6"};
 invoke.mockImplementation(async(_, {args})=>{
  if(args.action==="list")return {works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]};
  if(args.action==="materials")return {notes:[{locator:b,title:"附加材料",path:"B.md",libraryName:"工作笔记"}],total:1,nextOffset:null,snapshot:"same"};
  if(args.action==="source")return mode==="pending" ? new Promise(resolve=>{releaseSource=resolve}) : {excerpt};
  if(args.action==="status"&&failedScope)throw Error("范围结果仍待核对");
  if(args.action==="message"){
   if(mode==="uncertain"){failedScope=true;throw Error("撤回回执丢失");}
   current={...current,work:{...current.work,report:null},evidence:[],conversation:{messages:[],hasEarlier:false}};
   Object.assign(current.work,{revision:3,grant:{libraryIds:[],notes:[a]}});
  }
  return current;
 });
 await open();await click("查看引用原文");
 if(mode==="cached")expect(document.body.querySelector('.agent-source-preview')?.textContent).toContain("WITHDRAWN_PREVIEW_B_SECRET");
 await openAddPage("从笔记库添加");
 await click("撤回授权 附加材料");await click("确认撤回所选授权");
 if(mode==="pending")await act(async()=>{releaseSource({excerpt});await new Promise(r=>setTimeout(r,0));});
 expect(document.body.querySelector('.agent-source-preview')).toBeNull();
 expect(document.body.textContent).not.toContain("WITHDRAWN_PREVIEW_B_SECRET");
 if(mode==="uncertain"){
  expect(document.body.textContent).toContain("结果待核对");
  expect(document.body.querySelector('.agent-messages')).toBeNull();
  expect(document.body.textContent).not.toContain("历史记录要求保持 M6");
  expect(button("查看引用原文")).toBeUndefined();
  expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="source")).toHaveLength(1);
 }
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond")).toBe(false);
});

it("hides affected output until a lost full-revocation outcome is revalidated",async()=>{
 current={...makeView(),conversation:{messages:[{id:"answer",role:"assistant",runId:"run-cited",report,evidence:makeView().evidence,createdAt:1}],hasEarlier:false}};
 let failedScope=false, recover=false;
 invoke.mockImplementation(async(_, {args})=>{
  if(args.action==="list")return {works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]};
  if(args.action==="source")return {excerpt:{...makeView().evidence[0],content:"撤权前原文 保持 M6"}};
  if(args.action==="revoke"){failedScope=true;throw Error("撤权回执丢失");}
  if(args.action==="status"&&failedScope){if(!recover)throw Error("状态读取失败");return {...current,work:{...current.work,state:"revoked"}};}
  return current;
 });
 await open();await click("查看引用原文");await click("撤回来源授权");
 expect(document.body.textContent).toContain("结果待核对");
 expect(document.body.querySelector('.agent-messages')).toBeNull();
 expect(document.body.querySelector('.agent-source-preview')).toBeNull();
 expect(document.body.textContent).not.toContain("历史记录要求保持 M6");
 await click("撤回来源授权");
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="revoke")).toHaveLength(1);
 recover=true;await click("核对当前结果");
 expect(document.body.textContent).toContain("授权已撤回");
 expect(document.body.querySelector('[aria-label="操作结果待核对"]')).toBeNull();
 expect(document.body.querySelector('.agent-source-preview')).toBeNull();
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="respond")).toBe(false);
});
it("keeps a follow-up unsent until selected withdrawal is confirmed separately",async()=>{
 const a={kind:"note",libraryId:"notes",documentId:"doc",pageId:null},b={...a,documentId:"extra"};
 current=makeView();Object.assign(current.work,{revision:2,grant:{libraryIds:[],notes:[a,b]}});
 invoke.mockImplementation(async(_, {args})=>args.action==="list"?{works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]}:args.action==="materials"?{notes:[{locator:b,title:"附加材料",path:"B.md",libraryName:"工作笔记"}],total:1,nextOffset:null,snapshot:"same"}:current);
 await open();
 await openAddPage("从笔记库添加");
 await click("撤回授权 附加材料");await fill("investigationGoal","新的分析要求");
 expect(button("发送追问").disabled).toBe(true);
 await act(async()=>document.body.querySelector('.agent-composer form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="message"||p?.args?.action==="respond")).toBe(false);
 expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("新的分析要求");
 expect(document.body.textContent).toContain("请先确认撤回所选授权");
});
it("shows the drafts returned by the same agent run beside that answer without a second dispatch",async()=>{
 const base=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,payload)=>{
   if(command==="agent_investigation" && payload.args.action==="respond") {
     current={...makeView(),conversation:{hasEarlier:false,messages:[{id:"u",role:"user",text:"做成闪卡",revision:1,createdAt:1},{id:"a",role:"assistant",report,revision:1,createdAt:2}]},actions:{tagOptions:[],flashcardDecks:[],items:[{id:"cards",kind:"flashcardDrafts",baseRevision:1,state:"prepared",confirmationToken:"concrete-token",payload:{deckName:"收件箱",learningGoal:"学习安装条件",cards:[{question:"自然对话制卡问题",answer:"保持 M6",explanation:"依据安装条件",evidenceText:"保持 M6"}],uncoveredTargets:[]}}]}};return current;
   }
   return base(command,payload);
 });
 await open();await fill("investigationGoal","把当前材料做成闪卡");await click("开始调查");
 expect(document.body.querySelector('.agent-message-assistant .agent-outcomes')?.textContent).toContain("自然对话制卡问题");
 expect(document.body.querySelector('.agent-more-tools')?.textContent).not.toContain("自然对话制卡问题");
 expect(invoke.mock.calls.some(([,v])=>v?.args?.action==="submitFlashcards" || v?.args?.action==="prepareResponse")).toBe(false);
 await click("关闭助手");await click("调查这篇笔记");
 expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==="respond")).toHaveLength(1);
});

it("does not begin draft preparation if the user stops while the response is still pending",async()=>{
 let finish:(view:typeof current)=>void=()=>{};const base=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,payload)=>payload.args.action==="respond"?new Promise(resolve=>{finish=resolve;}):base(command,payload));
 await open();await fill("investigationGoal","准备闪卡");await click("开始调查");await click("停止本轮");
 await act(async()=>finish({...makeView(),draftRequest:{runId:"late-run",kind:"flashcards"}}));
 expect(invoke.mock.calls.some(([,v])=>v?.args?.action==="prepareResponse")).toBe(false);
});

it("creates a confirmed frozen source scope without a model and hides single-note scope edits",async()=>{
 const fallback=invoke.getMockImplementation()!;
 const locator={kind:"note",libraryId:"notes",documentId:"doc",pageId:null};
 invoke.mockImplementation(async(command,params)=>{
  if(params.args.action==="previewSourceScope")return {snapshot:"source-manifest-v1:test",members:[{locator,title:"安装方案",path:"安装方案.md"}],totalMembers:1,nextCursor:null,dateCoverage:{unknownDateMembers:1,excludedByDateSelection:0}};
  if(params.args.action==="createWithSourceScope") {const ready={...makeView("ready"),work:{...makeView("ready").work,grant:{libraryIds:[],notes:[],manifest:{members:[locator]}}}};current=ready;return ready;}
  return fallback(command,params);
 });
 await open();await fill("investigationGoal","核对固定范围");await openAddPage("资料范围");await click("预览材料范围");
 const consent=[...document.body.querySelectorAll("label")].find(l=>l.textContent?.includes("授权这份清单中的全部"))!.querySelector<HTMLInputElement>("input")!;
 await act(async()=>consent.click());await click("确认范围并建立对话");
 expect(invoke.mock.calls.filter(([,p])=>p?.args?.action==="createWithSourceScope")).toHaveLength(1);
 expect(invoke.mock.calls.some(([,p])=>["respond","run","create"].includes(p?.args?.action))).toBe(false);
 expect(document.body.textContent).toContain("已固定授权 1 份资料");expect(document.body.textContent).not.toContain("按标题或路径查找");
});

it("refreshes frozen scope in the same Work and retries the same confirmation without model dispatch",async()=>{
 const fallback=invoke.getMockImplementation()!;const locator={kind:"note",libraryId:"notes",documentId:"doc",pageId:null};
 const selection={libraryId:"notes",directory:"daily",dateFrom:"2025-01-01"};
 Object.assign(current,{...makeView("ready"),work:{...makeView("ready").work,revision:1,grant:{libraryIds:[],notes:[],manifest:{members:[locator],selection,snapshot:"source-manifest-v1:old"}}}});
 let fail=true;
 invoke.mockImplementation(async(command,params)=>{
  if(params.args.action==="list")return {works:[{id:current.work.id,goal:current.work.goal,state:"ready"}]};
  if(params.args.action==="previewSourceScope")return {snapshot:"source-manifest-v1:new",members:[{locator,title:"安装方案",path:"daily/2025-01-01.md"}],totalMembers:1,nextCursor:null,dateCoverage:{unknownDateMembers:0,excludedByDateSelection:0}};
  if(params.args.action==="replaceSourceScope"){if(fail)throw Error("回执暂不可用");return {...current,work:{...current.work,revision:2}};}
  return fallback(command,params);
 });
 await open();await fill("investigationGoal","保留尚未发送的补充");await openAddPage("资料范围");await click("预览材料范围");
 const consent=()=>[...document.body.querySelectorAll("label")].find(l=>l.textContent?.includes("授权这份清单中的全部"))!.querySelector<HTMLInputElement>("input")!;
 await act(async()=>consent().click());await click("确认新范围，保留本对话");
 expect(document.body.textContent).toContain("回执暂不可用");expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("保留尚未发送的补充");
 fail=false;await act(async()=>consent().click());await click("确认新范围，保留本对话");
 const calls=invoke.mock.calls.filter(([,p])=>p?.args?.action==="replaceSourceScope");expect(calls).toHaveLength(2);expect(calls[0][1].args).toEqual(calls[1][1].args);expect(calls[0][1].args).toMatchObject({id:"work-1",expectedRevision:1,expectedPreviousManifest:"source-manifest-v1:old",expectedManifest:"source-manifest-v1:new",selection});
 expect(invoke.mock.calls.some(([,p])=>["create","createWithSourceScope","respond","run"].includes(p?.args?.action))).toBe(false);
});

it("routes global assistant citations into the workspace body instead of the chat footer",async()=>{
 current={...makeView(),conversation:{messages:[{id:"answer",role:"assistant",runId:"run-cited",report,evidence:makeView().evidence,createdAt:1}],hasEarlier:false}};
 invoke.mockImplementation(async(_,{args})=>args.action==='list'?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:args.action==='source'?{excerpt:makeView().evidence[0]}:current);
 await act(async()=>root.render(<AgentPanelProvider><main><AgentCitationBody/></main><StandaloneInvestigation/></AgentPanelProvider>));
 await click("Hub 助手");await click("查看引用原文");
 expect(document.body.querySelector('main .agent-citation-preview mark')?.textContent).toBe('保持 M6');
 expect(document.body.querySelector('.agent-source-preview')).toBeNull();
 await click('返回回答');
 expect(document.body.querySelector('.agent-citation-preview')).toBeNull();
 expect(document.body.querySelector<HTMLElement>('.agent-panel')?.hidden).toBe(false);
});
it("replaces unavailable draft material with the current page without granting the whole library",async()=>{
 const next={...result,documentId:'current-doc',title:'当前文档',documentTitle:'当前文档'};
 invoke.mockImplementation(async(_,{args})=>{if(args.action==='list')return {works:[]};if(args.action==='create')throw new Error('资料库不在本次有效授权范围');return current;});
 await act(async()=>root.render(<AgentBrowsingContext.Provider value={{entry:{result:next},setEntry:vi.fn()}}><AgentInvestigation result={result}/></AgentBrowsingContext.Provider>));
 await click('调查这篇笔记');await fill('investigationGoal','保留这个问题');
 await act(async()=>document.body.querySelector<HTMLFormElement>('.agent-composer form')!.requestSubmit());
 await click('改用当前页面');
 expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe('保留这个问题');
 await act(async()=>document.body.querySelector<HTMLFormElement>('.agent-composer form')!.requestSubmit());
 const calls=invoke.mock.calls.filter(([,p])=>p?.args?.action==='create');
 expect(calls[calls.length-1][1].args).toMatchObject({anchor:{kind:'note',documentId:'current-doc'},grant:{libraryIds:[],notes:[{kind:'note',documentId:'current-doc'}]}});
 expect(calls[calls.length-1][1].args.grant.notes).toHaveLength(1);
});
it("routes checked citations to preview and returns without closing the assistant",async()=>{
 const preview=vi.fn();
 current={...makeView(),conversation:{messages:[{id:"answer",role:"assistant",runId:"run-cited",report,evidence:makeView().evidence,createdAt:1}],hasEarlier:false}};
 invoke.mockImplementation(async(_,{args})=>args.action==='list'?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:args.action==='source'?{excerpt:makeView().evidence[0]}:current);
 await act(async()=>root.render(<AgentInvestigation result={result} onPreviewCitation={preview}/>));
 await click("调查这篇笔记");await click("查看引用原文");
 expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({quote:"保持 M6",excerpt:makeView().evidence[0],onReturn:expect.any(Function)}));
 expect(document.body.querySelector('.agent-source-preview')).toBeNull();
 expect(document.body.querySelector('.agent-panel')?.getAttribute('data-agent-source-visible')).toBe('true');
 await act(async()=>document.body.querySelector('.agent-panel')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 expect(preview).toHaveBeenLastCalledWith(null);
 expect(document.body.querySelector('.agent-panel')?.getAttribute('data-agent-source-visible')).toBe('false');
 await click("查看引用原文");await click("关闭助手");expect(preview).toHaveBeenLastCalledWith(null);
});
it("does not route a rejected source version to preview",async()=>{
 const preview=vi.fn();
 current={...makeView(),conversation:{messages:[{id:"answer",role:"assistant",runId:"run-cited",report,evidence:makeView().evidence,createdAt:1}],hasEarlier:false}};
 invoke.mockImplementation(async(_,{args})=>{if(args.action==='source')throw new Error('来源版本已变化');return args.action==='list'?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:current;});
 await act(async()=>root.render(<AgentInvestigation result={result} onPreviewCitation={preview}/>));
 await click("调查这篇笔记");await click("查看引用原文");
 expect(preview.mock.calls.every(([value])=>value===null)).toBe(true);
 expect(document.body.textContent).toContain("来源版本已变化");
});

it.each([false,true])("restores citation origin mode, scroll and keyboard focus: reading=%s",async(reading)=>{
 const preview=vi.fn();
 current={...makeView(),conversation:{messages:[{id:"answer",role:"assistant",runId:"run-cited",report,evidence:makeView().evidence,createdAt:1}],hasEarlier:false}};
 invoke.mockImplementation(async(_,{args})=>args.action==='list'?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:args.action==='source'?{excerpt:makeView().evidence[0]}:current);
 await act(async()=>root.render(<AgentInvestigation result={result} onPreviewCitation={preview}/>));
 await click("调查这篇笔记");if(reading)await click("专注阅读报告");
 const conversation=document.body.querySelector<HTMLElement>('[aria-label="对话与报告"]')!;
 conversation.scrollTop=437;const cited=button("查看引用原文");cited.focus();
 await click("查看引用原文");
 const location=preview.mock.calls[preview.mock.calls.length-1][0];
 expect(document.body.querySelector('.agent-panel')?.getAttribute('data-agent-reading')).toBe('false');
 conversation.scrollTop=9;
 await act(async()=>location.onReturn());
 expect(preview).toHaveBeenLastCalledWith(null);
 expect(document.body.querySelector('.agent-panel')?.getAttribute('data-agent-reading')).toBe(String(reading));
 expect(conversation.scrollTop).toBe(437);expect(document.activeElement).toBe(cited);
 expect(invoke.mock.calls.some(([,p])=>['respond','resume','create'].includes(p?.args?.action))).toBe(false);
});

it("does not restore a stale citation layout after authority is revoked",async()=>{
 const preview=vi.fn();
 current={...makeView(),conversation:{messages:[{id:"answer",role:"assistant",runId:"run-cited",report,evidence:makeView().evidence,createdAt:1}],hasEarlier:false}};
 invoke.mockImplementation(async(_,{args})=>{
  if(args.action==='list')return {works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]};
  if(args.action==='source')return {excerpt:makeView().evidence[0]};
  if(args.action==='revoke')current={...current,work:{...current.work,state:'revoked'}};
  return current;
 });
 await act(async()=>root.render(<AgentInvestigation result={result} onPreviewCitation={preview}/>));
 await click("调查这篇笔记");await click("专注阅读报告");await click("查看引用原文");
 const stale=preview.mock.calls[preview.mock.calls.length-1][0];
 await click("撤回来源授权");await act(async()=>stale.onReturn());
 expect(document.body.querySelector('.agent-panel')?.getAttribute('data-agent-reading')).toBe('false');
 expect(document.body.querySelector('.agent-panel')?.getAttribute('data-agent-source-visible')).toBe('false');
 expect(document.body.querySelector('.agent-messages')).toBeNull();expect(preview).toHaveBeenLastCalledWith(null);
});


it("public URL is fetched only on explicit send, with no inherited library grant",async()=>{
  invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[]}:current);
  await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
  await act(async()=>{const menu=document.body.querySelector<HTMLDetailsElement>(".agent-add-menu")!;menu.open=true;menu.dispatchEvent(new Event("toggle"));});
  await click("读取公共链接");
  const input=document.body.querySelector<HTMLInputElement>('[aria-label="公共网页地址"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"https://example.org/a");input.dispatchEvent(new Event("input",{bubbles:true}));});
  expect(invoke.mock.calls.some(([,v])=>v?.args?.action==="createFromPublicUrl")).toBe(false);
  await click("返回填写问题");await fill("investigationGoal","总结网页并说明出处");
  await act(async()=>document.body.querySelector<HTMLFormElement>(".agent-composer form")!.requestSubmit());
  const calls=invoke.mock.calls.filter(([,v])=>v?.args?.action==="createFromPublicUrl");
  expect(calls).toHaveLength(1);
  expect(calls[0][1].args).toEqual({action:"createFromPublicUrl",url:"https://example.org/a",goal:"总结网页并说明出处",confirmedPublicRead:true});
});

it("starts a standalone conversation with empty authorization and optional materials",async()=>{
  await act(async()=>root.render(<StandaloneInvestigation/>));
  await click("Hub 助手");
  expect(document.body.textContent).toContain("有什么可以帮你？");
  expect(button("概括主要内容")).toBeUndefined();
  await fill("investigationGoal","写一段会议开场白");
  expect(button("开始调查").disabled).toBe(false);
  await act(async()=>document.body.querySelector<HTMLFormElement>(".agent-composer form")!.requestSubmit());
  const request=invoke.mock.calls.find(([,v])=>v?.args?.action==="create")![1].args;
  expect(request.anchor).toBeNull();
  expect(request.grant).toEqual({libraryIds:[],notes:[],readingItemKeys:[]});
  expect(request.successCriteria).toBe("");
});

it("standalone material picker never offers a fabricated current page",async()=>{
  invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[]}:args.action==="materials"?{notes:[],total:0,nextOffset:null,snapshot:"empty"}:current);
  await act(async()=>root.render(<StandaloneInvestigation/>));await click("Hub 助手");
  await act(async()=>{const menu=document.body.querySelector<HTMLDetailsElement>(".agent-add-menu")!;menu.open=true;menu.dispatchEvent(new Event("toggle"));});
  expect(document.body.querySelector('[aria-label="添加当前页面"]')).toBeNull();expect(button("添加资料").disabled).toBe(false);await click("添加资料");
  expect(document.body.textContent).toContain("完成选择");
  expect(invoke.mock.calls.some(([,v])=>v?.args?.action==="materials")).toBe(true);
});
it.each(["Escape","close button"])("local standalone citation returns to its original report using %s",async(method)=>{
  current={...makeView(),work:{...makeView().work,anchor:null},conversation:{messages:[{id:"answer",role:"assistant",runId:"saved-citation",report,evidence:makeView().evidence,createdAt:1}],hasEarlier:false}} as unknown as typeof current;
  invoke.mockImplementation(async(_,{args})=>args.action==='list'?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:args.action==='source'?{excerpt:makeView().evidence[0]}:current);
  await act(async()=>root.render(<StandaloneInvestigation/>));await click("Hub 助手");
  const conversation=document.body.querySelector<HTMLElement>('[aria-label="对话与报告"]')!;
  conversation.scrollTop=317;const citation=button("查看引用原文");citation.focus();await act(async()=>citation.click());
  expect(document.body.querySelector('.agent-source-preview mark')?.textContent).toBe("保持 M6");conversation.scrollTop=937;
  const close=button("关闭引用原文");close.focus();
  await act(async()=>method==="Escape"?close.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})):close.click());
  expect(document.body.querySelector<HTMLElement>('.agent-panel')?.hidden).toBe(false);
  expect(document.body.querySelector('.agent-source-preview')).toBeNull();
  expect(conversation.scrollTop).toBe(317);expect(document.activeElement).toBe(citation);
  expect(invoke.mock.calls.some(([,v])=>['create','respond','submitObsidianEdit'].includes(v?.args?.action))).toBe(false);
});
it.each([false,true])("local citation dismissal invalidates pending/error state without closing the assistant (error=%s)",async(error)=>{
  current={...makeView(),work:{...makeView().work,anchor:null},conversation:{messages:[{id:"answer",role:"assistant",runId:"saved-citation",report,evidence:makeView().evidence,createdAt:1}],hasEarlier:false}} as unknown as typeof current;
  let finish:(value:unknown)=>void=()=>{};
  invoke.mockImplementation(async(_,{args})=>args.action==='list'?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:args.action==='source'?(error?Promise.reject(new Error('来源版本已变化')):new Promise(resolve=>{finish=resolve;})):current);
  await act(async()=>root.render(<StandaloneInvestigation/>));await click("Hub 助手");await click("查看引用原文");
  expect(document.body.querySelector('.agent-source-preview')).not.toBeNull();
  await act(async()=>document.body.querySelector('.agent-panel')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  if(!error)await act(async()=>finish({excerpt:makeView().evidence[0]}));
  expect(document.body.querySelector<HTMLElement>('.agent-panel')?.hidden).toBe(false);
  expect(document.body.querySelector('.agent-source-preview')).toBeNull();
  expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==='source')).toHaveLength(1);
});
it("binds explicit standalone save target selection to the displayed Work and authorization",async()=>{
  const note={locator:{kind:"note" as const,libraryId:"notes",documentId:"target",pageId:null},title:"目标",path:"目标.md",libraryName:"隔离笔记"};
  current={...makeView(),work:{...makeView().work,anchor:null,revision:4,authorizationVersion:2,grant:{libraryIds:[],notes:[note.locator]}},actions:{tagOptions:[],items:[],obsidianTargets:[note]}} as unknown as typeof current;
  invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:current);
  await act(async()=>root.render(<StandaloneInvestigation/>));await click("Hub 助手");
  const select=document.body.querySelector<HTMLSelectElement>('[aria-label="选择保存目标"] select')!;
  expect(select.value).toBe("");
  await act(async()=>{select.value=JSON.stringify(["notes","target",null]);select.dispatchEvent(new Event('change',{bubbles:true}));});
  await act(async()=>select.closest('form')!.requestSubmit());
  expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==="selectObsidianTarget").map(([,v])=>v.args)).toEqual([{action:"selectObsidianTarget",id:"work-1",target:note.locator,expectedRevision:4,expectedAuthorizationVersion:2}]);
  expect(invoke.mock.calls.some(([,v])=>["respond","create","submitObsidianEdit"].includes(v?.args?.action))).toBe(false);
});

it("standalone lazy navigation opens the assistant on the first click",async()=>{
  const noop=vi.fn();
  await act(async()=>root.render(<AgentPanelProvider><WorkspaceRail activeView="home" spaces={[]} selectedLibraryIds={null} renderLibraryIcon={()=>null} favoriteCount={0} taskOpenCount={0} journalCount={0} historyCount={0} tagCount={0} flashcardDueCount={0} onSelectView={noop} onSelectAllLibraries={noop} onSelectLibrary={noop} onManageLibraries={noop}/></AgentPanelProvider>));
  expect(document.body.querySelector('.agent-panel')).toBeNull();
  await click("Hub 助手");
  expect(document.body.querySelector<HTMLElement>('.agent-panel')?.hidden).toBe(false);
  expect(document.body.textContent).toContain("有什么可以帮你？");
});

it.each([true,false])("standalone entry is available in the default layout and not duplicated beside a rail (%s)",async showAgent=>{
  const noop=vi.fn();
  await act(async()=>root.render(<AgentPanelProvider><SearchHeaderActions showAgent={showAgent} activeFilterCount={0} filtersOpen={false} hasSelectedResult={false} isMobileLayout={false} mobilePreviewOpen={false} searching={false} showPreviewPane={false} setFiltersOpen={noop} setMobilePreviewOpen={noop} setPreviewOpen={noop}/></AgentPanelProvider>));
  expect(!!button("Hub 助手")).toBe(showAgent);
  if(showAgent){await click("Hub 助手");expect(document.body.textContent).toContain("有什么可以帮你？");}
});

it.each(["failed","slow"])("core_input saved receipt stays acknowledged when refresh is %s",async refreshState=>{
  current=makeView("investigating");Object.assign(current.work,{revision:4,authorizationVersion:2});
  const input={key:"saved-question",runId:"native-run",state:"pending",isBlocking:true,questions:[{id:"scope",header:"范围",question:"读取哪些资料？",options:[{label:"当前材料",description:"不扩大授权"}]}]};
  Object.assign(current,{nativeInputs:[input]});
  let saved=false,release:((value:unknown)=>void)|undefined;
  invoke.mockImplementation(async(_,{args})=>{
    if(args.action==="list")return {works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]};
    if(args.action==="answerNativeInput"){saved=true;return {workId:args.id,runId:args.runId,key:args.key,saved:true};}
    if(args.action==="status"&&saved){if(refreshState==="failed")throw Error("状态暂时无法读取");return new Promise(resolve=>{release=resolve;});}
    return current;
  });
  await act(async()=>root.render(<AgentInvestigation result={result}/>));await click("调查这篇笔记");
  const select=document.querySelector<HTMLSelectElement>('.agent-native-input select')!;
  await act(async()=>{select.value="0";select.dispatchEvent(new Event("change",{bubbles:true}));});await click("提交回答");
  expect(document.body.textContent).toContain("回复已保存，等待发送");expect(document.querySelector('.agent-native-input form')).toBeNull();
  expect(document.querySelector('.agent-native-input')).toBeNull();
  expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==="answerNativeInput")).toHaveLength(1);
  expect(invoke.mock.calls.some(([,v])=>["steer","respond","resume"].includes(v?.args?.action))).toBe(false);
  if(refreshState==="failed")expect(document.body.textContent).toContain("状态暂时无法读取");
  else {await act(async()=>release!({...current,nativeInputs:[{...input,state:"sent"}]}));expect(document.body.textContent).toContain("回复已发送，等待助手处理");}
});

it("core_input rejects a mismatched receipt without claiming the answer was saved",async()=>{
  current=makeView("investigating");Object.assign(current.work,{revision:4,authorizationVersion:2});
  Object.assign(current,{nativeInputs:[{key:"question",runId:"native-run",state:"pending",isBlocking:true,questions:[{id:"scope",header:"范围",question:"选哪部分？",options:[{label:"当前材料",description:"现有范围"}]}]}]});
  invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:args.action==="answerNativeInput"?{workId:"other-work",runId:args.runId,key:args.key,saved:true}:current);
  await act(async()=>root.render(<AgentInvestigation result={result}/>));await click("调查这篇笔记");
  const select=document.querySelector<HTMLSelectElement>('.agent-native-input select')!;
  await act(async()=>{select.value="0";select.dispatchEvent(new Event("change",{bubbles:true}));});await click("提交回答");
  expect(document.querySelector('.agent-native-input [role="alert"]')?.textContent).toContain("回执不匹配");
  expect(document.querySelector<HTMLSelectElement>('.agent-native-input select')?.value).toBe("0");
  expect(document.querySelector('.agent-native-input-history')).toBeNull();
});

it.each([false,true])("core_async answers after turn completion and respects explicit resume (%s)",async requiresExplicitResume=>{
  current=makeView("completed");Object.assign(current.work,{revision:4,authorizationVersion:2});
  const input={key:"async-question",runId:"native-run",state:"pending",delivery:"async",isBlocking:false,questions:[{id:"q0",header:"时段",question:"明天可用时段？",isOther:true,options:[{label:"19:00–20:00",description:""}]}]};
  Object.assign(current,{nativeInputs:[input],lifecycle:{requiresExplicitResume,executionModes:{quick:true,deep:true}}});
  invoke.mockImplementation(async(_,{args})=>{
    if(args.action==="list")return {works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]};
    if(args.action==="answerNativeInput"){
      Object.assign(current,{nativeInputs:[{...input,state:"answered"}]});Object.assign(current.work,{state:"ready",revision:5});
      return {workId:args.id,runId:args.runId,key:args.key,saved:true,startNewTurn:true};
    }
    return current;
  });
  await act(async()=>root.render(<AgentInvestigation result={result}/>));await click("调查这篇笔记");
  expect(document.body.textContent).toContain("本轮结束后仍可回答");
  const select=document.querySelector<HTMLSelectElement>('.agent-native-input select')!;
  expect(select.disabled).toBe(false);
  await act(async()=>{select.value="0";select.dispatchEvent(new Event("change",{bubbles:true}));});await click("提交回答");
  expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==="answerNativeInput")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([,v])=>v?.args?.action==="respond")).toHaveLength(requiresExplicitResume?0:1);
  expect(invoke.mock.calls.some(([,v])=>["steer","message","resume"].includes(v?.args?.action))).toBe(false);
});

it("CN03 sends a native answer with current work authorization and never as a second steer",async()=>{
  current=makeView("investigating");
  invoke.mockImplementation(async (_,{args})=>args.action==="answerNativeInput" ? {workId:args.id,runId:args.runId,key:args.key,saved:true} : args.action==="list" ? {works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]} : current);
  Object.assign(current.work,{revision:4,authorizationVersion:2});
  Object.assign(current,{nativeInputs:[{key:"question-key",runId:"native-run",state:"pending",isBlocking:true,questions:[{id:"scope",header:"范围",question:"使用哪些材料？",options:[{label:"当前材料",description:"保持现有范围"}]}]}]});
  await act(async()=>root.render(<AgentInvestigation result={result}/>));await click("调查这篇笔记");
  const select=document.querySelector<HTMLSelectElement>('.agent-native-input select')!;expect(select).not.toBeNull();
  await act(async()=>{select.value="0";select.dispatchEvent(new Event("change",{bubbles:true}));});await click("提交回答");
  const calls=invoke.mock.calls.filter(([,v])=>v?.args?.action==="answerNativeInput");expect(calls).toHaveLength(1);expect(calls[0][1].args).toMatchObject({id:"work-1",runId:"native-run",key:"question-key",expectedRevision:4,expectedAuthorizationVersion:2,answers:{scope:"当前材料"},cancel:false});
  expect(invoke.mock.calls.some(([,v])=>v?.args?.action==="steer")).toBe(false);
});

it("CN05B standalone image authorization preserves options, draft and saves without running",async()=>{
 const image={libraryId:"notes",documentId:"doc",sourceItemId:"image",inputVersion:"version",blobHash:"a".repeat(64)};
 invoke.mockImplementation(async(_,{args})=>{
  if(args.action==="list")return {works:[]};
  if(args.action==="imageMaterials")return {images:[{grant:image,title:"图像样本",mime:"image/png"}],hasMore:false};
  if(args.action==="create"){current=makeView("ready");Object.assign(current.work,{revision:1,authorizationVersion:1,anchor:null,goal:args.goal,grant:{libraryIds:[],notes:[]}});}
  if(args.action==="message")Object.assign(current.work,{revision:2,authorizationVersion:2,grant:{libraryIds:[],notes:[],images:[image]}});
  return current;
 });
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));await fill("investigationGoal","请解读这张图");await openAddPage("从资料库添加图片");await click("查找缓存图片");
 const checkbox=[...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(c=>c.parentElement?.textContent?.includes("图像样本"))!;
 await act(async()=>checkbox.click());await click("添加到问题");
 const mutations=invoke.mock.calls.map(([,p])=>p.args).filter(a=>["create","configureAssistant","message","respond","resume"].includes(a.action));
 expect(mutations).toEqual([]);
 expect(document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("请解读这张图");
 await click("开始调查");
 expect(invoke.mock.calls.find(([,p])=>p?.args?.action==='message')![1].args).toMatchObject({expectedRevision:1,addImages:[image]});
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==='respond')).toBe(true);
});

it("CN06 budget entry sends current identities and never starts analysis",async()=>{
 Object.assign(current.work,{revision:7,authorizationVersion:3});
 Object.assign(current,{lifecycle:{providerBudget:{state:"unconfigured",legacy:{measured:{inputTokens:0,uncachedInputTokens:0,outputTokens:0},unknownRuns:[]}}}});
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]}:current);
 await open();const check=Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(e=>e.parentElement?.textContent?.includes('确认本次额度'))!;
 await act(async()=>check.click());await click('保存预算（不启动分析）');
 const requests=invoke.mock.calls.filter(([,v])=>v?.args?.action==='freezeProviderBudget');expect(requests).toHaveLength(1);expect(requests[0][1].args).toMatchObject({id:'work-1',expectedWorkRevision:7,expectedAuthorizationVersion:3,unknownReservations:{}});
 expect(invoke.mock.calls.some(([,v])=>['respond','resume','create','message'].includes(v?.args?.action))).toBe(false);
});

it.each(["completed","needsDecision","investigating"])("only labels a settled delivered answer as answered (%s)",async status=>{
 current=makeView(status==="investigating"?"investigating":"completed");
 current.work.report={...report,status};
 Object.assign(current,{goalAssessment:{workFulfillment:"partial",semanticStatusSource:"notProvided",completionEvidence:[{requirementId:"r",criterion:"安排日程",status:"unfulfilled",explanation:"尚未提供逐项完成核对"}]}});
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:current);
 await act(async()=>root.render(<AgentInvestigation result={result}/>));await click("调查这篇笔记");
 const title=document.querySelector('[aria-label="目标完成核对"] p strong');
 expect(title?.closest(".agent-header-menu, .agent-details-menu") || title?.closest("details")?.closest("details")).toBeTruthy();
 expect(document.querySelector(".agent-conversation [aria-label=\"目标完成核对\"]")).toBeNull();
 expect((document.querySelector(".agent-status") as HTMLElement).hidden).toBe(status!=="investigating");
 expect(title?.textContent).toBe(status==="completed"?"已回答":"目标待核对");
 expect(document.querySelector('[aria-label="目标完成核对"]')?.textContent).not.toContain("目标尚未全部完成");
});

it("global assistant retains its draft and panel when the preview route unmounts",async()=>{
 invoke.mockImplementation(async(_name,args)=>args?.args?.action==="list"?{works:[]}:{});
 const renderRoute=(visible:boolean)=>root.render(<AgentPanelProvider><StandaloneAgentLauncher/>{visible&&<AgentInvestigation result={result}/>}</AgentPanelProvider>);
 await act(async()=>renderRoute(true));await click("询问助手");
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
 await fill("investigationGoal","切换后保留的草稿");
 const panel=document.querySelector('aside[aria-label="Hub 助手"]');
 await act(async()=>renderRoute(false));
 expect(document.querySelector('aside[aria-label="Hub 助手"]')).toBe(panel);
 expect(document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("切换后保留的草稿");
 expect(document.querySelectorAll('aside[aria-label="Hub 助手"]')).toHaveLength(1);
});

it("opens the global assistant from its capsule before any conversation is loaded",async()=>{
 await act(async()=>root.render(<AgentPanelProvider><StandaloneAgentLauncher/></AgentPanelProvider>));
 expect(document.body.querySelectorAll('.agent-floating-launcher')).toHaveLength(1);
 expect(document.body.querySelector('.agent-panel')).toBeNull();
 expect(invoke).not.toHaveBeenCalled();
 await click("打开助手");
 expect(document.body.querySelector<HTMLElement>('.agent-panel')?.hidden).toBe(false);
 expect(document.body.querySelector<HTMLButtonElement>('.agent-floating-launcher')?.hidden).toBe(true);
});

it("keeps independent account drafts and restores the original panel when switching back",async()=>{
 invoke.mockImplementation(async(_name,args)=>args?.args?.action==="list"?{works:[]}:{});
 await act(async()=>root.render(<AgentPanelProvider><StandaloneAgentLauncher/></AgentPanelProvider>));
 await click("Hub 助手");await fill("investigationGoal","账号 A 的未发送草稿");
 const first=document.querySelector<HTMLElement>('.agent-panel:not([hidden])')!;
 const change=(from:string,to:string)=>window.dispatchEvent(new CustomEvent("hub:agent-account-changed",{detail:{newConversation:true,fromScopeId:from,scopeId:to,fromSelected:from.startsWith("a")?"desktop":"profile-b",selected:to.startsWith("a")?"desktop":"profile-b"}}));
 await act(async()=>change("a".repeat(64),"b".repeat(64)));
 const second=document.querySelector<HTMLElement>('.agent-panel:not([hidden])')!;
 expect(second).not.toBe(first);expect(first.hidden).toBe(true);
 const input=second.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!;
 expect(input.value).toBe("");
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"账号 B 的草稿");input.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>change("b".repeat(64),"a".repeat(64)));
 expect(first.hidden).toBe(false);expect(second.hidden).toBe(true);
 expect(first.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("账号 A 的未发送草稿");
 expect(document.querySelectorAll('.agent-panel:not([hidden])')).toHaveLength(1);
 expect(invoke.mock.calls.some(([,v])=>["create","respond","cancel","revoke"].includes(v?.args?.action))).toBe(false);
});
it.each([false,true])("keeps history open when deleting the displayed global chat (reading=%s)",async reading=>{
 const saved={id:current.work.id,goal:current.work.goal,state:current.work.state};let deleted=false;
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,params)=>{
  if(params.args.action==='list')return {works:deleted?[]:[saved]};
  if(params.args.action==='setHistoryPreference'){deleted=params.args.deleted===true;return {deleted};}
  return original(command,params);
 });
 await act(async()=>root.render(<AgentPanelProvider><StandaloneAgentLauncher/></AgentPanelProvider>));
 await click('Hub 助手');if(reading)await click('专注阅读报告');
 await openHistory();
 expect(document.querySelector<HTMLDetailsElement>('.agent-dialogue-details')?.open).toBe(true);
 await click(`更多对话操作 ${saved.goal}`);
 await click(`删除对话 ${saved.goal}`);
 expect(deleted).toBe(true);expect(document.body.textContent).not.toContain('确认删除');expect(document.querySelector('.agent-history-undo')).not.toBeNull();
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});expect(document.querySelector('.agent-history-undo')?.closest('.agent-dialogue-details')).toBe(document.querySelector('.agent-dialogue-details'));
 expect(document.querySelector<HTMLDetailsElement>('.agent-dialogue-details')?.open).toBe(true);
 expect(document.querySelector('.agent-dialogue-details')?.contains(document.activeElement)).toBe(true);
 await click('撤销');expect(deleted).toBe(false);expect(document.querySelector('.agent-history-title')?.textContent).toBe(saved.goal);
 expect(document.querySelector('.agent-history-undo')).toBeNull();
 expect(invoke.mock.calls.some(([,params])=>['create','respond','resume'].includes(params?.args?.action))).toBe(false);
});

it.each(["completed","investigating"])("continues the same chat and draft after switching accounts (%s)",async state=>{
 current=makeView(state);
 invoke.mockImplementation(async(_name,{args})=>args.action==="list"?{works:[{id:current.work.id,goal:current.work.goal,state}]}:current);
 await act(async()=>root.render(<AgentPanelProvider><StandaloneAgentLauncher/></AgentPanelProvider>));
 await click("Hub 助手");await fill("investigationGoal","保留的追问草稿");
 const panel=document.querySelector<HTMLElement>('.agent-panel:not([hidden])')!;
 await act(async()=>window.dispatchEvent(new CustomEvent("hub:agent-account-changed",{detail:{newConversation:false,fromScopeId:"a".repeat(64),scopeId:"b".repeat(64),fromSelected:"desktop",selected:"profile-b"}})));
 expect(document.querySelector('.agent-panel:not([hidden])')).toBe(panel);
 expect(panel.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("保留的追问草稿");
 const authorizations=invoke.mock.calls.filter(([,p])=>p?.args?.action==="authorizeCodexConversation");
 expect(authorizations).toHaveLength(state==="completed"?1:0);
 if(state==="completed")expect(authorizations[0][1].args).toMatchObject({id:current.work.id,scopeId:"b".repeat(64)});
 expect(invoke.mock.calls.some(([,p])=>["create","respond","resume","cancel"].includes(p?.args?.action))).toBe(false);
});

it.each(["close button","Escape inside","Escape outside"])("collapses to a capsule and resumes the same conversation and draft using %s",async method=>{
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:current);
 await open();
 await fill("investigationGoal","收起后继续写的追问");
 const panel=document.body.querySelector<HTMLElement>('.agent-panel')!;
 const capsule=document.body.querySelector<HTMLButtonElement>('.agent-floating-launcher')!;
 if(method==="close button")await click("关闭助手");
 else await act(async()=>{
  const target=method==="Escape inside"?panel:host;
  const event=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
 });
 expect(panel.hidden).toBe(true);
 expect(capsule.hidden).toBe(false);
 expect(capsule.getAttribute("aria-controls")).toBe(panel.id);
 expect(document.activeElement).toBe(capsule);
 await click("打开助手");
 expect(document.body.querySelector('.agent-panel')).toBe(panel);
 expect(panel.hidden).toBe(false);
 expect(capsule.hidden).toBe(true);
 expect(document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("收起后继续写的追问");
 expect(panel.textContent).toContain("核对安装方案");
 expect(invoke.mock.calls.some(([,v])=>["respond","cancel","revoke","create"].includes(v?.args?.action))).toBe(false);
});

it("keeps the floating assistant open across outside clicks, blur, navigation and repeated entry clicks",async()=>{
 const renderRoute=(visible:boolean)=>root.render(<AgentPanelProvider><StandaloneAgentLauncher/>{visible&&<AgentInvestigation result={result}/>}</AgentPanelProvider>);
 await act(async()=>renderRoute(true));await click("询问助手");
 await fill("investigationGoal","保持前台的草稿");
 const panel=document.body.querySelector<HTMLElement>('.agent-panel')!;
 await act(async()=>{host.click();window.dispatchEvent(new Event("blur"));});
 await act(async()=>renderRoute(false));
 await click("Hub 助手");
 expect(document.body.querySelector('.agent-panel')).toBe(panel);
 expect(panel.hidden).toBe(false);
 expect(document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("保持前台的草稿");
 await act(async()=>host.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,isComposing:true})));
 expect(panel.hidden).toBe(false);
 const dialog=document.createElement("div");dialog.setAttribute("role","dialog");host.append(dialog);
 await act(async()=>dialog.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
 expect(panel.hidden).toBe(false);
});

it("does not toggle an already open assistant closed from its inline entry",async()=>{
 await open();await click("调查这篇笔记");
 expect(document.body.querySelector<HTMLElement>('.agent-panel')?.hidden).toBe(false);
});

it("takes Escape before a focused page input can clear its own query",async()=>{
 await open();
 const input=document.createElement("input");input.value="保留正文搜索词";host.append(input);
 const clear=vi.fn((event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();input.value="";}});
 input.addEventListener("keydown",clear);
 await act(async()=>{input.focus();input.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));});
 expect(clear).not.toHaveBeenCalled();
 expect(input.value).toBe("保留正文搜索词");
 expect(document.body.querySelector<HTMLElement>('.agent-panel')?.hidden).toBe(true);
});

it("switches floating and sidebar presentation without losing draft and resets the new chat title",async()=>{
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 const title=()=>document.querySelector('.agent-task-mode .agent-mode-title')?.textContent;
 expect(title()).toBe("新聊天");
 await fill("investigationGoal","总结正文，提取待办事项");
 expect(title()).toBe("总结正文，提取待办事项");
 const panel=document.querySelector('aside[aria-label="Hub 助手"]');
 await click("展开为侧边栏");expect(document.body.classList.contains('agent-sidebar-open')).toBe(true);
 expect(document.querySelector('aside[aria-label="Hub 助手"]')).toBe(panel);
 expect(document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("总结正文，提取待办事项");
 await click("切换为浮窗");expect(document.body.classList.contains('agent-sidebar-open')).toBe(false);
 await click("新对话");expect(title()).toBe("新聊天");
 await click("展开为侧边栏");await click("关闭助手");expect(document.body.classList.contains('agent-sidebar-open')).toBe(false);
});

it("keeps the saved conversation title while composing a follow-up",async()=>{
 current=makeView();
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:current);
 await act(async()=>root.render(<AgentInvestigation result={result}/>));await click("调查这篇笔记");
 await fill("investigationGoal","继续分析另一个问题");
 expect(document.querySelector('.agent-task-mode .agent-mode-title')?.textContent).toBe(current.work.goal);
});


it("keeps sidebar mode across global new-chat remounts",async()=>{
 await act(async()=>root.render(<AgentPanelProvider><StandaloneAgentLauncher/></AgentPanelProvider>));await click("Hub 助手");
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
 await click("展开为侧边栏");await click("新对话");
 expect(document.body.classList.contains("agent-sidebar-open")).toBe(true);
 expect(button("切换为浮窗")).toBeTruthy();
});
it("drops mixed explicit sources into a new conversation without granting a library",async()=>{
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 for(const entry of [{result},{itemKey:"reading-1",title:"阅读资料"}]){
  await act(async()=>{const event=new Event("drop",{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:{getData:()=>JSON.stringify(entry)}});document.querySelector(".agent-panel-header")!.dispatchEvent(event);});
 }
 await fill("investigationGoal","比较这两份资料");
 await act(async()=>document.querySelector<HTMLFormElement>(".agent-composer form")!.requestSubmit());
 const create=invoke.mock.calls.find(([,p])=>p?.args?.action==="create")![1].args;
 expect(create.grant.libraryIds).toEqual([]);
 expect(create.grant.notes).toEqual([investigationAnchor(result)]);
 expect(create.grant.readingItemKeys).toEqual(["reading-1"]);
});
it("merges library drops anywhere in the assistant and grants them before the first response",async()=>{
 libraryInventory.value=[noteLibrary,{id:"craft",provider:"craft",name:"Craft",connected:true,documentCount:2,excludedPaths:[]}];
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 for(const [target,items] of [[".agent-panel-header",[{id:"notes",name:"笔记库"}]],[".agent-body",[{id:"notes",name:"笔记库"},{id:"craft",name:"Craft"}]]] as const){
  await act(async()=>{const event=new Event("drop",{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:{types:["application/x-hub-agent-libraries"],getData:()=>JSON.stringify(items)}});document.querySelector(target)!.dispatchEvent(event);});
 }
 expect(document.querySelector('.agent-scope-trigger')?.textContent).toContain('全部资料库 · 2');
 await openAddPage('资料范围');
 expect([...document.querySelectorAll<HTMLInputElement>('.agent-library-choice input:checked')].map(input=>input.getAttribute('aria-label'))).toEqual(['允许查找 工作笔记','允许查找 Craft']);
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="message")).toBe(false);
 await fill("investigationGoal","从这些库中查找相关资料");
 await act(async()=>document.querySelector<HTMLFormElement>(".agent-composer form")!.requestSubmit());
 const calls=invoke.mock.calls.map(([,p])=>p?.args);
 const binding=calls.findIndex(p=>p?.action==="message"&&p.setLibraryIds);
 expect(calls[binding].setLibraryIds).toEqual(["notes","craft"]);
 expect(calls.findIndex(p=>p?.action==="respond")).toBeGreaterThan(binding);
});
it("accepts internal material drags across the assistant and leaves unrelated drags alone",async()=>{
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 for(const target of [".agent-panel-header", ".agent-body", ".agent-composer textarea"]) for(const internal of [false,true]){
  const event=new Event("dragover",{bubbles:true,cancelable:true});
  const transfer={types:internal?["application/x-hub-agent-source"]:["text/plain"],dropEffect:"none"};
  Object.defineProperty(event,"dataTransfer",{value:transfer});
  await act(async()=>document.querySelector(target)!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(internal);
  expect(transfer.dropEffect).toBe(internal?"copy":"none");
 }
});
it("shows history as selectable rows instead of an overflowing native select",async()=>{
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:"work-1",goal:"长标题 ".repeat(30),state:"completed",updatedAt:1000}]}:current);
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 expect(document.querySelector(".agent-conversations select")).toBeNull();
 expect(document.querySelectorAll(".agent-history-row")).toHaveLength(1);
});
it("keeps Escape inside a focused disclosure surface without closing the assistant",async()=>{
 await open();const menu=document.querySelector<HTMLDetailsElement>('.agent-dialogue-details')!,panel=document.querySelector<HTMLElement>('.agent-panel')!;
 await act(async()=>{menu.querySelector('summary')!.focus();menu.open=true;menu.dispatchEvent(new Event('toggle'));});
 // Model the browser focus owner after clicking non-interactive menu padding.
 await act(async()=>menu.focus());
 expect(document.activeElement).toBe(menu);
 await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
 expect(menu.open).toBe(false);expect(panel.hidden).toBe(false);
 expect(document.activeElement).toBe(menu.querySelector('summary'));
});
it("dismisses header details after outside interaction or losing window focus without closing the assistant",async()=>{
 await open();const menu=document.querySelector<HTMLDetailsElement>('.agent-dialogue-details')!,panel=document.querySelector<HTMLElement>('.agent-panel')!;
 const show=()=>act(async()=>{menu.querySelector('summary')!.focus();menu.open=true;menu.dispatchEvent(new Event('toggle'));});
 await show();await act(async()=>document.querySelector('.agent-composer textarea')!.dispatchEvent(new Event('pointerdown',{bubbles:true})));expect(menu.open).toBe(false);expect(panel.hidden).toBe(false);
 await show();await act(async()=>document.querySelector<HTMLTextAreaElement>('.agent-composer textarea')!.focus());expect(menu.open).toBe(false);
 await show();await act(async()=>window.dispatchEvent(new Event('blur')));expect(menu.open).toBe(false);
 await show();const close=menu.querySelector<HTMLButtonElement>('[aria-label="关闭对话详情"]')!;await act(async()=>{close.focus();close.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));});
 expect(menu.open).toBe(false);expect(document.activeElement).toBe(menu.querySelector('summary'));expect(panel.hidden).toBe(false);
});

it("adds the currently browsed page without replacing the open conversation",async()=>{
 invoke.mockImplementation(async(_name,args)=>args?.args?.action==="list"?{works:[]}:{});
 const renderPage=(page:SearchResult)=>root.render(<AgentPanelProvider><StandaloneAgentLauncher/><AgentInvestigation result={page}/></AgentPanelProvider>);
 await act(async()=>renderPage(result));await click("Hub 助手");
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
 await fill("investigationGoal","保留草稿");
 const next={...result,id:"next",documentId:"next",title:"第二页面"};
 await act(async()=>renderPage(next));await click("添加资料");await click("添加当前页面");
 expect(document.querySelector(".agent-composer")?.textContent).toContain("第二页面");
 expect(document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe("保留草稿");
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="create")).toBe(false);
});

it("adds a dragged task to a follow-up and ignores duplicate drops",async()=>{
 Object.assign(current.work,{anchor:null,revision:1,grant:{libraryIds:[],notes:[]}});
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:"work-1",goal:current.work.goal,state:"completed"}]}:current);
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 const task:SearchResult={...result,provider:"dida365",contentType:"task",taskSourceId:"task-1",documentId:"task-1",title:"待办资料"};
 for(let i=0;i<2;i++)await act(async()=>{const event=new Event("drop",{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:{getData:()=>JSON.stringify({result:task})}});document.querySelector(".agent-panel-header")!.dispatchEvent(event);});
 expect(document.querySelectorAll('[aria-label="移除材料 待办资料"]')).toHaveLength(1);
 expect(button('移除材料 待办资料').classList.contains('agent-context-remove')).toBe(true);
 await fill("investigationGoal","结合待办继续处理");await act(async()=>document.querySelector<HTMLFormElement>(".agent-composer form")!.requestSubmit());
 expect(invoke.mock.calls.find(([,p])=>p?.args?.action==="message")?.[1].args.addSources).toEqual([investigationAnchor(task)]);
});

it("sends selected text as user-provided material without granting its whole page",async()=>{
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[]}:current);
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 await act(async()=>{const event=new Event("drop",{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:{getData:()=>JSON.stringify({kind:"text",title:"来源页面",text:"只使用这段文字"})}});document.querySelector('.agent-composer')!.dispatchEvent(event);});
 expect(document.querySelector('[data-material-kind="text"]')?.textContent).toContain('所选文字');
 await fill('investigationGoal','总结选中文字');await act(async()=>document.querySelector<HTMLFormElement>('.agent-composer form')!.requestSubmit());
 expect(invoke.mock.calls.find(([,p])=>p?.args?.action==='create')![1].args.grant).toEqual({libraryIds:[],notes:[],readingItemKeys:[]});
 const message=invoke.mock.calls.find(([,p])=>p?.args?.action==='message')![1].args;
 expect(message.text).toContain('只使用这段文字');expect(message.text).toContain('不代表已读取完整来源');
});
it("does not start a request when a dropped text snapshot exceeds the material limit",async()=>{
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 await act(async()=>{const event=new Event("drop",{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:{getData:()=>JSON.stringify({kind:"flashcard",title:"长闪卡",text:"字".repeat(2501)})}});document.querySelector('.agent-composer')!.dispatchEvent(event);});
 expect(document.body.textContent).toContain('每份最多2500字');expect(document.querySelector('[data-material-kind="flashcard"]')).toBeNull();
 expect(invoke.mock.calls.some(([,p])=>['message','create','respond'].includes(p?.args?.action))).toBe(false);
});
it("stages a dropped local text file without sending and includes it only with the question",async()=>{
 const locator={kind:'note',libraryId:'__hub_chat_text',documentId:'local-text',pageId:null};
 invoke.mockImplementation(async(_,{args})=>args.action==='list'?{works:[]}:args.action==='stageTextFile'?{locator,title:'核对.md',libraryName:'本地文本附件',path:'核对.md',totalChars:8}:current);
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 await act(async()=>{const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[new File(['附件里的核对事项'],'核对.md',{type:'text/markdown'})]}});document.querySelector('.agent-composer')!.dispatchEvent(event);await new Promise(r=>setTimeout(r,30));});
 expect(document.querySelector('[data-material-kind="page"]')?.textContent).toContain('核对.md');
 expect(invoke.mock.calls.some(([,p])=>['create','message','respond'].includes(p?.args?.action))).toBe(false);
 await fill('investigationGoal','核对附件');await click('开始调查');
 const request=invoke.mock.calls.find(([,p])=>p?.args?.action==='create')![1].args;
 expect(request.goal).toBe('核对附件');expect(request.grant.notes).toEqual([locator]);
 expect(JSON.stringify(request)).not.toContain('附件里的核对事项');
});
it("does not silently accept an unsupported pasted file",async()=>{
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 await act(async()=>{const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{files:[new File(['pdf'],'图纸.pdf',{type:'application/pdf'})]}});document.querySelector('.agent-composer')!.dispatchEvent(event);});
 expect(document.body.textContent).toContain('PDF、Word');
 expect(invoke.mock.calls.some(([,p])=>['create','message','respond'].includes(p?.args?.action))).toBe(false);
});
it("stages pasted pixels locally, retains them after a failed send and retries the same message",async()=>{
 const image={libraryId:'__hub_chat_images',documentId:'h',sourceItemId:'h',inputVersion:'h',blobHash:'h'};
 const prepare=vi.spyOn(fileInputs,'prepareImage').mockResolvedValue({mime:'image/png',base64:'sample'});
 let attempts=0;
 invoke.mockImplementation(async(_,{args})=>{
  if(args.action==='list')return {works:[{id:current.work.id,goal:current.work.goal,state:'ready'}]};
  if(args.action==='stageImage')return {grant:image};
  if(args.action==='imagePreview')return {title:'截图.png',url:'data:image/png;base64,sample'};
  if(args.action==='message'&&attempts++===0)throw new Error('发送失败');
  return current;
 });
 try{
  await open();
  await act(async()=>{const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{files:[new File(['sample'],'截图.png',{type:'image/png'})]}});document.querySelector('.agent-composer')!.dispatchEvent(event);});
  expect(invoke.mock.calls.some(([,p])=>p?.args?.action==='stageImage')).toBe(true);
  expect(invoke.mock.calls.some(([,p])=>['message','respond'].includes(p?.args?.action))).toBe(false);
  await fill('investigationGoal','分析截图');await click('发送追问');
  expect(document.querySelector('.agent-image-card')).not.toBeNull();expect(document.body.textContent).toContain('发送失败');
  await click('发送追问');
  const messages=invoke.mock.calls.filter(([,p])=>p?.args?.action==='message').map(([,p])=>p.args);
  expect(messages).toHaveLength(2);expect(messages[1]).toEqual(messages[0]);expect(messages[1].addImages).toEqual([image]);
 }finally{prepare.mockRestore();}
});
it("keeps the explicit page grant when adding cached images before the first question",async()=>{
 const image={libraryId:'notes',documentId:'doc',sourceItemId:'img',inputVersion:'v1',blobHash:'a'.repeat(64)};
 invoke.mockImplementation(async(_,{args})=>args.action==='list'?{works:[]}:args.action==='imageMaterials'?{images:[{grant:image,title:'图像样本',mime:'image/png'}],hasMore:false}:current);
 await open();await openAddPage('从资料库添加图片');await click('查找缓存图片');
 await act(async()=>Array.from(document.querySelectorAll<HTMLInputElement>('.agent-material-choice input')).find(e=>e.type==='checkbox')!.click());
 await click('添加到问题');
 expect(invoke.mock.calls.some(([,p])=>['create','message','respond'].includes(p?.args?.action))).toBe(false);
 await fill('investigationGoal','结合图片分析');await click('开始调查');
 expect(invoke.mock.calls.find(([,p])=>p?.args?.action==='create')![1].args.grant.notes).toEqual([investigationAnchor(result)]);
 expect(invoke.mock.calls.find(([,p])=>p?.args?.action==='message')![1].args.addImages).toEqual([image]);
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==='respond')).toBe(true);
});
it("captures preview selection as text and queues a flashcard snapshot through the shared launcher",async()=>{
 invoke.mockImplementation(async(_,{args})=>args.action==='list'?{works:[]}:current);
 await act(async()=>root.render(<AgentPanelProvider><article className="preview-card"><h1>来源文章</h1><p id="source-selection">选中的原文资料</p></article><StandaloneAgentLauncher/><AgentFlashcardMaterial title="闪卡问题" text="问题与答案快照"/></AgentPanelProvider>));
 await click('添加闪卡到助手');await act(async()=>{await new Promise(r=>setTimeout(r,80));});
 expect(document.querySelector('[data-material-kind="flashcard"]')?.textContent).toContain('闪卡问题');
 await act(async()=>{const range=document.createRange();range.selectNodeContents(document.getElementById('source-selection')!);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));});
 await click('添加所选文字');expect(document.querySelector('[data-material-kind="text"]')?.textContent).toContain('选中的原文资料');
 expect(document.querySelector('[data-material-kind="text"]')?.textContent).not.toContain('区块');
 expect(invoke.mock.calls.some(([,p])=>['message','create','respond'].includes(p?.args?.action))).toBe(false);
});

it("keeps global history in a fresh page chat without resuming an unrelated work",async()=>{
 invoke.mockImplementation(async(_,{args})=>args.action==='list'?{works:args.anchor?[]:[{id:'other-work',goal:'另一篇资料的历史对话',state:'completed'}]}:current);
 await open();
 await openHistory();
 expect(document.querySelector('.agent-conversations')?.textContent).toContain('另一篇资料的历史对话');
 expect(document.querySelector('.agent-task-mode .agent-mode-title')?.textContent).toBe('新聊天');
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==='status')).toBe(false);
 await click('新对话');
 await openHistory();
 expect(document.querySelector('.agent-conversations')?.textContent).toContain('另一篇资料的历史对话');
 await openDialogueDetails();
 expect(document.querySelector('.agent-dialogue-details')?.textContent).toContain('尚未开始任务');
 expect(document.querySelector('.agent-dialogue-details')?.textContent).toContain('资料范围');
 expect(document.querySelector('.agent-dialogue-details')?.textContent).toContain('记忆与后续操作');
 expect(invoke.mock.calls.some(([,p])=>['create','respond','resume','message'].includes(p?.args?.action))).toBe(false);
});
it("shows history read errors and retries only the history without replacing the draft",async()=>{
 let attempts=0;
 invoke.mockImplementation(async(_,{args})=>{if(args.action==='list'){attempts++;if(attempts===1)throw Error('历史读取暂时失败');return {works:[{id:'old',goal:'已保存的对话',state:'completed'}]};}return current;});
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 expect(document.querySelector('.agent-conversations')?.textContent).toContain('历史读取暂时失败');
 expect(document.querySelector('.agent-conversations')?.textContent).not.toContain('还没有历史对话');
 await fill('investigationGoal','重试时保留的草稿');await click('重新读取历史');
 expect(document.querySelector('.agent-conversations')?.textContent).toContain('已保存的对话');
 expect(document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.value).toBe('重试时保留的草稿');
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==='status')).toBe(false);
});
it("keeps history and menu sections visible when there are no saved conversations",async()=>{
 invoke.mockImplementation(async(_,{args})=>args.action==='list'?{works:[]}:current);
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 const menu=document.querySelector('.agent-details-content')!;
 expect(menu.textContent).toContain('还没有历史对话');expect(menu.textContent).toContain('资料范围');expect(menu.textContent).toContain('记忆与后续操作');expect(menu.textContent).toContain('用量与任务');
 expect(menu.querySelector('.agent-provider-budget')).toBeNull();expect(button('停止此任务')).toBeUndefined();
});


it.each(["codex","deepseek"])("new chats apply remembered model preferences and supported search (%s)",async provider=>{
 const model={provider,model:"remembered-model",reasoningEffort:"high",fast:true,maxConcurrent:2};
 localStorage.setItem("hub.agent.preferences.v1",JSON.stringify({model,webSearch:"live",autoFlashcardInbox:true,externalMcp:true}));
 await act(async()=>root.render(<StandaloneInvestigation initiallyOpen/>));
 await fill("investigationGoal","测试记忆设置");await click("开始调查");
 const configured=invoke.mock.calls.find(([,p])=>p?.args?.action==="configureAssistant")?.[1].args.options;
 expect(configured).toEqual({model,webSearch:provider==="codex"?"live":"disabled",autoFlashcardInbox:false});
});
it("new chat enables live search while restoring an old chat does not change its settings",async()=>{
 await open();await fill("investigationGoal","新问题");await click("开始调查");
 expect(invoke.mock.calls.find(([,p])=>p?.args?.action==="configureAssistant")?.[1].args.options.webSearch).toBe("live");
 expect(invoke.mock.calls.find(([,p])=>p?.args?.action==="create")?.[1].args.successCriteria).toBe("");
 await act(async()=>root.unmount());root=createRoot(host);invoke.mockClear();
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}]}:current);
 await open();
 expect(invoke.mock.calls.some(([,p])=>p?.args?.action==="configureAssistant")).toBe(false);
 await openAddPage("更多设置");
 const select=[...document.querySelectorAll<HTMLSelectElement>(".agent-connection-settings select")].find(s=>s.parentElement?.textContent?.startsWith("联网搜索"))!;
 expect(select.value).toBe("disabled");
});

it("opens the primary materials picker for a task and sends selected notes alongside it",async()=>{
 const original=invoke.getMockImplementation()!;
 const note={locator:{kind:'note',libraryId:'notes',documentId:'extra',pageId:null},title:'参考笔记',path:'研究',libraryName:'笔记库'};
 invoke.mockImplementation(async(command,options)=>options.args.action==='materials'?{notes:[note],total:1,nextOffset:null,snapshot:'task-notes'}:original(command,options));
 const task={...result,contentType:'task',sourceType:'craft_task',provider:'craft' as const,taskSourceId:'task-with-notes',blockId:'display'};
 await act(async()=>root.render(<AgentInvestigation result={task}/>));await click('调查这项任务');
 await click('添加资料');expect(document.body.querySelector('input[aria-label="按标题或路径查找"]')).not.toBeNull();
 await act(async()=>document.body.querySelector<HTMLInputElement>('.agent-material-choice input')!.click());
 await click('完成选择');await fill('investigationGoal','结合参考笔记核对任务');await click('开始调查');
 const grant=invoke.mock.calls.find(([,p])=>p?.args?.action==='create')![1].args.grant;
 expect(grant.notes).toEqual([note.locator]);expect(grant.sources).toEqual([{kind:'task',libraryId:'notes',sourceId:'task-with-notes'}]);
});

it.each([false,true])("sends the selected queued message with an exact run guard (active=%s)",async active=>{
 current=makeView(active?"investigating":"completed");
 if(active)Object.assign(current,{activity:[{runId:"native-run",running:true,canSteer:true,native:true,state:"investigating",events:[]}]});
 Object.assign(current,{followups:["one","two","three"].map(clientMessageId=>({clientMessageId,editVersion:1,state:"queued",deliveryMode:"queue",payload:{text:clientMessageId,addNotes:[],addImages:[]}})),lifecycle:{activeRunId:active?"native-run":null,controlRevision:1,workRevision:1,requiresExplicitResume:false}});
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:"work-1",goal:"测试队列",state:current.work.state}]}:current);
 await open();
 await act(async()=>[...document.querySelectorAll<HTMLButtonElement>(".agent-followups button")].filter(b=>b.textContent==="立即发送")[1].click());
 expect(invoke.mock.calls.find(([,p])=>p?.args?.action==="changeFollowup")?.[1].args).toMatchObject({clientMessageId:"two",operation:"send",expectedRunId:active?"native-run":null});
 const resumes=invoke.mock.calls.filter(([,p])=>p?.args?.action==="resumeQueue");
 expect(resumes).toHaveLength(active?0:1);
 if(!active)expect(resumes[0][1].args).toMatchObject({selectedMessageId:"two",expectedRunId:null});
});

it("keeps unsupported running queues in next-turn mode without a promotion request",async()=>{
 current=makeView("investigating");
 Object.assign(current,{followups:[{clientMessageId:"queued",editVersion:1,state:"queued",deliveryMode:"queue",payload:{text:"下一轮核对",addNotes:[],addImages:[]}}],activity:[{runId:"direct-run",running:true,canSteer:false,native:false,state:"investigating",events:[]}]});
 invoke.mockImplementation(async(_,{args})=>args.action==="list"?{works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]}:current);
 await open();
 expect(button("立即发送").disabled).toBe(true);
 await click("立即发送");
 expect(document.querySelector('.agent-followups')?.textContent).toContain("已排队 · 下一轮");
 expect(document.querySelector('.agent-followups')?.textContent).toContain("当前运行不支持即时追加");
 expect(invoke.mock.calls.some(([,p])=>["changeFollowup","resumeQueue"].includes(p?.args?.action))).toBe(false);
 expect(button("停止本轮").disabled).toBe(false);
});

it("keeps stop available and suppresses verified stop errors during selected queue delivery",async()=>{
 current=makeView("completed");
 Object.assign(current,{followups:[{clientMessageId:"two",editVersion:1,state:"held",deliveryMode:"queue",payload:{text:"第二条",addNotes:[],addImages:[]}}]});
 let rejectRun!:(reason:Error)=>void;
 invoke.mockImplementation(async(_,{args})=>{
  if(args.action==="list")return {works:[{id:"work-1",goal:current.work.goal,state:current.work.state}]};
  if(args.action==="resumeQueue")return new Promise((_,reject)=>{rejectRun=reject;});
  if(args.action==="cancel")current=makeView("paused");
  return current;
 });
 await open();await click("立即发送");
 expect(button("停止本轮").disabled).toBe(false);
 await click("停止本轮");
 await act(async()=>rejectRun(new Error("调查已结束")));
 expect(document.querySelector('.agent-error')).toBeNull();
});

it("keeps file-only followup and typed draft through a send failure, then queues the exact attachment",async()=>{
 const locator={kind:"note",libraryId:"files",documentId:"staged",pageId:null};
 current={...makeView("investigating"),activity:[{runId:"native-run",revision:1,state:"investigating",running:true,native:true,canSteer:true,startedAt:Date.now(),steps:0,events:[]}]};
 Object.assign(current.work,{authorizationVersion:7});
 let reject=true;
 invoke.mockImplementation(async(_,{args})=>{
  if(args.action==="list")return {works:[{id:"work-1",goal:"正在处理",state:"investigating"}]};
  if(args.action==="stageTextFile")return {locator,title:"追加.md",libraryName:"本地文本附件",path:"追加.md",totalChars:4};
  if(args.action==="followup"&&reject)throw new Error("暂时无法保存");
  return current;
 });
 const read=vi.spyOn(fileInputs,"readTextFile").mockResolvedValue("新资料");
 await open();
 expect(button("添加资料").disabled).toBe(false);
 await act(async()=>{const event=new Event("drop",{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:{files:[new File(["新资料"],"追加.md",{type:"text/markdown"})]}});document.querySelector(".agent-composer")!.dispatchEvent(event);});
 expect(document.body.textContent).toContain("追加.md");
 await click("追加要求");
 expect(document.body.textContent).toContain("暂时无法保存");
 expect(document.body.textContent).toContain("追加.md");
 await fill("investigationGoal","下一轮核对附件");
 await act(async()=>{const select=document.querySelector<HTMLSelectElement>('[aria-label="运行中发送方式"]')!;select.value="queue";select.dispatchEvent(new Event("change",{bubbles:true}));});
 reject=false;await click("排队发送");
 const requests=invoke.mock.calls.filter(([,p])=>p?.args?.action==="followup").map(([,p])=>p.args);
 expect(requests[0]).toMatchObject({text:"请查看本次提供的附件。",deliveryMode:"steer",addNotes:[locator]});
 expect(requests[1]).toMatchObject({text:"下一轮核对附件",deliveryMode:"queue",addNotes:[locator],expectedAuthorizationVersion:7});
 expect(invoke.mock.calls.some(([,p])=>["respond","message","steer"].includes(p?.args?.action))).toBe(false);
 expect(document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!.value).toBe("");
 read.mockRestore();
});
