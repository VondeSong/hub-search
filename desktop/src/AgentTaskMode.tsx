import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { policyNames, type ResearchTopic } from "./AgentResearch";
import { Check, ChevronDown, FolderBookmark, PinOff, Sparkles, Tags, WandSparkles, X } from "lucide-react";
import { useAgentPopover } from "./useAgentPopover";
import { skillPurpose, skillTitle } from "./AgentSkills";

export function AgentTaskMode({ title, disabled, selectedSkills = [], pinnedSkills = [], tagMode = false, activeTopic, onGeneral, onTag, onSkill, onTopics, onUsage, onTopic, onUnpinSkill, onUnpinTopic }: {
  title: string; disabled: boolean; selectedSkills?: string[]; pinnedSkills?: string[]; tagMode?: boolean;
  onGeneral: () => void; onTag: () => void; onSkill: (name: string) => void;
  activeTopic?: ResearchTopic; onUnpinSkill?: (name:string)=>void; onUnpinTopic?: (topic:ResearchTopic)=>Promise<void>;
  onTopic?:(topic:ResearchTopic)=>void;onTopics: () => void; onUsage: () => void;
}) {
  const popover = useAgentPopover();
  const [topics,setTopics]=useState<ResearchTopic[]>([]);
  const [error,setError]=useState("");
  const choose = (action: () => void) => { popover.close(); action(); };
  return <details ref={popover.ref} className="agent-task-mode" name="hub-agent-header" onToggle={event=>{if(event.target===event.currentTarget&&event.currentTarget.open){setError("");void invoke<{topics:ResearchTopic[]}>("agent_investigation",{args:{action:"researchTopics"}}).then(v=>setTopics(Array.isArray(v?.topics)?v.topics:[])).catch(e=>{setTopics([]);setError(String(e));});}}}>
    <summary aria-label="任务模式" title={tagMode ? "标签助手" : activeTopic?.title || title} aria-description={`当前模式：${tagMode?"标签":activeTopic?"专题":selectedSkills.length?"技能":"标准"}`}>
      {tagMode ? <Tags size={15}/> : activeTopic ? <FolderBookmark size={15}/> : null}<span className="agent-mode-title">{tagMode ? "标签助手" : activeTopic?.title || title}</span><small className="agent-mode-badge">{tagMode?"标签":activeTopic?"专题":selectedSkills.length?"技能":"标准"}</small><ChevronDown size={13}/>
    </summary>
    <section className="agent-mode-menu" aria-label="任务模式">
      <div className="agent-mode-heading"><strong>任务模式</strong><button type="button" aria-label="关闭任务模式" onClick={() => popover.close(true)}><X size={16}/></button></div>
      <button type="button" className="agent-menu-choice" disabled={disabled} aria-pressed={!tagMode} onClick={() => choose(onGeneral)}><Sparkles size={17}/><span><strong>通用助手</strong><small>自由提问，保留当前对话与设置</small></span>{!tagMode && <Check size={16}/>}</button>
      <button type="button" className="agent-menu-choice" disabled={disabled} aria-pressed={tagMode} onClick={() => choose(onTag)}><Tags size={17}/><span><strong>标签助手</strong><small>起草定义、查找漏标、比较关系</small></span>{tagMode && <Check size={16}/>}</button>
      <div className="agent-mode-group"><strong>置顶技能</strong>{!pinnedSkills.length&&<p>可通过底栏的魔杖「添加技能」，置顶常用技能。</p>}{pinnedSkills.map(name => <div className="agent-mode-pin-row" key={name}><button type="button" className="agent-menu-choice" disabled={disabled} aria-pressed={selectedSkills.includes(name)} onClick={() => choose(() => onSkill(name))}><WandSparkles size={17}/><span><strong>{skillTitle(name)}</strong>{skillPurpose(name)&&<small>{skillPurpose(name)}</small>}</span>{selectedSkills.includes(name) && <Check size={16}/>}</button>{onUnpinSkill&&<button type="button" className="agent-mode-unpin" disabled={disabled} aria-label={`取消置顶技能 ${skillTitle(name)}`} onClick={()=>onUnpinSkill(name)}><PinOff size={14}/></button>}</div>)}</div>
      <div className="agent-mode-group"><strong>置顶专题</strong>{!topics.some(t=>t.pinned)&&<p>可在专题列表里置顶常用专题。</p>}{onTopic&&topics.filter(t=>t.pinned).map(topic=><div className="agent-mode-pin-row" key={topic.id}><button type="button" className="agent-menu-choice" disabled={disabled} aria-current={activeTopic?.id===topic.id||undefined} onClick={()=>choose(()=>onTopic(topic))}><FolderBookmark size={17}/><span><strong>{topic.title}</strong><small>{policyNames[topic.policy]} · {topic.grant.notes.length} 份材料 · {topic.grant.libraryIds.length} 个库</small></span>{activeTopic?.id===topic.id&&<Check size={16}/>}</button>{onUnpinTopic&&<button type="button" className="agent-mode-unpin" disabled={disabled} aria-label={`取消置顶专题 ${topic.title}`} onClick={()=>void onUnpinTopic(topic).then(()=>setTopics(current=>current.map(t=>t.id===topic.id?{...t,pinned:false}:t))).catch(e=>setError(String(e)))}><PinOff size={14}/></button>}</div>)}<button type="button" className="agent-mode-link" onClick={() => choose(onTopics)}>{activeTopic?"切换专题":"全部专题"}</button></div>
      {error&&<p role="alert">{error}</p>}
      <footer className="agent-mode-footer"><span>执行安排 · 自动</span><button type="button" className="agent-mode-link" onClick={() => choose(onUsage)}>查看任务状态</button></footer>
    </section>
  </details>;
}
