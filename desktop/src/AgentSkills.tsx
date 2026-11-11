import ReactMarkdown from "react-markdown";
import { useEffect, useRef, useState } from "react";
import { WandSparkles, Check, Pin, PinOff } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAgentPopover } from "./useAgentPopover";
import {AgentSkillPackages} from "./AgentSkillPackages";
import builtin0 from "../src-tauri/src/agent_work/skills/hub-research/SKILL.md?raw";
import builtin1 from "../src-tauri/src/agent_work/skills/hub-flashcards/SKILL.md?raw";
import builtin2 from "../src-tauri/src/agent_work/skills/hub-note-edit/SKILL.md?raw";
import builtin3 from "../src-tauri/src/agent_work/skills/hub-archive/SKILL.md?raw";
import builtin4 from "../src-tauri/src/agent_work/skills/hub-tool-guide/SKILL.md?raw";
import builtin5 from "../src-tauri/src/agent_work/skills/hub-statistics/SKILL.md?raw";
const builtinDocuments: Record<string, string> = {"hub-research": builtin0,"hub-flashcards": builtin1,"hub-note-edit": builtin2,"hub-archive": builtin3,"hub-tool-guide": builtin4,"hub-statistics": builtin5};


export type AgentSkill = { name: string; title: string; description: string; origin: "builtin" | "user" | "registered"; packageId?: string; methodVersion?: string; version: string; available: boolean; allowImplicitInvocation: boolean; unavailableReasons: string[] };
type Catalog = { skills: AgentSkill[]; diagnostics: { name: string; message: string }[]; directory: string };

const builtinTitles: Record<string,string> = {"hub-research":"资料分析与核对","hub-statistics":"材料统计与覆盖核对","hub-flashcards":"有来源的闪卡","hub-note-edit":"笔记整理与修改","hub-archive":"阅读材料归档","hub-tool-guide":"Hub 工具使用方法"};
export const skillTitle = (name:string) => builtinTitles[name] || name;
const purposes: Record<string,string> = {"hub-research":"比较材料中的观点，核对原文与矛盾","hub-statistics":"统计材料中的数量、日期与覆盖范围","hub-flashcards":"根据笔记制作或检查学习卡片","hub-note-edit":"整理、改写当前可编辑的 Obsidian 笔记","hub-archive":"为阅读材料准备归档方案","hub-tool-guide":"查看标签、媒体和闪卡工具的使用约定"};
export const skillPurpose=(name:string)=>purposes[name]||"";

export function AgentSkills({ disabled, onSelect, embedded=false, selected=[], onReset, pinned=[], onPin }: { disabled: boolean; onSelect: (name: string) => void; embedded?: boolean; selected?:string[]; onReset?:()=>void; pinned?:string[]; onPin?:(name:string)=>void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const popover = useAgentPopover();
  const details = popover.ref;
  const alive = useRef(true);
  const request = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  async function load(action = "skills") {
    const ticket = ++request.current;
    setLoading(true); setError("");
    try {
      const result = await invoke<Catalog>("agent_investigation", { args: { action } });
      if (alive.current && ticket === request.current) setCatalog(result);
    } catch (reason) { if (alive.current && ticket === request.current) setError(String(reason)); }
    finally { if (alive.current && ticket === request.current) setLoading(false); }
  }
  useEffect(()=>{if(embedded)void load();},[embedded]);
  const [detail, setDetail] = useState<AgentSkill | null>(null);
  const [sourcePath,setSourcePath] = useState("");
  const [sourceError,setSourceError] = useState("");
  useEffect(()=>{
    let current=true;setSourcePath("");setSourceError("");
    if(detail && detail.origin!=="registered") void invoke<{path:string}>("agent_investigation",{args:{action:"skillSourceFile",name:detail.name}}).then(value=>{if(current)setSourcePath(value.path || "");},reason=>{if(current)setSourceError(String(reason));});
    return ()=>{current=false;};
  },[detail]);
  async function revealSource(){
    if(!detail)return;
    try{await invoke("agent_investigation",{args:{action:"skillSourceFile",name:detail.name,reveal:true}});setSourceError("");}
    catch(reason){setSourceError(String(reason));}
  }
  const [managing, setManaging] = useState(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const listReturn = useRef<HTMLButtonElement | null>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  useEffect(() => { if (detail || managing) detailHeading.current?.focus(); }, [detail, managing]);
  function back() {
    setDetail(null);
    setManaging(false);
    const label = listReturn.current?.getAttribute("aria-label");
    const title = listReturn.current?.textContent;
    requestAnimationFrame(() => Array.from(menuElement.current?.querySelectorAll("button") || []).find(button => label ? button.getAttribute("aria-label") === label : button.textContent === title)?.focus());
  }
  const choice = (skill: AgentSkill) => <div className="agent-skill-choice" key={skill.name}>
    <button type="button" aria-label={`查看技能 ${skill.title}`} aria-pressed={selected.includes(skill.name)}
      onClick={event => { listReturn.current = event.currentTarget; setDetail(skill); }}>
      <span className="agent-skill-icon" aria-hidden="true"><WandSparkles size={17} strokeWidth={1.4}/></span>
      <span className="agent-skill-copy"><strong>{skill.title}</strong><span>{purposes[skill.name] || skill.description.split(/[。；]/)[0] || "未提供用途说明"}</span></span>
      {selected.includes(skill.name) && <Check size={16} className="agent-skill-check" aria-hidden="true"/>}
    </button>
    {onPin && <button type="button" className="agent-skill-pin" aria-label={(pinned.includes(skill.name)?"取消置顶技能 ":"置顶技能 ")+skill.title} aria-pressed={pinned.includes(skill.name)} onClick={()=>onPin(skill.name)}>{pinned.includes(skill.name)?<PinOff size={15}/>:<Pin size={15}/>}</button>}
  </div>;
  const content = <div className="agent-skill-menu" ref={menuElement} aria-label="可用技能">
    {!embedded && <div className="agent-popover-header"><strong>使用技能</strong><button type="button" aria-label="关闭技能菜单" onClick={() => popover.close(true)}>关闭</button></div>}
    {error && <p role="alert">{error}</p>}
    {detail ? <section className="agent-skill-detail" aria-label="技能详情">
      <button type="button" className="agent-menu-back" onClick={back}>← 技能库</button>
      <h3 ref={detailHeading} tabIndex={-1}>{detail.title}</h3>
      <p className="agent-note">{detail.origin === "builtin" ? "Hub 内置" : detail.origin === "registered" ? "已登记方法包" : "用户技能"} · {detail.allowImplicitInvocation ? "助手可按需使用" : "仅手动指定"}</p>
      <h4>适用范围</h4><p>{detail.description || "未提供用途说明"}</p>
      {!detail.available && <p role="status">暂不可用：{detail.unavailableReasons.join("；")}</p>}
      <div className="agent-skill-actions">
        <button type="button" disabled={disabled || !detail.available} onClick={() => { onSelect(detail.name); if (details.current) details.current.open = false; }}>{selected.includes(detail.name) ? "已添加到本次对话" : "添加到本次对话"}</button>
        {detail.origin === "user" && <button type="button" onClick={() => void load("openSkillDirectory")}>打开文件夹编辑</button>}
        {detail.origin === "registered" && <button type="button" onClick={() => {setDetail(null);setManaging(true);}}>查看与管理方法包</button>}
      </div>
      {detail.origin !== "registered" && <section className="agent-skill-source"><span>源文件</span>{sourcePath ? <button type="button" onClick={()=>void revealSource()} title="在资源管理器中定位"><span>SKILL.md</span><small>{sourcePath}</small><span aria-hidden="true">↗</span></button> : <p className="agent-note">{sourceError || "正在读取文件位置…"}</p>}{sourcePath && sourceError && <p role="alert">{sourceError}</p>}<small>{detail.origin === "builtin" ? "修改后重新构建 Hub 生效" : "修改后刷新技能生效"}</small></section>}

      {detail.origin === "builtin" && <details className="agent-skill-document"><summary>完整技能说明</summary><div className="agent-skill-prose"><ReactMarkdown>{(builtinDocuments[detail.name] || "正文暂不可用").replace(/^---[\s\S]*?\n---\s*\n/, "")}</ReactMarkdown></div></details>}

    </section> : managing ? <section className="agent-skill-detail" aria-label="技能管理">
      <button type="button" className="agent-menu-back" onClick={back}>← 技能库</button>
      <h3 ref={detailHeading} tabIndex={-1}>管理技能</h3>
      <AgentSkillPackages initiallyExpanded onChanged={() => void load()}/>
      <div className="agent-skill-actions"><button type="button" disabled={loading} onClick={() => void load("openSkillDirectory")}>打开用户技能文件夹</button></div>
      <details className="agent-menu-advanced"><summary>文件夹与使用说明</summary>
        <p className="agent-note">用户技能与 Codex 的用户技能独立。每个技能放在独立文件夹中，包含 SKILL.md；修改后刷新。已登记方法包通过检查并发布新版本更新。外部 Codex 可通过 Hub MCP 读取 Hub 技能。</p>
        <p className="agent-skill-directory">{catalog?.directory}</p>
      </details>
    </section> : <>
      <div className="agent-skill-toolbar"><strong>技能库</strong><button type="button" onClick={event => {listReturn.current=event.currentTarget;setManaging(true);}}>管理技能</button><button type="button" disabled={loading} onClick={() => void load()}>刷新技能</button></div>
      <p className="agent-note">{selected.length ? `已指定 ${selected.length} 项技能，随下一条消息生效。` : "普通提问可直接发送，助手会自动按需选择。"}</p>
      {!!selected.length && onReset && <button type="button" disabled={disabled} onClick={onReset}>恢复自动选择</button>}
      {loading && <p role="status">正在读取技能…</p>}
      {catalog && !loading && !error && catalog.skills.length === 0 && <p className="agent-note">还没有可用技能。你仍可直接提问，或从管理技能添加。</p>}
      {catalog?.skills.filter(skill => skill.name !== "hub-tool-guide").map(choice)}
      {catalog?.skills.some(skill => skill.name === "hub-tool-guide") && <details className="agent-menu-advanced"><summary>高级工具指南</summary>{catalog.skills.filter(skill => skill.name === "hub-tool-guide").map(choice)}</details>}
      {!!catalog?.diagnostics.length && <details><summary>有技能未能加载</summary>{catalog.diagnostics.map((item, index) => <p className="agent-note" key={index}>{item.name}：{item.message}</p>)}</details>}
    </>}
  </div>;
  return embedded ? <div className="agent-menu-embedded">{content}</div> : <details className="agent-skills agent-popover" name="hub-agent-preference" ref={details} onToggle={event=>{if(event.target===event.currentTarget && event.currentTarget.open)void load();}}><summary>使用技能</summary>{content}</details>;
}
