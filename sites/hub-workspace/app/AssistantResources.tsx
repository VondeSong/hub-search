"use client";
import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, FileText, FolderOpen, Globe, Image as ImageIcon, RefreshCw, Search, Settings2, WandSparkles, X } from 'lucide-react';
import { PinShortcut } from './AssistantResearch';
import type { AssistantContext } from './Assistant';

export type ResourceDraft = { pages: AssistantContext[]; libraryIds: string[]; skills: string[]; url: string; images: string[] };
export const emptyResources = (): ResourceDraft => ({ pages: [], libraryIds: [], skills: [], url: '', images: [] });
export const demoSkills = [
  ['hub-research', '资料分析与核对', '比较材料中的观点，核对原文与矛盾'],
  ['hub-statistics', '材料统计与覆盖核对', '统计材料中的数量、日期与覆盖范围'],
  ['hub-flashcards', '有来源的闪卡', '根据笔记制作或检查学习卡片'],
  ['hub-note-edit', '笔记整理与修改', '整理、改写当前可编辑的 Obsidian 笔记'],
  ['hub-archive', '阅读材料归档', '为阅读材料准备归档方案'],
  ['hub-tool-guide', 'Hub 工具使用方法', '查看标签、媒体和闪卡工具的使用约定'],
] as const;
export function publicUrl(value: string) {
  if (!value.trim()) return '';
  try { const url = new URL(value.trim()); return url.protocol === 'https:' && !url.username && !url.password && value.length <= 2000 ? url.href : null; } catch { return null; }
}
export function publicLinkIn(text: string) {
  for (const value of text.match(/https:\/\/[^\s<>"，。！？；、]+/gi) || []) {
    const url = publicUrl(value.replace(/[)\]）】.,;!?]+$/, ''));
    if (url) return url;
  }
  return '';
}
export function AssistantResources({ resources, onChange, disabled, skillPins, onPinSkill, onDone }: {
  resources: ResourceDraft; onChange: (value: ResourceDraft) => void;
  disabled: boolean; skillPins: string[]; onPinSkill: (id: string) => void; onDone: () => void;
}) {
  const [detail, setDetail] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [managementNotice,setManagementNotice] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const returnPin = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!returnPin.current) return;
    const row = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-skill-id]') || []).find(item => item.dataset.skillId === returnPin.current);
    row?.querySelector<HTMLButtonElement>('.ha-pin-shortcut')?.focus();
    returnPin.current = null;
  }, [skillPins]);
  const keyword = query.trim().toLocaleLowerCase();
  const matches = demoSkills.filter(skill => skill.join(' ').toLocaleLowerCase().includes(keyword));
  const groups = [
    { title: '置顶', items: matches.filter(([id]) => skillPins.includes(id)) },
    { title: skillPins.length ? '其他技能' : '全部技能', items: matches.filter(([id]) => !skillPins.includes(id)) },
  ];
  return <div ref={root} className="ha-resource-section ha-skills-content">
    {!detail ? <>
      <div className="ha-skills-toolbar"><label className="ha-skills-search"><Search size={15} aria-hidden="true"/><input type="search" aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={event => setQuery(event.target.value)}/></label><button type="button" className="ha-icon" aria-label="管理技能" title="管理技能" onClick={() => setDetail('manage')}><Settings2 size={17}/></button></div>
      <p className="ha-skills-hint">{resources.skills.length ? `已选 ${resources.skills.length} 项，随下一条消息使用。` : '按需自动选用，也可指定本次使用的技能。'}</p>
      <div className="ha-skills-scroll">{groups.filter(group => group.items.length).map(group => <section className="ha-skills-group" key={group.title} aria-label={group.title}><h3>{group.title}<span>{group.items.length}</span></h3>{group.items.map(([id, title, purpose]) => <div className="ha-pin-row ha-skill-row" data-skill-id={id} key={id} data-selected={resources.skills.includes(id) || undefined}><button type="button" className="ha-menu-choice" aria-label={'查看技能 ' + title} aria-pressed={resources.skills.includes(id)} onClick={() => setDetail(id)}><span className="ha-skill-symbol"><WandSparkles size={17}/></span><span><strong>{title}</strong><small>{purpose}</small></span>{resources.skills.includes(id) && <Check size={16}/>}</button><PinShortcut kind="技能" title={title} pinned={skillPins.includes(id)} onToggle={() => { returnPin.current = id; onPinSkill(id); }}/></div>)}</section>)}{!matches.length && <p className="ha-skills-empty">没有找到匹配的技能。</p>}</div>
    </> : <div className="ha-skills-detail"><button type="button" className="ha-skills-back" onClick={() => setDetail(null)}><ArrowLeft size={15}/>返回技能</button>{detail === 'manage' ? <section aria-label="管理技能"><div className="ha-skill-management-heading"><div><h3>管理技能</h3><p>管理本机技能与固定方法包。</p></div><button type="button" className="ha-icon" aria-label="刷新技能" title="刷新技能" onClick={()=>setManagementNotice('技能列表已刷新（演示）。')}><RefreshCw size={16}/></button></div>
<div className="ha-skill-management-group"><button type="button" className="ha-skill-management-row" onClick={()=>setManagementNotice('用户技能文件夹需在桌面客户端打开。')}><FolderOpen size={18}/><span><strong>用户技能文件夹</strong><small>添加或编辑自己的 SKILL.md</small></span><ChevronRight size={15}/></button></div>
<div className="ha-skill-management-group"><h4>方法包</h4><p>从文件夹检查、导入方法包；更新前保留固定版本。</p><button type="button" className="ha-secondary-button" onClick={()=>setManagementNotice('方法包文件检查需在桌面客户端进行。')}><FolderOpen size={15}/>检查方法文件夹</button><details><summary>导入格式与容量</summary><p>每个方法包包含 SKILL.md，可包含供技能读取的说明和资源。导入前检查文件与可用能力。</p></details></div>
<details className="ha-skill-management-help"><summary>文件夹与使用说明</summary><p>置顶技能排在技能列表前面。新增或编辑用户技能后刷新列表；固定方法包检查更新后再采用新版本。</p></details>{managementNotice&&<p role="status" className="ha-skills-hint">{managementNotice}</p>}</section> : demoSkills.filter(([id]) => id === detail).map(([id, title, purpose]) => <section key={id} aria-label="技能详情"><div className="ha-skill-detail-title"><span className="ha-skill-symbol"><WandSparkles size={20}/></span><h3>{title}</h3><PinShortcut kind="技能" title={title} pinned={skillPins.includes(id)} onToggle={() => { returnPin.current = id; onPinSkill(id); }}/></div><p>{purpose}。</p><p>使用本次选定资料，保留依据和待确认项。</p><button type="button" className="ha-primary-button" disabled={disabled || resources.skills.includes(id)} onClick={() => { onChange({ ...resources, skills: [...resources.skills, id] }); onDone(); }}>{resources.skills.includes(id) ? '已添加到本次对话' : '添加到本次对话'}</button></section>)}</div>}
  </div>;
}
export function ResourceChips({ resources, canShowPage, onChange }: { resources: ResourceDraft; canShowPage: (page: AssistantContext) => boolean; onChange: (value: ResourceDraft) => void }) {
  const chips = [
    ...resources.pages.filter(canShowPage).map(item => ({ key: 'page:' + item.id, Icon: FileText, title: item.title, image: item.kind === 'image', remove: () => onChange({ ...resources, pages: resources.pages.filter(value => value.id !== item.id) }) })),
    ...resources.skills.map(id => ({ key: 'skill:' + id, Icon: WandSparkles, title: demoSkills.find(item => item[0] === id)?.[1] || id, remove: () => onChange({ ...resources, skills: resources.skills.filter(value => value !== id) }) })),
    ...resources.images.map(name => ({ key: 'image:' + name, Icon: ImageIcon, title: name, remove: () => onChange({ ...resources, images: resources.images.filter(value => value !== name) }) })),
    ...(resources.url ? [{ key: 'url', Icon: Globe, title: resources.url, remove: () => onChange({ ...resources, url: '' }) }] : []),
  ];
  return !!chips.length && <div className="ha-resource-chips" aria-label="本次指定资料与技能">{chips.map(chip => <span key={chip.key}><chip.Icon size={15} aria-hidden="true"/><span>{chip.title}</span><button type="button" className="ha-chip-remove" aria-label={'移除 ' + chip.title} onClick={chip.remove}><X size={13}/></button></span>)}</div>;
}
