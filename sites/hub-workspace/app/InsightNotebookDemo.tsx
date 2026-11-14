"use client";
import {useCallback} from "react";
import {InsightNotebook,type NotebookEntry,type NotebookBoard} from "./InsightNotebook";
const key="hub.insights.decisions.demo.v1";
type State={items:NotebookEntry[];operations:Record<string,{request:string;entry:NotebookEntry}>};
function load():State {try{return JSON.parse(localStorage.getItem(key)||'{"items":[],"operations":{}}');}catch{return {items:[],operations:{}};}}
export function InsightNotebookDemo({onAssistant}:{onAssistant:(id:string)=>void}){
 const read=useCallback(async():Promise<NotebookBoard>=>({items:load().items,drafts:[]}),[]);
 const works=useCallback(async()=>[{id:"decision-example",goal:"工具选择与小样例验证（示例）"}],[]);
 const mutate=useCallback(async(args:Record<string,unknown>)=>{
  const s=load(),op=String(args.operationId),request=JSON.stringify(args),old=s.operations[op];
  if(args.action==="insightEntryHistory")return {versions:Object.values(s.operations).map(o=>o.entry).filter(e=>e.id===args.entryId).sort((a,b)=>b.version-a.version),nextBefore:null};
  if(args.action==="insightEntryOperation")return {committed:!!old,entry:old?.entry};
  if(old){if(old.request!==request)throw new Error("操作身份已用于不同请求");return {entry:old.entry};}
  let entry=s.items.find(e=>e.id===args.entryId);
  if(entry&&entry.version!==args.expectedVersion)throw new Error("记录已更新，请读取最新版本");
  if(args.action==="insightEntrySave"){
   const fields=args.entry as NotebookEntry;
   entry={...entry,...fields,id:entry?.id||crypto.randomUUID(),workId:entry?.workId||String(args.workId||"decision-example"),createdAt:entry?.createdAt||Date.now(),observations:entry?.observations||[],state:"draft",version:entry?.version||0,updatedAt:Date.now(),assumptions:fields.assumptions.map(a=>({id:a.id||crypto.randomUUID(),version:(entry?.assumptions.find(v=>v.id===a.id)?.version||0)+(entry?.assumptions.find(v=>v.id===a.id)?.text===a.text?0:1),text:a.text}))};
  }else if(!entry)throw new Error("记录不存在");
  else if(args.action==="insightEntryObserve"){
   const assumption=entry.assumptions.find(a=>a.id===args.assumptionId);
   entry={...entry,observations:[...entry.observations,{id:crypto.randomUUID(),text:String(args.text),assumptionId:String(args.assumptionId||""),assumptionText:assumption?.text,assumptionVersion:assumption?.version,occurredAt:String(args.occurredAt||""),recordedAt:Date.now(),nature:"selfReported"}]};
  }else if(args.action==="insightEntryAdopt")entry={...entry,state:"provided",providedAt:Date.now()};
  entry={...entry,version:entry.version+1,updatedAt:Date.now()};
  s.items=[...s.items.filter(v=>v.id!==entry.id),entry];s.operations[op]={request,entry};localStorage.setItem(key,JSON.stringify(s));return {entry};
 },[]);
 return <InsightNotebook kind="decision" demo read={read} loadWorks={works} mutate={mutate} onOpenWork={onAssistant}/>;
}
