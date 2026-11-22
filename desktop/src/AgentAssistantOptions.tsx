import { useEffect, useRef, useState } from "react";
import { useCodexSuite, type CodexSettings } from "./CodexSuite";
import { AgentModelMenu } from "./AgentModelMenu";
import {AgentMcpServices,type McpGrant} from "./AgentMcpServices";
import {invoke} from "@tauri-apps/api/core";
import {openPath} from "@tauri-apps/plugin-opener";

export type ResearchPolicy = "material-first" | "materials-only" | "open";
export type AssistantOptions = { researchPolicy?:ResearchPolicy; model: CodexSettings | null; autoFlashcardInbox: boolean; externalMcp?:boolean; goalMode?:boolean; knowledgeReview?:boolean; nativeCapabilities?:{workspace:boolean;multiAgent:boolean}; webSearch?:"disabled"|"cached"|"live";mcpServices?:McpGrant[] };
export const defaultAssistantOptions: AssistantOptions = {model:null,autoFlashcardInbox:false};
export const webSearchNames = { disabled: "关闭", cached: "缓存搜索", live: "实时搜索" };
type Section = "model" | "connection";

type Props = {workId?:string;section?:Section;inspector?:boolean;value:AssistantOptions;disabled:boolean;canAuto:boolean;onSave:(value:AssistantOptions)=>Promise<void>;onOpenAccounts?:()=>void};
export function AgentAssistantOptions(props:Props) {
  return props.section==="connection" ? <AgentConnectionOptions {...props}/> : <AgentModelMenu value={props.value} disabled={props.disabled} onSave={props.onSave} onOpenAccounts={props.onOpenAccounts}/>;
}
function AgentConnectionOptions({value,disabled,onSave,section,workId,inspector}:Props) {
  const runtime = useCodexSuite();
  const effective = value.model ?? (runtime.loaded ? runtime.settings : null);
  const [draft,setDraft]=useState(value);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  useEffect(()=>{setDraft(value);},[value]);
  async function save(next:AssistantOptions) {
    if(disabled || saving)return;
    setSaving(true);setError("");
    try {await onSave(next);}
    catch(reason){if(alive.current)setError(String(reason));}
    finally {if(alive.current)setSaving(false);}
  }
  const changed=JSON.stringify(draft)!==JSON.stringify(value);
  const materialsOnly = draft.researchPolicy === "materials-only";
  const deepseek = effective?.provider === "deepseek";
  const searchBlocked = materialsOnly || deepseek;
  const webStatus = materialsOnly ? "当前对话只使用所选资料。" : deepseek ? "当前模型不支持网页搜索。" : "";
  const searchOn = !searchBlocked && !!draft.webSearch && draft.webSearch !== "disabled";
  const rememberedSearch = useRef<"live"|"cached">("live");
  const rememberedMcp = useRef<McpGrant[]>([]);
  const mcpPickerRef = useRef<HTMLDetailsElement>(null);
  const mcpChecked = !searchBlocked && !!draft.mcpServices?.length;
  useEffect(() => { rememberedMcp.current = []; }, [workId]);
  function toggleMcp() {
    if (mcpChecked) {
      rememberedMcp.current = draft.mcpServices ?? [];
      setDraft(current => ({ ...current, mcpServices: undefined }));
    } else if (rememberedMcp.current.length) {
      setDraft(current => ({ ...current, mcpServices: rememberedMcp.current }));
    } else if (mcpPickerRef.current) {
      mcpPickerRef.current.open = true;
      mcpPickerRef.current.querySelector("summary")?.focus();
    }
  }
  useEffect(()=>{
    if(draft.webSearch==="cached" || draft.webSearch==="live") rememberedSearch.current=draft.webSearch;
  },[draft.webSearch]);
  const webSelect = <label>{inspector?"搜索方式":"联网搜索"}<select value={searchBlocked ? "disabled" : draft.webSearch ?? "disabled"} disabled={disabled || saving || searchBlocked} onChange={event=>setDraft(current=>{const next={...current};if(event.target.value==="disabled")delete next.webSearch;else next.webSearch=event.target.value as "cached"|"live";return next;})}>
    <option value="disabled">{webSearchNames.disabled}</option><option value="cached">{webSearchNames.cached}</option><option value="live">{webSearchNames.live}</option>
  </select></label>;
  const mcpPicker = <details className="agent-mcp-settings" ref={mcpPickerRef}><summary>{inspector?"管理已授权工具":"外部工具（MCP）"}<small>{draft.mcpServices?.length ? `已选 ${draft.mcpServices.length} 项` : "未选择"}</small></summary><AgentMcpServices value={draft.mcpServices ?? []} disabled={disabled || saving || searchBlocked} onChange={services=>{
    rememberedMcp.current = services;
    setDraft(current => ({...current,mcpServices:services.length ? services : undefined}));
  }}/></details>;
  const contents=<>
    {section==="connection" && <>
      {inspector ? <button type="button" role="switch" className="agent-inspector-switch" aria-checked={searchOn} disabled={disabled||saving||searchBlocked} onClick={()=>setDraft(current=>{
        const next={...current};
        if(searchOn)delete next.webSearch;
        else next.webSearch=rememberedSearch.current;
        return next;
      })}><span>联网搜索</span><span aria-hidden="true"/></button> : webSelect}
      {inspector && <button type="button" role="switch" className="agent-inspector-switch" aria-checked={mcpChecked} disabled={disabled||saving||searchBlocked} onClick={toggleMcp}><span>MCP 外部工具</span><span aria-hidden="true"/></button>}
      {webStatus && <p className="agent-note" role="status">{webStatus}</p>}
      {inspector && mcpPicker}
      <details className="agent-connection-explanation"><summary>搜索说明</summary><p className="agent-note">新聊天默认实时搜索；此处可关闭，选择会用于后续新聊天。已有对话保留各自设置。仅支持 Codex。开启后，检索词会发送给联网搜索服务；不会因此开放其他本地资料。缓存搜索可能不是最新信息，实时搜索可获取更新内容。搜索记录和链接随对话保存，网页全文需另行读取。提供方内部检索材料不计入 Hub 的材料字节统计。</p></details>
      <details className="agent-connection-advanced"><summary>高级设置</summary>
        {inspector ? webSelect : mcpPicker}
        <details className="agent-connection-explanation"><summary>执行与协作<small>{draft.nativeCapabilities?.workspace?draft.nativeCapabilities.multiAgent?"工作区与子代理":"独立工作区":"受控计算"}</small></summary>
          <label><input type="checkbox" checked={!!draft.knowledgeReview} disabled={disabled || saving || deepseek} onChange={event=>setDraft(current=>({...current,knowledgeReview:event.target.checked}))}/>分工复核资料</label>
          <p className="agent-note">两位助手分头看已授权的原文，并各自核对共同的重点。主助手会汇总发现、分歧和未读部分。</p>
          <label><input type="checkbox" checked={!!draft.nativeCapabilities?.workspace} disabled={disabled||saving||draft.externalMcp||effective?.provider==="deepseek"} onChange={event=>setDraft(current=>{const next={...current};if(event.target.checked)next.nativeCapabilities={workspace:true,multiAgent:false};else delete next.nativeCapabilities;return next;})}/>允许本对话使用独立工作区</label>
          <p className="agent-note">Windows 可运行脚本、创建和编辑工作区文件。网络关闭，不开放原资料库与宿主凭据；来源保存继续使用 Hub 的授权与回执。</p>
          {workId && value.nativeCapabilities?.workspace && <button type="button" onClick={()=>{void invoke<{path:string}>("agent_investigation",{args:{action:"nativeWorkspacePath",id:workId}}).then(result=>openPath(result.path)).catch(reason=>setError(String(reason)));}}>打开本对话工作区</button>}
          <label><input type="checkbox" checked={!!draft.nativeCapabilities?.multiAgent} disabled={disabled||saving||!draft.nativeCapabilities?.workspace||draft.externalMcp||effective?.provider==="deepseek"} onChange={event=>setDraft(current=>({...current,nativeCapabilities:{workspace:true,multiAgent:event.target.checked}}))}/>允许助手委派工作区子任务</label>
          <p className="agent-note">最多两个子代理、一级委派，使用相同工作区边界；随本轮结束或取消退出。冻结材料额度的对话暂不支持工作区；冻结 Token 额度的对话暂不支持子代理。</p>
          <dl className="agent-connection-facts"><div><dt>资料计算</dt><dd>Windows 支持隔离脚本计算。</dd></div><div><dt>外部工具</dt><dd>按对话选择 MCP、已连接应用及具体工具；GitHub 评论先准备草稿再确认。</dd></div><div><dt>技能与记忆</dt><dd>使用 Hub 已选技能和共享记忆。</dd></div><div><dt>浏览器与电脑</dt><dd>可授权独立浏览器访问指定公共网站；电脑操作未接入，网页搜索单独设置。</dd></div></dl>
        </details>
        <details className="agent-connection-explanation agent-diagnostics">
          <summary>开发者诊断{draft.externalMcp && <small>通过 MCP 调用</small>}</summary>
          <label>Hub 工具调用方式<select value={draft.externalMcp ? "mcp" : "native"} disabled={disabled || saving || deepseek} onChange={event=>setDraft(current=>{
            const next={...current};
            if(event.target.value==="mcp"){next.externalMcp=true;delete next.nativeCapabilities;}
            else delete next.externalMcp;
            return next;
          })}><option value="native">直接调用（默认）</option><option value="mcp">通过 MCP 调用</option></select></label>
          <p className="agent-note">两种方式使用相同的资料范围、累计预算与保存权限。MCP 用于检查工具调用，每轮从已保存记录继续。</p>
          {value.nativeCapabilities?.workspace && draft.externalMcp && <p className="agent-note" role="status">应用后会关闭本对话的独立工作区与子代理。</p>}
        </details>
      </details>
    </>}
    {changed && <button type="button" disabled={disabled||saving} onClick={()=>void save(draft)}>{saving?"正在应用…":draft.autoFlashcardInbox&&!value.autoFlashcardInbox?"确认本对话的自动导入授权":"应用到本对话"}</button>}
    {error && <p role="alert">{error}</p>}
  </>;
  return <div className="agent-connection-settings">{contents}</div>;
}
