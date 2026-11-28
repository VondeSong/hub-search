import type {TaskState} from './task-data';

export type AnalysisTask={id:string;title:string;description:string;project:string;parent:string;priority?:string;date:string;status:TaskState;source:string};
export type AnalysisMode='today'|'project'|'task';
export type ReadMode='fresh'|'cached'|'partial';
export type AnalysisRequest={id:number;mode:AnalysisMode;label:string;taskIds:string[]};
export type TaskEvidence={id:string;title:string;source:string;text:string};
export type TaskAdvice={id:string;taskId:string;title:string;reason:string;text:string;kind:'today'|'note'|'source';revision:string;evidence:TaskEvidence[]};
export type AdoptionReceipt={id:string;taskId:string;message:string;at:string;before?:string;after?:string;revision?:string};
export type WaitingCondition={person:string;reason:string;reviewDate?:string};
export type AnalysisMemory={today:Record<string,string>;notes:Record<string,string>;waiting?:Record<string,WaitingCondition>;reviewDates?:Record<string,string>;topicReviewDates?:Record<string,string>;receipts:AdoptionReceipt[]};
export const emptyAnalysisMemory=():AnalysisMemory=>({today:{},notes:{},waiting:{},reviewDates:{},topicReviewDates:{},receipts:[]});
export function shiftDay(day:string,deltaDays:number):string {
 const d=new Date(day+'T12:00:00');
 if(!Number.isFinite(d.getTime()))return day;
 d.setDate(d.getDate()+deltaDays);
 return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function nextMonday(day:string):string {
 const d=new Date(day+'T12:00:00');
 if(!Number.isFinite(d.getTime()))return day;
 const diff=(8-d.getDay())%7||7;
 return shiftDay(day,diff);
}
export function parseAnalysisMemory(raw:string|null):AnalysisMemory|null {
 if(!raw)return emptyAnalysisMemory();
 try{const value=JSON.parse(raw);const record=(x:unknown)=>!!x&&typeof x==='object'&&!Array.isArray(x);
  if(!record(value)||!record(value.today)||!record(value.notes)||!Array.isArray(value.receipts))return null;
  if(!Object.values(value.today).every(x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x))||!Object.values(value.notes).every(x=>typeof x==='string'))return null;
  if(!value.receipts.every((r:AdoptionReceipt)=>r&&['id','taskId','message','at'].every(k=>typeof r[k as keyof AdoptionReceipt]==='string')))return null;
  const waiting:Record<string,WaitingCondition>={};
  if(record(value.waiting)){
   for(const [k,v] of Object.entries(value.waiting as Record<string,unknown>)){
    if(record(v)){
     const item=v as Record<string,unknown>;
     if(typeof item.person==='string'&&typeof item.reason==='string'){
      waiting[k]={person:item.person,reason:item.reason,...(typeof item.reviewDate==='string'?{reviewDate:item.reviewDate}:{})};
     }
    }
   }
  }
  const parseDateMap=(rawMap:unknown)=>{
   const out:Record<string,string>={};
   if(record(rawMap)){
    for(const [k,v] of Object.entries(rawMap as Record<string,unknown>)){
     if(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v))out[k]=v;
    }
   }
   return out;
  };
  return {today:value.today,notes:value.notes,waiting,reviewDates:parseDateMap(value.reviewDates),topicReviewDates:parseDateMap(value.topicReviewDates),receipts:value.receipts};
 }catch{return null;}
}
export const analysisRevision=(task:AnalysisTask)=>JSON.stringify([task.id,task.title,task.description,task.project,task.source,task.date,task.status,task.priority,task.parent]);
export function shortRevisionHash(revision:string):string {
 let hash=2166136261;
 for(let i=0;i<revision.length;i++){hash^=revision.charCodeAt(i);hash=Math.imul(hash,16777619);}
 return (hash>>>0).toString(16).padStart(8,'0');
}
export function toggleTodayPlan(memory:AnalysisMemory,taskId:string,day:string):AnalysisMemory {
 const nextToday={...memory.today};
 if(nextToday[taskId]===day)delete nextToday[taskId];
 else nextToday[taskId]=day;
 return {...memory,today:nextToday};
}
export function setWaitingCondition(memory:AnalysisMemory,taskId:string,condition:WaitingCondition|null):AnalysisMemory {
 const nextWaiting={...(memory.waiting||{})};
 if(!condition||(!condition.person.trim()&&!condition.reason.trim()))delete nextWaiting[taskId];
 else nextWaiting[taskId]={person:condition.person.trim()||'外部协作者',reason:condition.reason.trim()||'等待确认条件',...(condition.reviewDate?{reviewDate:condition.reviewDate}:{})};
 return {...memory,waiting:nextWaiting};
}
export function setTaskReviewDate(memory:AnalysisMemory,taskId:string,reviewDate:string):AnalysisMemory {
 const nextDates={...(memory.reviewDates||{})};
 if(!reviewDate)delete nextDates[taskId];
 else nextDates[taskId]=reviewDate;
 return {...memory,reviewDates:nextDates};
}
export function setTopicReviewDate(memory:AnalysisMemory,topicKey:string,reviewDate:string):AnalysisMemory {
 const nextDates={...(memory.topicReviewDates||{})};
 if(!reviewDate)delete nextDates[topicKey];
 else nextDates[topicKey]=reviewDate;
 return {...memory,topicReviewDates:nextDates};
}
export function buildTaskAdvice(tasks:AnalysisTask[],request:AnalysisRequest,evidence:Record<string,TaskEvidence[]>,readMode:ReadMode,day:string):TaskAdvice[]{
 const ids=new Set(request.taskIds);
 const scoped=tasks.filter(task=>ids.has(task.id)&&task.status!=='done');
 scoped.sort((a,b)=>Number(!!b.date&&b.date<=day)-Number(!!a.date&&a.date<=day)||Number(b.priority==='高')-Number(a.priority==='高')||a.id.localeCompare(b.id));
 const due=scoped.filter(t=>t.date&&t.date<=day);
 const chosen=request.mode==='today'?[...due,...scoped.filter(t=>!due.includes(t)&&t.status!=='waiting').slice(0,3)]:scoped;
 return chosen.map((task,index)=>{
  const refs=(evidence[task.id]||[]).filter(r=>readMode!=='partial'||r.source!=='飞书');
  const waiting=task.status==='waiting';
  const kind=waiting||request.mode==='project'||(request.mode==='task'&&task.source==='Obsidian')?'note':request.mode==='today'?'today':'source';
  const next=waiting?'先确认等待对象与缺失条件，条件满足后再恢复原任务。':refs.length?`先查看${refs.map(r=>`《${r.title}》`).join('、')}，核对与“${task.title}”相关的要求，列出尚待确认的问题。`:`先把“${task.title}”要交付的结果写清楚，确定一个可以开始的动作。`;
  return {id:`${request.id}-${index}`,taskId:task.id,kind,revision:analysisRevision(task),evidence:refs,
   title:waiting?'先核实等待条件':request.mode==='today'?(task.date&&task.date<=day?'先照顾已到期的承诺':'可作为今天的下一步'):request.mode==='project'?(task.date?'核对交期与下一步':'补充行动安排'):'准备一个具体下一步',
   reason:waiting?'原任务仍处于等待状态，分析不会自动解除等待。':task.date&&task.date<=day?`来源日期为 ${task.date}，已到期；本次仅建议处理顺序，不擅自改期。`:task.date?'根据原任务状态和已取得的资料提出建议。':'来源没有设置日期，不能把它自动当成没有期限的低优先级事项。',
   text:kind==='source'?(task.description.includes(`下一步（AI 演示草稿）：${next}`)?task.description:`${task.description}${task.description?'\n\n':''}下一步（AI 演示草稿）：${next}`):next};
 });
}
export function adoptionError(task:AnalysisTask|undefined,advice:TaskAdvice,readMode:ReadMode):string {
 if(!task)return '原任务已不在当前数据中，请重新读取。';
 if(analysisRevision(task)!==advice.revision)return '原任务已变化，请重新读取并分析，避免覆盖你的修改。';
 if(task.status==='done')return '任务已经完成，请重新分析当前状态。';
 if(advice.kind==='source'&&readMode==='cached')return '当前使用旧数据，请先刷新并重新分析，再修改来源。';
 return '';
}
export function applyLocalAdvice(memory:AnalysisMemory,advice:TaskAdvice,day:string,at:string,beforeText?:string):AnalysisMemory {
 if(memory.receipts.some(r=>r.id===advice.id))return memory;
 return {...memory,today:advice.kind==='today'?{...memory.today,[advice.taskId]:day}:memory.today,
  notes:advice.kind==='note'?{...memory.notes,[advice.taskId]:advice.text}:memory.notes,
  receipts:[{id:advice.id,taskId:advice.taskId,at,message:advice.kind==='today'?'已加入 Hub 今日计划，只引用原任务；来源日期与状态未改。':advice.kind==='note'?'已保留到这条任务的 Hub 建议笔记，原任务未改。':'演示来源已确认更新任务说明，保留任务 ID、日期、状态与清单。',...(advice.kind==='source'?{before:beforeText??'',after:advice.text}:{})},...memory.receipts].slice(0,50)};
}
