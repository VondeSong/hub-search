// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {InsightsWorkspace} from "./InsightsWorkspace";
import {AgentPanelContext} from "./StandaloneAgentLauncher";
import {userProfileStorage} from "./UserProfileStorage";
import type {Insight} from "./InsightTypes";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

const {invoke,listeners,store}=vi.hoisted(()=>({invoke:vi.fn(),listeners:new Map<string,(event:unknown)=>void>(),store:{items:[] as Insight[],lostReply:false}}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("./CodexAccounts",()=>({getCodexAccountSnapshot:()=>({loaded:true,loading:false,current:{scopeId:"a".repeat(64)}}),refreshCodexAccounts:vi.fn(async()=>undefined)}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async(name:string,handler:(e:unknown)=>void)=>{listeners.set(name,handler);return()=>listeners.delete(name);})}));
let root:Root,host:HTMLDivElement;
const openWork=vi.fn();
const source={evidenceId:"e1",quote:"本周已完成原型验证",excerpt:{title:"项目复盘",sourcePath:"project.md",content:"本周已完成原型验证；采用小样本方法。",startChar:0,endChar:26,totalChars:26,truncated:false,locator:{kind:"note",libraryId:"notes",documentId:"progress",pageId:null},version:{kind:"document",fingerprint:"v1"}}};
function item(id="one"):Insight{return {id,workId:"work-a",headRevision:1,rowRevision:1,createdAt:Date.now(),updatedAt:Date.now(),processingState:"attention",snoozeUntil:null,followed:true,validity:"available",reasons:[],snapshot:{text:"本周已完成原型验证。",origin:{workId:"work-a",runId:"run-a",deliveryRecordId:"delivery-a",deliveryHash:"hash-a",generatedAt:Date.now()},sourceCitations:[source],contextDependencies:[],userContextRefs:[]},events:[]};}
function button(text:string){const b=[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===text);if(!b)throw new Error(`Missing button: ${text}`);return b;}
async function click(text:string){await act(async()=>button(text).click());}
async function mount(){host=document.createElement("div");document.body.append(host);root=createRoot(host);await act(async()=>root.render(<AgentPanelContext.Provider value={openWork}><InsightsWorkspace/></AgentPanelContext.Provider>));}
beforeEach(()=>{
 localStorage.clear();listeners.clear();invoke.mockReset();openWork.mockReset();store.items=[item()];store.lostReply=false;
 invoke.mockImplementation(async(_command:string,{args}:{args:Record<string,unknown>})=>{
  const current=store.items.find(i=>i.id===(args.insightId??"one"))!;
  switch(args.action){
   case "status":return {work:{id:"work-a",revision:2,report:null},lifecycle:{controlRevision:7,workRevision:2,activeRunId:null,requiresExplicitResume:true,canResume:true,executionModes:{quick:true}},assistantOptions:{model:{provider:"codex"}}};
   case "insightList":return structuredClone({items:store.items,hasMore:false,nextBefore:null});
   case "insightDetail":return structuredClone({...current,contentRevision:Number(args.revision??current.headRevision)});
   case "insightStatus":current.processingState=args.state as Insight["processingState"];++current.rowRevision;if(store.lostReply){store.lostReply=false;throw new Error("reply lost");}return structuredClone({committed:true,item:current});
   case "insightOperation":return structuredClone({committed:true,item:current});
   case "insightSource":return structuredClone(source);
   case "insightFeedback":++current.rowRevision;current.validity="review";current.reasons.push({id:"reason-u1",kind:"feedback",active:true,reference:{feedbackId:String(args.operationId)}});current.events?.push({id:String(args.operationId),kind:"insightFeedback",createdAt:Date.now(),targetRevision:1,body:{text:String(args.text),kind:String(args.kind)}});return structuredClone({committed:true,item:current});
   case "list":return {works:[{id:"work-a",goal:"核对方法与进展",state:"completed"}],nextCursor:null};
   case "insightDeliveries":return {items:[{deliveryRecordId:"delivery-a",deliveryHash:"hash-a",generatedAt:Date.now(),findingCount:1,status:"completed",runId:"run-a"}],nextBeforeRecordId:null};
   case "insightCandidates":return {origin:store.items[0].snapshot!.origin,candidates:[{findingPointer:"/report/findings/0",text:"验证前先固定通过条件。",eligibility:"verifiedSources",sourceCitations:[source]}],contextOptions:[]};
   case "insightImport":return structuredClone({committed:true,item:store.items[0]});
   default:throw new Error(`Unexpected command: ${String(args.action)}`);
  }
 });
});
afterEach(async()=>{await act(async()=>root?.unmount());host?.remove();vi.useRealTimers();});

it("reads and filters stored findings without invoking a model",async()=>{
 await mount();expect(host.textContent).toContain("本周已完成原型验证。");
 await click("查看发现");await click("已处理");
 expect(document.body.textContent).toContain("已处理");
 expect(invoke.mock.calls.filter(([,v])=>["respond","resume","run"].includes(v.args.action))).toHaveLength(0);
 expect(invoke.mock.calls.find(([,v])=>v.args.action==="insightStatus")?.[1].args.expectedRevision).toBe(1);
});

it("opens the same original Work and rechecks a citation before showing its source",async()=>{
 await mount();await click("查看发现");
 await act(async()=>button("查看引用原文").click());expect(document.querySelector('[aria-label="引用定位"]')).not.toBeNull();
 expect(invoke.mock.calls.some(([,v])=>v.args.action==="insightSource"&&v.args.insightId==="one")).toBe(true);
 await click("返回回答");await click("原事项");expect(openWork).toHaveBeenCalledWith({workId:"work-a"});expect(document.querySelector('dialog[aria-label="发现与依据"]')).toBeNull();
});

it("requires source confirmation before saving a selected structured candidate",async()=>{
 await mount();await click("选择已有成果");
 const save=button("保存所选发现");expect(save.disabled).toBe(true);
 const radio=document.querySelector<HTMLInputElement>('dialog input[name="insightCandidate"]')!;
 await act(async()=>radio.click());expect(save.disabled).toBe(true);
 const confirm=[...document.querySelectorAll<HTMLLabelElement>("dialog label")].find(l=>l.textContent?.includes("已核对所选发现"))!.querySelector<HTMLInputElement>("input")!;
 await act(async()=>confirm.click());expect(save.disabled).toBe(false);
 await click("保存所选发现");
 const request=invoke.mock.calls.find(([,v])=>v.args.action==="insightImport")![1].args;
 expect(request.confirmDependencies).toBe(true);expect(request.deliveryRecordId).toBe("delivery-a");expect(request.findingPointer).toBe("/report/findings/0");
});

it("keeps an uncertain write identity and probes its result instead of sending it again",async()=>{
 store.lostReply=true;await mount();await click("查看发现");await click("已处理");
 expect(userProfileStorage.getItem("hub.insights.pending-write.v1")).toBeTruthy();
 // Close the detail so the pending-operation controls are not behind a modal.
 await click("返回列表");await click("核对提交结果");
 expect(userProfileStorage.getItem("hub.insights.pending-write.v1")).toBeNull();
 expect(invoke.mock.calls.filter(([,v])=>v.args.action==="insightStatus")).toHaveLength(1);
 expect(store.items[0].processingState).toBe("done");
});

it("removes cached sensitive content when source eligibility changes",async()=>{
 vi.useFakeTimers();await mount();await click("查看发现");
 store.items=[{...store.items[0],snapshot:undefined,validity:"unavailable"}];
 await act(async()=>{listeners.get("library-registry-updated")?.({payload:{}});});
 expect(document.body.textContent).not.toContain("本周已完成原型验证。");
 await act(async()=>{await vi.advanceTimersByTimeAsync(160);});
 expect(host.textContent).toContain("来源当前不可访问");
});


it("ignores an in-flight old detail after access changes and clears the result picker",async()=>{
 vi.useFakeTimers();await mount();
 let resolveOld!:(value:Insight)=>void;
 const normal=invoke.getMockImplementation()!;
 invoke.mockImplementation((command,args)=>args.args.action==="insightDetail"?new Promise<Insight>(resolve=>{resolveOld=resolve;}):normal(command,args));
 await act(async()=>button("查看发现").click());
 const old=structuredClone(store.items[0]);
 store.items=[{...old,snapshot:undefined,validity:"unavailable"}];
 await act(async()=>listeners.get("library-registry-updated")?.({payload:{}}));
 await act(async()=>resolveOld(old));
 expect(document.body.textContent).not.toContain("本周已完成原型验证。");
 invoke.mockImplementation(normal);
 await act(async()=>vi.advanceTimersByTimeAsync(160));
 await click("选择已有成果");
 expect(document.querySelector('dialog[aria-label="从已有成果保存发现"]')).not.toBeNull();
 await act(async()=>listeners.get("library-registry-updated")?.({payload:{}}));
 expect(document.querySelector('dialog[aria-label="从已有成果保存发现"]')).toBeNull();
});


it.each(["执行失败","用户已停止"])("preserves the old finding and feedback after a controlled review outcome: %s",async outcome=>{
 const original=store.items[0];original.validity="review";original.reasons=[{id:"u1-reason",kind:"feedback",active:true,reference:{feedbackId:"u1"}},{id:"source-reason",kind:"sourceChanged",active:true}];original.events=[{id:"u1",kind:"insightFeedback",targetRevision:1,createdAt:Date.now(),body:{kind:"correction",text:"这里只完成纸面原型。"}}];
 const normal=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,args)=>{if(args.args.action==="insightContinue")return {committed:true,item:structuredClone(original)};if(args.args.action==="resume")throw new Error(outcome);return normal(command,args);});
 await mount();await click("核对这条发现");
 const choice=document.querySelector<HTMLInputElement>('.insights-feedback-choice input')!;await act(async()=>choice.click());await click("按补充继续核对");
 expect(document.body.textContent).toContain("本次核对未完成");expect(store.items[0].headRevision).toBe(1);expect(store.items[0].validity).toBe("review");expect(store.items[0].events?.[0].id).toBe("u1");expect(store.items[0].reasons.every(r=>r.active)).toBe(true);
 expect(invoke.mock.calls.filter(([,v])=>v.args.action==="resume")).toHaveLength(1);
 const run=invoke.mock.calls.find(([,v])=>v.args.action==="resume")![1].args;expect(run).toMatchObject({id:"work-a",mode:"quick",expectedControlRevision:7,expectedWorkRevision:2,expectedRunId:null,codexScopeId:"a".repeat(64),commandId:expect.any(String)});
 expect(invoke.mock.calls.some(([,v])=>v.args.action==="insightUpdate")).toBe(false);
});


it("keeps an unsaved feedback draft and the current discovery while masking content on window focus",async()=>{
 vi.useFakeTimers();await mount();await click("查看发现");
 const area=document.querySelector<HTMLTextAreaElement>('textarea[aria-label="你的补充"]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(area,"未保存的验证范围补充");area.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>window.dispatchEvent(new Event("focus")));
 expect(document.querySelector('dialog[aria-label="发现与依据"]')).not.toBeNull();
 expect(document.body.textContent).not.toContain("本周已完成原型验证。");
 expect(document.body.textContent).toContain("未保存的补充已暂时保留");
 await act(async()=>vi.advanceTimersByTimeAsync(160));
 expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="你的补充"]')!.value).toBe("未保存的验证范围补充");
 expect(document.body.textContent).toContain("本周已完成原型验证。");
});


it("resumes an already queued supplement without saving another user message",async()=>{
 const original=store.items[0];original.validity="review";original.reasons=[{id:"u1-reason",kind:"feedback",active:true,reference:{feedbackId:"u1"}}];original.events=[{id:"u1",kind:"insightFeedback",targetRevision:1,createdAt:Date.now(),body:{kind:"correction",text:"这里只完成纸面原型。"}},{id:"sent-u1",kind:"insightContinue",targetRevision:1,createdAt:Date.now(),body:{workRevision:2,feedbackIds:["u1"]}}];
 const normal=invoke.getMockImplementation()!;invoke.mockImplementation(async(command,args)=>{if(args.args.action==="respond")return {};const value=await normal(command,args);if(args.args.action==="status")value.lifecycle.requiresExplicitResume=false;return value;});
 await mount();await click("核对这条发现");await act(async()=>document.querySelector<HTMLInputElement>('.insights-feedback-choice input')!.click());await click("按补充继续核对");
 expect(invoke.mock.calls.some(([,v])=>v.args.action==="insightContinue")).toBe(false);expect(invoke.mock.calls.filter(([,v])=>v.args.action==="respond")).toHaveLength(1);expect(openWork).toHaveBeenCalledWith({workId:"work-a"});
});
