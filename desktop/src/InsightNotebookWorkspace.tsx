import {useCallback,useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {InsightNotebook,type NotebookBoard,type NotebookEntry} from "./InsightNotebook";
import {AgentConditions,type AgentCondition} from "./AgentConditions";
import {userProfileStorage} from "./UserProfileStorage";
const call=<T,>(args:Record<string,unknown>)=>invoke<T>("agent_investigation",{args});
export function InsightNotebookWorkspace({kind,query,onOpenWork,generation=0}:{generation?:number;kind:NotebookEntry["kind"];query:string;onOpenWork:(id:string)=>void}){
 const read=useCallback((before?:unknown)=>call<NotebookBoard>({action:"insightWorkspace",before}),[]);
 const works=useCallback(async()=>{let before:unknown=null;const all:{id:string;goal:string}[]=[];do{const page=await call<{works:{id:string;goal:string}[];nextCursor:unknown}>({action:"list",anchor:null,...(before?{before}:{})});all.push(...page.works);before=page.nextCursor;if(all.length>1000)throw new Error("事项较多，请先在助手历史中收窄范围");}while(before);return all;},[]);
 const mutate=useCallback((args:Record<string,unknown>)=>call<{entry?:NotebookEntry;committed?:boolean;versions?:NotebookEntry[];nextBefore?:number|null}>(args),[]);
 return <InsightNotebook generation={generation} kind={kind} query={query} read={read} loadWorks={works} mutate={mutate} storage={userProfileStorage} onOpenWork={onOpenWork} watch={(entry,refresh)=><><NotebookScope id={entry.workId}/><p className="stage-review-muted">{entry.hasDelivery?"已完成一次核对，可明确启用有限复查。":"先将当前记录送入原事项，明确运行并完成一轮核对，再启用有限复查。"}</p><details open={entry.watch?.enabled||undefined}><summary>{entry.watch?.enabled?"有限复查正在启用":"设置有限复查条件"}</summary><AgentConditions value={entry.watch as AgentCondition} disabled={!entry.hasDelivery&&!entry.watch?.enabled} active={false} onAction={async args=>{await call({...args,id:entry.workId});refresh();}}/></details></>}/>;
}

function NotebookScope({id}:{id:string}){const [scope,setScope]=useState<{description:string;count:number;items:{title:string;path:string}[]}|null>(null),[error,setError]=useState("");useEffect(()=>{let ignore=false;void call<{description:string;count:number;items:{title:string;path:string}[]}>({action:"insightReviewScope",id}).then(v=>{if(!ignore)setScope(v);},e=>{if(!ignore)setError(String(e));});return()=>{ignore=true;};},[id]);return <details><summary>原事项的明确资料范围{scope?` · ${scope.count} 份`:""}</summary>{error?<p role="alert">{error}</p>:scope?<><p>{scope.description}</p>{scope.items.map((s,i)=><p key={i}>{s.title} · {s.path}</p>)}</>:<p>正在核对资料范围…</p>}</details>;}
