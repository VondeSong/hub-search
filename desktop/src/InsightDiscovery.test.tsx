// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {InsightDiscovery} from "./InsightDiscovery";
import type {useInsights} from "./useInsights";
import type {Insight} from "./InsightTypes";
const {invoke,listeners}=vi.hoisted(()=>({invoke:vi.fn(),listeners:new Map<string,()=>void>()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async(name:string,fn:()=>void)=>{listeners.set(name,fn);return()=>listeners.delete(name);})}));
let host:HTMLDivElement,root:Root,finished:boolean,revoked:boolean,prepares:Record<string,unknown>[];let candidateCount=1;
const source={title:"旧复盘",sourcePath:"旧复盘.md",content:"先做小样验证。",startChar:0,endChar:8,totalChars:8,truncated:false,locator:{kind:"note",libraryId:"notes",documentId:"one",pageId:null},version:{kind:"document",fingerprint:"v1"}};
const origin={workId:"work",runId:"run",deliveryRecordId:"delivery",deliveryHash:"hash",generatedAt:1};
const candidate={methodDependencies:[{kind:"skillInstructions",title:"资料分析与核对"}],findingPointer:"/report/findings/0",eligibility:"verifiedSources",text:"用旧复盘的小样方法先验证。",sourceCitations:[{evidenceId:"e1",excerpt:source}]};
const saved:Insight={id:"saved",workId:"work",rowRevision:1,headRevision:1,createdAt:1,updatedAt:1,processingState:"attention",snoozeUntil:null,followed:true,validity:"available",reasons:[],snapshot:{text:candidate.text,origin,sourceCitations:candidate.sourceCitations,contextDependencies:[],userContextRefs:[]}};
const saveCandidate=vi.fn(async()=>({item:saved}));
const data={unresolved:null,saveCandidate} as unknown as ReturnType<typeof useInsights>;
function button(label:string){const b=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label);if(!b)throw Error('Missing '+label);return b;}
async function click(label:string){await act(async()=>button(label).click());}
async function mount(){await act(async()=>root.render(<InsightDiscovery data={data} onOpenWork={vi.fn()} onView={vi.fn()}/>));}
beforeEach(()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();finished=false;revoked=false;prepares=[];candidateCount=1;listeners.clear();saveCandidate.mockClear();invoke.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);
 invoke.mockImplementation(async(_command:string,{args}:{args:Record<string,unknown>})=>{
  const config={question:"找联系",previousText:"",...prepares[prepares.length-1]};
  switch(args.action){
   case 'materials':return {notes:[{locator:source.locator,title:source.title,path:source.sourcePath,libraryName:"本地笔记"}],total:1,nextOffset:null,snapshot:"notes-v1"};
   case 'insightDiscoveryPrepare':prepares.push(args);return {workId:"work",workRevision:2,config,sources:[{title:source.title,path:source.sourcePath,locator:source.locator,version:source.version}],results:null};
   case 'status':return {work:{id:"work",revision:2,state:finished?"completed":"ready",report:finished?{summary:"完整答复"}:null},runActive:false,lifecycle:{requiresExplicitResume:false,executionModes:{quick:true}},assistantOptions:{model:{provider:"test"}}};
   case 'respond':finished=true;return {};
   case 'insightDiscoveryRead':if(revoked)throw Error("资料范围已改变");return {workId:"work",workRevision:2,config,sources:[{title:source.title,path:source.sourcePath,locator:source.locator,version:source.version}],results:finished?{origin,candidates:Array.from({length:candidateCount},(_,i)=>({...candidate,findingPointer:`/report/findings/${i}`})),contextOptions:[]}:null};
   case 'insightDiscoveryPreview':
   case 'insightDiscoverySource':return source;
   case 'insightDetail':return saved;
   default:throw Error(String(args.action));
  }
 });
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it('reads selectable local materials without running, then delivers and saves in the same view',async()=>{
 await mount();await click('查看原文');expect(host.querySelector('blockquote')?.textContent).toBe(source.content);await click('返回发现');expect(invoke.mock.calls.some(([,v])=>v.args.action==='respond')).toBe(false);expect(button('开始发现').disabled).toBe(true);
 await act(async()=>host.querySelector<HTMLInputElement>('.agent-material-choice input')!.click());await click('开始发现');
 expect(prepares[0].notes).toEqual([source.locator]);expect(host.textContent).toContain(candidate.text);expect(host.textContent).toContain('分析方法与工作约定');expect(host.textContent).toContain('不计为资料事实依据');expect(button('保留这条发现').disabled).toBe(true);
 await act(async()=>host.querySelector<HTMLInputElement>('.idd-check input')!.click());await click('保留这条发现');
 expect(saveCandidate).toHaveBeenCalledOnce();expect(host.textContent).toContain('已保留');await click('刷新结果');
 expect(invoke.mock.calls.filter(([,v])=>v.args.action==='respond')).toHaveLength(1);
});
it('carries the saved identity into a follow-up and keeps an explicit maintain outcome',async()=>{
 await mount();await act(async()=>host.querySelector<HTMLInputElement>('.agent-material-choice input')!.click());await click('开始发现');await act(async()=>host.querySelector<HTMLInputElement>('.idd-check input')!.click());await click('保留这条发现');await click('加入后续记录');
 await click('核对这次变化');expect(prepares[prepares.length-1]).toMatchObject({targetInsightId:'saved',targetRevision:1,id:'work'});
 await act(async()=>host.querySelector<HTMLInputElement>('.idd-check input')!.click());await click('维持判断并留记录');
 expect(saveCandidate.mock.calls[saveCandidate.mock.calls.length-1]).toEqual([origin,candidate,saved,[],[],'maintain']);
 await act(async()=>root.unmount());root=createRoot(host);await mount();
 expect(host.textContent).toContain('原判断');expect(button('维持判断并留记录')).toBeDefined();expect(host.textContent).not.toContain('保留这条发现');
 expect(invoke.mock.calls.filter(([,v])=>v.args.action==='respond')).toHaveLength(2);
 await click('另开始一次发现');expect(button('开始发现').disabled).toBe(true);expect(host.textContent).not.toContain('原判断');
});
it('hides the displayed answer and source when current authorization becomes unreadable',async()=>{
 await mount();await act(async()=>host.querySelector<HTMLInputElement>('.agent-material-choice input')!.click());await click('开始发现');await click('旧复盘');expect(host.querySelector('blockquote')?.textContent).toBe(source.content);
 revoked=true;await act(async()=>listeners.get('library-runtime-updated')?.());
 expect(host.querySelector('blockquote')).toBeNull();expect(host.textContent).not.toContain(candidate.text);expect(host.textContent).not.toContain('完整答复');expect(saveCandidate).not.toHaveBeenCalled();
});
it('formats Craft source with the shared reader while keeping exact text available',async()=>{
 await mount();const raw='<page id="one">\n<pageTitle>旧复盘</pageTitle>\n<content>\n  **先做小样验证。**\n</content>\n</page>';
 invoke.mockImplementationOnce(async()=>({...source,content:raw,facts:{provider:'craft'}}));await click('查看原文');
 expect(host.querySelector('.idd-source-text strong')?.textContent).toBe('先做小样验证。');
 expect(host.querySelector('.idd-source-text')?.textContent).not.toContain('<page');
 expect(host.querySelector('blockquote')?.textContent).toBe(raw);
 expect(invoke.mock.calls.some(([,v])=>v.args.action==='respond')).toBe(false);
});

it('keeps the original judgment visible when every new candidate needs rechecking',async()=>{
 finished=true;prepares.push({targetInsightId:saved.id,previousText:saved.snapshot!.text});
 const current=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(command,request)=>{
  const result=await current(command,request);
  if(request.args.action==='insightDiscoveryRead'&&result.results)result.results.candidates=[{...candidate,eligibility:'unavailable',reason:'资料内容已变化'}];
  return result;
 });
 await act(async()=>root.render(<InsightDiscovery data={data} target={saved} onOpenWork={vi.fn()} onView={vi.fn()}/>));
 await act(async()=>listeners.get('library-runtime-updated')?.());
 expect(host.querySelector('.idd-original')?.textContent).toContain(saved.snapshot!.text);
 expect(host.querySelector('.idd-compare-grid')).toBeNull();
 expect(host.textContent).toContain('资料内容已变化');
 expect(invoke.mock.calls.some(([,v])=>v.args.action==='respond')).toBe(false);
});

it('starts with three results and expands the remainder without another model run',async()=>{
 candidateCount=4;await mount();await act(async()=>host.querySelector<HTMLInputElement>('.agent-material-choice input')!.click());await click('开始发现');
 expect(host.querySelectorAll('.idd-finding')).toHaveLength(3);await click('再看 1 条发现');expect(host.querySelectorAll('.idd-finding')).toHaveLength(4);
 expect(invoke.mock.calls.filter(([,v])=>v.args.action==='respond')).toHaveLength(1);
});

it('restores the chosen judgment after a source refresh without treating its earlier analysis as a follow-up',async()=>{
 finished=true;await act(async()=>root.render(<InsightDiscovery data={data} target={saved} onOpenWork={vi.fn()} onView={vi.fn()}/>));
 await act(async()=>listeners.get('library-runtime-updated')?.());
 expect(host.querySelector('.idd-original')?.textContent).toContain(saved.snapshot!.text);
 expect(host.querySelector('.idd-results')).toBeNull();expect(host.querySelector('.idd-answer')).toBeNull();
 expect(invoke.mock.calls.some(([,v])=>v.args.action==='respond')).toBe(false);
});

it('waits for a slow status refresh before scheduling the next poll',async()=>{
 await mount();await act(async()=>host.querySelector<HTMLInputElement>('.agent-material-choice input')!.click());
 const original=invoke.getMockImplementation()!;const releases:Array<()=>void>=[];
 invoke.mockImplementation((command:string,value:{args:Record<string,unknown>})=>value.args.action==='insightDiscoveryRead'?new Promise(resolve=>releases.push(()=>resolve(original(command,value)))):original(command,value));
 vi.useFakeTimers();
 try{
  await act(async()=>button('开始发现').click());
  await act(async()=>vi.advanceTimersByTimeAsync(5000));
  expect(releases).toHaveLength(2);
  await act(async()=>releases.forEach(release=>release()));
  expect(host.textContent).toContain(candidate.text);
 }finally{vi.useRealTimers();}
});
