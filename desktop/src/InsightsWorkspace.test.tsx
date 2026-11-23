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
   case "insightStar":current.starred=!!args.starred;++current.rowRevision;return structuredClone({committed:true,item:current});
   case "insightPerspective":current.perspective=String(args.perspective);++current.rowRevision;return structuredClone({committed:true,item:current});
   case "insightHistory":return {items:[{id:"event1",insightId:"one",kind:"insightStar",createdAt:Date.now(),cursor:1,text:"本周已完成原型验证"}],nextBefore:null};
   case "insightAnalysisScope":return {workRevision:2,sources:[{title:"指定任务",locator:{kind:"task",libraryId:"craft",sourceId:"t1"},sourcePath:"task"},{title:"完成说明",locator:source.excerpt.locator,sourcePath:"progress.md"}]};
   case "insightAnalysisPrepare":return {prepared:true,modelStarted:false};
   case "insightStatus":current.processingState=args.state as Insight["processingState"];++current.rowRevision;if(store.lostReply){store.lostReply=false;throw new Error("reply lost");}return structuredClone({committed:true,item:current});
   case "insightOperation":return structuredClone({committed:true,item:current});
   case "insightSource":return structuredClone(source);
   case "insightRelate":current.supersedes=args.supersedes as string[];++current.rowRevision;return structuredClone({committed:true,item:current});
   case "insightFeedback":++current.rowRevision;current.validity="review";current.reasons.push({id:"reason-u1",kind:"feedback",active:true,reference:{feedbackId:String(args.operationId)}});current.events?.push({id:String(args.operationId),kind:"insightFeedback",createdAt:Date.now(),targetRevision:1,body:{text:String(args.text),kind:String(args.kind)}});return structuredClone({committed:true,item:current});
   case "list":return {works:[{id:"work-a",goal:"核对方法与进展",state:"completed"}],nextCursor:null};
   case "insightDeliveries":return {items:[{deliveryRecordId:"delivery-a",deliveryHash:"hash-a",generatedAt:Date.now(),findingCount:1,status:"completed",runId:"run-a"}],nextBeforeRecordId:null};
   case "insightCandidates":return {origin:store.items[0].snapshot!.origin,candidates:[{findingPointer:"/report/findings/0",text:"验证前先固定通过条件。",eligibility:"verifiedSources",sourceCitations:[source]}],contextOptions:[]};
   case "insightImport":return structuredClone({committed:true,item:store.items[0]});
   case "insightRecall":return {scopeCount:2,candidates:[{locator:source.excerpt.locator,version:source.excerpt.version,title:"项目复盘",snippet:"本周已完成原型验证",matchStartChar:0}],limitReached:false,unavailableCandidates:0};
   case "insightRecallSource":return structuredClone(source.excerpt);
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

it("preserves an explicitly selected historical revision across focus revalidation",async()=>{
 store.items[0].headRevision=3;await mount();await click('查看发现');
 const select=document.querySelector<HTMLSelectElement>('select[aria-label="查看内容版本"]')!;
 await act(async()=>{select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));});
 vi.useFakeTimers();await act(async()=>window.dispatchEvent(new Event('focus')));
 await act(async()=>vi.advanceTimersByTimeAsync(160));
 const request=invoke.mock.calls.filter(([,v])=>v.args.action==='insightDetail').slice(-1)[0][1].args;
 expect(request.revision).toBe(1);expect(document.querySelector<HTMLSelectElement>('select[aria-label="查看内容版本"]')!.value).toBe('1');
});

it("returns to the current revision after reconciling a committed write with a lost reply",async()=>{
 store.items[0].headRevision=3;store.lostReply=true;await mount();
 await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="列表与详情"]')!.click());
 await click('查看发现');const select=document.querySelector<HTMLSelectElement>('select[aria-label="查看内容版本"]')!;
 await act(async()=>{select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));});
 const action=[...host.querySelectorAll<HTMLButtonElement>('.insights-card-menu button')].find(b=>b.textContent==='已处理')!;
 await act(async()=>action.click());await click('核对提交结果');
 vi.useFakeTimers();await act(async()=>window.dispatchEvent(new Event('focus')));await act(async()=>vi.advanceTimersByTimeAsync(160));
 const request=invoke.mock.calls.filter(([,v])=>v.args.action==='insightDetail').slice(-1)[0][1].args;
 expect(request.revision).toBeUndefined();expect(document.querySelector<HTMLSelectElement>('select[aria-label="查看内容版本"]')!.value).toBe('3');
});

it("requires source confirmation before saving a selected structured candidate",async()=>{
 await mount();await click("从已有分析导入");
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


it("ignores an old detail and rechecks picker access while preserving the chosen Work",async()=>{
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
 await click("从已有分析导入");
 expect(document.querySelector('dialog[aria-label="从已有成果保存发现"]')).not.toBeNull();
 await act(async()=>listeners.get("library-registry-updated")?.({payload:{}}));
 expect(document.querySelector('dialog[aria-label="从已有成果保存发现"]')).not.toBeNull();
 expect(document.querySelector<HTMLSelectElement>('select[aria-label="成果事项"]')!.value).toBe("work-a");
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
 expect(document.querySelector('section[aria-label="发现与依据"]')).not.toBeNull();
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


it("keeps prototype navigation honest and filters review findings without a model",async()=>{
 const second=item("two");second.validity="review";second.reasons=[{id:"changed",kind:"sourceChanged",active:true}];second.snapshot!.text="来源变化，需要重新核对。";store.items.push(second);
 await mount();expect(host.querySelector('aside[aria-label="洞察导航"]')).not.toBeNull();
 const navOpen=host.querySelector<HTMLButtonElement>('button[aria-label="展开洞察侧边栏"]')!;await act(async()=>navOpen.click());expect(document.activeElement?.getAttribute("aria-label")).toBe("收起洞察侧边栏");
 await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));expect(document.activeElement).toBe(navOpen);
 expect(button("阶段回顾").disabled).toBe(false);expect(host.querySelectorAll('.insights-card')).toHaveLength(2);
 await act(async()=>host.querySelector<HTMLButtonElement>('nav button[aria-current="page"]')!.click());
 const review=[...host.querySelectorAll<HTMLButtonElement>('nav button')].find(node=>node.textContent?.startsWith("待复核"))!;await act(async()=>review.click());
 expect(host.querySelectorAll('.insights-card')).toHaveLength(1);expect(host.querySelector('.insights-card')?.textContent).toContain("来源变化");
 expect(invoke.mock.calls.some(([,v])=>["respond","resume","run"].includes(v.args.action))).toBe(false);
});

it("preserves the draft and original finding when switching between cards and contextual detail",async()=>{
 store.items[0].snapshot!.text="验证范围需要补充。\n这里只完成纸面原型，尚未完成实机验证。";
 await mount();expect(host.querySelector('.insights-card h2')?.textContent).toBe("验证范围需要补充。");expect(host.querySelector('.insights-card-summary')?.textContent).toContain("尚未完成实机验证");
 await click("查看发现");const area=document.querySelector<HTMLTextAreaElement>('textarea[aria-label="你的补充"]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(area,"尚未保存的补充");area.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="列表与详情"]')!.click());
 expect(host.querySelector('section[aria-label="发现与依据"]')).not.toBeNull();expect(host.querySelector('textarea')!.value).toBe("尚未保存的补充");
 await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="卡片浏览"]')!.click());
 expect(host.querySelector('dialog[aria-label="发现与依据"]')).not.toBeNull();expect(host.querySelector('textarea')!.value).toBe("尚未保存的补充");expect(store.items[0].headRevision).toBe(1);
});


function twoCandidates(){return {origin:store.items[0].snapshot!.origin,candidates:[{findingPointer:"/report/findings/0",text:"验证方法发现。",eligibility:"verifiedSources",sourceCitations:[source]},{findingPointer:"/report/findings/1",text:"验证范围发现。",eligibility:"verifiedSources",sourceCitations:[source]}],contextOptions:[{evidenceId:"background-one",title:"共同口径",locator:source.excerpt.locator,version:source.excerpt.version}]};}
function dependencyConfirm(){return [...document.querySelectorAll<HTMLLabelElement>('dialog label')].find(label=>label.textContent?.includes("已核对所选发现"))!.querySelector<HTMLInputElement>('input')!;}

it("invalidates source confirmation whenever selected candidates or common background change",async()=>{
 const normal=invoke.getMockImplementation()!;invoke.mockImplementation(async(command,args)=>args.args.action==="insightCandidates"?twoCandidates():normal(command,args));
 await mount();await click("从已有分析导入");const choices=document.querySelectorAll<HTMLInputElement>('dialog input[name="insightCandidate"]');
 await act(async()=>choices[0].click());await act(async()=>dependencyConfirm().click());expect(button("保存所选发现").disabled).toBe(false);
 await act(async()=>choices[1].click());expect(dependencyConfirm().checked).toBe(false);expect(button("保存所选发现").disabled).toBe(true);
 await act(async()=>dependencyConfirm().click());const background=[...document.querySelectorAll<HTMLLabelElement>('dialog label')].find(label=>label.textContent?.includes("共同口径"))!.querySelector<HTMLInputElement>('input')!;
 await act(async()=>background.click());expect(dependencyConfirm().checked).toBe(false);expect(button("保存所选发现").disabled).toBe(true);
});

it("keeps the original Work entry when a published answer has no extractable findings",async()=>{
 const normal=invoke.getMockImplementation()!;invoke.mockImplementation(async(command,args)=>args.args.action==="insightCandidates"?{origin:store.items[0].snapshot!.origin,candidates:[],reason:"本成果是普通正文，没有可提取发现。"}:normal(command,args));
 await mount();await click("从已有分析导入");expect(document.body.textContent).toContain("没有可提取发现");await click("查看原事项");expect(openWork).toHaveBeenCalledWith({workId:"work-a"});expect(document.querySelector('dialog[aria-label="从已有成果保存发现"]')).toBeNull();expect(invoke.mock.calls.some(([,v])=>["respond","run","resume"].includes(v.args.action))).toBe(false);
});

it("preserves unsaved feedback while selecting a new result and returning to the finding",async()=>{
 await mount();await click("查看发现");const area=document.querySelector<HTMLTextAreaElement>('textarea[aria-label="你的补充"]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(area,"还没有保存的限定");area.dispatchEvent(new Event("input",{bubbles:true}));});
 await click("选择新成果更新");expect(document.querySelector('dialog[aria-label="更新这条发现"]')).not.toBeNull();await click("取消");expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="你的补充"]')!.value).toBe("还没有保存的限定");expect(invoke.mock.calls.some(([,v])=>v.args.action==="insightFeedback")).toBe(false);
});

it("reports confirmed partial saves if a later selection has an unknown result",async()=>{
 const normal=invoke.getMockImplementation()!;let saved=0;invoke.mockImplementation(async(command,args)=>{if(args.args.action==="insightCandidates")return twoCandidates();if(args.args.action==="insightImport"&&++saved===2)throw new Error("第二项回执中断");return normal(command,args);});
 await mount();await click("从已有分析导入");for(const choice of document.querySelectorAll<HTMLInputElement>('dialog input[name="insightCandidate"]'))await act(async()=>choice.click());await act(async()=>dependencyConfirm().click());await click("保存所选发现");
 expect(document.querySelector('dialog')!.textContent).toContain("已保存 1 条");expect(document.querySelector('dialog')!.textContent).toContain("有一项保存结果需要核对");expect(button("保存所选发现").disabled).toBe(true);expect(document.querySelectorAll('dialog input[name="insightCandidate"]:checked')).toHaveLength(1);expect(invoke.mock.calls.filter(([,v])=>v.args.action==="insightImport")).toHaveLength(2);
});

it("saves manual replacement links without completing or changing the original discovery",async()=>{
 const old=item("old"),fresh=item("fresh");old.processingState="done";old.snapshot!.text="需要保留的原发现。";fresh.snapshot!.text="拆分后单独保存的新发现。";store.items=[old,fresh];
 await mount();await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="拆分后单独保存的新发现。"]')!.click());await act(async()=>{const section=document.querySelector<HTMLDetailsElement>(".insights-relations")!;section.open=true;section.dispatchEvent(new Event("toggle"));});const choice=document.querySelector<HTMLInputElement>('input[aria-label="替代：需要保留的原发现。"]')!;expect(choice).not.toBeNull();await act(async()=>choice.click());expect(button("保存替代关系").disabled).toBe(true);
 const confirm=[...document.querySelectorAll<HTMLLabelElement>('.insights-relations label')].find(label=>label.textContent?.includes("我已核对这些发现"))!.querySelector<HTMLInputElement>('input')!;await act(async()=>confirm.click());await click("保存替代关系");
 expect(invoke.mock.calls.find(([,v])=>v.args.action==="insightRelate")?.[1].args).toMatchObject({insightId:"fresh",expectedRevision:1,supersedes:["old"]});expect(old.processingState).toBe("done");expect(old.headRevision).toBe(1);expect(fresh.headRevision).toBe(1);expect(fresh.supersedes).toEqual(["old"]);expect(document.querySelector('.insights-relations')!.textContent).toContain("1 条");
});

async function recallSearchDraft(){
 await click("寻找旧知识");
 const work=document.querySelector<HTMLSelectElement>('select[aria-label="原事项"]')!;
 await act(async()=>{work.value="work-a";work.dispatchEvent(new Event("change",{bubbles:true}));});
 const input=document.querySelector<HTMLInputElement>('.insights-recall input')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"验证");input.dispatchEvent(new Event("input",{bubbles:true}));});
 return input;
}
it("recalls only inside the selected original Work and opens version-bound text without model or writes",async()=>{
 await mount();await recallSearchDraft();await click("在已选资料中查找");
 expect(document.body.textContent).toContain("2 份已选笔记");
 expect(invoke.mock.calls.find(([,v])=>v.args.action==="insightRecall")?.[1].args).toEqual({action:"insightRecall",id:"work-a",query:"验证"});
 await click("查看原文");expect(document.querySelector('[aria-label="候选资料原文"]')?.textContent).toContain(source.excerpt.content);
 expect(invoke.mock.calls.find(([,v])=>v.args.action==="insightRecallSource")?.[1].args.version).toEqual(source.excerpt.version);
 await click("在原事项核对");expect(openWork).toHaveBeenCalledWith({workId:"work-a",question:{id:expect.any(String),text:expect.stringContaining('关键词 "验证"')}});
 expect(document.querySelector('.insights-recall')).toBeNull();
 expect(invoke.mock.calls.every(([,v])=>!["respond","resume","create","message","insightImport","insightUpdate"].includes(v.args.action))).toBe(true);
});
it("changing a recall query rejects a late old result",async()=>{
 await mount();const input=await recallSearchDraft();let resolve!:(v:unknown)=>void;const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((c,v)=>v.args.action==="insightRecall"?new Promise(r=>{resolve=r;}):original(c,v));
 await click("在已选资料中查找");
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"没有资料");input.dispatchEvent(new Event("input",{bubbles:true}));});
 await act(async()=>resolve({scopeCount:2,candidates:[{title:"STALE_RECALL_SENTINEL",snippet:"old"}],limitReached:false,unavailableCandidates:0}));
 expect(document.body.textContent).not.toContain("STALE_RECALL_SENTINEL");expect(button("在已选资料中查找").disabled).toBe(false);
});
it("recall source errors and access refresh clear excerpts while retaining the question",async()=>{
 await mount();await recallSearchDraft();await click("在已选资料中查找");const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((c,v)=>v.args.action==="insightRecallSource"?Promise.reject(new Error("证据版本已改变")):original(c,v));
 await click("查看原文");expect(document.body.textContent).toContain("原文未显示，请重新查找");expect(document.querySelector('[aria-label="候选资料原文"]')).toBeNull();
 await act(async()=>listeners.get("library-registry-updated")?.({payload:{}}));
 expect(document.querySelector('.insights-recall')).not.toBeNull();
 expect(document.querySelector<HTMLInputElement>('.insights-recall input')!.value).toBe("验证");
 expect(document.querySelector('[aria-label="候选资料原文"]')).toBeNull();
});

it("opens the stage review with one current navigation item and no automatic model run",async()=>{
 await mount();await click("阶段回顾");expect(host.querySelectorAll('nav button[aria-current="page"]')).toHaveLength(1);expect(host.querySelector('nav button[aria-current="page"]')?.textContent).toContain("阶段回顾");expect(host.querySelector('[aria-label="回顾问题"]')).not.toBeNull();expect(invoke.mock.calls.some(([,v])=>["respond","resume","run"].includes(v.args.action))).toBe(false);
});

it("persists stars separately and enables the real history and public cases",async()=>{
 await mount();const star=host.querySelector<HTMLButtonElement>('.insights-card button[aria-label="星标发现"]')!;await act(async()=>star.click());expect(store.items[0].starred).toBe(true);expect(store.items[0].followed).toBe(true);expect(store.items[0].processingState).toBe("attention");
 await click("处理记录");expect(host.textContent).toContain("更新了星标");await click("返回发现");expect(document.body.textContent).toContain("发现与依据");await click("返回列表");
 await act(async()=>[...host.querySelectorAll<HTMLButtonElement>("nav button")].find(b=>b.textContent?.startsWith("真实案例"))!.click());expect(host.textContent).toContain("五个由公开文档支持");expect(store.items).toHaveLength(1);expect(invoke.mock.calls.some(([,v])=>v.args.action==="run")).toBe(false);
});
it("preserves feedback while navigating adjacent findings and changing focus",async()=>{
 const second=item("two");second.updatedAt=store.items[0].updatedAt-1;second.snapshot!.text="第二条不同发现";store.items.push(second);await mount();await click("查看发现");const input=document.querySelector<HTMLTextAreaElement>('[aria-label="你的补充"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"还没保存的纠正");input.dispatchEvent(new Event("input",{bubbles:true}));});await click("下一条");await click("上一条");expect(document.querySelector<HTMLTextAreaElement>('[aria-label="你的补充"]')!.value).toBe("还没保存的纠正");await click("专注阅读");expect(document.body.textContent).toContain("退出专注");
});
it("prepares explicit task comparison without starting a model or changing the task",async()=>{
 await mount();await click("寻找旧知识");const work=document.querySelector<HTMLSelectElement>('[aria-label="原事项"]')!;await act(async()=>{work.value="work-a";work.dispatchEvent(new Event("change",{bubbles:true}));});const mode=document.querySelector<HTMLSelectElement>('[aria-label="核对方式"]')!;await act(async()=>{mode.value="status";mode.dispatchEvent(new Event("change",{bubbles:true}));});const task=document.querySelector<HTMLSelectElement>('[aria-label="核对的任务"]')!;await act(async()=>{task.selectedIndex=1;task.dispatchEvent(new Event("change",{bubbles:true}));});const question=document.querySelector<HTMLInputElement>('.insights-recall input[type="text"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(question,"验证完成了吗？");question.dispatchEvent(new Event("input",{bubbles:true}));});await click("保存问题并打开原事项");expect(invoke.mock.calls.find(([,v])=>v.args.action==="insightAnalysisPrepare")?.[1].args).toMatchObject({mode:"status",task:{kind:"task",sourceId:"t1"},expectedRevision:2});expect(openWork).toHaveBeenCalledWith({workId:"work-a"});expect(invoke.mock.calls.some(([,v])=>["run","respond","resume","updateTask"].includes(v.args.action))).toBe(false);
});

it("hides old picker candidates when a registry refresh revokes their access, keeping navigation usable",async()=>{await mount();await click("从已有分析导入");expect(document.querySelector('.insights-candidate')).not.toBeNull();const normal=invoke.getMockImplementation()!;invoke.mockImplementation(async(c,v)=>v.args.action==="insightCandidates"?{origin:store.items[0].snapshot!.origin,candidates:[],reason:"来源已撤回"}:normal(c,v));await act(async()=>listeners.get("library-registry-updated")?.({payload:{}}));expect(document.querySelector('dialog[aria-label="从已有成果保存发现"]')).not.toBeNull();expect(document.querySelector('.insights-candidate')).toBeNull();expect(document.querySelector<HTMLButtonElement>('dialog footer button.insights-primary')!.disabled).toBe(true);expect(document.body.textContent).toContain("来源已撤回");});

it("searches stored Work titles and keeps paginated navigation across source refreshes",async()=>{
 const normal=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(c,v)=>v.args.action==="list"?{works:[{id:v.args.before?"work-older":"work-a",goal:v.args.before?"早期事项":"当前事项",state:"completed"}],nextCursor:v.args.before?null:{id:"work-a"}}:normal(c,v));
 await mount();await click("从已有分析导入");await click("更多事项");
 expect(document.querySelector<HTMLSelectElement>('[aria-label="成果事项"]')!.options.length).toBe(3);
 await act(async()=>listeners.get("library-registry-updated")?.({payload:{}}));
 expect(document.querySelector<HTMLSelectElement>('[aria-label="成果事项"]')!.options.length).toBe(3);
 const input=document.querySelector<HTMLInputElement>('[aria-label="搜索成果事项"]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"LiveSync");input.dispatchEvent(new Event("input",{bubbles:true}));});
 expect(invoke.mock.calls.some(([,v])=>v.args.action==="list"&&v.args.query==="LiveSync"&&!v.args.before)).toBe(true);
 expect(document.querySelector<HTMLSelectElement>('[aria-label="成果事项"]')!.options.length).toBe(2);
});

it("hides candidate bodies during revalidation and restores confirmation only for identical evidence",async()=>{
 await mount();await click("从已有分析导入");
 await act(async()=>document.querySelector<HTMLInputElement>('dialog input[name="insightCandidate"]')!.click());await act(async()=>dependencyConfirm().click());
 const normal=invoke.getMockImplementation()!;let finish!:(v:unknown)=>void;
 invoke.mockImplementation((c,v)=>v.args.action==="insightCandidates"?new Promise(resolve=>{finish=resolve;}):normal(c,v));
 await act(async()=>listeners.get("library-registry-updated")?.({payload:{}}));
 expect(document.querySelector('.insights-candidate')).toBeNull();expect(button("保存所选发现").disabled).toBe(true);
 await act(async()=>finish({origin:store.items[0].snapshot!.origin,candidates:[{findingPointer:"/report/findings/0",text:"验证前先固定通过条件。",eligibility:"verifiedSources",sourceCitations:[source]}],contextOptions:[]}));
 expect(document.querySelector<HTMLInputElement>('dialog input[name="insightCandidate"]')!.checked).toBe(true);expect(dependencyConfirm().checked).toBe(true);expect(button("保存所选发现").disabled).toBe(false);
});

it("renders native finding emphasis without exposing markdown markers or loading embedded media",async()=>{
 store.items[0].snapshot!.text="**明确的标题。** 保留条件与原文。 ![远程图片](https://fixture.invalid/track.png)";
 await mount();expect(host.querySelector('.insights-card h2')!.textContent).toBe("明确的标题。");
 await click("查看发现");expect(document.querySelector('.insights-finding-text strong')!.textContent).toBe("明确的标题。");expect(document.querySelector('.insights-finding-text img')).toBeNull();expect(document.querySelector('.insights-finding-text')!.textContent).not.toContain("**");
});

it("uses the finding body for a sectioned card heading without changing the stored content",async()=>{
 const raw="## 发现\n\n先核对常用目录的深度。模板是理想目标，工程笔记给出了常用工作区建议。\n\n## 适用条件\n\n用于日常工作区。";
 store.items[0].snapshot!.text=raw;await mount();
 expect(host.querySelector('.insights-card h2')!.textContent).toBe("先核对常用目录的深度。");
 expect(host.querySelector('.insights-card-summary')!.textContent).toContain("模板是理想目标");
 await click("查看发现");
 expect(host.querySelector(".insights-finding-heading")!.textContent).toBe("先核对常用目录的深度。");
 expect(host.querySelector(".insights-finding-text")!.textContent).toContain("用于日常工作区。");
 expect(store.items[0].snapshot!.text).toBe(raw);
});

it("preserves card menu identity during focus refresh while hiding stale evidence",async()=>{
 vi.useFakeTimers();await mount();const menu=document.querySelector<HTMLDetailsElement>('.insights-card-menu')!;menu.open=true;
 await act(async()=>window.dispatchEvent(new Event("focus")));
 expect(document.querySelector('.insights-card-menu')).toBe(menu);expect(menu.open).toBe(true);expect(document.body.textContent).not.toContain("本周已完成原型验证。");expect(document.body.textContent).toContain("正在核对依据");
 await act(async()=>vi.advanceTimersByTimeAsync(160));expect(document.querySelector('.insights-card-menu')).toBe(menu);expect(menu.open).toBe(true);
});

it("opens a native finding from the property table and rechecks its quoted source",async()=>{
 await mount();
 await click("查看发现");
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="全宽属性表格"]')!.click());
 expect(host.querySelector(".insights-table")?.textContent).toContain("依据已核对");
 expect(host.querySelector('section[aria-label="发现与依据"]')).toBeNull();
 await act(async()=>host.querySelector<HTMLButtonElement>(".insights-table-open")!.click());
 expect(host.querySelector('section[aria-label="发现与依据"]')).not.toBeNull();
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="原文引文核对"]')!.click());
 await click("查看引用原文");
 expect(host.querySelector('[aria-label="引用定位"]')).not.toBeNull();
 expect(invoke.mock.calls.find(([,value])=>value.args.action==="insightSource")?.[1].args).toMatchObject({insightId:"one",revision:1,sourceIndex:0});
 expect(invoke.mock.calls.every(([,value])=>["insightList","insightDetail","insightSource"].includes(value.args.action))).toBe(true);
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="关闭核对抽屉"]')!.click());
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="关闭详情"]')!.click());
 expect(host.querySelector(".insights-table")).not.toBeNull();
 expect(host.querySelector("[class*=insights-inline-detail]")).toBeNull();
});

it("stops a batch on an uncertain write and keeps the native operation receipt",async()=>{
 const now=Date.now();
 store.items=[item("one"),item("two"),item("three")].map((finding,index)=>({...finding,updatedAt:now-index}));
 const normal=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,request)=>{
  if(request.args.action==="insightStatus"&&request.args.insightId==="two")throw Error("reply lost");
  return normal(command,request);
 });
 await mount();
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="全宽属性表格"]')!.click());
 await act(async()=>host.querySelector<HTMLInputElement>('[aria-label="选择当前可操作发现"]')!.click());
 await click("批量标为已处理");
 const writes=invoke.mock.calls.filter(([,request])=>request.args.action==="insightStatus").map(([,request])=>request.args);
 expect(writes.map(request=>request.insightId)).toEqual(["one","two"]);
 expect(writes.map(request=>request.expectedRevision)).toEqual([1,1]);
 expect(store.items[0].processingState).toBe("done");
 expect(store.items[2].processingState).toBe("attention");
 expect(JSON.parse(userProfileStorage.getItem("hub.insights.pending-write.v1")!).operationId).toBe(writes[1].operationId);
 expect(host.textContent).toContain("已确认 1 / 3 条");
 expect(button("批量标为已处理").disabled).toBe(true);
});

it("aligns desktop single-row 3-mode topbar, list-header filters, stable split drag/reset, and inline Escape focus exit",async()=>{
 const second=item("two");second.processingState="done";second.validity="review";second.perspective="decision";second.starred=true;second.updatedAt=store.items[0].updatedAt-1000;second.snapshot!.text="决定保留双栏默认布局。";
 store.items[0].perspective="knowledge";
 store.items.push(second);
 const normal=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,request)=>{
  if(request.args.action==="insightWorkspace")return {entries:[],hasMore:false,nextBefore:null};
  return normal(command,request);
 });
 await mount();
 const workspace=host.querySelector<HTMLElement>(".insights-workspace")!;
 expect(workspace.classList.contains("insights-navigation-closed")).toBe(true);

 // Single-row 3-mode switch switches between 全部发现 / 阶段回顾 / 关注主题
 const modeTabs=[...host.querySelectorAll<HTMLButtonElement>('.insights-mode-switch [role="tab"]')];
 expect(modeTabs.map(t=>t.textContent?.replace(/\d+\+?$/,"").trim())).toEqual(["全部发现","阶段回顾","关注主题"]);
 await act(async()=>modeTabs[1].click());
 expect(host.querySelector('[aria-label="回顾问题"]')).not.toBeNull();
 await act(async()=>modeTabs[2].click());
 expect(host.querySelector(".insight-notebook")).not.toBeNull();
 await act(async()=>modeTabs[0].click());

 // List header quick scope pills and inline perspective/status filters work without model calls
 const reviewPill=[...host.querySelectorAll<HTMLButtonElement>('.insights-scope-pills [role="tab"]')].find(b=>b.textContent?.includes("待复核"))!;
 await act(async()=>reviewPill.click());
 expect(host.querySelectorAll(".insights-card")).toHaveLength(1);
 const allPill=host.querySelector<HTMLButtonElement>('.insights-scope-pills [role="tab"]')!;
 await act(async()=>allPill.click());
 expect(host.querySelectorAll(".insights-card")).toHaveLength(2);

 const persSelect=host.querySelector<HTMLSelectElement>('select[aria-label="按视角筛选"]')!;
 await act(async()=>{persSelect.value="decision";persSelect.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(host.querySelectorAll(".insights-card")).toHaveLength(1);
 await act(async()=>button("重置筛选").click());
 expect(host.querySelectorAll(".insights-card")).toHaveLength(2);

 // Split gutter ignores bare single click, persists real drag, and resets on double click
 const gutter=host.querySelector<HTMLDivElement>(".insights-split-gutter")!;
 expect(gutter.getAttribute("aria-valuenow")).toBe("344");
 await act(async()=>{
  gutter.dispatchEvent(new MouseEvent("pointerdown",{clientX:346,bubbles:true}));
  gutter.dispatchEvent(new MouseEvent("pointerup",{clientX:346,bubbles:true}));
 });
 expect(gutter.getAttribute("aria-valuenow")).toBe("344");
 await act(async()=>{
  gutter.dispatchEvent(new MouseEvent("pointerdown",{clientX:346,bubbles:true}));
  gutter.dispatchEvent(new MouseEvent("pointermove",{clientX:406,bubbles:true}));
  gutter.dispatchEvent(new MouseEvent("pointerup",{clientX:406,bubbles:true}));
 });
 expect(gutter.getAttribute("aria-valuenow")).toBe("404");
 expect(userProfileStorage.getItem("hub.insights.list-width.v1")).toBe("404");
 await act(async()=>{gutter.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));});
 expect(gutter.getAttribute("aria-valuenow")).toBe("344");

 // Inline desktop focus mode enters on click and exits cleanly on Escape
 await click("查看发现");
 await click("专注阅读");
 expect(workspace.classList.contains("insights-focus")).toBe(true);
 expect(host.querySelector("section.insights-v4-detail")).not.toBeNull();
 await act(async()=>{window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));});
 expect(workspace.classList.contains("insights-focus")).toBe(false);
 expect(invoke.mock.calls.some(([,v])=>["respond","resume","run"].includes(v.args.action))).toBe(false);
});

it("switches to discoveries when typing in topbar search from stageReview, topic, and history while keeping focus, filters, and drafts",async()=>{
 const liveSync=item("livesync-1");
 liveSync.perspective="knowledge";
 liveSync.snapshot!.text="LiveSync 同步冲突已通过独立副本解决。";
 liveSync.workTitle="LiveSync 排查";
 const other=item("other-1");
 other.perspective="decision";
 other.updatedAt=liveSync.updatedAt-500;
 other.snapshot!.text="其他决策记录。";
 store.items=[liveSync,other];
 const normal=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,request)=>{
  if(request.args.action==="insightWorkspace")return {items:[],drafts:[],nextBefore:null};
  return normal(command,request);
 });
 await mount();

 const modeTabs=()=>[...host.querySelectorAll<HTMLButtonElement>('.insights-mode-switch [role="tab"]')];
 const searchInput=host.querySelector<HTMLInputElement>('input[aria-label="搜索发现与依据"]')!;
 const typeQuery=async(value:string)=>{
  searchInput.focus();
  await act(async()=>{
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(searchInput,value);
   searchInput.dispatchEvent(new Event("input",{bubbles:true}));
  });
 };

 // 1) From 阶段回顾: preserve unsaved review draft + input focus + existing filter while rendering real LiveSync match
 await act(async()=>modeTabs()[1].click());
 const questionArea=host.querySelector<HTMLTextAreaElement>('textarea[aria-label="回顾问题"]')!;
 const noteArea=host.querySelector<HTMLTextAreaElement>('textarea[aria-label="回顾笔记"]')!;
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(questionArea,"本周 LiveSync 同步复盘");
  questionArea.dispatchEvent(new Event("input",{bubbles:true}));
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(noteArea,"实测 11-23 同步耗时");
  noteArea.dispatchEvent(new Event("input",{bubbles:true}));
 });
 await typeQuery("LiveSync");
 expect(modeTabs()[0].getAttribute("aria-selected")).toBe("true");
 expect(document.activeElement).toBe(searchInput);
 expect(host.querySelectorAll(".insights-card")).toHaveLength(1);
 expect(host.querySelector(".insights-card")?.textContent).toContain("LiveSync 同步冲突");
 // Returning to 阶段回顾 preserves both draft fields intact
 await act(async()=>modeTabs()[1].click());
 expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="回顾问题"]')!.value).toBe("本周 LiveSync 同步复盘");
 expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="回顾笔记"]')!.value).toBe("实测 11-23 同步耗时");

 // 2) From 关注主题: typing switches to discoveries while preserving open topic draft
 await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="清除搜索"]')!.click());
 await act(async()=>modeTabs()[2].click());
 await click("关注一个问题");
 const topicTitle=host.querySelector<HTMLInputElement>('.insight-notebook input[required]')!;
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(topicTitle,"持续观察同步稳定性");
  topicTitle.dispatchEvent(new Event("input",{bubbles:true}));
 });
 await typeQuery("LiveSync");
 expect(modeTabs()[0].getAttribute("aria-selected")).toBe("true");
 expect(document.activeElement).toBe(searchInput);
 expect(host.querySelectorAll(".insights-card")).toHaveLength(1);
 expect(host.querySelector(".insights-card")?.textContent).toContain("LiveSync 同步冲突");
 await act(async()=>modeTabs()[2].click());
 expect(host.querySelector<HTMLInputElement>('.insight-notebook input[required]')!.value).toBe("持续观察同步稳定性");
 // Pressing Enter on an already-filled search query from a secondary mode also jumps back to discoveries
 searchInput.focus();
 await act(async()=>{searchInput.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));});
 expect(modeTabs()[0].getAttribute("aria-selected")).toBe("true");
 expect(document.activeElement).toBe(searchInput);

 // 3) From 处理记录 (legacy history entry): typing switches to discoveries and preserves focus
 await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="清除搜索"]')!.click());
 expect(document.activeElement).toBe(searchInput);
 await click("处理记录");
 expect(host.textContent).toContain("更新了星标");
 await typeQuery("LiveSync");
 expect(modeTabs()[0].getAttribute("aria-selected")).toBe("true");
 expect(document.activeElement).toBe(searchInput);
 expect(host.querySelectorAll(".insights-card")).toHaveLength(1);
 expect(host.querySelector(".insights-card")?.textContent).toContain("LiveSync 同步冲突");
 // Returning to 处理记录 still displays real history entries
 await click("处理记录");
 expect(host.textContent).toContain("更新了星标");

 // 4) Existing discovery filter is preserved when search switches from secondary mode back to discoveries
 await act(async()=>modeTabs()[0].click());
 await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="清除搜索"]')!.click());
 const persSelect=host.querySelector<HTMLSelectElement>('select[aria-label="按视角筛选"]')!;
 await act(async()=>{persSelect.value="decision";persSelect.dispatchEvent(new Event("change",{bubbles:true}));});
 await act(async()=>modeTabs()[1].click());
 await typeQuery("LiveSync");
 expect(modeTabs()[0].getAttribute("aria-selected")).toBe("true");
 expect(persSelect.value).toBe("decision");
 expect(host.querySelectorAll(".insights-card")).toHaveLength(0);
 await act(async()=>button("重置筛选").click());
 expect(host.querySelectorAll(".insights-card")).toHaveLength(2);

 // 5) Compact 2-row list header keeps sort/filter/layout accessibility and single-row default layout CSS
 const sortBtn=host.querySelector<HTMLButtonElement>(".insights-sort")!;
 expect(sortBtn.textContent?.trim()).toBe("最近");
 expect(sortBtn.getAttribute("aria-label")).toBe("按最近更新排序");
 await act(async()=>sortBtn.click());
 expect(sortBtn.textContent?.trim()).toBe("最早");
 expect(sortBtn.getAttribute("aria-label")).toBe("按最早更新排序");
 expect(host.querySelector('summary[aria-label="筛选发现"]')).not.toBeNull();
 expect(host.querySelectorAll('.insights-layout-switch button')).toHaveLength(3);
 expect(invoke.mock.calls.some(([,v])=>["respond","resume","run"].includes(v.args.action))).toBe(false);
});

it("keeps Android mobile unmounted per section with original query forwarding and no hidden generation reloads",async()=>{
 const previousPlatform=document.documentElement.dataset.runtimePlatform;
 document.documentElement.dataset.runtimePlatform="android";
 try{
  const normal=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command,request)=>{
   if(request.args.action==="insightWorkspace"){
    return {
     items:[
      {id:"topic-1",kind:"topic",workId:"work-a",version:1,title:"LiveSync 同步观察",body:"移动端主题正文",createdAt:Date.now(),updatedAt:Date.now(),state:"active",assumptions:[],observations:[]},
      {id:"topic-2",kind:"topic",workId:"work-a",version:1,title:"其他无关主题",body:"常规笔记",createdAt:Date.now(),updatedAt:Date.now(),state:"active",assumptions:[],observations:[]},
     ],
     drafts:[],
     nextBefore:null,
    };
   }
   return normal(command,request);
  });
  await mount();

  // Visiting 阶段回顾 then 关注主题 mounts only the active section (no desktop keep-alive slots)
  await click("阶段回顾");
  expect(host.querySelector(".insights-panel-slot")).toBeNull();
  expect(host.querySelector('[aria-label="回顾问题"]')).not.toBeNull();

  await click("关注主题");
  expect(host.querySelector(".insights-panel-slot")).toBeNull();
  expect(host.querySelector('[aria-label="回顾问题"]')).toBeNull();
  expect(host.textContent).toContain("LiveSync 同步观察");
  expect(host.textContent).toContain("其他无关主题");

  // Mobile topbar search stays in 关注主题 and filters current section directly
  const searchInput=host.querySelector<HTMLInputElement>('input[aria-label="搜索发现与依据"]')!;
  await act(async()=>{
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(searchInput,"LiveSync");
   searchInput.dispatchEvent(new Event("input",{bubbles:true}));
  });
  expect(host.querySelector(".insight-notebook")).not.toBeNull();
  expect(host.textContent).toContain("LiveSync 同步观察");
  expect(host.textContent).not.toContain("其他无关主题");

  // Leaving 关注主题 for 发现 unmounts the notebook so later generation refreshes never re-fetch insightWorkspace
  await click("工作草稿");
  const navDiscoveries=[...host.querySelectorAll<HTMLButtonElement>("nav button")].find(b=>b.textContent?.startsWith("发现"))!;
  await act(async()=>navDiscoveries.click());
  expect(host.querySelector(".insights-panel-slot")).toBeNull();
  expect(host.querySelector(".insight-notebook")).toBeNull();
  expect(host.querySelector('[aria-label="回顾问题"]')).toBeNull();

  const workspaceCallsBefore=invoke.mock.calls.filter(([,v])=>v.args.action==="insightWorkspace").length;
  vi.useFakeTimers();
  await act(async()=>{listeners.get("library-registry-updated")?.({payload:{}});});
  await act(async()=>{await vi.advanceTimersByTimeAsync(160);});
  const workspaceCallsAfter=invoke.mock.calls.filter(([,v])=>v.args.action==="insightWorkspace").length;
  expect(workspaceCallsAfter).toBe(workspaceCallsBefore);
 }finally{
  if(previousPlatform===undefined)delete document.documentElement.dataset.runtimePlatform;
  else document.documentElement.dataset.runtimePlatform=previousPlatform;
 }
});
