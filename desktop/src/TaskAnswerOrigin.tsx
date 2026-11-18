import {useContext,useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {AgentPanelContext} from "./StandaloneAgentLauncher";

type Origin={workId:string;runId:string};
export function TaskAnswerOrigin({provider,libraryId,objectId}:{provider:string;libraryId:string;objectId:string}){
  const open=useContext(AgentPanelContext);
  const [value,setValue]=useState<{key:string;items:Origin[];error?:string}|null>(null);
  const key=JSON.stringify([provider,libraryId,objectId]);
  useEffect(()=>{
    let current=true;
    if(provider!=="dida365"||!objectId||!open)return;
    void invoke<Origin[]>("agent_investigation",{args:{action:"answerTaskOrigins",libraryId,objectId}})
      .then(items=>{if(current)setValue({key,items});},()=>{if(current)setValue({key,items:[],error:"原分析入口暂时无法读取，请稍后重开任务核对。"});});
    return()=>{current=false;};
  },[key,provider,libraryId,objectId,open]);
  if(!open||value?.key!==key||!value.items.length&&!value.error)return null;
  return <div className="task-planning-detail">{value.items.map((item,i)=><button type="button" key={item.workId+item.runId} onClick={()=>open({workId:item.workId})}>{value.items.length>1?`查看原分析 ${i+1}`:"查看原分析"}</button>)}{value.error&&<p role="status">{value.error}</p>}</div>;
}
