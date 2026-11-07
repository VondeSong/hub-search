import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
type Ticket={workId:string;runId:string;expiresAt:number;prompt:string;mcpServer:{command:string;args:string[];env:Record<string,string>;enabled:boolean;required:boolean;startup_timeout_sec:number;tool_timeout_sec:number}};
export function AgentExternalReport({id,revision,authorization,disabled,onChanged}:{id:string;revision:number;authorization:number;disabled:boolean;onChanged:()=>void}){
  const description=useId();
  const [ticket,setTicket]=useState<Ticket|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[copied,setCopied]=useState(false);
  const [time,setTime]=useState(Date.now);
  useEffect(()=>{if(!ticket)return;const timer=window.setInterval(()=>setTime(Date.now()),1000);return()=>window.clearInterval(timer);},[ticket]);
  const expired=!!ticket&&time>=ticket.expiresAt;
  const configuration=ticket?["[mcp_servers.hub_work]",...Object.entries(ticket.mcpServer).filter(([key])=>key!=="env").map(([key,value])=>`${key} = ${JSON.stringify(value)}`),"[mcp_servers.hub_work.env]",...Object.entries(ticket.mcpServer.env).map(([key,value])=>`${key} = ${JSON.stringify(value)}`)].join("\n"):"";
  return <details className="agent-external-report"><summary>外部助手补报告</summary>
    <p id={description} className="agent-note">核对当前资料和已保存成果后补交报告，不重新抽取或重算。先准备好外部客户端，再建立一次性连接；会话占用本事项原有额度，旧失败和未知用量保留。</p>
    {!ticket||expired?<button type="button" disabled={disabled||busy} aria-describedby={description} onClick={async()=>{
      if(disabled||busy)return;setBusy(true);setError("");
      try{const value=await invoke<Ticket>("agent_investigation",{args:{action:"prepareExternalWork",id,purpose:"finishSavedReport",expectedWorkRevision:revision,expectedAuthorizationVersion:authorization}});setTicket(value);setTime(Date.now());onChanged();}
      catch(reason){setError(String(reason));}finally{setBusy(false);}
    }}>{expired?"重新建立连接":"建立一次性连接"}</button>:<>
      <p role="status">{expired?"连接已过期。已有成果保留，请核对当前状态。":"连接待使用，仅限当前事项；Hub尚未启动外部模型。可用“停止本轮”撤销。"}</p>
      {!expired&&<><label>Codex 连接配置（config.toml）<textarea readOnly rows={8} value={configuration}/></label>
        <label>本次任务<textarea readOnly rows={3} value={ticket.prompt}/></label>
        <p className="agent-note">配置含一次性访问身份，仅交给本次获准的本机客户端，不公开或写入笔记。使用完毕后会失效。</p>
        <button type="button" onClick={async()=>{try{await navigator.clipboard.writeText(configuration);setCopied(true);}catch(reason){setError(String(reason));}}}>{copied?"已复制连接配置":"复制连接配置"}</button>
      </>}
    </>}
    {error&&<p role="alert">{error}</p>}
  </details>;
}
