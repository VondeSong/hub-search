import {useEffect,useRef,useState} from "react";
import {save} from "@tauri-apps/plugin-dialog";
import {invoke} from "@tauri-apps/api/core";
export type FileAnalysis={executionId:string;title:string;revision?:number;superseded?:boolean;available:boolean;runtime:string;files:{name:string;bytes:number;sha256:string;type:string}[]};
export function AgentAnalysisFiles({workId,items}:{workId:string;items:FileAnalysis[]}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const scope=useRef(workId);
 useEffect(()=>{scope.current=workId;setError("");setNotice("");setBusy(false);},[workId]);
 async function open(item:FileAnalysis,name:string){setBusy(true);setError("");try{await invoke("agent_investigation",{args:{action:"analysisOpenFile",id:workId,executionId:item.executionId,file:name}});}catch(e){if(scope.current===workId)setError(String(e));}finally{if(scope.current===workId)setBusy(false);}}
 async function exportFile(item:FileAnalysis,file:FileAnalysis["files"][number]){
  setBusy(true);setError("");setNotice("");try{
   const destination=await save({title:"导出文件副本",defaultPath:file.name,filters:[{name:file.type.toUpperCase(),extensions:[file.type]}]});
   if(!destination||scope.current!==workId)return;
   await invoke("agent_investigation",{args:{action:"analysisExportFile",id:workId,executionId:item.executionId,file:file.name,expectedSha256:file.sha256,destination}});
   if(scope.current===workId)setNotice("已导出并核对文件副本。保存到知识库仍需使用保存入口。");
  }catch(e){if(scope.current===workId)setError(String(e));}finally{if(scope.current===workId)setBusy(false);}
 }
 if(!items.length)return null;
 return <section className="agent-analysis-files" aria-label="分析文件成果">{items.map(item=><details key={item.executionId}><summary>{item.title} · 第 {item.revision||1} 版 · {item.files.length} 个文件{!item.available?" · 已失效":item.superseded?" · 已被修订":""}</summary><p className="agent-note">本机分析产物。可打开检查，或导出到自己选择的位置。保存到知识库仍需使用保存入口。</p>{item.files.map(file=><p key={file.name}><button type="button" disabled={busy||!item.available} onClick={()=>void open(item,file.name)}>{file.name}</button><small> · {(file.bytes/1024).toFixed(1)} KiB</small> <button type="button" disabled={busy||!item.available} aria-label={"导出 "+file.name} onClick={()=>void exportFile(item,file)}>导出副本</button></p>)}</details>)}{notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}</section>;
}
