import { Check, ChevronDown, FolderBookmark, Sparkles, Tags, WandSparkles, X } from "lucide-react";
import { useAgentPopover } from "./useAgentPopover";
import { skillTitle } from "./AgentSkills";

export function AgentTaskMode({ title, disabled, selectedSkills = [], pinnedSkills = [], tagMode = false, onGeneral, onTag, onSkill, onSkills, onTopics, onUsage }: {
  title: string; disabled: boolean; selectedSkills?: string[]; pinnedSkills?: string[]; tagMode?: boolean;
  onGeneral: () => void; onTag: () => void; onSkill: (name: string) => void;
  onSkills: () => void; onTopics: () => void; onUsage: () => void;
}) {
  const popover = useAgentPopover();
  const choose = (action: () => void) => { popover.close(); action(); };
  return <details ref={popover.ref} className="agent-task-mode" name="hub-agent-header">
    <summary aria-label="任务模式" title={tagMode ? "标签助手" : title}>
      {tagMode ? <Tags size={15}/> : <Sparkles size={15}/>}<span className="agent-mode-title">{tagMode ? "标签助手" : title}</span><ChevronDown size={13}/>
    </summary>
    <section className="agent-mode-menu" aria-label="任务模式">
      <div className="agent-mode-heading"><strong>任务模式</strong><button type="button" aria-label="关闭任务模式" onClick={() => popover.close(true)}><X size={16}/></button></div>
      <button type="button" className="agent-menu-choice" disabled={disabled} aria-pressed={!tagMode} onClick={() => choose(onGeneral)}><Sparkles size={17}/><span><strong>通用助手</strong><small>自由提问，保留当前对话与设置</small></span>{!tagMode && <Check size={16}/>}</button>
      <button type="button" className="agent-menu-choice" disabled={disabled} aria-pressed={tagMode} onClick={() => choose(onTag)}><Tags size={17}/><span><strong>标签助手</strong><small>起草定义、查找漏标、比较关系</small></span>{tagMode && <Check size={16}/>}</button>
      <div className="agent-mode-group"><strong>置顶技能</strong>{pinnedSkills.map(name => <button type="button" className="agent-menu-choice" key={name} disabled={disabled} aria-pressed={selectedSkills.includes(name)} onClick={() => choose(() => onSkill(name))}><WandSparkles size={17}/><span>{skillTitle(name)}</span>{selectedSkills.includes(name) && <Check size={16}/>}</button>)}<button type="button" className="agent-mode-link" onClick={() => choose(onSkills)}>全部技能</button></div>
      <div className="agent-mode-group"><strong>专题</strong><button type="button" className="agent-menu-choice" onClick={() => choose(onTopics)}><FolderBookmark size={17}/><span>全部专题</span><ChevronDown size={14}/></button></div>
      <footer className="agent-mode-footer"><span>执行安排 · 自动</span><button type="button" className="agent-mode-link" onClick={() => choose(onUsage)}>查看任务状态</button></footer>
    </section>
  </details>;
}
