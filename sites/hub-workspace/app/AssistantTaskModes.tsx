"use client";
import { useId, useState } from 'react';
import { Check, ChevronDown, FolderBookmark, Sparkles, Tags, WandSparkles, X } from 'lucide-react';
import { demoSkills } from './AssistantResources';
import { PinShortcut, TopicSourceReview, researchPolicies, type TopicSource, type ResearchTopic, type WorkPins } from './AssistantResearch';

export function AssistantTaskModes({ tagActive, onTag, topics, pins, skills, allTopics, disabled, onPin, onSkill, onGeneral, onTopic, onAllTopics, onUsage, onClose, activeTopic }: {
  tagActive: boolean; onTag: () => void; topics: ResearchTopic[]; pins: WorkPins; skills: string[]; allTopics: boolean; disabled: boolean; activeTopic: string | null;
  onPin: (kind: keyof WorkPins, id: string) => void; onSkill: (id: string) => void; onGeneral: () => void;
  onTopic: (topic: ResearchTopic) => void; onAllTopics: () => void; onUsage: () => void; onClose: () => void;
}) {
  const shownTopics = allTopics ? topics : topics.filter(topic => pins.topics.includes(topic.id));
  return <section className="ha-menu ha-header-menu ha-work-modes" aria-label={allTopics ? '全部专题' : '任务模式'}>
    <header className="ha-menu-heading"><strong>{allTopics ? '全部专题' : '任务模式'}</strong><button type="button" className="ha-icon" aria-label={allTopics ? '关闭全部专题' : '关闭任务模式'} onClick={onClose}><X size={16}/></button></header>
    {!allTopics && <>
      <button type="button" className="ha-menu-choice" disabled={disabled} aria-pressed={!tagActive} onClick={onGeneral}><Sparkles size={17}/><span><strong>通用助手</strong><small>自由提问，保留当前对话与设置</small></span>{!tagActive && <Check size={16}/>}</button>
      <button type="button" className="ha-menu-choice" disabled={disabled} aria-pressed={tagActive} onClick={onTag}><Tags size={17}/><span><strong>标签助手</strong><small>起草定义、查找漏标、比较关系</small></span>{tagActive && <Check size={16}/>}</button>
    </>}
    <div className="ha-mode-group">
      {!allTopics && <strong>置顶专题</strong>}
      {shownTopics.length ? shownTopics.map(topic => <div className="ha-pin-row" key={topic.id}>
        <button type="button" className="ha-menu-choice" disabled={disabled} aria-current={activeTopic === topic.id || undefined} onClick={() => onTopic(topic)}><FolderBookmark size={17}/><span><strong>{topic.name}</strong><small>{researchPolicies.find(item => item.id === topic.policy)?.name} · {topic.pageIds.length} 份材料 · {topic.libraryIds.length} 个库</small></span>{activeTopic === topic.id && <Check size={16} aria-label="当前专题"/>}</button>
        <PinShortcut kind="专题" title={topic.name} pinned={pins.topics.includes(topic.id)} onToggle={() => onPin('topics', topic.id)}/>
      </div>) : <p>{allTopics ? '还没有专题。可在「资料范围」中保存当前设置。' : '可在专题列表里置顶常用专题。'}</p>}
      <button type="button" className="ha-mode-link" onClick={onAllTopics}>{allTopics ? '返回任务模式' : activeTopic ? '切换专题' : '全部专题'}</button>
    </div>
    {!allTopics && <footer className="ha-mode-footer"><span>执行安排 · 自动</span><button type="button" className="ha-mode-link" onClick={onUsage}>查看任务状态</button></footer>}
  </section>;
}


export function ActiveTopicChip({ name, sources, pages, libraries, skills, disabled, onCancel, onRemoveSource, onRemoveSkill }: { name: string; sources: TopicSource[]; pages: number; libraries: number; skills: string[]; disabled: boolean; onCancel: () => void; onRemoveSource?: (source: TopicSource) => void; onRemoveSkill?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const count = [pages ? pages + ' 份资料' : '', libraries ? libraries + ' 个库' : ''].filter(Boolean).join(' · ') || '未选资料';
  return <div className="ha-topic-chip">
    <div className="ha-topic-chip-label" data-removable={!disabled || undefined}>
      <button type="button" className="ha-topic-chip-toggle" title={name} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)}><FolderBookmark size={15} aria-hidden="true"/><strong>{name}</strong><small>{count}</small><span className="ha-topic-chip-caret" aria-hidden="true"><ChevronDown size={13}/></span></button>
      {!disabled && <button type="button" className="ha-topic-chip-cancel ha-chip-remove" aria-label="取消专题" title="取消当前专题" onClick={onCancel}><X size={13} aria-hidden="true"/></button>}
    </div>
    <div id={detailsId} className="ha-topic-chip-body" hidden={!open}>{sources.length ? <TopicSourceReview sources={sources} onRemove={onRemoveSource}/> : <p>当前没有使用这个专题的资料。</p>}
      {!!skills.length && <div className="ha-topic-review"><div><strong>专题技能</strong><ul>{demoSkills.filter(([id]) => skills.includes(id)).map(([id, label]) => <li key={id}><WandSparkles size={13} aria-hidden="true"/>{label}{onRemoveSkill && <button type="button" className="ha-icon ha-topic-item-remove ha-chip-remove" aria-label={'从当前专题移除技能 ' + label} onClick={() => onRemoveSkill(id)}><X size={13}/></button>}</li>)}</ul></div></div>}
      <p>这里的移除只影响当前对话。</p>
    </div>
  </div>;
}

export function AssistantTopicReview({ topic, sources, disabled, onBack, onClose, onApply, onEdit }: {
  topic: ResearchTopic; sources: TopicSource[]; disabled: boolean; onBack: () => void; onClose: () => void;
  onApply: () => void; onEdit: () => void;
}) {
  const hasAvailable = sources.some(item => item.available), hasMissing = sources.some(item => !item.available);
  const skills = demoSkills.filter(item => topic.skillIds?.includes(item[0])).map(item => item[1]);
  return <section className="ha-menu ha-header-menu ha-work-modes" aria-label="核对专题">
    <header className="ha-menu-heading"><button type="button" onClick={onBack}>返回</button><strong>核对专题</strong><button type="button" className="ha-icon" aria-label="关闭专题核对" onClick={onClose}><X size={16}/></button></header>
    <div className="ha-topic-open-review"><h3>{topic.name}</h3><p>资料策略：{researchPolicies.find(item => item.id === topic.policy)?.name}</p>
      {!!skills.length && <p>将加入的技能：{skills.join('、')}</p>}
      <TopicSourceReview sources={sources}/>
      <p>{!hasAvailable ? '没有可用资料。请先调整范围，再应用专题。' : hasMissing ? '部分资料不可用。可调整范围，或仅应用可用的专题资料。手选资料和草稿会保留。' : '从下一轮起使用这个专题的资料和策略。手选资料会保留，默认不额外纳入；手选技能和草稿不变。'}</p>
      <footer><button type="button" className="ha-secondary-button" disabled={disabled} onClick={onEdit}>调整资料范围</button>
        <button type="button" className="ha-primary-button" disabled={disabled || !hasAvailable} onClick={onApply}>{hasMissing && hasAvailable ? '仅应用可用资料' : '应用到当前对话'}</button></footer>
    </div>
  </section>;
}
