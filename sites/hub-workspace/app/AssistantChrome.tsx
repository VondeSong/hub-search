"use client";
import type { ReactNode } from 'react';

import { useState } from 'react';
import { AssistantOverlay } from './AssistantOverlay';
import { ChevronDown, Check, ChevronRight, FileText, FolderBookmark, Menu, MoreHorizontal, PanelRight, PanelsTopLeft, Plus, Tags, ShieldCheck, WandSparkles, X } from 'lucide-react';
import { AssistantHistory, type HistoryChange } from './AssistantHistory';
import { AssistantResources, type ResourceDraft } from './AssistantResources';
import { AssistantModels } from './AssistantModels';
import { AssistantDetails } from './AssistantDetails';
import { MemoryManageLink, MemorySettings } from './AssistantMemory';
import { memoryUseLabel } from './assistant-memory';
import type { AssistantContext, AssistantSettings } from './Assistant';

export type AssistantMenu = 'history' | 'details' | 'usage' | 'add' | 'materials' | 'skills' | 'permissions' | 'memory' | 'model' | 'effort' | 'mode' | 'topics' | 'topic-review' | 'tags' | 'tag-materials' | null;
export type HistoryItem = { id: string; title: string; messageCount: number; pinned: boolean; archived: boolean; blocked: boolean; updatedAt?: number };
type MenuProps = { menu: AssistantMenu; setMenu: (value: AssistantMenu) => void };

export function clampPanelSize(value: number, available: number, minimum: number, maximum: number) {
  const limit = Math.max(0, Math.min(maximum, available - 24));
  return Math.max(Math.min(minimum, limit), Math.min(limit, Math.round(value)));
}

function MenuHeading({ title, close }: { title: string; close: () => void }) {
  return <header className="ha-menu-heading"><strong>{title}</strong><button type="button" className="ha-icon" aria-label={'关闭' + title} onClick={close}><X size={16}/></button></header>;
}

export function AssistantHeader({ tagMode, goalMode, menu, setMenu, title, topicName, hasSkills, settings, setSettings, expanded, onExpand, onClose, history, currentId, onNew, onSelect, onHistoryChange, disabled, hasReport, reading, onReading, messageCount, materialCount, libraryCount, hasMaterials, taskStatus, modePanel, memoryPending, onManageMemory }: MenuProps & {
  memoryPending: number; onManageMemory: () => void; tagMode: boolean; goalMode?: boolean; title: string; topicName?: string; hasSkills: boolean; settings: AssistantSettings; setSettings: (value: AssistantSettings) => void;
  expanded: boolean; onExpand: () => void; onClose: () => void; disabled: boolean;
  history: HistoryItem[]; currentId: string; onNew: () => void; onSelect: (id: string) => void;
  onHistoryChange: (id: string, change: HistoryChange) => void; hasReport: boolean; reading: boolean; onReading: () => void; messageCount: number; materialCount: number; libraryCount: number; hasMaterials: boolean; taskStatus?: 'running' | 'paused'; modePanel: ReactNode;
}) {
  const toggle = (value: AssistantMenu) => setMenu(menu === value ? null : value);
  const modeLabel = tagMode ? '标签' : goalMode ? '目标' : topicName ? '专题' : '标准';
  return <header className="ha-header">
    <div className="ha-header-start"><button type="button" className="ha-icon" title="对话历史" aria-label="对话历史" aria-expanded={menu === 'history'} onClick={() => toggle('history')}><Menu size={18}/></button><button type="button" className="ha-icon" title="新对话" aria-label="新对话" disabled={disabled} onClick={onNew}><Plus size={19}/></button></div>
    <button type="button" className="ha-chat-title ha-mode-trigger" data-topic={!tagMode && !!topicName || undefined} title={tagMode ? '标签助手' : topicName ? '当前专题：' + topicName : title} aria-label={!tagMode && topicName ? '当前专题：' + topicName : '任务模式'} aria-description={'当前模式：' + modeLabel} aria-expanded={menu === 'mode' || menu === 'topics' || menu === 'topic-review'} onClick={() => setMenu(menu === 'mode' || menu === 'topics' || menu === 'topic-review' ? null : 'mode')}>{tagMode ? <Tags size={14} aria-hidden="true"/> : topicName && <FolderBookmark size={14} aria-hidden="true"/>}<span>{tagMode ? '标签助手' : topicName || title}</span><small className="ha-mode-label" aria-hidden="true">{modeLabel}</small><ChevronDown size={13}/></button>
    {modePanel}
    <div className="ha-header-end"><button type="button" className="ha-icon ha-layout-toggle" title={expanded ? '切换为浮窗' : '展开为侧边栏'} aria-label={expanded ? '切换为浮窗' : '展开为侧边栏'} onClick={() => { setMenu(null); onExpand(); }}>{expanded ? <PanelsTopLeft size={18} aria-hidden="true"/> : <PanelRight size={18} aria-hidden="true"/>}</button><button type="button" className="ha-icon" title="对话详情" aria-label="对话详情" aria-expanded={menu === 'details' || menu === 'usage'} onClick={() => setMenu(menu === 'details' || menu === 'usage' ? null : 'details')}><MoreHorizontal size={18}/></button><button type="button" className="ha-icon" title="关闭助手（Esc）" aria-label="关闭助手" onClick={onClose}><X size={19}/></button></div>
    {menu === 'history' && <AssistantHistory history={history} currentId={currentId} disabled={disabled} onSelect={onSelect} onChange={onHistoryChange} onClose={() => setMenu(null)}/>}
    {(menu === 'details' || menu === 'usage') && <AssistantDetails taskStatus={taskStatus} usageOpen={menu === 'usage'} settings={settings} setSettings={setSettings} disabled={disabled} hasReport={hasReport} reading={reading} onReading={onReading} onClose={() => setMenu(null)} messageCount={messageCount} materialCount={materialCount} libraryCount={libraryCount} hasMaterials={hasMaterials} memoryPending={memoryPending} onManageMemory={onManageMemory}/>}
  </header>;
}

export function AssistantTools({ menu, setMenu, settings, setSettings, material, onFiles, disabled, resources, onResources, materialPanel, scopeButton, skillPins, onPinSkill, memoryPending, onManageMemory }: MenuProps & {
  settings: AssistantSettings; setSettings: (value: AssistantSettings) => void;
  material: AssistantContext | null; memoryPending: number; onManageMemory: () => void;
  onFiles: () => void; materialPanel: ReactNode; scopeButton: ReactNode; skillPins: string[]; onPinSkill: (id: string) => void; disabled: boolean; resources: ResourceDraft; onResources: (value: ResourceDraft) => void;
}) {
  const toggle = (value: AssistantMenu) => setMenu(menu === value ? null : value);
  return <>
    <button type="button" className="ha-attach" aria-label="添加附件" title="添加附件" aria-expanded={menu === 'add'} onClick={() => toggle('add')}><Plus size={20}/></button>
    <button type="button" className="ha-attach ha-memory-trigger" aria-label={'记忆与保存：记忆' + (settings.researchPolicy === 'materials-only' ? '本轮不使用' : memoryUseLabel(settings.memoryEnabled, settings.memoryScope)) + '；' + (settings.autoFlashcardInbox && material?.kind === 'note' && material.libraryId === 'obsidian' ? '闪卡自动导入' : '保存前确认')} title={'记忆与保存 · ' + (settings.researchPolicy === 'materials-only' ? '本轮不使用记忆' : memoryUseLabel(settings.memoryEnabled, settings.memoryScope))} aria-expanded={menu === 'permissions'} data-memory-enabled={settings.memoryEnabled && settings.researchPolicy !== 'materials-only' || undefined} onClick={() => toggle('permissions')}><ShieldCheck size={18}/><span className="ha-memory-trigger-full">记忆与保存</span><span className="ha-memory-trigger-short">记忆</span></button>
    {scopeButton}
    <button type="button" className="ha-attach ha-skill-shortcut" aria-label="添加技能" title="添加技能" aria-expanded={menu === 'skills'} onClick={() => toggle('skills')}><WandSparkles size={17}/></button>
    {menu === 'materials' && materialPanel}
    <AssistantModels settings={settings} setSettings={setSettings} menu={menu} setMenu={setMenu} disabled={disabled}/>
    {menu === 'add' && <section className="ha-menu ha-composer-menu ha-add-menu ha-attachment-menu" aria-label="添加到本次对话">
      <MenuHeading title="添加到本次对话" close={() => setMenu(null)}/>
      <button type="button" className="ha-menu-choice" onClick={() => { setMenu(null); onFiles(); }}><FileText size={18}/><span><strong>添加图片或文件</strong><small>也可以直接拖入或粘贴到输入框</small></span><ChevronRight size={15}/></button>
      <button type="button" className="ha-menu-choice" onClick={() => setMenu('tags')}><Tags size={18}/><span><strong>添加标签</strong><small>引用标签参与讨论</small></span><ChevronRight size={15}/></button><p>资料库里的图片和文档可直接拖入。也可通过「资料范围」查找。</p>
    </section>}
    {menu === 'skills' && <AssistantOverlay title="技能" className="ha-composer-menu ha-skills-menu" bodyClassName="ha-skills-body" onClose={() => setMenu(null)} initialFocus='.ha-skills-search input' composerAnchored>
      <AssistantResources resources={resources} onChange={onResources} disabled={disabled} skillPins={skillPins} onPinSkill={onPinSkill} onDone={() => setMenu(null)}/>
    </AssistantOverlay>}
    {menu === 'permissions' && <Permissions settings={settings} setSettings={setSettings} disabled={disabled} canAuto={material?.kind === 'note' && material.libraryId === 'obsidian'} memoryPending={memoryPending} onManageMemory={onManageMemory} onClose={() => setMenu(null)}/>}
  </>;
}

function Permissions({ settings, setSettings, disabled, canAuto, memoryPending, onManageMemory, onClose }: { settings: AssistantSettings; setSettings: (value: AssistantSettings) => void; disabled: boolean; canAuto: boolean; memoryPending: number; onManageMemory: () => void; onClose: () => void }) {
  const [auto, setAuto] = useState(settings.autoFlashcardInbox);
  return <AssistantOverlay title="记忆与保存" className="ha-composer-menu ha-permissions-menu ha-memory-permissions" onClose={onClose} initialFocus=".ha-memory-switch input" composerAnchored footer={<><MemoryManageLink pending={memoryPending} onClick={onManageMemory}/><p className="ha-memory-save-note">交互示例 · 不读取真实记忆或保存成果</p></>}>
    <MemorySettings enabled={settings.memoryEnabled} scope={settings.memoryScope} blocked={disabled} materialsOnly={settings.researchPolicy === 'materials-only'} onChange={(memoryEnabled, memoryScope) => setSettings({ ...settings, memoryEnabled, memoryScope })}/>
    <section className="ha-memory-saving" aria-label="保存成果">
      <h3>保存成果</h3>
      {canAuto ? <>
        <button type="button" className="ha-menu-choice" disabled={disabled} aria-pressed={!auto} onClick={() => setAuto(false)}><span><strong>保存前确认</strong><small>先查看草稿，再确认保存。</small></span>{!auto && <Check size={16}/>}</button>
        <button type="button" className="ha-menu-choice" disabled={disabled} aria-pressed={auto} onClick={() => setAuto(true)}><span><strong>自动导入闪卡收件箱</strong><small>仅限本对话，仍需审核后才能复习。</small></span>{auto && <Check size={16}/>}</button>
        {auto !== settings.autoFlashcardInbox && <button type="button" className="ha-memory-auto-confirm" disabled={disabled} onClick={() => { setSettings({ ...settings, autoFlashcardInbox: auto }); onClose(); }}>{auto ? '确认本对话的自动导入授权' : '应用到本对话'}</button>}
      </> : <><div className="ha-memory-save-status"><span>保存前确认</span><Check size={16} aria-hidden="true"/></div><p>先查看草稿，再确认保存。</p></>}
    </section>
  </AssistantOverlay>;
}
