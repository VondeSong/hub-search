import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { policyNames, type ResearchTopic } from "./AgentResearch";
import { Check, ChevronDown, FolderBookmark, Goal, PinOff, Sparkles, Tags, X } from "lucide-react";
import { useAgentPopover } from "./useAgentPopover";

export function AgentTaskMode({ title, disabled, tagMode = false, goalMode = false, goalDisabled = false, activeTopic, onGeneral, onGoal, onTag, onTopics, onUsage, onTopic, onUnpinTopic }: {
  title: string; disabled: boolean; selectedSkills?: string[]; tagMode?: boolean;
  goalMode?: boolean; goalDisabled?: boolean; onGoal?: () => void;
  onGeneral: () => void; onTag: () => void;
  activeTopic?: ResearchTopic; onUnpinTopic?: (topic:ResearchTopic)=>Promise<void>;
  onTopic?:(topic:ResearchTopic)=>void;onTopics: () => void; onUsage: () => void;
}) {
  const popover = useAgentPopover();
  const [topics,setTopics]=useState<ResearchTopic[]>([]);
  const [error,setError]=useState("");
  const choose = (action: () => void) => { popover.close(); action(); };
  const mode = tagMode ? "标签" : goalMode ? "目标" : activeTopic ? "专题" : "标准";
  return <details ref={popover.ref} className="agent-task-mode" name="hub-agent-header" onToggle={event=>{if(event.target===event.currentTarget&&event.currentTarget.open){setError("");void invoke<{topics:ResearchTopic[]}>("agent_investigation",{args:{action:"researchTopics"}}).then(v=>setTopics(Array.isArray(v?.topics)?v.topics:[])).catch(e=>{setTopics([]);setError(String(e));});}}}>
    <summary aria-label="任务模式" title={tagMode ? "标签助手" : activeTopic?.title || title} aria-description={`当前模式：${mode}`}>
      {tagMode ? <Tags size={15}/> : goalMode ? <Goal size={15}/> : activeTopic ? <FolderBookmark size={15}/> : null}<span className="agent-mode-title">{tagMode ? "标签助手" : activeTopic?.title || title}</span><small className="agent-mode-badge">{mode}</small><ChevronDown size={13}/>
    </summary>
    <section className="agent-mode-menu" aria-label="任务模式">
      <div className="agent-mode-heading"><strong>任务模式</strong><button type="button" aria-label="关闭任务模式" onClick={() => popover.close(true)}><X size={16}/></button></div>
      <button type="button" className="agent-menu-choice" disabled={disabled} aria-pressed={!tagMode&&!goalMode} onClick={() => choose(onGeneral)}><Sparkles size={17}/><span><strong>通用助手</strong><small>自由提问，保留当前对话与设置</small></span>{!tagMode&&!goalMode && <Check size={16}/>}</button>
      {onGoal && <button type="button" className="agent-menu-choice" disabled={disabled || goalDisabled} aria-pressed={goalMode} onClick={() => choose(onGoal)}><Goal size={17}/><span><strong>目标模式</strong><small>按完成条件推进，遇到阻碍时暂停</small></span>{goalMode && <Check size={16}/>}</button>}
      <button type="button" className="agent-menu-choice" disabled={disabled} aria-pressed={tagMode} onClick={() => choose(onTag)}><Tags size={17}/><span><strong>标签助手</strong><small>起草定义、查找漏标、比较关系</small></span>{tagMode && <Check size={16}/>}</button>

      <div className="agent-mode-group"><strong>置顶专题</strong>{!topics.some(t=>t.pinned)&&<p>可在专题列表里置顶常用专题。</p>}{onTopic&&topics.filter(t=>t.pinned).map(topic=><div className="agent-mode-pin-row" key={topic.id}><button type="button" className="agent-menu-choice" disabled={disabled} aria-current={activeTopic?.id===topic.id||undefined} onClick={()=>choose(()=>onTopic(topic))}><FolderBookmark size={17}/><span><strong>{topic.title}</strong><small>{policyNames[topic.policy]} · {topic.grant.notes.length} 份材料 · {topic.grant.libraryIds.length} 个库</small></span>{activeTopic?.id===topic.id&&<Check size={16}/>}</button>{onUnpinTopic&&<button type="button" className="agent-mode-unpin" disabled={disabled} aria-label={`取消置顶专题 ${topic.title}`} onClick={()=>void onUnpinTopic(topic).then(()=>setTopics(current=>current.map(t=>t.id===topic.id?{...t,pinned:false}:t))).catch(e=>setError(String(e)))}><PinOff size={14}/></button>}</div>)}<button type="button" className="agent-mode-link" onClick={() => choose(onTopics)}>{activeTopic?"切换专题":"全部专题"}</button></div>
      {error&&<p role="alert">{error}</p>}
      <footer className="agent-mode-footer"><span>执行安排 · 自动</span><button type="button" className="agent-mode-link" onClick={() => choose(onUsage)}>查看任务状态</button></footer>
    </section>
  </details>;
}
