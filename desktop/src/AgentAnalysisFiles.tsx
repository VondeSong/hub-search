import {useEffect,useRef,useState} from "react";
import {save} from "@tauri-apps/plugin-dialog";
import {invoke} from "@tauri-apps/api/core";
import {FileText,FolderOpen} from "lucide-react";
import {AgentCloudHandoff,canHandoffAnalysis} from "./CloudHandoff";
export type FileAnalysis={executionId:string;title:string;revision?:number;superseded?:boolean;available:boolean;runtime:string;files:{name:string;bytes:number;sha256:string;type:string}[]};
export function AgentAnalysisFiles({workId,items}:{workId:string;items:FileAnalysis[]}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [visible,setVisible]=useState(6);
 const [handoffId,setHandoffId]=useState("");
 const scope=useRef(workId);
 useEffect(()=>{scope.current=workId;setError("");setNotice("");setBusy(false);setVisible(6);setHandoffId("");},[workId]);
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
 const eligible=items.filter(canHandoffAnalysis);
 const handoff=eligible.find(item=>item.executionId===handoffId)??eligible[0];
 return <section className="agent-analysis-files" aria-label="分析文件成果">
  <details>
   <summary><FolderOpen size={16} aria-hidden="true"/>分析成果 · {items.length===1 ? items[0].title : `${items.length} 项记录`}</summary>
   <div className="agent-analysis-batches">
    {items.slice(0,visible).map(item=><details key={item.executionId}>
     <summary>{item.title} <small>第 {item.revision||1} 版 · {item.files.length} 个文件{!item.available?" · 已失效":item.superseded?" · 已被修订":""}</small></summary>
     <ul>{item.files.map(file=><li key={file.name}>
      <button className="agent-analysis-file" type="button" disabled={busy||!item.available} onClick={()=>void open(item,file.name)}><FileText size={14} aria-hidden="true"/>{file.name}</button>
      <small>{(file.bytes/1024).toFixed(1)} KiB</small>
      <button type="button" disabled={busy||!item.available} aria-label={"导出 "+file.name} onClick={()=>void exportFile(item,file)}>导出副本</button>
     </li>)}</ul>
    </details>)}
    {visible<items.length && <button type="button" onClick={()=>setVisible(count=>count+6)}>显示更多批次 · 另 {items.length-visible} 批</button>}
   </div>
   <div className="agent-analysis-handoff">
    {eligible.length>1 && <label>交接成果<select value={handoff?.executionId} onChange={event=>setHandoffId(event.target.value)}>{eligible.map(item=><option key={item.executionId} value={item.executionId}>{item.title} · 第 {item.revision||1} 版</option>)}</select></label>}
    {handoff ? <AgentCloudHandoff key={handoff.executionId} workId={workId} item={handoff}/> : <small>手机继续查看需要一份不超过 48 KB 的 Markdown 报告。</small>}
   </div>
  </details>
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
 </section>;
}
