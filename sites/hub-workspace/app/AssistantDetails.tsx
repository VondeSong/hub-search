"use client";
import type { ReactNode } from 'react';
import { Activity, Brain, ChevronDown, Globe2, Layers, Maximize2, Minimize2, NotebookPen, X } from 'lucide-react';
import { researchPolicies } from './AssistantResearch';
import type { AssistantSettings } from './Assistant';

function DetailRow({ icon, title, status, children }: { icon: ReactNode; title: string; status?: string; children: ReactNode }) {
  return <details className="ha-detail-row">
    <summary><span className="ha-detail-icon" aria-hidden="true">{icon}</span><span className="ha-detail-title">{title}</span>{status && <small>{status}</small>}<ChevronDown className="ha-detail-caret" size={14} aria-hidden="true"/></summary>
    <div className="ha-detail-body">{children}</div>
  </details>;
}

export function AssistantDetails({ settings, setSettings, disabled, hasReport, reading, onReading, onClose, messageCount, materialCount, libraryCount, usageOpen = false, taskStatus }: {
  settings: AssistantSettings; setSettings: (value: AssistantSettings) => void; disabled: boolean; hasReport: boolean; reading: boolean; onReading: () => void; onClose: () => void; messageCount: number; materialCount: number; libraryCount: number; usageOpen?: boolean; taskStatus?: 'running' | 'paused';
}) {
  const progress = taskStatus === 'running' ? '正在处理' : taskStatus === 'paused' ? '已暂停' : hasReport ? '回答已生成' : '尚未开始';
  const scope = [materialCount ? materialCount + ' 份资料' : '', libraryCount ? libraryCount + ' 个库' : ''].filter(Boolean).join(' · ') || '未选资料';
  const policy = researchPolicies.find(item => item.id === settings.researchPolicy) || researchPolicies[0];
  const taskDetails = <dl className="ha-detail-facts" aria-live="polite">
    <div><dt>任务进展</dt><dd>{progress}</dd></div>
    <div><dt>对话消息</dt><dd>{messageCount} 条</dd></div>
    <div><dt>上下文占用</dt><dd>原型未提供数据</dd></div>
  </dl>;
  return <section className={'ha-menu ha-header-menu ha-details' + (usageOpen ? ' ha-task-status-panel' : '')} aria-label={usageOpen ? '任务状态' : '对话详情'}>
    <header className="ha-menu-heading"><strong>{usageOpen ? '任务状态' : '对话详情'}</strong><button type="button" className="ha-icon" aria-label={usageOpen ? '关闭任务状态' : '关闭对话详情'} onClick={onClose}><X size={16}/></button></header>
    {usageOpen ? <div className="ha-detail-standalone">{taskDetails}</div> : <>
      {hasReport && <section className="ha-detail-section ha-detail-reading" aria-label="阅读">
        <div className="ha-detail-actions"><button type="button" disabled={disabled} aria-pressed={reading} onClick={() => { onReading(); onClose(); }}>{reading ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}<span>{reading ? '返回对话布局' : '只看最新回答'}</span></button></div>
      </section>}
      <section className="ha-detail-section" aria-label="资料与工具"><h3>资料与工具</h3>
        <DetailRow icon={<Layers size={16}/>} title="资料范围" status={scope}>
          <dl className="ha-detail-facts ha-detail-scope"><div><dt>资料策略</dt><dd>{policy.name}</dd></div><div><dt>选定范围</dt><dd>{scope}</dd></div></dl>
          <p>在输入框底部调整。浏览页面不会自动加入。</p>
        </DetailRow>
        <DetailRow icon={<Globe2 size={16}/>} title="联网与工具" status={settings.researchPolicy === 'materials-only' ? '不联网' : '按资料策略'}>
          <AssistantConnection settings={settings}/>
        </DetailRow>
        <DetailRow icon={<Brain size={16}/>} title="共享记忆" status={settings.memoryEnabled ? '已启用' : '未启用'}>
          <label className="ha-detail-setting"><span>下一轮使用共享记忆</span><input type="checkbox" disabled={disabled} checked={settings.memoryEnabled} onChange={event => setSettings({ ...settings, memoryEnabled: event.target.checked })}/></label>
          <label className="ha-detail-setting"><span>记忆范围</span><select aria-label="本事项的记忆范围" value={settings.memoryScope} disabled={disabled} onChange={event => setSettings({ ...settings, memoryScope: event.target.value })}><option value="general">通用 · 示例</option><option value="hub">Hub 原型 · 示例</option></select></label>
          <p>此处保存原型偏好，不读取或修改本地共享记忆。</p>
        </DetailRow>
      </section>
      <section className="ha-detail-section" aria-label="进度与成果"><h3>进度与成果</h3>
        <DetailRow icon={<Activity size={16}/>} title="任务状态" status={progress}>{taskDetails}</DetailRow>
        <DetailRow icon={<NotebookPen size={16}/>} title="成果与保存">
          <p>可从回答下方插入页面、创建笔记或任务。保存前可以查看并修改草稿。</p>
        </DetailRow>
      </section>
    </>}
  </section>;
}

function AssistantConnection({ settings }: { settings: AssistantSettings }) {
  const web = settings.researchPolicy === 'materials-only' ? '只用本轮材料，不搜索网页或读取链接。'
    : settings.model === 'deepseek' ? 'DeepSeek 不支持联网搜索。'
    : settings.researchPolicy === 'open' ? '可按问题查询公开来源。' : '优先使用材料，有需要再补充网页。';
  return <><dl className="ha-detail-facts ha-detail-connections">
    <div><dt>网页补充</dt><dd>{web}</dd></div>
    <div><dt>内置工具</dt><dd>遵循资料范围和保存权限。</dd></div>
    <div><dt>外部工具（MCP）</dt><dd>由桌面端按对话配置。</dd></div>
  </dl><p>站点原型不实际联网或连接外部服务。</p></>;
}
