import { useEffect, useRef, useState } from "react";
import { Check, ShieldCheck, X } from "lucide-react";
import { useCodexSuite, type CodexSettings } from "./CodexSuite";
import { useAgentPopover } from "./useAgentPopover";
import { AgentModelMenu } from "./AgentModelMenu";
import {AgentMcpServices,type McpGrant} from "./AgentMcpServices";
import {invoke} from "@tauri-apps/api/core";
import {openPath} from "@tauri-apps/plugin-opener";

export type ResearchPolicy = "material-first" | "materials-only" | "open";
export type AssistantOptions = { researchPolicy?:ResearchPolicy; model: CodexSettings | null; autoFlashcardInbox: boolean; externalMcp?:boolean; nativeCapabilities?:{workspace:boolean;multiAgent:boolean}; webSearch?:"disabled"|"cached"|"live";mcpServices?:McpGrant[] };
export const defaultAssistantOptions: AssistantOptions = {model:null,autoFlashcardInbox:false};
type Section = "model" | "permissions" | "connection";

type Props = {workId?:string;section?:Section;value:AssistantOptions;disabled:boolean;canAuto:boolean;onSave:(value:AssistantOptions)=>Promise<void>};
export function AgentAssistantOptions(props:Props) {
  return props.section==="permissions" || props.section==="connection" ? <AgentSaveOptions {...props}/> : <AgentModelMenu value={props.value} disabled={props.disabled} onSave={props.onSave}/>;
}
function AgentSaveOptions({value,disabled,canAuto,onSave,section,workId}:Props) {
  const runtime = useCodexSuite();
  const effective = value.model ?? (runtime.loaded ? runtime.settings : null);
  const [draft,setDraft]=useState(value);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const alive=useRef(true);
  const popover=useAgentPopover();
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  useEffect(()=>{setDraft(value);},[value]);
  async function save(next:AssistantOptions, close=true) {
    if(disabled || saving)return;
    setSaving(true);setError("");
    try {await onSave(next);if(alive.current && close)popover.close(true);}
    catch(reason){if(alive.current)setError(String(reason));}
    finally {if(alive.current)setSaving(false);}
  }
  const title=section==="permissions"?"保存权限":"工具连接";
  const changed=JSON.stringify(draft)!==JSON.stringify(value);
  const webStatus=effective?.provider==="deepseek"?"当前模型不支持网页搜索。":draft.researchPolicy==="materials-only"?"仅使用所选材料，不搜索网页。":!draft.webSearch||draft.webSearch==="disabled"?"已关闭，本轮不搜索网页。":draft.webSearch==="cached"?"使用缓存搜索，结果可能不是最新。":draft.researchPolicy==="open"?"可按问题查询公开来源。":"优先使用材料，有需要再补充网页。";
  const contents=<>
    {section==="permissions" && <>
      <p className="agent-note">控制成果如何保存，不改变助手可读取的资料范围。</p>
      <button type="button" className="agent-menu-choice" disabled={disabled||saving} aria-pressed={!draft.autoFlashcardInbox} onClick={()=>setDraft(current=>({...current,autoFlashcardInbox:false}))}><span><strong>保存前确认</strong><small>先准备草稿，由你查看并确认保存。</small></span>{!draft.autoFlashcardInbox && <Check size={17} aria-hidden="true"/>}</button>
      {canAuto && <button type="button" className="agent-menu-choice" disabled={disabled||saving} aria-pressed={draft.autoFlashcardInbox} onClick={()=>setDraft(current=>({...current,autoFlashcardInbox:true}))}><span><strong>自动导入闪卡收件箱</strong><small>仅限本对话；仍需审核后才能复习。</small></span>{draft.autoFlashcardInbox && <Check size={17} aria-hidden="true"/>}</button>}
      <p className="agent-note">笔记修改与远端归档仍需预览确认。读取授权资料与分析不需要逐次确认。</p>
    </>}
    {section==="connection" && <>
      <dl className="agent-connection-facts"><div><dt>网页补充</dt><dd>{webStatus}</dd></div><div><dt>内置工具</dt><dd>使用本轮资料范围和保存权限。</dd></div></dl>
      <label>工具连接<select value={draft.externalMcp?"mcp":"native"} disabled={disabled||saving||effective?.provider==="deepseek"} onChange={event=>setDraft(current=>{const next={...current};if(event.target.value==="mcp"){next.externalMcp=true;delete next.nativeCapabilities;}else delete next.externalMcp;return next;})}><option value="native">Hub 内置连接</option><option value="mcp">Codex MCP 通道</option></select></label>
      <label>联网搜索<select value={draft.researchPolicy==="materials-only"?"disabled":draft.webSearch??"disabled"} disabled={disabled||saving||draft.researchPolicy==="materials-only"} onChange={event=>setDraft(current=>{const next={...current};if(event.target.value==="disabled")delete next.webSearch;else next.webSearch=event.target.value as "cached"|"live";return next;})}><option value="disabled">关闭</option><option value="cached" disabled={effective?.provider==="deepseek"}>缓存搜索</option><option value="live" disabled={effective?.provider==="deepseek"}>实时搜索</option></select></label>
      <details className="agent-connection-explanation"><summary>联网与工具说明</summary><p className="agent-note">新聊天默认实时搜索；此处可关闭，选择会用于后续新聊天。已有对话保留各自设置。仅支持 Codex。开启后，检索词会发送给联网搜索服务；不会因此开放其他本地资料。缓存搜索可能不是最新信息，实时搜索可获取更新内容。搜索记录和链接随对话保存，网页全文需另行读取。提供方内部检索材料不计入 Hub 的材料字节统计。</p></details>
      {draft.externalMcp && <p className="agent-note">通过 MCP 调用 Hub 工具，沿用本对话的资料范围、累计预算与保存权限。每轮从已保存记录继续，不会自动继承其他聊天的工具或权限。</p>}
      <details className="agent-connection-explanation"><summary>执行与协作<small>{draft.nativeCapabilities?.workspace?draft.nativeCapabilities.multiAgent?"工作区与子代理":"独立工作区":"受控计算"}</small></summary>
        <label><input type="checkbox" checked={!!draft.nativeCapabilities?.workspace} disabled={disabled||saving||draft.externalMcp||effective?.provider==="deepseek"} onChange={event=>setDraft(current=>{const next={...current};if(event.target.checked)next.nativeCapabilities={workspace:true,multiAgent:false};else delete next.nativeCapabilities;return next;})}/>允许本对话使用独立工作区</label>
        <p className="agent-note">Windows 可运行脚本、创建和编辑工作区文件。网络关闭，不开放原资料库与宿主凭据；来源保存继续使用 Hub 的授权与回执。</p>
        {workId && value.nativeCapabilities?.workspace && <button type="button" onClick={()=>{void invoke<{path:string}>("agent_investigation",{args:{action:"nativeWorkspacePath",id:workId}}).then(result=>openPath(result.path)).catch(reason=>setError(String(reason)));}}>打开本对话工作区</button>}
        <label><input type="checkbox" checked={!!draft.nativeCapabilities?.multiAgent} disabled={disabled||saving||!draft.nativeCapabilities?.workspace||draft.externalMcp||effective?.provider==="deepseek"} onChange={event=>setDraft(current=>({...current,nativeCapabilities:{workspace:true,multiAgent:event.target.checked}}))}/>允许助手委派工作区子任务</label>
        <p className="agent-note">最多两个子代理、一级委派，使用相同工作区边界；随本轮结束或取消退出。冻结材料额度的对话暂不支持工作区；冻结 Token 额度的对话暂不支持子代理。</p>
        <dl className="agent-connection-facts"><div><dt>资料计算</dt><dd>Windows 支持隔离脚本计算。</dd></div><div><dt>外部工具</dt><dd>按对话选择 MCP、已连接应用及具体工具；GitHub 评论先准备草稿再确认。</dd></div><div><dt>技能与记忆</dt><dd>使用 Hub 已选技能和共享记忆。</dd></div><div><dt>浏览器与电脑</dt><dd>可授权独立浏览器访问指定公共网站；电脑操作未接入，网页搜索单独设置。</dd></div></dl>
      </details>
      <details className="agent-mcp-settings"><summary>外部工具（MCP）<small>{draft.mcpServices?.length?`已选 ${draft.mcpServices.length} 项`:"未选择"}</small></summary><AgentMcpServices value={draft.mcpServices??[]} disabled={disabled||saving||effective?.provider==="deepseek"||draft.researchPolicy==="materials-only"} onChange={services=>setDraft(current=>{const next={...current};if(services.length)next.mcpServices=services;else delete next.mcpServices;return next;})}/></details>
    </>}
    {changed && <button type="button" disabled={disabled||saving} onClick={()=>void save(draft)}>{saving?"正在应用…":draft.autoFlashcardInbox&&!value.autoFlashcardInbox?"确认本对话的自动导入授权":"应用到本对话"}</button>}
    {error && <p role="alert">{error}</p>}
  </>;
  if(section==="connection")return <div className="agent-connection-settings">{contents}</div>;
  return <details ref={popover.ref} className={`agent-assistant-options agent-popover agent-option-${section}`} name="hub-agent-preference" onToggle={event=>{
    if(event.target===event.currentTarget && event.currentTarget.open){setDraft(value);setError("");}
  }}>
    <summary aria-label={`保存权限：${value.autoFlashcardInbox?"闪卡自动导入":"保存前确认"}`} title={value.autoFlashcardInbox?"仅自动导入闪卡收件箱":"保存前确认"}><ShieldCheck size={18} aria-hidden="true"/></summary>
    <div className="agent-assistant-settings">
      <div className="agent-popover-header"><strong>{title}</strong><button type="button" aria-label="关闭对话设置" onClick={()=>popover.close(true)}><X size={16} aria-hidden="true"/></button></div>
      {contents}
    </div>
  </details>;
}
