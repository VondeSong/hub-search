// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentActivity, type ActivityRun } from "./AgentActivity";
import { AgentConversation, type Conversation, type Report } from "./AgentDelivery";

let host:HTMLDivElement,root:Root;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();});
it("keeps one time disclosure above the timeline and preserves the user's collapse during streaming",async()=>{
 await act(async()=>root.render(<AgentActivity value={run}/>));
 const toggle=host.querySelector<HTMLButtonElement>('.agent-activity-toggle')!;
 expect(host.querySelector('section')?.firstElementChild).toBe(toggle);
 expect(toggle.textContent).toMatch(/^已处理 /);
 expect(toggle.getAttribute('aria-expanded')).toBe('true');
 expect(host.querySelector('.agent-spinning')).toBeNull();
 await act(async()=>toggle.click());
 expect(host.querySelector('.agent-activity-events')).toBeNull();
 await act(async()=>root.render(<AgentActivity value={{...run,events:[...run.events,{id:'next',kind:'message',state:'completed',label:'第二次进展',createdAt:2000}]}}/>));
 expect(host.querySelector('section')?.firstElementChild).toBe(toggle);
 expect(toggle.getAttribute('aria-expanded')).toBe('false');
 expect(host.querySelector('.agent-live-progress')).toBeNull();
 await expandProcess();
 expect(host.querySelectorAll('.agent-commentary')).toHaveLength(2);
 const group=host.querySelector<HTMLDetailsElement>('.agent-operation-group')!;
 expect(group.open).toBe(false);
 await act(async()=>group.querySelector('summary')!.click());
 expect(group.open).toBe(true);
});
async function expandProcess(){const button=host.querySelector<HTMLButtonElement>(".agent-activity-toggle");if(button?.getAttribute("aria-expanded")==="false")await act(async()=>button.click());}
it("keeps public reasoning visible between collapsed tool groups in chronological order",async()=>{
 const events:ActivityRun['events']=[run.events[1],{id:'reason',kind:'reasoning',state:'running',label:'核对两份来源的差异',createdAt:1750},run.events[2]];
 await act(async()=>root.render(<AgentActivity value={{...run,events}}/>));
 const reasoning=host.querySelector('[aria-label="思考摘要"]')!;
 expect(reasoning.textContent).toBe('核对两份来源的差异');
 expect(reasoning.closest('details')).toBeNull();
 expect(reasoning.previousElementSibling?.classList.contains('agent-operation-group')).toBe(true);
 expect(reasoning.nextElementSibling?.classList.contains('agent-operation-group')).toBe(true);
 expect([...host.querySelectorAll<HTMLDetailsElement>('.agent-operation-group')].every(group=>!group.open)).toBe(true);
});
it("uses the current action as the heading while keeping history oldest first",async()=>{
 const events:ActivityRun['events']=[{id:'new',kind:'webSearch',state:'running',label:'最新网页操作',createdAt:3000},{id:'old',kind:'webSearch',state:'completed',label:'最早网页操作',createdAt:1000}];
 await act(async()=>root.render(<AgentActivity value={{...run,events}}/>));
 const phase=host.querySelector<HTMLDetailsElement>('.agent-operation-group')!;
 expect(phase.querySelector('summary')?.textContent).toBe('最新网页操作');
 await act(async()=>phase.querySelector('summary')!.click());
 const rows=phase.querySelectorAll('.agent-web-activity > summary');
 expect(rows[0].textContent).toContain('最早网页操作');
 expect(rows[1].textContent).toContain('最新网页操作');
 expect(host.textContent).not.toContain('联网记录说明');
});
it("updates a phase title and preserves its disclosure when tools and summaries arrive",async()=>{
 const initial:ActivityRun={...run,events:[run.events[0],{...run.events[1],state:'running'}]};
 await act(async()=>root.render(<AgentActivity value={initial}/>));
 const phase=host.querySelector<HTMLDetailsElement>('.agent-operation-group')!;
 expect(phase.querySelector('summary')?.textContent).toBe('正在读取原文');
 await act(async()=>phase.querySelector('summary')!.click());
 await act(async()=>root.render(<AgentActivity value={{...run,events:[...run.events,{id:'thinking',kind:'reasoning',state:'running',label:'核对引用范围',createdAt:2000}]}}/>));
 expect(host.querySelector('.agent-operation-group')).toBe(phase);
 expect(phase.open).toBe(true);
 expect(phase.querySelector('summary')?.textContent).toBe('读取资料、调用工具');
 expect(phase.nextElementSibling?.textContent).toBe('核对引用范围');
 expect(phase.nextElementSibling?.closest('.agent-operation-group')).toBeNull();
 await act(async()=>root.render(<AgentActivity value={{...run,running:false,state:'completed',events:run.events.map(e=>({...e,state:'completed'}))}}/>));
 expect(phase.open).toBe(true);
 expect(phase.querySelector('summary')?.textContent).toBe('已读取资料、调用工具');
});
it("does not count failed or unresolved operations as completed",async()=>{
 await act(async()=>root.render(<AgentActivity value={{...run,events:[run.events[1],{...run.events[2],state:'failed'}, {id:'pending',kind:'tool',state:'queued',label:'尚未执行',createdAt:3000}]}}/>));
 const summary=host.querySelector('.agent-operation-group > summary')!;
 expect(summary.textContent).toContain('部分未完成');
 expect(summary.textContent).not.toContain('已完成');
});
const run:ActivityRun={runId:"r",revision:1,state:"investigating",running:true,startedAt:1000,steps:2,events:[
  {id:"1",kind:"message",state:"completed",label:"两份材料的适用范围不同，我先核对原文。",createdAt:1200},
  {id:"2",kind:"tool",state:"completed",label:"读取原文",createdAt:1300,finishedAt:1700},
  {id:"3",kind:"tool",state:"running",label:"检查草稿",createdAt:1800}
]};
it.each([false,true])("preserves process identity and user collapse=%s when the final answer is published",async collapsed=>{
 const conversation:Conversation={hasEarlier:false,messages:[{id:'user',role:'user',revision:1,text:'核对资料',createdAt:1}]};
 const activity={...run,events:run.events.map(e=>({...e,detail:e.kind==='tool'?'原文已核对':undefined}))};
 const render=(finished:boolean)=>root.render(<AgentConversation revoked={false} onOpenCitation={()=>{}} conversation={finished?{...conversation,messages:[...conversation.messages,{id:'answer',role:'assistant',runId:'r',revision:1,createdAt:5000,report:{status:'completed',summary:'最终核对结果',findings:[],nextSteps:[],questions:[],limitations:[],waitCondition:''}}]}:conversation} activity={[finished?{...activity,running:false,state:'completed',finishedAt:5000}:activity]}/>);
 await act(async()=>render(false));
 const section=host.querySelector('[aria-label="本轮工作过程"]');
 const toggle=host.querySelector<HTMLButtonElement>('.agent-activity-toggle')!;
 const group=host.querySelector<HTMLDetailsElement>('.agent-operation-group')!;
 await act(async()=>group.querySelector('summary')!.click());
 const detail=host.querySelector<HTMLDetailsElement>('.agent-tool-activity')!;
 await act(async()=>detail.querySelector('summary')!.click());
 if(collapsed)await act(async()=>toggle.click());
 await act(async()=>render(true));
 expect(host.querySelector('[aria-label="本轮工作过程"]')).toBe(section);
 expect(host.querySelector('.agent-activity-toggle')).toBe(toggle);
 expect(toggle.getAttribute('aria-expanded')).toBe(String(!collapsed));
 if(!collapsed){expect(host.querySelector('.agent-operation-group')).toBe(group);expect(group.open).toBe(true);expect(host.querySelector('.agent-tool-activity')).toBe(detail);expect(detail.open).toBe(true);}
 expect(host.textContent?.match(/最终核对结果/g)).toHaveLength(1);
 expect(section!.compareDocumentPosition(host.querySelector('[aria-label="助手回答"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it.each(['status','tool','reasoning'] as const)("renders %s thinking placeholders once without a completion icon",async kind=>{
 const events:ActivityRun['events']=[{id:'one',kind,state:'completed',label:'正在思考',createdAt:1},{id:'two',kind,state:'running',label:'正在思考',createdAt:2}];
 await act(async()=>root.render(<AgentActivity value={{...run,events}}/>));
 expect(host.textContent?.match(/正在思考/g)).toHaveLength(1);
 expect(host.querySelector('.agent-live-status')?.querySelector('svg')).toBeNull();
 expect(host.querySelector('.lucide-check')).toBeNull();
 await act(async()=>root.render(<AgentActivity value={{...run,running:false,state:'completed',finishedAt:5000,events}}/>));
 expect(host.textContent).not.toContain('正在思考');
});
it("shows honest waiting then a direct answer without an empty or invented process",async()=>{
 const user:Conversation['messages']=[{id:'u',role:'user',revision:1,text:'比较人物',createdAt:1}];
 const render=(activity:ActivityRun,messages=user)=>root.render(<AgentConversation conversation={{hasEarlier:false,messages}} activity={[activity]} revoked={false} onOpenCitation={()=>{}}/>);
 await act(async()=>render({...run,events:[]}));
 expect(host.textContent?.match(/正在思考/g)).toHaveLength(1);
 expect(host.querySelector('.agent-activity-toggle')).toBeNull();
 const answer={id:'answer',kind:'answer' as const,state:'running',label:'直接回答的正文',createdAt:4000};
 await act(async()=>render({...run,events:[answer]}));
 expect(host.textContent).not.toContain('正在思考');
 expect(host.querySelector('[aria-label="完整工作过程"]')).toBeNull();
 expect(host.querySelector('[aria-label="正在生成回答"]')?.textContent).toBe('直接回答的正文');
 await act(async()=>render({...run,running:false,state:'completed',finishedAt:5000,events:[answer]},[...user,{id:'a',role:'assistant',runId:'r',revision:1,createdAt:5000,report:{status:'completed',summary:'直接回答的正文',findings:[],nextSteps:[],questions:[],limitations:[],waitCondition:''}}]));
 expect(host.textContent?.match(/直接回答的正文/g)).toHaveLength(1);
 expect(host.querySelector('[aria-label="完整工作过程"]')).toBeNull();
 expect(host.querySelector('[aria-label="正在生成回答"]')).toBeNull();
 expect(host.querySelector('.agent-elapsed')?.textContent).toBe('用时 4 秒');
});
it("stops phase thinking placeholders as soon as answer text starts streaming",async()=>{
 await act(async()=>root.render(<AgentActivity value={{...run,events:[{...run.events[1],state:'completed'},{id:'answer',kind:'answer',state:'running',label:'核对结果',createdAt:4000}]}}/>));
 expect(host.textContent).not.toContain('正在思考');
 expect(host.querySelector('.agent-operation-group > summary')?.textContent).toBe('已读取资料');
 expect(host.querySelector('[aria-label="正在生成回答"]')?.textContent).toBe('核对结果');
});
it("does not hide a failed thinking-status record with a diagnostic",async()=>{
 await act(async()=>root.render(<AgentActivity value={{...run,events:[{id:'fail',kind:'status',state:'failed',label:'正在思考',detail:'连接已中断',createdAt:1}]}}/>));
 expect(host.textContent).toContain('未完成');
 expect(host.textContent).toContain('连接已中断');
});
it("keeps chronological work flat without hiding public updates or partial failures", async()=>{
  const events:ActivityRun["events"]=[
    {id:"message",kind:"message",state:"completed",label:"先核对一手来源",createdAt:1},
    {id:"reason",kind:"reasoning",state:"completed",label:"核对不同版本",createdAt:2},
    {id:"web",kind:"webSearch",state:"completed",label:"访问网页",action:"openPage",errorCount:1,resultCount:2,createdAt:3},
    {id:"tool",kind:"tool",state:"completed",label:"读取原文",createdAt:4},
    {id:"update",kind:"message",state:"completed",label:"已找到两个版本",createdAt:5}
  ];
  await act(async()=>root.render(<AgentActivity value={{...run,events,running:false,state:"completed"}}/>));
  await expandProcess();
  expect(host.querySelector('.agent-activity-group')).toBeNull();
  expect(host.querySelectorAll('.agent-commentary')).toHaveLength(2);
  const timeline=host.querySelector('.agent-activity-events')!;
  expect(timeline.textContent!.indexOf('先核对一手来源')).toBeLessThan(timeline.textContent!.indexOf('读取原文'));
  expect(timeline.textContent!.indexOf('读取原文')).toBeLessThan(timeline.textContent!.indexOf('已找到两个版本'));
  expect(host.querySelector('.agent-web-activity > summary')?.textContent).toBe('访问网页 · 1 项未获取');
  expect(host.textContent).toContain('当前展示记录未包含具体原因');
  expect(host.querySelector('.agent-spinning')).toBeNull();
});
it("renders native answer deltas outside process details and removes the preview after publication", async()=>{
  const streamed={...run,events:[...run.events,{id:"a",kind:"answer" as const,state:"running",label:"直接回答 **问题**。[1]",createdAt:2000}]};
  await act(async()=>root.render(<AgentActivity value={streamed}/>));
  const answer=host.querySelector('[aria-label="正在生成回答"]')!;
  expect(answer.textContent).toContain("直接回答 问题。[1]");
  expect(answer.getAttribute("aria-busy")).toBe("true");
  expect(answer.querySelector('a')).toBeNull();
  expect(host.querySelector('[aria-label="当前进展"]')).toBeNull();
  await expandProcess();
  expect(host.querySelector('.agent-activity-events')?.textContent).not.toContain("直接回答");
  await act(async()=>root.render(<AgentActivity value={{...streamed,state:"completed",running:false,finishedAt:3000}}/>));
  expect(host.querySelector('[aria-label="正在生成回答"]')).toBeNull();
});
it("labels host-loaded context separately from model tool calls",async()=>{
  await act(async()=>root.render(<AgentActivity value={{...run,steps:0,events:[{id:"ctx",kind:"context",state:"completed",label:"已载入材料「当前笔记」",createdAt:1100}]}}/>));
  await expandProcess();
  expect(host.querySelector('.agent-context-event')?.textContent).toContain('已载入材料');
  expect(host.querySelector('.agent-step-completed')).toBeNull();
  expect(host.querySelector('.agent-activity-toggle')?.textContent).not.toContain('个步骤');
});
it("shows selected-material read coverage and failures without claiming adoption",async()=>{
  await act(async()=>root.render(<AgentActivity value={{...run,steps:0,events:[
    {id:"read",kind:"context",state:"completed",label:"已读取部分资料「笔记」",detail:"已读取 0–6000 / 7000 字符，模型自行判断是否采用",createdAt:1100},
    {id:"failed",kind:"context",state:"failed",label:"添加的资料未读入",detail:"本轮资料读取预算已用尽",createdAt:1200}
  ]}}/>));
  await expandProcess();
  const entries=host.querySelectorAll('.agent-context-event');
  expect(entries).toHaveLength(2);
  expect(entries[0].querySelector('summary')?.textContent).toContain('已读取部分资料');
  expect(entries[0].querySelector('p')?.textContent).toContain('模型自行判断是否采用');
  expect(entries[1].querySelector('p')?.textContent).toContain('预算已用尽');
  expect(host.textContent).not.toContain('已采用');
});
it("shows an actual skill load with provenance and keeps its details expandable",async()=>{
  await act(async()=>root.render(<AgentActivity value={{...run,steps:1,events:[{id:"skill",kind:"skill",state:"completed",label:"已读取「有来源的闪卡」技能",detail:"Hub 内置 · 模型选择读取 · 版本 abc123",createdAt:1100,finishedAt:1200}]}}/>));
  await expandProcess();
  expect(host.querySelector('.agent-step-completed summary')?.textContent).toContain('有来源的闪卡');
  expect(host.querySelector('.agent-step-completed details')?.textContent).toContain('模型选择读取');
  expect(host.querySelector('.agent-commentary')).toBeNull();
});
it("keeps the actual process beside its completed answer and reopens it without running work",async()=>{
  const report:Report={status:"completed",summary:"",findings:[],nextSteps:[],questions:[],limitations:[],waitCondition:"",
    prose:{markdown:"共同方法是先测量再加工。[1]\n\n| 方法 | 条件 |\n|---|---|\n| 测量 | 加工之前 |",citations:[{evidenceId:"e1",quote:"先测量再加工"}]}};
  const evidence=[{title:"加工条件",sourcePath:"条件.md",content:"先测量再加工",startChar:0,endChar:6,totalChars:6,truncated:false}];
  const citation=vi.fn();
  await act(async()=>root.render(<AgentConversation revoked={false} conversation={{hasEarlier:false,messages:[{id:"a",role:"assistant",runId:"r",createdAt:2,report,evidence}]}} activity={[{...run,running:false,state:"completed",finishedAt:4100}]} onOpenCitation={citation}/>));
  expect(host.textContent).not.toContain("查明的情况");
  expect(host.querySelector("table")?.textContent).toContain("加工之前");
  expect(host.querySelector('[aria-label="本轮工作过程"]')).not.toBeNull();
  expect(host.querySelector(".agent-commentary")).toBeNull();
  await expandProcess();
  expect(host.textContent).toContain("两份材料的适用范围不同");
  await act(async()=>host.querySelector<HTMLButtonElement>(".agent-inline-citation")!.click());
  expect(citation).toHaveBeenCalledWith("r",0,"先测量再加工");
});
it("shows pending and failed steps distinctly and stops the clock at the committed finish time",async()=>{
  vi.useFakeTimers();vi.setSystemTime(5000);
  await act(async()=>root.render(<AgentActivity value={run}/>));
  expect(host.textContent).toContain("4 秒");
  expect(host.querySelector(".agent-step-running")?.textContent).toContain("检查草稿");
  expect(host.querySelector(".agent-live-status")).toBeNull();
  await act(async()=>root.render(<AgentActivity value={{...run,running:false,state:"interrupted",finishedAt:6000,events:[{...run.events[2],state:"failed",detail:"引文未通过核对"}]}}/>));
  await expandProcess();
  expect(host.textContent).toContain("未完成");
  expect(host.textContent).toContain("5 秒");
  await act(async()=>vi.advanceTimersByTime(90000));
  expect(host.textContent).toContain("5 秒");
});
it("places live work and prepared drafts after the user message without duplicating the process",async()=>{
  await act(async()=>root.render(<AgentConversation revoked={false} conversation={{hasEarlier:false,messages:[{id:"u",role:"user",revision:1,text:"整理笔记并制卡",createdAt:1}]}} activity={[run]} onOpenCitation={()=>{}} renderAfter={()=><div aria-label="已准备的草稿">两张闪卡草稿</div>}/>));
  const user=host.querySelector('[aria-label="你的消息"]')!;
  const process=host.querySelector('[aria-label="本轮工作过程"]')!;
  const drafts=host.querySelector('[aria-label="已准备的草稿"]')!;
  expect(user.contains(drafts)).toBe(false);
  expect(user.compareDocumentPosition(process) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(process.compareDocumentPosition(drafts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(host.querySelectorAll('[aria-label="本轮工作过程"]')).toHaveLength(1);
});
it("keeps DeepSeek streamed summaries and answer previews provisional",async()=>{
 const current={...run,events:[{id:"reason",origin:"deepseek",kind:"reasoning" as const,state:"running",label:"核对原文的日期范围",createdAt:1200},{id:"answer",origin:"deepseek",kind:"answer" as const,state:"running",label:"第一段",createdAt:1300}]};
 await act(async()=>root.render(<AgentActivity value={current}/>));
 expect(host.textContent).toContain("核对原文的日期范围");
 expect(host.querySelector('[aria-label="正在生成回答"]')?.textContent).toContain("完整接收并核验后交付");
 await act(async()=>root.render(<AgentActivity value={{...current,events:[current.events[0],{...current.events[1],label:"第一段，第二段"}]}}/>));
 expect(host.querySelectorAll('[aria-label="正在生成回答"]')).toHaveLength(1);
 expect(host.textContent).toContain("第一段，第二段");
 await act(async()=>root.render(<AgentActivity value={{...current,running:false,state:"interrupted",events:[current.events[0],{...current.events[1],kind:"unpublishedAnswer",state:"unverified"}]}}/>));
 expect(host.querySelector('[aria-label="正在生成回答"]')).toBeNull();
 expect(host.textContent).toContain("查看未发布的模型答复");
});
it("streams public summaries without presenting them as completed tool actions",async()=>{
  const current={...run,native:true,events:[{id:"summary",kind:"reasoning" as const,state:"running",label:"核对日期范围",createdAt:1200},run.events[1]]};
  await act(async()=>root.render(<AgentActivity value={current}/>));
  expect(host.querySelector('.agent-reasoning')?.textContent).toBe('核对日期范围');
  expect(host.querySelector('.agent-reasoning summary')).toBeNull();
  await act(async()=>root.render(<AgentActivity value={{...current,events:[{...current.events[0],label:"核对日期范围后发现重复，需要重新计算。"},run.events[1]]}}/>));
  expect(host.querySelectorAll('.agent-reasoning')).toHaveLength(1);
  expect(host.querySelector('.agent-reasoning')?.textContent).toContain('发现重复');
  expect(host.textContent?.match(/发现重复/g)).toHaveLength(1);
  expect(host.querySelectorAll('.agent-activity-step:not(.agent-reasoning)')).toHaveLength(1);
  await expandProcess();
  expect(host.querySelectorAll('.agent-activity-step:not(.agent-reasoning)')).toHaveLength(1);
});

it("foregrounds actual public updates while keeping repeated tool receipts out of the default view",async()=>{
  const scoped={...run,workId:"work",currentWorkRevision:1,authorizationVersion:1,events:[...run.events,
    {id:"4",kind:"message" as const,state:"completed",label:"两篇已核对，R02为重复记录；接下来核对合计。",createdAt:2000},
    {id:"5",kind:"tool" as const,state:"running",label:"核对报告",createdAt:2100,resultRef:{recordId:"stored",sha256:"hash"}}]};
  await act(async()=>root.render(<AgentActivity value={scoped}/>));
  expect(host.querySelectorAll('.agent-commentary')[1]?.textContent).toContain('R02为重复记录');
  expect(host.querySelector('.agent-operation-group')?.hasAttribute('open')).toBe(false);
  expect(host.textContent).toContain('两份材料的适用范围不同');
  expect(host.querySelector('.agent-activity-toggle')?.getAttribute('aria-expanded')).toBe('true');
  await expandProcess();
  expect(host.textContent).toContain('两份材料的适用范围不同');
  expect(host.textContent).toContain('查看完整工具记录');
  await act(async()=>root.render(<AgentActivity value={{...scoped,running:false,state:"completed",finishedAt:3000}}/>));
  expect(host.querySelector('.agent-activity-toggle')?.getAttribute('aria-expanded')).toBe('true');
});

it("does not manufacture a narrative when the provider gives none, and exposes an actual failure while collapsed",async()=>{
  await act(async()=>root.render(<AgentActivity value={{...run,events:[]}}/>));
  expect(host.querySelector('.agent-commentary')).toBeNull();
  expect(host.querySelector('.agent-live-status')?.textContent).toBe('正在思考');
  await act(async()=>root.render(<AgentActivity value={{...run,running:false,state:"failed",events:[{id:"failed",kind:"tool",state:"failed",label:"读取原文",detail:"来源已撤权",createdAt:2000}]}}/>));
  expect(host.querySelector('.agent-step-failed')?.textContent).toContain('来源已撤权');
  expect(host.querySelector('.agent-activity-toggle')?.getAttribute('aria-expanded')).toBe('true');
});

it("prioritizes the public update and retains reasoning in the expanded process",async()=>{
  await act(async()=>root.render(<AgentActivity value={{...run,events:[...run.events,{id:"reason",kind:"reasoning",state:"completed",label:"公开摘要中的分析",createdAt:2100}]}}/>));
  expect(host.querySelector('.agent-commentary')?.textContent).toContain("适用范围不同");
  expect(host.querySelector('.agent-reasoning')?.textContent).toContain('公开摘要中的分析');
  await expandProcess();
  expect(host.querySelector('.agent-reasoning')?.textContent).toContain("公开摘要中的分析");
});

it("marks completed public reasoning as historical without altering its text",async()=>{
 await act(async()=>root.render(<AgentActivity value={{...run,running:false,state:"completed",finishedAt:3000,events:[{id:"reason",kind:"reasoning",state:"completed",label:"**正在核对研究来源**",createdAt:2100}]}}/>));
 await expandProcess();
 expect(host.querySelector('.agent-reasoning')?.textContent).toBe('正在核对研究来源');
 expect(host.querySelector('.agent-reasoning .agent-spinning')).toBeNull();
 expect(host.querySelector('.agent-reasoning .lucide-circle')).toBeNull();
});

it("does not show a completed, failed or interrupted tool as still running",async()=>{
  for(const [state] of [["completed","已完成：读取原文"],["failed","未完成：读取原文"],["interrupted","已中断：读取原文"]]) {
    await act(async()=>root.render(<AgentActivity value={{...run,events:[{...run.events[1],state}]}}/>));
    expect(host.querySelector('.agent-operation-group > summary')?.textContent).toContain('正在思考');
    expect(host.querySelector('.agent-live-status')).toBeNull();
    expect(host.querySelector('.agent-activity-step')?.textContent).toContain('读取原文');
    expect(host.querySelector('.agent-live-status .agent-spinning')).toBeNull();
  }
  await act(async()=>root.render(<AgentActivity value={run}/>));
  expect(host.querySelector('.agent-spinning')).toBeNull();
});

it("CN03 shows the native plan without counting it as a business completion",async()=>{
  await act(async()=>root.render(<AgentActivity value={{...run,steps:0,events:[{id:"p",kind:"plan",state:"completed",label:"1. 阅读资料 — 模型标记完成",createdAt:1200}]}}/>));
  expect(host.textContent).toContain("工作计划");expect(host.textContent).not.toContain("实际成果与保存结果以交付记录为准");expect(host.querySelector('.agent-step-completed')).toBeNull();
  await expandProcess();expect(Array.from(host.querySelectorAll('summary')).filter(e=>e.textContent?.includes('工作计划'))).toHaveLength(1);
});

it("keeps long reasoning available and preserves a failure after an answer preview",async()=>{
  const text="核对材料中的日期与适用范围。".repeat(10);
  await act(async()=>root.render(<AgentActivity value={{...run,events:[{id:"long",kind:"reasoning",state:"running",label:text,createdAt:1}]}}/>));
  expect(host.querySelector('details.agent-reasoning summary')?.textContent).toContain('…');
  expect(host.querySelector('details.agent-reasoning div')?.textContent).toBe(text);
  await act(async()=>root.render(<AgentActivity value={{...run,running:false,state:"failed",events:[{id:"a",kind:"answer",state:"completed",label:"部分回答",createdAt:1},{id:"f",kind:"tool",state:"failed",label:"保存失败",detail:"连接中断",createdAt:2}]}}/>));
  expect(host.querySelector('.agent-step-failed')?.textContent).toContain('连接中断');
});
it("does not offer an empty process disclosure for a direct native answer",async()=>{
  await act(async()=>root.render(<AgentActivity value={{...run,running:false,state:"completed",finishedAt:5000,events:[{id:"a",kind:"answer",state:"completed",label:"直接回答",createdAt:2000}]}}/>));
  expect(host.querySelector('.agent-activity-toggle')).toBeNull();
  expect(host.textContent).toBe('用时 4 秒');
});


it("keeps long tool labels and records inside one disclosure without losing full text",async()=>{
 const label='读取已授权原文 '+ 'very-long-source-name '.repeat(12);
 await act(async()=>root.render(<AgentActivity value={{...run,running:false,state:'completed',finishedAt:2000,events:[{id:'long',kind:'tool',state:'completed',label,detail:'完整操作说明',createdAt:1}]}}/>));
 await expandProcess();
 const detail=host.querySelector<HTMLDetailsElement>('.agent-tool-activity')!;
 expect(detail.open).toBe(false);
 expect(detail.querySelector('summary')?.getAttribute('title')).toBe(label);
 await act(async()=>detail.querySelector('summary')!.click());
 expect(detail.open).toBe(true);
 expect(detail.querySelector('p')?.textContent).toBe(label);
 expect(detail.textContent).toContain('完整操作说明');
});

it("replays waiting, tools, answer streaming and completion without resetting either disclosure",async()=>{
 vi.useFakeTimers();vi.setSystemTime(5000);
 const draw=async(events:ActivityRun['events'],running=true)=>act(async()=>root.render(<AgentActivity value={{...run,events,running,state:running?'investigating':'completed',finishedAt:running?null:9000}}/>));
 await draw([]);
 expect(host.querySelector('.agent-activity-toggle')).toBeNull();
 expect(host.textContent).toBe('正在思考');
 const tool={...run.events[1],state:'running',detail:'原文已分段读取'};
 await draw([run.events[0],tool]);
 const phase=host.querySelector<HTMLDetailsElement>('.agent-operation-group')!;
 const title=phase.querySelector('summary')!;
 expect(title.textContent).toBe('正在读取原文');
 await act(async()=>{title.click();});
 const detail=phase.querySelector<HTMLDetailsElement>('.agent-tool-activity')!;
 await act(async()=>{detail.querySelector('summary')!.click();});
 await draw([run.events[0],{...tool,state:'completed'}]);
 expect(title.textContent).toBe('正在思考');
 expect(title.querySelectorAll('svg')).toHaveLength(1); // disclosure only
 expect(host.querySelector('.agent-live-status')).toBeNull();
 expect(phase.open&&detail.open).toBe(true);
 await draw([run.events[0],{...tool,state:'completed'},run.events[2]]);
 expect(title.textContent).toBe('正在检查草稿');
 expect(phase.querySelector('.agent-tool-activity')).toBe(detail);
 expect(detail.open).toBe(true);
 const finished=[run.events[0],{...tool,state:'completed'},{...run.events[2],state:'completed'}];
 const answer={id:'a',kind:'answer' as const,state:'running',label:'已核对',createdAt:7000};
 await draw([...finished,answer]);
 expect(host.querySelector('.agent-activity-toggle')?.textContent).toBe('用时 6 秒');
 await act(async()=>vi.advanceTimersByTime(2000));
 expect(host.querySelector('.agent-activity-toggle')?.textContent).toBe('用时 6 秒');
 expect(host.querySelector('[aria-label="正在生成回答"]')?.closest('.agent-activity-events')).toBeNull();
 await draw([...finished,{...answer,state:'completed'}],false);
 expect(phase.open&&detail.open).toBe(true);
 expect(title.textContent).toBe('已读取资料、调用工具');
 expect(host.textContent).not.toContain('正在思考');
 expect(host.querySelector('.agent-activity-toggle')?.textContent).toBe('用时 8 秒');
});

it("closes a previous phase at a public update while the newest phase owns the live status",async()=>{
 const events:ActivityRun['events']=[...run.events.map(e=>({...e,state:'completed'})),{id:'update',kind:'message',state:'completed',label:'已发现差异，继续验证。',createdAt:2500},{id:'next',kind:'tool',state:'running',label:'验证差异',createdAt:3000}];
 await act(async()=>root.render(<AgentActivity value={{...run,events}}/>));
 const phases=host.querySelectorAll('.agent-operation-group > summary');
 expect(phases[0].textContent).toBe('已读取资料、调用工具');
 expect(phases[1].textContent).toBe('正在验证差异');
 expect(host.querySelectorAll('.agent-operation-active')).toHaveLength(1);
 expect(host.querySelectorAll('.agent-commentary')).toHaveLength(2);
});
