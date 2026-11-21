"use client";
import { useState } from 'react';
import {AssistantFileDelivery} from './AssistantDataMaterials';
import type { ReactNode } from 'react';
import { Activity, Brain, ChevronDown, Globe2, Layers, Maximize2, Minimize2, NotebookPen, X } from 'lucide-react';
import { researchPolicies } from './AssistantResearch';
import type { AssistantSettings } from './Assistant';
import {AssistantNativeConnections} from './AssistantNativeConnections';

function DetailRow({ icon, title, status, children }: { icon: ReactNode; title: string; status?: string; children: ReactNode }) {
  return <details className="ha-detail-row">
    <summary><span className="ha-detail-icon" aria-hidden="true">{icon}</span><span className="ha-detail-title">{title}</span>{status && <small>{status}</small>}<ChevronDown className="ha-detail-caret" size={14} aria-hidden="true"/></summary>
    <div className="ha-detail-body">{children}</div>
  </details>;
}

export function AssistantDetails({ settings, setSettings, disabled, hasReport, reading, onReading, onClose, messageCount, materialCount, libraryCount, hasMaterials, usageOpen = false, taskStatus, memoryPending, onManageMemory }: {
  memoryPending: number; onManageMemory: () => void; settings: AssistantSettings; setSettings: (value: AssistantSettings) => void; disabled: boolean; hasReport: boolean; reading: boolean; onReading: () => void; onClose: () => void; messageCount: number; materialCount: number; libraryCount: number; hasMaterials: boolean; usageOpen?: boolean; taskStatus?: 'running' | 'paused';
}) {
  const [review, setReview] = useState(false);
  const [frequency, setFrequency] = useState('weekly');
  const [firstRun, setFirstRun] = useState('');
  const [scheduled, setScheduled] = useState(false);
  const progress = taskStatus === 'running' ? '正在处理' : taskStatus === 'paused' ? '已暂停' : hasReport ? '回答已生成' : '尚未开始';
  const scope = [materialCount ? materialCount + ' 份资料' : '', libraryCount ? libraryCount + ' 个库' : ''].filter(Boolean).join(' · ') || '未选资料';
  const policy = researchPolicies.find(item => item.id === settings.researchPolicy) || researchPolicies[0];
  const materialsOnly = settings.researchPolicy === 'materials-only';
  const searchBlocked = materialsOnly || settings.model === 'deepseek';
  const searchNames = { disabled: '关闭', cached: '缓存搜索', live: '实时搜索' };
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
          {hasMaterials || materialsOnly ? <p>{materialsOnly && !hasMaterials ? '请添加资料，或切换为普通提问。' : policy.name}</p> : null}
          <p>从输入框底部添加页面或资料库。</p>
        </DetailRow>
        <DetailRow icon={<Globe2 size={16}/>} title="联网与工具" status={materialsOnly ? '只用所选资料' : settings.model === 'deepseek' ? '搜索不可用' : searchNames[settings.webSearch]}>
          <label className="ha-detail-setting"><span>联网搜索</span><select value={searchBlocked ? 'disabled' : settings.webSearch} disabled={disabled || searchBlocked} onChange={event => setSettings({ ...settings, webSearch: event.target.value as AssistantSettings['webSearch'] })}>
            <option value="disabled">关闭</option><option value="cached">缓存搜索</option><option value="live">实时搜索</option>
          </select></label>
          {searchBlocked && <p>{materialsOnly ? '当前对话只使用所选资料。' : 'DeepSeek 模式下网页搜索不可用。'}</p>}
          <details className="ha-connection-group"><summary>外部工具（MCP）</summary><AssistantNativeConnections disabled={disabled || searchBlocked}/></details>
          <details className="ha-connection-group"><summary>执行与协作</summary>
            <label className="ha-detail-setting"><span>分工复核资料</span><input type="checkbox" checked={review} disabled={disabled || settings.model === 'deepseek'} onChange={event => setReview(event.target.checked)}/></label>
            <p>两位助手分头阅读已选资料，并独立核对共同的重点。当前设置为原型示例。</p>
          </details>
          <details className="ha-connection-group"><summary>开发者诊断{settings.externalMcp && <small>通过 MCP 调用</small>}</summary>
            <label className="ha-detail-setting"><span>Hub 工具调用方式</span><select value={settings.externalMcp ? 'mcp' : 'direct'} disabled={disabled || settings.model === 'deepseek'} onChange={event => setSettings({ ...settings, externalMcp: event.target.value === 'mcp' })}>
              <option value="direct">直接调用（默认）</option><option value="mcp">通过 MCP 调用</option>
            </select></label>
            <p>两种方式使用相同的资料范围和保存权限。MCP 用于检查工具调用。</p>
          </details>
          <p>此处演示设置，搜索和工具调用由桌面端执行。</p>
        </DetailRow>
        <button type="button" className="ha-detail-memory-link" onClick={onManageMemory}><span className="ha-detail-icon" aria-hidden="true"><Brain size={16}/></span><span>管理记忆</span>{memoryPending > 0 && <small>{memoryPending} 条待确认</small>}<ChevronDown size={14} aria-hidden="true" style={{ transform: 'rotate(-90deg)' }}/></button>
      </section>
      <section className="ha-detail-section" aria-label="进度与成果"><h3>进度与成果</h3>
        <DetailRow icon={<Activity size={16}/>} title="任务状态" status={progress}>{taskDetails}</DetailRow>
        {hasReport && <DetailRow icon={<Activity size={16}/>} title="定时复查" status={scheduled ? '已安排 · 示例' : '未启用'}>
          <label className="ha-detail-setting"><span>复查频率</span><select value={frequency} disabled={disabled || scheduled} onChange={event => setFrequency(event.target.value)}><option value="daily">每天</option><option value="weekly">每周</option></select></label>
          <label className="ha-detail-setting"><span>首次运行</span><input type="datetime-local" value={firstRun} disabled={disabled || scheduled} onChange={event => setFirstRun(event.target.value)}/></label>
          <p>Windows 上的 Hub 运行时，可以定期检查已授权的资料库。这里可预览设置。</p>
          <button type="button" disabled={disabled || (!firstRun && !scheduled)} onClick={() => setScheduled(!scheduled)}>{scheduled ? '暂停复查' : '启用定时复查'}</button>
        </DetailRow>}
        <DetailRow icon={<NotebookPen size={16}/>} title="成果与保存">
          <p>可从回答下方插入页面、创建笔记或任务。保存前可以查看并修改草稿。</p><AssistantFileDelivery/>
        </DetailRow>
      </section>
    </>}
  </section>;
}
