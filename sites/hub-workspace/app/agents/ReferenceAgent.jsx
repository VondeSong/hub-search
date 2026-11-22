'use client';

import { useEffect, useState } from 'react';
import { tagPrompt } from '../tag-assistant';
import { runWorkspaceTagReview, tagDiscussionContext, tagWorkspaceLibraries, tagWorkspaceMaterials } from './workspace-context';

const tagActions = { draft: 'definition', find: 'missing', compare: 'relation' };
const currentLabels = { document: '当前页', task: '当前任务', insight: '当前洞察', tag: '当前标签' };

// 统一线框图标组件（严格遵守 JSX Fragment 包裹多标签）
function Icon({ name, className = 'w-4 h-4', strokeWidth = 1.75 }) {
  const icons = {
    sliders: <><line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2" fill="currentColor" /><line x1="4" y1="17" x2="20" y2="17" /><circle cx="15" cy="17" r="2" fill="currentColor" /></>,
    dockRight: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><line x1="14" y1="4" x2="14" y2="20" /></>,
    floatWindow: <><rect x="3" y="4" width="18" height="16" rx="2.5" opacity="0.35" /><rect x="11" y="7" width="8" height="10" rx="1.5" /></>,
    maximize: <><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>,
    user: <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
    lock: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
    menu: <><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="14" y2="17" /></>,
    plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
    x: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
    chevronDown: <polyline points="6 9 12 15 18 9" />,
    chevronRight: <polyline points="9 18 15 12 9 6" />,
    arrowUp: <><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></>,
    arrowLeft: <><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></>,
    check: <polyline points="20 6 9 17 4 12" />,
    search: <><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>,
    sparkles: <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3zM5 17l.9 2.1L8 20l-2.1.9L5 23l-.9-2.1L2 20l2.1-.9L5 17z" />,
    target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" /></>,
    tag: <><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></>,
    bookmark: <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
    layers: <><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></>,
    panelRight: <><rect x="3" y="3" width="18" height="18" rx="3" /><line x1="15" y1="3" x2="15" y2="21" /></>,
    zap: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
    brain: <><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" /><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><line x1="3" y1="12" x2="21" y2="12" /><path d="M12 3a14 14 0 0 1 3.5 9 14 14 0 0 1-3.5 9 14 14 0 0 1-3.5-9A14 14 0 0 1 12 3z" /></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" /><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></>,
    fileText: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></>,
    code: <><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>,
    video: <><rect x="2" y="6" width="14" height="12" rx="2" /><polygon points="16 10 22 7 22 17 16 14 16 10" /></>,
    audio: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></>,
    checkSquare: <><rect x="3" y="3" width="18" height="18" rx="3" /><polyline points="9 12 11 14 15 10" /></>,
    copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    moreHorizontal: <><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></>,
    pin: <><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 1 1-1h1V3H7v2h1a1 1 0 0 1 1 1z" /></>,
    trash: <><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></>,
    externalLink: <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></>,
    alertCircle: <><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>,
    refresh: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M3 21v-5h5" /></>,
    folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />,
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>,
    flag: <><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></>,
    fileSearch: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><circle cx="11" cy="14" r="2.5" /><line x1="13" y1="16" x2="15" y2="18" /></>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    wrench: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
    alertTriangle: <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
    play: <polygon points="5 3 19 12 5 21 5 3" />
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
      {icons[name] || null}
    </svg>
  );
}

// Apple 原生风格 Toggle Switch
function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${checked ? 'bg-primary' : 'bg-black/15'}`}
    >
      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition duration-200 ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  );
}

// 极简厂商图标（14px 单色/低饱和，让底栏只需显示紧凑型号短名）
function VendorIcon({ vendor, className = 'w-3.5 h-3.5' }) {
  if (vendor === 'DeepSeek') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={`${className} text-sky-600 shrink-0`}>
        <path d="M3.5 13.2C5.2 9.2 9.4 7 13.8 7.6c2.6.35 4.8 1.6 6.2 3.3-1.4.4-2.5 1.1-3.2 2.1.9.3 2 .3 3.1-.1-.9 2.6-3.7 4.6-7.6 4.6-4.1 0-7.2-1.8-8.8-4.3Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="14.2" cy="11.2" r="1" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`${className} text-primary shrink-0`}>
      <path d="M12 3.5a4.2 4.2 0 0 1 3.7 2.2l2.1 1.2a4.2 4.2 0 0 1 1.5 5.7 4.2 4.2 0 0 1-1.5 5.7l-2.1 1.2a4.2 4.2 0 0 1-7.4 0l-2.1-1.2a4.2 4.2 0 0 1-1.5-5.7 4.2 4.2 0 0 1 1.5-5.7l2.1-1.2A4.2 4.2 0 0 1 12 3.5Z" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

// 思维链微缩站点图标（替代笨重的纯文字灰框，悬停显示站点名）
function SiteFavicon({ site }) {
  const configs = {
    W3C: {
      title: 'W3C 标准文档 (w3.org)',
      bg: 'bg-[#005A9C] text-white',
      content: <span className="text-[7px] font-bold tracking-tighter leading-none">W3</span>
    },
    MDN: {
      title: 'MDN Web Docs (developer.mozilla.org)',
      bg: 'bg-[#1B1B1B] text-white',
      content: (
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="currentColor">
          <path d="M2.5 12.5V3.5h1.8l2.2 4.8 2.2-4.8h1.8v9H9V6.7L6.9 11h-.8L4 6.7v5.8H2.5zm9.5 0V3.5h1.5v9H12z" />
        </svg>
      )
    },
    WAI: {
      title: 'W3C WAI 无障碍指南',
      bg: 'bg-[#0E7490] text-white',
      content: (
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="8" cy="4.2" r="1.4" fill="currentColor" stroke="none" />
          <path d="M4.2 6.8h7.6M8 6.8v3.2m0 0l-2 3.2m2-3.2l2 3.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    },
    WHATWG: {
      title: 'WHATWG HTML Living Standard',
      bg: 'bg-[#2E7D32] text-white',
      content: (
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="5" />
          <path d="M5.5 8l1.6 1.6L10.5 6.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    },
    Hub: {
      title: 'Hub 本地知识库与任务工具',
      bg: 'bg-primary text-white',
      content: <span className="text-[8px] font-bold leading-none">H</span>
    }
  };
  const cfg = configs[site] || { title: site, bg: 'bg-subtle text-secondary', content: <span className="text-[7px] font-bold">{site.slice(0, 2)}</span> };
  return (
    <span
      title={cfg.title}
      className={`w-[18px] h-[18px] rounded-[5px] ${cfg.bg} ring-1 ring-surface inline-flex items-center justify-center shrink-0 shadow-2xs`}
    >
      {cfg.content}
    </span>
  );
}

// 渲染行内等宽代码片段（把 `code` 转成精致芯片）
function InlineCodeText({ text }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code key={i} className="mx-0.5 px-1.5 py-0.2 rounded-md bg-subtle border border-border font-mono text-[11.5px] text-primary">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

// 模拟高保真缩略图内容（避免外部图片失效）
function ThumbArtwork({ kind, large = false }) {
  if (kind === 'terminal') {
    return (
      <div className="w-full h-full bg-[#18181B] flex flex-col justify-center p-2 font-mono text-[6px] leading-tight text-emerald-400/90 select-none">
        <div className={large ? 'text-xs space-y-1.5 p-4' : 'space-y-0.5'}>
          <div className="text-zinc-400">$ hub verify --stream --aria</div>
          <div>✓ aria-live="polite" status verified</div>
          <div>✓ scroll-anchor preserved on toggle</div>
          <div className="text-sky-400">→ 15 desktop checks generated</div>
        </div>
      </div>
    );
  }
  return (
    <div className="w-full h-full bg-[#F8F7F4] flex items-center justify-center p-2">
      <svg viewBox="0 0 120 120" className={large ? 'w-56 h-56' : 'w-full h-full'}>
        <path d="M22 98 C24 62, 42 36, 70 36 C88 36, 98 46, 98 60 C98 70, 90 74, 80 76 C78 85, 82 94, 86 98" fill="none" stroke="#27272A" strokeWidth="3.2" strokeLinecap="round" />
        <circle cx="72" cy="54" r="2.8" fill="#27272A" />
        <path d="M88 61 C92 62, 95 60, 96 58" fill="none" stroke="#27272A" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M48 39 C46 31, 54 29, 57 36" fill="none" stroke="#27272A" strokeWidth="2.8" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export default function ReferenceAgent({ onDismiss, workspaceContext, tagWorkspace, onOpenTagQueue, onOpenDemos, onLayoutChange, open }) {
  // 1. 视口宽度模式：'sidebar' (480px) | 'focus' (760px) | 'full'
  const [viewportMode, setViewportMode] = useState('focus');
  const [layout, setLayout] = useState('expanded');
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  // 示例场景切换：'report' (正常流式复核报告) | 'interrupted' (图2规则加载 + 图3核验中断重构案例)
  const [activeCase, setActiveCase] = useState(workspaceContext ? 'new' : 'report');
  const [newMessages, setNewMessages] = useState([]);

  // 2. 顶部与模式状态
  const [threadTitle, setThreadTitle] = useState(workspaceContext?.name ?? 'Hub 助手工作过程和展示方案');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [taskMode, setTaskMode] = useState(tagWorkspace ? 'tag' : 'standard'); // 'standard' | 'goal' | 'tag' | 'topic'
  const [tagSubTab, setTagSubTab] = useState(
    Object.keys(tagActions).find(key => tagActions[key] === workspaceContext?.tagTask?.intent) || 'draft'
  ); // 'draft' | 'find' | 'compare'
  const [targetTag, setTargetTag] = useState(workspaceContext?.tag || '');
  const [compareTag, setCompareTag] = useState(workspaceContext?.tagTask?.other || '');
  const [tagPickerSlot, setTagPickerSlot] = useState(null); // null | 'target' | 'compare'
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const [goalText, setGoalText] = useState(workspaceContext ? '' : '核对流式状态与工作过程规范，输出 15 条桌面测试项');
  const [pauseOnBlocker, setPauseOnBlocker] = useState(true);

  // 3. 专题系统（支持置顶、搜索与自定义保存）
  const [topics, setTopics] = useState([
    { id: 't1', name: 'OS 标签与原文核对', strategy: 'only', docs: ['d1', 'd3'], libs: ['OS'], pinned: true },
    { id: 't2', name: '折腾记录单页核对', strategy: 'only', docs: ['d1'], libs: [], pinned: true },
    { id: 't3', name: 'DXF 线表与工程资料', strategy: 'prefer', docs: ['d2'], libs: ['Car', 'OS'], pinned: false }
  ]);
  const [activeTopicId, setActiveTopicId] = useState(null);
  const [modePopoverOpen, setModePopoverOpen] = useState(false);
  const [modePopoverView, setModePopoverView] = useState('main'); // 'main' | 'allTopics'
  const [topicSearch, setTopicSearch] = useState('');

  // 4. 抽屉与浮层开关
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [scopeModalOpen, setScopeModalOpen] = useState(false);
  const [scopeTab, setScopeTab] = useState('docs'); // 'docs' | 'libs' | 'strategy'
  const [docSearchQuery, setDocSearchQuery] = useState('');
  const [docFilterMode, setDocFilterMode] = useState('all'); // 'all' | 'selected'
  const [fixedChecklistCheck, setFixedChecklistCheck] = useState(false);
  const [savingTopicMode, setSavingTopicMode] = useState(false);
  const [newTopicName, setNewTopicName] = useState('');
  const [skillsPopoverOpen, setSkillsPopoverOpen] = useState(false);
  const [skillsDetailView, setSkillsDetailView] = useState(null);
  const [skillsManagerOpen, setSkillsManagerOpen] = useState(false);
  const [skillsManagerTab, setSkillsManagerTab] = useState('all'); // 'all' | 'local' | 'package'
  const [codexSyncEnabled, setCodexSyncEnabled] = useState(true);
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const [memorySheetOpen, setMemorySheetOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [sourcesModalOpen, setSourcesModalOpen] = useState(false);
  const [sourcesSearch, setSourcesSearch] = useState('');
  const [saveNoteModalOpen, setSaveNoteModalOpen] = useState(false);
  const [saveNoteTab, setSaveNoteTab] = useState('append'); // 'append' | 'new'
  const [saveNoteTarget, setSaveNoteTarget] = useState(workspaceContext?.name ?? '2023-02-02');
  const [saveNoteTitle, setSaveNoteTitle] = useState(workspaceContext?.name ?? 'Hub 桌面助手｜流式状态与工作过程证据复核');
  const [createTaskModalOpen, setCreateTaskModalOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState(workspaceContext ? `跟进：${workspaceContext.name}` : '验证 Hub 桌面助手流式状态与 15 项可访问性用例');
  const [taskList, setTaskList] = useState('收件箱');
  const [taskDue, setTaskDue] = useState('明天');
  const [taskPriority, setTaskPriority] = useState('高');
  const [taskAttachReport, setTaskAttachReport] = useState(false);
  const [taskSubItems, setTaskSubItems] = useState(workspaceContext ? [] : [
    { id: 'st1', text: '将回执列表改为普通列表 + 独立 status 播报区', checked: true },
    { id: 'st2', text: '实测展开旧回执后，新内容到达不跳动视口与焦点', checked: true },
    { id: 'st3', text: '验证「回到最新」按钮在 reduced-motion 下的滚动行为', checked: true }
  ]);

  // 5. 视图与诊断偏好
  const [onlyLatestReply, setOnlyLatestReply] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(!workspaceContext);
  const [mcpEnabled, setMcpEnabled] = useState(!workspaceContext);
  const [diagExpanded, setDiagExpanded] = useState(false);

  const [codexAccounts, setCodexAccounts] = useState([
    { id: 'follow', type: 'follow', label: '跟随 Codex 桌面登录', email: 'p***@example.test', plan: 'Plus', workspace: '个人', status: 'active' },
    { id: 'acc_work', type: 'account', label: 'w***@example.test', email: 'w***@example.test', plan: 'Pro', workspace: '工作空间', status: 'active' },
    { id: 'acc_expired', type: 'account', label: 'dev***@example.test', email: 'dev***@example.test', plan: 'Team', workspace: '外包协作', status: 'expired' }
  ]);
  const [activeAccountId, setActiveAccountId] = useState('follow');
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);
  const [pendingSwitchId, setPendingSwitchId] = useState(null);
  const [switchStrategy, setSwitchStrategy] = useState('continue'); // 'continue' | 'new'
  const [accountSwitchedBanner, setAccountSwitchedBanner] = useState(null);
  const [chatAuthNeeded, setChatAuthNeeded] = useState(false);
  const [oauthFlow, setOauthFlow] = useState('idle'); // 'idle' | 'pending' | 'ready'
  const [newlyAddedAccId, setNewlyAddedAccId] = useState(null);

  // 6. 模型、资料范围、记忆、技能与附件状态
  const [selectedModel, setSelectedModel] = useState('DeepSeek V4.1 Flash');
  const [reasoningLevel, setReasoningLevel] = useState('high'); // 'low' | 'medium' | 'high'
  const [responseSpeed, setResponseSpeed] = useState('standard'); // 'standard' | 'fast'
  const [retrievalStrategy, setRetrievalStrategy] = useState(workspaceContext ? 'only' : 'prefer'); // 'prefer' | 'only'
  const primaryMaterial = tagWorkspace
    ? targetTag && { ...tagDiscussionContext(targetTag, undefined, tagWorkspace), id: workspaceContext.id }
    : workspaceContext;
  const documentId = primaryMaterial?.id;
  const evidence = workspaceContext?.evidence || [];
  const [selectedDocs, setSelectedDocs] = useState(workspaceContext
    ? [...(documentId ? [documentId] : []), ...evidence.map(item => item.id)]
    : ['d1', 'd2']);
  const [selectedLibs, setSelectedLibs] = useState(workspaceContext
    ? workspaceContext.tagTask?.libraries || []
    : ['Car']);
  const [memoryActive, setMemoryActive] = useState(!workspaceContext);

  useEffect(() => {
    if (open && documentId) {
      setSelectedDocs(docs => docs.includes(documentId) ? docs : [documentId, ...docs]);
    }
  }, [open, documentId]);
  const [memoryScope, setMemoryScope] = useState('工程资料整理');
  const [memoryTab, setMemoryTab] = useState('saved'); // 'saved' | 'pending'
  const [memoryDiffExpanded, setMemoryDiffExpanded] = useState(true);
  const [memorySourceExpanded, setMemorySourceExpanded] = useState(false);
  const [memoryItems, setMemoryItems] = useState([
    {
      id: 'mem1',
      scope: '工程资料整理',
      title: '工程资料整理时的事实与建议边界',
      version: '第 2 版',
      updatedAt: '2026/11/15 13:31',
      content: '整理工程资料时，区分方法建议、原始问题和已核对的事实；没有实际操作记录，不声称已迁移。工程文件已归档或 Craft 范围已覆盖，补充：PARA 的 Archives 与工程交付物的归档，语义不是同一回事，应按照材料所属状态的语义拆分。',
      diffOld: '工程文件已归档或 Craft 范围已覆盖。',
      diffNew: '补充：PARA 的 Archives 与工程交付物的归档，语义不是同一回事，不因为都叫“归档”就混在一起。',
      sourceId: '示例工作 · 资料复核',
      enabled: true
    }
  ]);
  const [addingMemory, setAddingMemory] = useState(false);
  const [newMemoryTitle, setNewMemoryTitle] = useState('');
  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [editingMemoryId, setEditingMemoryId] = useState(null);
  const [editingMemoryText, setEditingMemoryText] = useState('');

  const [uploadError, setUploadError] = useState(workspaceContext ? null : {
    fileName: '会话示例录音.flac',
    size: '34.2 MB',
    limit: '10 MB'
  });
  const [attachedSkills, setAttachedSkills] = useState(workspaceContext ? [] : ['阅读材料归档']);
  const [attachedLocalFiles, setAttachedLocalFiles] = useState(workspaceContext ? [] : [
    { id: 'f1', name: '初步策略', type: 'task' },
    { id: 'f2', name: 'codex2.mp4', type: 'video' },
    { id: 'f3', name: 'style.css', type: 'code' },
    { id: 'f4', name: 'index.html', type: 'code' },
    { id: 'f5', name: '扭矩扳手量具操作指导书2025(1).pdf', type: 'pdf' }
  ]);
  const [expandAllFiles, setExpandAllFiles] = useState(false);
  const [attachedImages, setAttachedImages] = useState(workspaceContext ? [] : [
    { id: 'img1', name: 'image.png', size: '248 KB', kind: 'terminal' },
    { id: 'img2', name: 'unnamed.jpg', size: '182 KB', kind: 'sketch' }
  ]);
  const [previewImage, setPreviewImage] = useState(null);

  const [inputText, setInputText] = useState('');
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

  // 7. 思维链折叠状态、技术记录与草稿预览展开
  const [timelineOpenMap, setTimelineOpenMap] = useState({ m2: true, c2_m2: true });
  const [toolGroupOpenMap, setToolGroupOpenMap] = useState({ 'm2-ctx': false, 'm2-g1': true, 'm2-g2': false, 'm2-g3': false, 'c2-ctx': true, 'c2-g1': true });
  const [techLogOpenMap, setTechLogOpenMap] = useState({ 'c2-step-err': false });
  const [draftPreviewOpenMap, setDraftPreviewOpenMap] = useState({ c2_m2: false });
  const [checklistExpanded, setChecklistExpanded] = useState(false);

  // 8. 历史会话
  const [historyList, setHistoryList] = useState([
    { id: 'h1', caseKey: 'report', title: 'Hub 助手工作过程和展示方案', time: '3 小时前', pinned: true },
    { id: 'h2', caseKey: 'interrupted', title: '找一下我最近的任务，帮我安排一下', time: '刚刚', pinned: true },
    { id: 'h3', caseKey: 'report', title: '根据摘要，哪三个 PowerShell 分数最高', time: '5 小时前', pinned: false },
    { id: 'h4', caseKey: 'report', title: '当前 Hub 助手是否支持联网能力？', time: '6 小时前', pinned: false }
  ]);

  // 9. Hub & Codex 通用技能库
  const [managedSkills, setManagedSkills] = useState([
    { id: 'sk1', name: '阅读材料归档', desc: '提炼结构化摘要，为原始材料补全标签和归档建议。', file: 'SKILL.md', kind: 'local', shared: true, enabled: true, version: '本地' },
    { id: 'sk2', name: 'record-to-log', desc: '将零散工作记录按时间线归档为结构化日志与状态复盘。', file: 'record-to-log/SKILL.md', kind: 'package', shared: true, enabled: true, version: '登记第5版' },
    { id: 'sk3', name: '工程问题 RCA 分析', desc: '根据根因分析框架拆解线束干涉或短路案例。', file: 'rca-analysis/SKILL.md', kind: 'local', shared: true, enabled: true, version: '本地' },
    { id: 'sk4', name: '线表字段核对与映射', desc: '自动核对 DXF Pin 脚定义、线径规格与差异项。', file: 'wire-table/SKILL.md', kind: 'package', shared: true, enabled: true, version: 'v2.1' },
    { id: 'sk5', name: '会议纪要提炼行动', desc: '从非结构化文字中抽离 Action Items 与责任人。', file: 'meeting-extract/SKILL.md', kind: 'local', shared: false, enabled: false, version: '本地' }
  ]);

  // 10. 示例对话流（包含完整的 Codex 公开思维链 + 结构化复核报告）
  const [messages, setMessages] = useState([
    {
      id: 'm1',
      role: 'user',
      time: '18:05',
      text: '请为 Hub 桌面助手做一份「流式状态与工作过程证据复核」。把三个实现取舍逐项查清：一、连续进展和工具回执怎么播报；二、展开回执后的滚动锚定与焦点维持；三、回到最新按钮与减少动态效果偏好。最后整理成 15 条桌面测试项。'
    },
    {
      id: 'm2',
      role: 'assistant',
      duration: '4 分 7 秒',
      hasWebSources: true,
      timeline: [
        {
          type: 'contextPrep',
          id: 'm2-ctx',
          summary: '已载入上下文 · 1 份材料 · 1 条规则',
          items: [
            { kind: 'doc', name: '仪表线束评审待查清单', meta: '飞书 / Obsidian' },
            { kind: 'rule', name: 'OS 知识库工作规则', file: 'AGENTS.md', hash: '示例版', fullPath: '示例库 / AGENTS.md' }
          ]
        },
        {
          type: 'thought',
          text: '我会分三轮核对公开原文，依次查播报语义、展开回执后的滚动与焦点，以及回到最新与减少动态效果。每轮核对后会简短汇报，再把结论整理成 15 条桌面测试。'
        },
        {
          type: 'toolGroup',
          id: 'm2-g1',
          title: '网页检索 · 5 步',
          badges: ['W3C', 'MDN', 'WAI'],
          steps: [
            { icon: 'search', label: '搜索网页', detail: 'site:w3.org WAI ARIA Recommendation log status implicit aria-live polite aria-atomic', extra: '另 2 条查询' },
            { icon: 'globe', label: '网页操作', detail: '打开 WAI-ARIA 1.2 Role Definitions' },
            { icon: 'fileSearch', label: '在网页内查找', detail: 'new information is added in meaningful order' },
            { icon: 'globe', label: '网页操作', detail: '对照 MDN ARIA: status role 说明' },
            { type: 'status', text: 'Preparing atomic reference check' },
            { icon: 'fileSearch', label: '在网页内查找', detail: 'have an implicit `aria-atomic` value of `false`' }
          ]
        },
        {
          type: 'thought',
          text: '第一轮查明了两种角色的默认行为。`log` 适合按顺序追加、需要逐条通知的事件，`status` 适合简短的当前状态。Hub 的回执可以保留为普通列表，由一处状态区播报关键变化。接下来核对回执展开后，滚动位置和键盘焦点各由什么机制维持。'
        },
        {
          type: 'toolGroup',
          id: 'm2-g2',
          title: '网页检索 · 4 步',
          badges: ['WHATWG', 'MDN'],
          steps: [
            { icon: 'search', label: '搜索网页', detail: 'CSS Scroll Anchoring overflow-anchor details summary focus preservation', extra: '另 1 条查询' },
            { icon: 'globe', label: '网页操作', detail: '打开 WHATWG HTML The details element' },
            { icon: 'fileSearch', label: '在网页内查找', detail: 'scroll anchoring adjusts the scroll position' },
            { icon: 'globe', label: '网页操作', detail: '核对 MDN Keyboard focus management' }
          ]
        },
        {
          type: 'thought',
          text: '第二轮确认了两个边界。原生 `summary` 负责切换展开状态，浏览器的滚动锚定只在符合条件时补偿布局变化。新回执、首段答案和完成事件到达时，Hub 仍需保留现有回执节点，并维持视口与焦点。接下来核对用户主动回到最新时的按钮行为和动效。'
        },
        {
          type: 'toolGroup',
          id: 'm2-g3',
          title: '网页检索 · 6 步',
          badges: ['W3C', 'MDN'],
          steps: [
            { icon: 'search', label: '搜索网页', detail: 'prefers-reduced-motion scroll-behavior smooth vs auto accessibility', extra: '另 3 条查询' },
            { icon: 'globe', label: '网页操作', detail: '打开 MDN prefers-reduced-motion' },
            { icon: 'fileSearch', label: '在网页内查找', detail: 'reduced motion should disable smooth scrolling' }
          ]
        },
        {
          type: 'thought',
          text: '第三轮核对完毕。减少动态效果偏好可以指导滚动方式，是否继续跟随最新内容仍由 Hub 根据用户操作决定。我会把这两条行为分别写进测试，并标出需要在桌面运行时、浏览器和读屏器上验证的项目。'
        },
        { type: 'status', text: 'Defining start-once test' }
      ],
      report: {
        title: 'Hub 桌面助手｜流式状态与工作过程证据复核',
        summary: '建议采用普通回执列表和一处 `status` 状态区。用户展开回执或离开列表末尾后，Hub 继续接收结果，同时保留阅读位置、展开状态和键盘焦点。用户主动按「回到最新」后恢复跟随。减少动态效果偏好只决定滚动和过渡的表现。',
        introNote: '本次分三阶段打开并核对了超过 12 个不同的 W3C、WAI、WHATWG 和 MDN 官方页面。',
        tableRows: [
          { item: '播报语义', decision: '普通回执列表 + 独立 status 区', evidence: 'log 会逐条打断阅读；status 仅在关键阶段切换时礼貌播报', cite: 'WAI-ARIA 1.2' },
          { item: '展开与锚定', decision: '保留 DOM 节点 + 锁定阅读位置', evidence: '原生 summary 切换状态时，避免整列表重渲染导致焦点丢失', cite: 'WHATWG HTML' },
          { item: '回到最新与动效', decision: '手动触发恢复跟随；动效服从系统偏好', evidence: 'prefers-reduced-motion 下将 smooth 降级为 instant 跳转', cite: 'MDN Media' }
        ],
        bullets: [
          { title: '流式追加不抢占视口', body: '当用户向上滚动阅读历史回执时，立即暂停自动吸底，并在底栏上方浮现轻量「回到最新」胶囊。', cite: 'CSS Anchoring' },
          { title: '焦点与展开状态持久化', body: '工具组展开后，即使流式输出仍在继续，已展开的工具回执节点不得被重置或折叠。', cite: 'WAI Focus' }
        ],
        checklist: [
          { id: 1, title: '首条工具调用到达时，仅 status 区播报一次阶段摘要', env: '读屏器' },
          { id: 2, title: '连续 5 步网页检索过程中，回执列表不触发高频语音打断', env: '读屏器' },
          { id: 3, title: '用户展开任意历史工具组后，新流式文本到达保持展开态', env: '桌面端' },
          { id: 4, title: '键盘 Tab 聚焦在 summary 上时，流式更新不丢失焦点', env: '键盘' },
          { id: 5, title: '向上滚动超过 40px 后，自动跟随立即暂停并显示「回到最新」', env: '桌面端' },
          { id: 6, title: '点击「回到最新」后平滑滚至底部并重新恢复自动吸底', env: '桌面端' },
          { id: 7, title: '系统开启减少动态效果时，滚动切换为无过渡 instant 模式', env: '系统偏好' },
          { id: 8, title: '流式输出完成瞬间，状态栏更新为“已完成”且不强制拉回视口', env: '桌面端' }
        ]
      }
    }
  ]);

  // 案例 2：重构后的「任务排查中断 + Hub 规则加载」场景（对应图 2 & 图 3）
  const [interruptedMessages, setInterruptedMessages] = useState([
    {
      id: 'c2_m1',
      role: 'user',
      time: '22:14',
      text: '找一下我最近的任务，帮我安排一下'
    },
    {
      id: 'c2_m2',
      role: 'assistant',
      duration: '38 秒',
      statusBadge: '已暂停',
      timeline: [
        {
          type: 'contextPrep',
          id: 'c2-ctx',
          summary: '已载入上下文 · 1 份材料 · 1 条规则',
          items: [
            { kind: 'doc', name: '仪表线束评审待查清单', meta: '当前打开材料' },
            { kind: 'rule', name: 'OS 知识库工作规则', file: 'AGENTS.md', hash: '示例版', fullPath: '示例库 / AGENTS.md' }
          ]
        },
        {
          type: 'thought',
          text: '我先查 Hub 里能看到的任务，再按截止时间和优先级排一份近期计划。'
        },
        {
          type: 'toolGroup',
          id: 'c2-g1',
          icon: 'wrench',
          title: '检索 Hub 任务 · 10 次调用',
          badges: ['Hub'],
          warnBadge: '1 项参数异常',
          steps: [
            { icon: 'database', label: '列出 Hub 资料库', detail: 'hub_list_libraries · 已连接 6 个资料库' },
            {
              id: 'c2-step-err',
              icon: 'alertTriangle',
              label: '搜索相关任务',
              detail: '首次查询词为空，已自动调整后重试',
              isWarning: true,
              countBadge: '× 8 次',
              techJson: '{\n  "error": "取证查询需要 1-200 个字符",\n  "origin": "host"\n}'
            },
            { type: 'status', text: 'Checking available sources' },
            { icon: 'fileText', label: '读取授权材料列表', detail: '已核对当前对话可访问的任务与收件箱范围' }
          ]
        }
      ],
      interruptedCard: {
        title: '未完成最终核验，已为你保留草稿',
        desc: '部分任务检索未返回完整结果，为避免遗漏已暂停直接输出。你可以核对资料范围后继续，或先查看当前草稿。',
        draftTitle: '近期任务安排（草稿 · 未核验）',
        draftItems: [
          '【高优】核对仪表线束 GUA 数模原理图待查清单（含 10 项待查）',
          '【中优】完成 Hub 桌面助手流式状态 15 项可访问性测试',
          '【待确认】滴答清单 / 收件箱中尚有未授权读取的逾期任务'
        ]
      }
    }
  ]);

  const availableModels = [
    { id: 'GPT-6.2 Sol', shortName: '6.2 Sol', vendor: 'OpenAI', web: true, reasoning: true, supportsFastMode: true, desc: '旗舰综合推理与长上下文' },
    { id: 'GPT-6.1 Terra', shortName: '6.1 Terra', vendor: 'OpenAI', web: true, reasoning: true, desc: '均衡稳定，适合工程资料整理' },
    { id: 'DeepSeek V4.1 Flash', shortName: 'V4.1 Flash', vendor: 'DeepSeek', web: false, reasoning: true, desc: '极速响应，本地资料检索优选' },
    { id: 'DeepSeek V4 Pro', shortName: 'V4 Pro', vendor: 'DeepSeek', web: true, reasoning: true, desc: '深度逻辑分析与代码核对' }
  ];

  const availableDocs = [
    ...(primaryMaterial ? [{ ...primaryMaterial, current: currentLabels[primaryMaterial.kind] }] : []),
    ...evidence,
    ...(tagWorkspace ? tagWorkspaceMaterials(tagWorkspace) : [
    { id: 'd1', name: '2023-02-02', path: '示例库 · Journals/2023/02/2023-02-02.md', current: !workspaceContext && '当前页' },
    { id: 'd2', name: '8_竞品和参考', path: 'Car · 工作台方案' },
    { id: 'd3', name: '案例', path: '示例库 · 未分类' },
    { id: 'd4', name: '2024.08.31', path: '示例库 · 未分类' },
    { id: 'd5', name: 'DXF 图纸到线表规范', path: 'Car · 工程标准' }
    ]),
  ];

  const availableLibs = tagWorkspace ? tagWorkspaceLibraries(tagWorkspace, selectedLibs) : [
    { id: 'Car', name: 'Car', source: 'Craft', count: '49 篇文档', color: 'bg-amber-500' },
    { id: 'OS', name: 'OS', source: 'Obsidian', count: '2,066 篇文档', color: 'bg-purple-500' },
    { id: 'main', name: 'main', source: 'Craft', count: '155 篇文档', color: 'bg-sky-500' },
    { id: 'Vonde', name: 'Vonde', source: '飞书', count: '13 篇文档', color: 'bg-emerald-500' },
    { id: '滴答清单', name: '滴答清单', source: '滴答', count: '407 条任务', color: 'bg-blue-500' }
  ];

  const availableTags = tagWorkspace ? tagWorkspace.tags.map(tag => ({
    value: tag,
    name: '#' + tag,
    count: tagWorkspace.records.filter(item => item.tags.includes(tag)).length,
  })) : [
    { name: '#craft', count: 121 },
    { name: '#main', count: 86 },
    { name: '#结构学', count: 73 },
    { name: '#movie', count: 59 },
    { name: '#archive', count: 45 },
    { name: '#teleplay', count: 41 }
  ];

  const webSourcesList = [
    { title: 'WCAG 4.1.3 Status Messages', host: 'w3.org/WAI/WCAG21/Understanding/status-messages', badge: 'W3C' },
    { title: 'WAI-ARIA 1.2 Role Definitions (log & status)', host: 'w3.org/TR/wai-aria-1.2/#status', badge: 'WAI' },
    { title: 'MDN ARIA: status role', host: 'developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/status_role', badge: 'MDN' },
    { title: 'WHATWG HTML Living Standard: details & summary', host: 'html.spec.whatwg.org/multipage/interactive-elements.html', badge: 'WHATWG' },
    { title: 'CSS Scroll Anchoring Module Level 1', host: 'drafts.csswg.org/css-scroll-anchoring', badge: 'W3C' },
    { title: 'MDN prefers-reduced-motion', host: 'developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion', badge: 'MDN' }
  ];
  const sourcesQuery = sourcesSearch.trim().toLowerCase();
  const visibleWebSources = webSourcesList.filter(source =>
    source.title.toLowerCase().includes(sourcesQuery) || source.host.toLowerCase().includes(sourcesQuery));

  const reasoningTiersByVendor = {
    OpenAI: [
      { id: 'low', label: '低', desc: '较少推理投入，适合简单问题' },
      { id: 'medium', label: '中', desc: '适合日常讨论与资料整理' },
      { id: 'high', label: '高', desc: '增加推理投入，适合复杂问题' },
      { id: 'very_high', label: '极高', desc: '更充分地推理与检查，等待可能更久' },
      { id: 'max', label: '最大', desc: '使用该模型最高的推理投入' },
      { id: 'extreme', label: '极限', desc: '使用该模型支持的更高推理投入' }
    ],
    DeepSeek: [
      { id: 'off', label: '关闭', desc: '跳过深度思考，直接快速作答' },
      { id: 'medium', label: '中', desc: '标准深度思考，兼顾速度与准确度' },
      { id: 'high', label: '高', desc: '充分链式推理，适合复杂核对与分析' }
    ]
  };
  const currentModelObj = availableModels.find(m => m.id === selectedModel) || availableModels[0];
  const currentReasoningTiers = reasoningTiersByVendor[currentModelObj.vendor];
  const currentReasoning = currentReasoningTiers.find(tier => tier.id === reasoningLevel);
  const reasoningLabels = { off: '关闭', low: '低', medium: '中', high: '高', very_high: '极高', max: '最大', extreme: '极限' };
  const activeTopic = topics.find(t => t.id === activeTopicId);
  const currentAccountObj = codexAccounts.find(a => a.id === activeAccountId) || codexAccounts[0];
  const closeAccountSheet = () => {
    setAccountSheetOpen(false);
    setPendingSwitchId(null);
    setOauthFlow('idle');
  };

  const confirmSwitchAccount = (targetId, strategy = switchStrategy) => {
    const target = codexAccounts.find(a => a.id === targetId);
    if (!target || target.status !== 'active') return;
    setActiveAccountId(targetId);
    setPendingSwitchId(null);
    setAccountSheetOpen(false);
    setChatAuthNeeded(false);
    setAccountSwitchedBanner({
      email: target.email,
      workspace: target.workspace,
      plan: target.plan,
      isFollow: target.type === 'follow'
    });
    if (strategy === 'new') {
      setActiveCase('new');
      setNewMessages([]);
      setInputText('');
      setThreadTitle('新对话');
      triggerToast(`已切换至 ${target.email} 并开启新对话`);
    } else {
      triggerToast(`已切换至 ${target.email}，下条消息将共享必要历史`);
    }
  };

  const handleSelectModel = (model) => {
    setSelectedModel(model.id);
    const tiers = reasoningTiersByVendor[model.vendor] || reasoningTiersByVendor.OpenAI;
    if (!tiers.some(t => t.id === reasoningLevel)) {
      setReasoningLevel('high');
    }
    if (!model.supportsFastMode) {
      setResponseSpeed('standard');
    }
  };

  const triggerToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(prev => (prev === msg ? '' : prev)), 2400);
  };

  const closeAllPopovers = () => {
    setModePopoverOpen(false);
    setLayoutMenuOpen(false);
    setSkillsPopoverOpen(false);
    setModelPopoverOpen(false);
    setPlusMenuOpen(false);
    setSlashMenuOpen(false);
    setAtMenuOpen(false);
    setTagPickerSlot(null);
  };

  const handleCopyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      triggerToast('已复制到剪贴板');
    } catch {
      triggerToast('无法访问剪贴板，请选中文字复制');
    }
  };

  const handleInputChange = (val) => {
    setInputText(val);
    if (val.endsWith('/')) {
      setSlashMenuOpen(true);
      setAtMenuOpen(false);
    } else if (val.endsWith('@')) {
      setAtMenuOpen(true);
      setSlashMenuOpen(false);
    } else {
      if (slashMenuOpen) setSlashMenuOpen(false);
      if (atMenuOpen) setAtMenuOpen(false);
    }
  };

  const tagAction = tagWorkspace && taskMode === 'tag' ? {
    intent: tagActions[tagSubTab], tag: targetTag, other: compareTag,
  } : null;
  const canSend = !chatAuthNeeded && (!!inputText.trim() || !!tagAction?.tag);

  const handleSendMessage = () => {
    if (!canSend) return;
    const userMsg = {
      id: 'u_' + Date.now(),
      role: 'user',
      time: '刚刚',
      text: inputText.trim() || tagPrompt(tagAction)
    };
    const currentMaterialSelected = primaryMaterial && selectedDocs.includes(primaryMaterial.id);
    const excerpt = currentMaterialSelected ? primaryMaterial.text.replace(/\s+/g, ' ').slice(0, 120) : '';
    const receiptLabel = workspaceContext?.kind === 'document' ? '当前资料' : currentLabels[workspaceContext?.kind];
    const documentReceipt = currentMaterialSelected
      ? `\n\n${receiptLabel}《${primaryMaterial.name}》${excerpt ? `\n正文节选：${excerpt}` : ''}`
      : '';
    const selectedEvidence = evidence.filter(item => selectedDocs.includes(item.id));
    const evidenceReceipt = selectedEvidence.length ? '\n关联依据：' + selectedEvidence.map(item => item.name).join('、') : '';
    const tagResult = tagAction ? runWorkspaceTagReview(
      tagWorkspace, tagAction.intent, tagAction.tag, tagAction.other, selectedDocs, selectedLibs
    ) : null;
    const aiMsg = {
      id: 'a_' + (Date.now() + 1),
      role: 'assistant',
      duration: '6 秒',
      tagReviewIds: tagResult?.ids,
      text: tagResult ? tagResult.message + documentReceipt : `已按「${taskMode === 'topic' && activeTopic ? activeTopic.name : taskMode === 'goal' ? '目标模式' : taskMode === 'tag' ? '标签助手' : '通用助手'}」模式结合 ${selectedDocs.length} 份核心资料与 ${selectedLibs.length} 个资料库生成演示回执（模型：${currentModelObj.id} · 思考强度${reasoningLabels[reasoningLevel]}）。如需沉淀结论，可直接点击下方「存入笔记」或「创建任务」。${documentReceipt}${evidenceReceipt}`
    };
    if (activeCase === 'interrupted') {
      setInterruptedMessages(prev => [...prev, userMsg, aiMsg]);
    } else if (activeCase === 'new') {
      setNewMessages(prev => [...prev, userMsg, aiMsg]);
    } else {
      setMessages(prev => [...prev, userMsg, aiMsg]);
    }
    setInputText('');
    closeAllPopovers();
  };

  const switchDemoCase = (caseKey) => {
    setActiveCase(caseKey);
    setThreadTitle(caseKey === 'interrupted' ? '找一下我最近的任务，帮我安排一下' : 'Hub 助手工作过程和展示方案');
  };

  const handleContinueInterrupted = (msgId) => {
    setInterruptedMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m;
      return {
        ...m,
        statusBadge: null,
        duration: '46 秒',
        interruptedCard: null,
        text: '演示：补充核对后得到以下近期优先安排：\n1. 今日优先：核对《仪表线束评审待查清单》中 3 项高风险待查项；\n2. 明日跟进：实测 Hub 桌面助手流式回执与焦点保持；\n3. 本周收尾：归档 Car 资料库 DXF 线表变更记录。'
      };
    }));
    triggerToast('已演示续跑并完成核验');
  };

  const applyTopic = (topic) => {
    setActiveTopicId(topic.id);
    setTaskMode('topic');
    setSelectedDocs(topic.docs);
    setSelectedLibs(topic.libs);
    setRetrievalStrategy(topic.strategy);
    setModePopoverOpen(false);
    triggerToast(`已切换至专题「${topic.name}」`);
  };

  const handleSaveCurrentAsTopic = () => {
    const finalName = newTopicName.trim() || `自定义专题 ${topics.length + 1}`;
    const newTopic = {
      id: 't_' + Date.now(),
      name: finalName,
      strategy: retrievalStrategy,
      docs: [...selectedDocs],
      libs: [...selectedLibs],
      pinned: true
    };
    setTopics(prev => [newTopic, ...prev]);
    setActiveTopicId(newTopic.id);
    setTaskMode('topic');
    setSavingTopicMode(false);
    setNewTopicName('');
    setScopeModalOpen(false);
    triggerToast(`已保存并置顶「${newTopic.name}」`);
  };

  const renderFileStyle = (type) => {
    switch (type) {
      case 'task': return { icon: 'checkSquare', color: 'text-emerald-600' };
      case 'video': return { icon: 'video', color: 'text-purple-600' };
      case 'code': return { icon: 'code', color: 'text-sky-600' };
      case 'pdf': return { icon: 'fileText', color: 'text-orange-600' };
      default: return { icon: 'fileText', color: 'text-secondary' };
    }
  };

  const modeDisplayLabel =
    taskMode === 'goal' ? '目标' :
    taskMode === 'tag' ? '标签' :
    taskMode === 'topic' && activeTopic ? activeTopic.name : '标准';

  // 柔和语义色胶囊样式（取代刺眼纯黑实心块）
  const modeButtonStyle =
    taskMode === 'goal'
      ? 'bg-amber-50 text-amber-800 border-amber-200/90 hover:bg-amber-100/70'
      : taskMode === 'tag'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200/90 hover:bg-emerald-100/70'
      : taskMode === 'topic'
      ? 'bg-accent-indigo/10 text-accent-indigo border-accent-indigo/25 hover:bg-accent-indigo/15'
      : 'bg-surface text-primary border-border hover:bg-hover';

  const modeDotStyle =
    taskMode === 'goal' ? 'bg-amber-500' :
    taskMode === 'tag' ? 'bg-emerald-500' :
    taskMode === 'topic' ? 'bg-accent-indigo' : null;

  const containerWidthClass =
    viewportMode === 'sidebar' ? 'max-w-[480px]' :
    viewportMode === 'focus' ? 'max-w-[780px]' : 'max-w-full';

  const currentMessagesList = activeCase === 'interrupted' ? interruptedMessages : activeCase === 'new' ? newMessages : messages;
  const visibleMessages = onlyLatestReply && currentMessagesList.length > 0 ? [currentMessagesList[currentMessagesList.length - 1]] : currentMessagesList;
  const visibleLocalFiles = expandAllFiles ? attachedLocalFiles : attachedLocalFiles.slice(0, 3);
  const hiddenFilesCount = attachedLocalFiles.length > 3 ? attachedLocalFiles.length - 3 : 0;

  return (
    <div data-agents-layout={layout} className="h-screen w-full flex flex-col items-center justify-center p-2 sm:p-4">
      {/* 顶部原型视口与示例场景控制条 */}
      <div className={`w-full ${containerWidthClass} ${layout !== 'expanded' ? 'self-end' : ''} pointer-events-auto shrink-0 mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs transition-all duration-300`}>
        <div className="flex flex-wrap items-center gap-2">
          {onDismiss && (
            <button
              type="button"
              autoFocus
              onClick={onDismiss}
              className="flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-secondary hover:bg-hover hover:text-primary"
            >
              <Icon name="arrowLeft" className="w-3.5 h-3.5" />
              返回工作台
            </button>
          )}
          <span className="font-semibold text-primary">Hub 助手原型</span>
          {!workspaceContext && <div className="flex items-center bg-black/5 p-0.5 rounded-xl">
            <button
              aria-pressed={activeCase === 'report'}
              onClick={() => switchDemoCase('report')}
              className={`px-2 py-0.5 rounded-lg text-[11px] font-medium transition-all ${activeCase === 'report' ? 'bg-surface text-primary shadow-sm' : 'text-secondary hover:text-primary'}`}
            >
              案例1：流式复核
            </button>
            <button
              aria-pressed={activeCase === 'interrupted'}
              onClick={() => switchDemoCase('interrupted')}
              className={`px-2 py-0.5 rounded-lg text-[11px] font-medium transition-all flex items-center gap-1 ${activeCase === 'interrupted' ? 'bg-surface text-primary shadow-sm' : 'text-secondary hover:text-primary'}`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
              <span>案例2：中断与规则</span>
            </button>
            {onOpenDemos ? <button type="button" onClick={onOpenDemos}
              className="px-2 py-0.5 rounded-lg text-[11px] font-medium text-secondary hover:text-primary">更多演示</button>
              : <a href="/?assistant=ui-demo" className="px-2 py-0.5 rounded-lg text-[11px] font-medium text-secondary hover:text-primary">更多演示</a>}
          </div>}
        </div>
        <div className="flex items-center bg-black/5 p-0.5 rounded-xl">
          {[
            { id: 'sidebar', label: '侧栏 480px' },
            { id: 'focus', label: '专注 780px' },
            { id: 'full', label: '全屏' }
          ].map(v => (
            <button
              key={v.id}
              aria-pressed={viewportMode === v.id}
              onClick={() => { setViewportMode(v.id); if (v.id !== 'sidebar' && layout !== 'expanded') { setLayout('expanded'); onLayoutChange?.('expanded'); } }}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${viewportMode === v.id ? 'bg-surface text-primary shadow-sm' : 'text-secondary hover:text-primary'}`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* 主窗口外壳 */}
      <div className={`relative w-full ${containerWidthClass} ${layout === 'docked' ? 'self-end rounded-l-none rounded-r-lg' : layout === 'floating' ? 'self-end rounded-[20px]' : 'rounded-[22px]'} pointer-events-auto flex-1 min-h-0 bg-canvas border border-border shadow-sheet flex flex-col overflow-hidden transition-all duration-300`}>

        {/* 1. 顶部导航栏（彻底解耦：左抽屉/新建，中可编辑标题，右模式/检查器） */}
        <header className="h-12 px-3 border-b border-border/80 bg-canvas/85 glass flex items-center justify-between gap-2 shrink-0 z-20">
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => { closeAllPopovers(); setHistoryOpen(true); }}
              className="p-1.5 rounded-lg text-secondary hover:text-primary hover:bg-hover transition-colors"
              title="对话历史"
            >
              <Icon name="menu" className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                closeAllPopovers();
                setActiveCase('new');
                setNewMessages([]);
                setInputText('');
                setThreadTitle(workspaceContext?.name ?? '新对话');
                triggerToast('已开启新对话');
              }}
              className="p-1.5 rounded-lg text-secondary hover:text-primary hover:bg-hover transition-colors"
              title="新建对话"
            >
              <Icon name="plus" className="w-4 h-4" />
            </button>
          </div>

          {/* 中间单行极简标题（点击内联重命名） */}
          <div className="flex-1 min-w-0 flex justify-center">
            {isEditingTitle ? (
              <input
                autoFocus
                value={threadTitle}
                onChange={(e) => setThreadTitle(e.target.value)}
                onBlur={() => setIsEditingTitle(false)}
                onKeyDown={(e) => e.key === 'Enter' && setIsEditingTitle(false)}
                className="w-full max-w-[260px] text-center text-xs font-semibold text-primary bg-surface border border-primary/25 rounded-lg px-2 py-1 focus:outline-none"
              />
            ) : (
              <button
                onClick={() => setIsEditingTitle(true)}
                className="max-w-[240px] sm:max-w-[320px] px-2 py-1 rounded-lg hover:bg-hover text-xs font-semibold text-primary truncate transition-colors"
                title="点击重命名对话"
              >
                {threadTitle}
              </button>
            )}
          </div>

          {/* 右侧：任务模式/专题切换 + Inspector 抽屉 */}
          <div className="flex items-center gap-1 shrink-0 relative">
            <button
              onClick={() => {
                const next = !modePopoverOpen;
                closeAllPopovers();
                setModePopoverView('main');
                setModePopoverOpen(next);
              }}
              className={`px-2.5 py-1 rounded-lg text-[11.5px] font-medium flex items-center gap-1.5 border transition-colors ${modeButtonStyle}`}
            >
              {modeDotStyle && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${modeDotStyle}`}></span>}
              <span className="max-w-[88px] truncate">{modeDisplayLabel}</span>
              <Icon name="chevronDown" className="w-3 h-3 opacity-70" />
            </button>
            <button
              onClick={() => { closeAllPopovers(); setInspectorOpen(v => !v); }}
              className={`p-1.5 rounded-lg transition-colors ${inspectorOpen ? 'bg-subtle text-primary' : 'text-secondary hover:text-primary hover:bg-hover'}`}
              title="对话详情与设置"
            >
              <Icon name="sliders" className="w-4 h-4" />
            </button>

            <span className="h-3.5 w-px bg-border mx-0.5" aria-hidden="true" />
            <button type="button" title="切换窗口形态" aria-label="切换窗口形态" aria-expanded={layoutMenuOpen}
              className="p-1.5 rounded-lg text-secondary hover:bg-hover"
              onClick={() => { const next = !layoutMenuOpen; closeAllPopovers(); setLayoutMenuOpen(next); }}>
              <Icon name={layout === 'docked' ? 'dockRight' : layout === 'floating' ? 'floatWindow' : 'maximize'} />
            </button>
            {onDismiss && <button type="button" title="收起助手" aria-label="收起助手" onClick={onDismiss} className="p-1.5 rounded-lg text-secondary hover:bg-hover"><Icon name="x" /></button>}
            {layoutMenuOpen && <div className="absolute right-0 top-10 w-56 rounded-2xl border border-border bg-surface p-1.5 shadow-popover z-50" aria-label="助手显示形态">
              {[
                { id: 'docked', icon: 'dockRight', label: '右侧分屏停靠', viewport: 'sidebar' },
                { id: 'floating', icon: 'floatWindow', label: '悬浮浮窗', viewport: 'sidebar' },
                { id: 'expanded', icon: 'maximize', label: '专注展开', viewport: 'focus' }
              ].map(option => <button key={option.id} type="button" aria-pressed={layout === option.id} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-hover"
                onClick={() => { setViewportMode(option.viewport); setLayout(option.id); onLayoutChange?.(option.id); setLayoutMenuOpen(false); }}>
                <Icon name={option.icon} className="w-3.5 h-3.5" />{option.label}{layout === option.id && <Icon name="check" className="ml-auto w-3.5 h-3.5" />}
              </button>)}
            </div>}

            {/* 任务模式与专题统一浮层（单层无嵌套弹窗） */}
            {modePopoverOpen && (
              <div className="absolute top-10 right-0 w-[300px] bg-surface/95 glass rounded-2xl border border-border shadow-popover overflow-hidden z-50 animate-fadeIn">
                {modePopoverView === 'main' ? (
                  <div className="p-2 space-y-2">
                    <div className="flex items-center justify-between px-1.5 pt-0.5">
                      <span className="text-[11px] font-semibold text-primary">任务模式</span>
                      <button onClick={() => setModePopoverOpen(false)} className="text-muted hover:text-primary">
                        <Icon name="x" className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="space-y-1">
                      {[
                        { id: 'standard', icon: 'sparkles', title: '通用助手', desc: '自由提问，保留当前对话与设置', iconCls: 'bg-subtle text-primary border-border', activeCls: 'bg-subtle border-border' },
                        { id: 'goal', icon: 'target', title: '目标模式', desc: '按完成条件推进，遇到阻碍时暂停', iconCls: 'bg-amber-50 text-amber-700 border-amber-200/80', activeCls: 'bg-amber-50/70 border-amber-200/80' },
                        { id: 'tag', icon: 'tag', title: '标签助手', desc: '起草定义、查找漏标、比较关系', iconCls: 'bg-emerald-50 text-emerald-700 border-emerald-200/80', activeCls: 'bg-emerald-50/70 border-emerald-200/80' }
                      ].map(m => {
                        const active = taskMode === m.id;
                        return (
                          <button
                            key={m.id}
                            onClick={() => { setTaskMode(m.id); setActiveTopicId(null); setModePopoverOpen(false); }}
                            className={`w-full p-2 rounded-xl text-left flex items-center justify-between gap-2 transition-colors border ${active ? m.activeCls : 'hover:bg-hover border-transparent'}`}
                          >
                            <div className="flex items-start gap-2.5 min-w-0">
                              <div className={`w-6 h-6 rounded-lg border flex items-center justify-center shrink-0 mt-0.5 ${m.iconCls}`}>
                                <Icon name={m.icon} className="w-3.5 h-3.5" />
                              </div>
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-primary">{m.title}</div>
                                <div className="text-[10.5px] text-muted truncate">{m.desc}</div>
                              </div>
                            </div>
                            {active && <Icon name="check" className="w-3.5 h-3.5 text-primary shrink-0" />}
                          </button>
                        );
                      })}
                    </div>

                    {/* 置顶专题 */}
                    <div className="pt-2 border-t border-border/70 space-y-1">
                      <div className="flex items-center justify-between px-1.5 text-[10.5px]">
                        <span className="text-muted font-medium">置顶专题</span>
                        <button
                          onClick={() => setModePopoverView('allTopics')}
                          className="text-accent-indigo hover:underline font-medium"
                        >
                          全部专题 ({topics.length}) ›
                        </button>
                      </div>
                      {topics.filter(t => t.pinned).map(t => {
                        const isTopicActive = taskMode === 'topic' && activeTopicId === t.id;
                        return (
                          <button
                            key={t.id}
                            onClick={() => applyTopic(t)}
                            className={`w-full p-2 rounded-xl text-left flex items-center justify-between gap-2 transition-colors border ${isTopicActive ? 'bg-accent-indigo/10 border-accent-indigo/25' : 'hover:bg-hover border-transparent'}`}
                          >
                            <div className="flex items-start gap-2.5 min-w-0">
                              <div className={`w-6 h-6 rounded-lg border flex items-center justify-center shrink-0 mt-0.5 ${isTopicActive ? 'bg-accent-indigo text-white border-accent-indigo' : 'bg-accent-indigo/10 text-accent-indigo border-accent-indigo/20'}`}>
                                <Icon name="layers" className="w-3.5 h-3.5" />
                              </div>
                              <div className="min-w-0">
                                <div className={`text-xs font-medium truncate ${isTopicActive ? 'text-accent-indigo' : 'text-primary'}`}>{t.name}</div>
                                <div className="text-[10px] text-muted">
                                  {t.strategy === 'only' ? '只用所选' : '优先所选'} · {t.docs.length} 篇 · {t.libs.length} 库
                                </div>
                              </div>
                            </div>
                            {isTopicActive ? (
                              <Icon name="check" className="w-3.5 h-3.5 text-accent-indigo shrink-0" />
                            ) : (
                              <Icon name="pin" className="w-3 h-3 text-muted shrink-0" />
                            )}
                          </button>
                        );
                      })}
                    </div>

                    {/* 底部执行状态 */}
                    <div className="pt-2 border-t border-border/70 px-1.5 pb-0.5 flex items-center justify-between text-[11px]">
                      <span className="text-muted">执行安排 · 自动</span>
                      <button
                        onClick={() => { setModePopoverOpen(false); setInspectorOpen(true); }}
                        className="text-primary font-medium hover:underline"
                      >
                        查看任务状态
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <button onClick={() => setModePopoverView('main')} className="flex items-center gap-1 text-xs font-medium text-secondary hover:text-primary">
                        <Icon name="arrowLeft" className="w-3.5 h-3.5" />
                        <span>全部专题</span>
                      </button>
                      <button
                        onClick={() => { setModePopoverOpen(false); setScopeModalOpen(true); }}
                        className="text-[11px] font-medium text-accent-indigo hover:underline"
                      >
                        + 新建专题
                      </button>
                    </div>
                    <div className="relative">
                      <Icon name="search" className="w-3.5 h-3.5 text-muted absolute left-2.5 top-2" />
                      <input
                        value={topicSearch}
                        onChange={(e) => setTopicSearch(e.target.value)}
                        placeholder="搜索专题..."
                        className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-subtle rounded-lg border border-border focus:outline-none"
                      />
                    </div>
                    <div className="space-y-1 max-h-52 overflow-y-auto">
                      {topics
                        .filter(t => t.name.toLowerCase().includes(topicSearch.toLowerCase()))
                        .map(t => (
                          <div key={t.id} className="p-2 rounded-xl hover:bg-hover border border-border/60 flex items-center justify-between gap-2">
                            <button onClick={() => applyTopic(t)} className="text-left min-w-0 flex-1">
                              <div className="text-xs font-semibold text-primary truncate">{t.name}</div>
                              <div className="text-[10px] text-muted">
                                {t.strategy === 'only' ? '只用所选资料' : '优先用所选资料'} · {t.docs.length} 核心页 · {t.libs.length} 库
                              </div>
                            </button>
                            <button
                              onClick={() => setTopics(prev => prev.map(item => item.id === t.id ? { ...item, pinned: !item.pinned } : item))}
                              className={`p-1.5 rounded-lg transition-colors ${t.pinned ? 'bg-primary text-white' : 'bg-subtle text-muted hover:text-primary'}`}
                              title={t.pinned ? '取消置顶' : '置顶专题'}
                            >
                              <Icon name="pin" className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        {/* 2. 模式上下文轻状态条（36px 紧凑条，彻底消除 4 层堆叠） */}
        {taskMode === 'tag' && (
          <div className="h-10 px-3 border-b border-emerald-200/70 bg-emerald-50/50 flex items-center justify-between gap-2 shrink-0 animate-fadeIn">
            <div className="flex items-center bg-black/5 p-0.5 rounded-lg text-[11px]">
              {[
                { id: 'draft', label: '起草定义' },
                { id: 'find', label: '查找漏标' },
                { id: 'compare', label: '比较关系' }
              ].map(tab => (
                <button
                  key={tab.id}
                  aria-pressed={tagSubTab === tab.id}
                  onClick={() => setTagSubTab(tab.id)}
                  className={`px-2.5 py-0.5 rounded-md font-medium transition-all ${tagSubTab === tab.id ? 'bg-surface text-emerald-800 shadow-xs' : 'text-secondary hover:text-primary'}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <button onClick={() => setTaskMode('standard')} className="text-muted hover:text-primary p-1 rounded-md">
              <Icon name="x" className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {taskMode === 'goal' && (
          <div className="px-3 py-2 border-b border-amber-200/70 bg-amber-50/50 flex items-center justify-between gap-2 shrink-0 text-xs animate-fadeIn">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Icon name="target" className="w-3.5 h-3.5 text-amber-700 shrink-0" />
              <input
                value={goalText}
                onChange={(e) => setGoalText(e.target.value)}
                className="bg-transparent text-xs text-primary font-medium w-full focus:outline-none truncate"
              />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[10.5px] text-amber-800/80 hidden sm:inline">遇阻暂停</span>
              <Toggle checked={pauseOnBlocker} onChange={setPauseOnBlocker} />
            </div>
          </div>
        )}

        {taskMode === 'topic' && activeTopic && (
          <div className="h-9 px-3 border-b border-border/70 bg-accent-indigo/5 flex items-center justify-between gap-2 shrink-0 text-[11px] animate-fadeIn">
            <div className="flex items-center gap-1.5 text-accent-indigo font-medium truncate">
              <Icon name="layers" className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">专题：{activeTopic.name}</span>
              <span className="text-secondary font-normal">· {activeTopic.strategy === 'only' ? '只用所选资料' : '优先用所选'}</span>
            </div>
            <button onClick={() => { setTaskMode('standard'); setActiveTopicId(null); }} className="text-muted hover:text-primary text-[11px]">
              退出专题
            </button>
          </div>
        )}

        {/* 3. 主内容消息流 / 居中呼吸感空状态 */}
        <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-6" onClick={closeAllPopovers}>
          {visibleMessages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center max-w-md mx-auto text-center pb-10 animate-fadeIn">
              <div className="w-11 h-11 rounded-2xl bg-surface border border-border shadow-card flex items-center justify-center mb-4">
                <Icon name="sparkles" className="w-5 h-5 text-primary" />
              </div>
              <h2 className="text-lg font-semibold text-primary tracking-tight">准备从哪里开始？</h2>
              <p className="text-xs text-secondary mt-1.5">直接提问，或输入 <code className="font-mono bg-subtle px-1 rounded">/</code> 调用技能、<code className="font-mono bg-subtle px-1 rounded">@</code> 引用知识库资料</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 w-full mt-6 text-left">
                {[
                  { title: '整理当前页面', desc: '提炼要点并补全标签' },
                  { title: '比对标签关系', desc: '进入标签助手核查漏标' },
                  { title: '检索 Car 资料库', desc: '核对工程图纸与线表' }
                ].map((card, idx) => (
                  <button
                    key={idx}
                    onClick={() => setInputText(card.title + '：')}
                    className="p-3 rounded-xl bg-surface border border-border hover:border-primary/25 shadow-card text-left transition-all"
                  >
                    <div className="text-xs font-semibold text-primary">{card.title}</div>
                    <div className="text-[11px] text-muted mt-0.5">{card.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            visibleMessages.map((msg) => (
              <div key={msg.id} className="space-y-3">
                {msg.role === 'user' ? (
                  <div className="flex justify-end">
                    <div className="max-w-[88%] bg-subtle border border-border/60 rounded-2xl rounded-tr-md px-4 py-3 text-[13.5px] leading-relaxed text-primary">
                      {msg.text}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3.5">
                    {/* A. Codex 风格两层可展开公开思维链与工具调用回执 */}
                    {msg.timeline && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <button
                            onClick={() => setTimelineOpenMap(prev => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                            className="inline-flex items-center gap-1.5 px-2 py-1 -ml-2 rounded-lg hover:bg-hover text-xs font-medium text-secondary hover:text-primary transition-colors"
                          >
                            <span className="font-mono text-[11.5px]">用时 {msg.duration}</span>
                            {msg.statusBadge && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded-md bg-amber-50 text-amber-800 border border-amber-200/80 text-[10.5px] font-sans font-medium">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                                {msg.statusBadge}
                              </span>
                            )}
                            <Icon name={timelineOpenMap[msg.id] ? 'chevronDown' : 'chevronRight'} className="w-3.5 h-3.5 opacity-70" />
                          </button>
                          <button
                            onClick={() => triggerToast('已复制完整思维链过程摘要')}
                            className="p-1 rounded-md text-muted hover:text-primary hover:bg-hover"
                            title="过程选项"
                          >
                            <Icon name="moreHorizontal" className="w-4 h-4" />
                          </button>
                        </div>

                        {timelineOpenMap[msg.id] && (
                          <div className="pl-3.5 border-l border-border space-y-3 text-[12.5px] leading-relaxed text-secondary animate-fadeIn">
                            {msg.timeline.map((node, idx) => {
                              if (node.type === 'contextPrep') {
                                const isCtxOpen = !!toolGroupOpenMap[node.id];
                                return (
                                  <div key={node.id} className="space-y-1.5">
                                    <button
                                      onClick={() => setToolGroupOpenMap(prev => ({ ...prev, [node.id]: !prev[node.id] }))}
                                      className="inline-flex items-center gap-2 py-0.5 rounded-md hover:text-primary transition-colors text-left"
                                    >
                                      <Icon name="layers" className="w-3.5 h-3.5 text-muted shrink-0" />
                                      <span className="font-medium text-primary/85">{node.summary}</span>
                                      <Icon name={isCtxOpen ? 'chevronDown' : 'chevronRight'} className="w-3 h-3 text-muted" />
                                    </button>

                                    {isCtxOpen && (
                                      <div className="pl-4 border-l border-border/70 space-y-1.5 py-0.5 text-[12px] animate-fadeIn">
                                        {node.items.map((it, ii) => (
                                          <div key={ii} className="flex items-center justify-between gap-2 py-0.5">
                                            <div className="flex items-center gap-2 min-w-0">
                                              <Icon
                                                name={it.kind === 'rule' ? 'shield' : 'fileText'}
                                                className={`w-3.5 h-3.5 shrink-0 ${it.kind === 'rule' ? 'text-accent-indigo' : 'text-secondary'}`}
                                              />
                                              <span className="font-medium text-primary/90 truncate">{it.name}</span>
                                              {it.kind === 'rule' ? (
                                                <span className="px-1.5 py-0.2 rounded bg-subtle border border-border font-mono text-[10px] text-secondary shrink-0">
                                                  {it.file} · {it.hash}
                                                </span>
                                              ) : (
                                                <span className="text-[11px] text-muted shrink-0">{it.meta}</span>
                                              )}
                                            </div>
                                            {it.kind === 'rule' && (
                                              <button
                                                onClick={() => triggerToast(`规则源文件：${it.fullPath}`)}
                                                className="text-[11px] text-muted hover:text-primary shrink-0 flex items-center gap-0.5"
                                                title={it.fullPath}
                                              >
                                                <span>查看</span>
                                                <Icon name="externalLink" className="w-2.5 h-2.5" />
                                              </button>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              }
                              if (node.type === 'thought') {
                                return (
                                  <p key={idx} className="text-secondary">
                                    <InlineCodeText text={node.text} />
                                  </p>
                                );
                              }
                              if (node.type === 'status') {
                                return (
                                  <div key={idx} className="text-[11.5px] font-mono text-muted">
                                    {node.text}
                                  </div>
                                );
                              }
                              if (node.type === 'toolGroup') {
                                const isGroupOpen = !!toolGroupOpenMap[node.id];
                                return (
                                  <div key={node.id} className="space-y-1.5">
                                    <button
                                      onClick={() => setToolGroupOpenMap(prev => ({ ...prev, [node.id]: !prev[node.id] }))}
                                      className="inline-flex items-center gap-2 py-0.5 rounded-md hover:text-primary transition-colors text-left"
                                    >
                                      <Icon name={node.icon || 'search'} className="w-3.5 h-3.5 text-muted shrink-0" />
                                      <span className="font-medium text-primary/85">{node.title}</span>
                                      {/* 叠放微缩站点图标（替代笨重文字框） */}
                                      {node.badges && node.badges.length > 0 && (
                                        <div className="flex items-center -space-x-1 ml-0.5">
                                          {node.badges.map((b, bi) => (
                                            <SiteFavicon key={bi} site={b} />
                                          ))}
                                        </div>
                                      )}
                                      {node.warnBadge && (
                                        <span className="px-1.5 py-0.2 rounded-md bg-amber-50 text-amber-800 border border-amber-200/80 text-[10px] font-medium">
                                          {node.warnBadge}
                                        </span>
                                      )}
                                      <Icon name={isGroupOpen ? 'chevronDown' : 'chevronRight'} className="w-3 h-3 text-muted" />
                                    </button>

                                    {isGroupOpen && (
                                      <div className="pl-4 border-l border-border/70 space-y-1.5 py-0.5 text-[12px] animate-fadeIn">
                                        {node.steps.map((st, si) =>
                                          st.type === 'status' ? (
                                            <div key={si} className="text-[11px] font-mono text-muted py-0.5">
                                              {st.text}
                                            </div>
                                          ) : (
                                            <div key={si} className="space-y-1.5">
                                              <button
                                                onClick={() => {
                                                  if (st.techJson) {
                                                    setTechLogOpenMap(prev => ({ ...prev, [st.id]: !prev[st.id] }));
                                                  } else {
                                                    triggerToast(`${st.label}：${st.detail}`);
                                                  }
                                                }}
                                                className="w-full flex items-center gap-1.5 text-left text-secondary hover:text-primary py-0.5 group"
                                              >
                                                <Icon name={st.icon} className={`w-3.5 h-3.5 shrink-0 ${st.isWarning ? 'text-amber-600' : 'text-muted'}`} />
                                                <span className={`shrink-0 font-medium ${st.isWarning ? 'text-amber-800' : 'text-primary/80'}`}>{st.label}</span>
                                                {st.countBadge && (
                                                  <span className="px-1.5 py-0.2 rounded bg-subtle border border-border text-[10px] font-mono text-secondary shrink-0">
                                                    {st.countBadge}
                                                  </span>
                                                )}
                                                <span className="text-muted">·</span>
                                                <span className="truncate font-mono text-[11.5px] text-secondary">
                                                  <InlineCodeText text={st.detail} />
                                                </span>
                                                {st.extra && (
                                                  <span className="shrink-0 text-[11px] text-muted ml-1">{st.extra}</span>
                                                )}
                                                {st.techJson ? (
                                                  <span className="shrink-0 text-[10.5px] text-muted group-hover:text-primary ml-auto flex items-center gap-0.5">
                                                    <span>技术记录</span>
                                                    <Icon name={techLogOpenMap[st.id] ? 'chevronDown' : 'chevronRight'} className="w-3 h-3" />
                                                  </span>
                                                ) : (
                                                  <Icon name="chevronRight" className="w-3 h-3 text-muted/60 group-hover:text-primary shrink-0 ml-auto" />
                                                )}
                                              </button>
                                              {st.techJson && techLogOpenMap[st.id] && (
                                                <pre className="ml-5 p-2.5 rounded-xl bg-subtle/80 border border-border font-mono text-[11px] text-secondary overflow-x-auto leading-relaxed">
                                                  {st.techJson}
                                                </pre>
                                              )}
                                            </div>
                                          )
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              }
                              return null;
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* B. 正式结构化长报告 / 重构后的中断恢复卡片 / 普通文本 */}
                    {msg.interruptedCard ? (
                      <div className="rounded-2xl border border-amber-200/80 bg-amber-50/45 p-4 space-y-3 shadow-card animate-fadeIn">
                        <div className="flex items-start gap-2.5">
                          <div className="w-7 h-7 rounded-xl bg-amber-100/90 text-amber-700 flex items-center justify-center shrink-0 mt-0.5">
                            <Icon name="alertTriangle" className="w-4 h-4" />
                          </div>
                          <div className="space-y-1 min-w-0">
                            <div className="text-[13.5px] font-semibold text-primary">{msg.interruptedCard.title}</div>
                            <p className="text-[12.5px] text-secondary leading-relaxed">{msg.interruptedCard.desc}</p>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 pt-0.5 pl-9">
                          <button
                            onClick={() => handleContinueInterrupted(msg.id)}
                            className="px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-medium hover:opacity-90 flex items-center gap-1.5 shadow-2xs"
                          >
                            <Icon name="play" className="w-3 h-3" />
                            <span>继续完成</span>
                          </button>
                          <button
                            onClick={() => setScopeModalOpen(true)}
                            className="px-3 py-1.5 rounded-xl bg-surface border border-border hover:bg-hover text-xs font-medium text-primary flex items-center gap-1.5"
                          >
                            <Icon name="database" className="w-3.5 h-3.5 text-secondary" />
                            <span>核对资料范围</span>
                          </button>
                          <button
                            onClick={() => setDraftPreviewOpenMap(prev => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                            className="px-2.5 py-1.5 rounded-xl hover:bg-amber-100/60 text-xs font-medium text-secondary hover:text-primary flex items-center gap-1 ml-auto"
                          >
                            <span>{draftPreviewOpenMap[msg.id] ? '收起草稿' : '查看草稿预览'}</span>
                            <Icon name={draftPreviewOpenMap[msg.id] ? 'chevronDown' : 'chevronRight'} className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {draftPreviewOpenMap[msg.id] && (
                          <div className="ml-9 p-3 rounded-xl bg-surface border border-border/80 space-y-2 text-xs animate-fadeIn">
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-primary">{msg.interruptedCard.draftTitle}</span>
                              <span className="px-1.5 py-0.5 rounded bg-subtle text-[10px] text-muted">仅预览 · 未存入</span>
                            </div>
                            <ul className="space-y-1.5 text-secondary">
                              {msg.interruptedCard.draftItems.map((di, idx) => (
                                <li key={idx} className="leading-relaxed">• {di}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    ) : msg.report ? (
                      <article className="space-y-4 text-[14.5px] leading-[1.7] text-primary">
                        <h1 className="text-[17px] font-bold tracking-tight text-primary">
                          {msg.report.title}
                        </h1>
                        <p className="text-primary/90">
                          <InlineCodeText text={msg.report.summary} />
                        </p>
                        <p className="text-[13px] text-secondary">{msg.report.introNote}</p>

                        {/* 对比表格（防窄栏撑爆） */}
                        <div className="rounded-xl border border-border bg-surface overflow-x-auto shadow-card">
                          <table className="w-full text-left border-collapse text-[12.5px] min-w-[420px]">
                            <thead>
                              <tr className="bg-subtle/70 border-b border-border text-secondary">
                                <th className="py-2 px-3 font-semibold w-24">维度</th>
                                <th className="py-2 px-3 font-semibold">推荐方案</th>
                                <th className="py-2 px-3 font-semibold">依据与边界</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/70">
                              {msg.report.tableRows.map((row, ri) => (
                                <tr key={ri} className="hover:bg-hover/60">
                                  <td className="py-2.5 px-3 font-medium text-primary align-top">{row.item}</td>
                                  <td className="py-2.5 px-3 text-primary align-top">{row.decision}</td>
                                  <td className="py-2.5 px-3 text-secondary align-top">
                                    {row.evidence}
                                    <button
                                      onClick={(event) => { event.stopPropagation(); setSourcesSearch(''); setSourcesModalOpen(true); }}
                                      className="ml-1.5 inline-flex items-center px-1.5 py-0.2 rounded-md bg-subtle border border-border text-[10.5px] text-secondary hover:text-primary hover:border-primary/30 transition-colors"
                                    >
                                      {row.cite}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {/* 关键要点 */}
                        <ul className="space-y-2 text-[13.5px]">
                          {msg.report.bullets.map((b, bi) => (
                            <li key={bi} className="flex items-start gap-2">
                              <span className="w-1.5 h-1.5 rounded-full bg-primary/40 mt-2.5 shrink-0"></span>
                              <div>
                                <strong className="font-semibold text-primary">{b.title}：</strong>
                                <span className="text-primary/85">{b.body}</span>
                                <button
                                  onClick={(event) => { event.stopPropagation(); setSourcesSearch(''); setSourcesModalOpen(true); }}
                                  className="ml-1.5 inline-flex items-center px-1.5 py-0.2 rounded-md bg-subtle border border-border text-[10.5px] text-secondary hover:text-primary"
                                >
                                  {b.cite}
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>

                        {/* 桌面测试核对清单 */}
                        <div className="rounded-xl border border-border bg-surface overflow-hidden shadow-card">
                          <div className="px-3.5 py-2.5 bg-subtle/60 border-b border-border flex items-center justify-between">
                            <span className="text-xs font-semibold text-primary">桌面验证核对清单（示例 8/15 项）</span>
                            <button
                              onClick={() => setChecklistExpanded(v => !v)}
                              className="text-[11px] font-medium text-accent-indigo hover:underline"
                            >
                              {checklistExpanded ? '收起部分' : '展开全部'}
                            </button>
                          </div>
                          <div className="divide-y divide-border/60 text-[12.5px]">
                            {(checklistExpanded ? msg.report.checklist : msg.report.checklist.slice(0, 4)).map(item => (
                              <div key={item.id} className="px-3.5 py-2 flex items-center justify-between gap-3">
                                <div className="flex items-start gap-2 min-w-0">
                                  <span className="font-mono text-[11px] text-muted w-4 shrink-0">{item.id}.</span>
                                  <span className="text-primary/90">{item.title}</span>
                                </div>
                                <span className="px-1.5 py-0.5 rounded-md bg-subtle text-[10.5px] text-secondary shrink-0">
                                  {item.env}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </article>
                    ) : (
                      <div className="text-[14.5px] leading-[1.7] text-primary whitespace-pre-line">{msg.text}</div>
                    )}

                    {msg.tagReviewIds?.map(id => {
                      const pending = tagWorkspace?.suggestions.find(item => item.id === id && item.status === 'pending');
                      return pending && onOpenTagQueue ? (
                        <button key={id} type="button" onClick={() => onOpenTagQueue(id)}
                          className="text-xs font-medium text-emerald-800 underline underline-offset-4">
                          在标签页核查{pending.kind === 'definition' ? '定义草稿' : pending.kind === 'missing' ? '漏标建议' : '关系建议'}
                        </button>
                      ) : null;
                    })}

                    {/* C. 极简底栏操作（合并存入笔记 + 极简创建任务 + 轻量化来源胶囊） */}
                    {!msg.interruptedCard && (
                      <div className="pt-1 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleCopyText(msg.report ? `${msg.report.title}\n\n${msg.report.summary}` : msg.text)}
                            className="px-2 py-1 rounded-lg text-[11.5px] text-secondary hover:text-primary hover:bg-hover flex items-center gap-1 transition-colors"
                          >
                            <Icon name="copy" className="w-3.5 h-3.5" />
                            <span>复制</span>
                          </button>
                          <button
                            onClick={() => setSaveNoteModalOpen(true)}
                            className="px-2 py-1 rounded-lg text-[11.5px] text-secondary hover:text-primary hover:bg-hover flex items-center gap-1 transition-colors"
                          >
                            <Icon name="fileText" className="w-3.5 h-3.5" />
                            <span>存入笔记</span>
                          </button>
                          <button
                            onClick={() => setCreateTaskModalOpen(true)}
                            className="px-2 py-1 rounded-lg text-[11.5px] text-secondary hover:text-primary hover:bg-hover flex items-center gap-1 transition-colors"
                          >
                            <Icon name="checkSquare" className="w-3.5 h-3.5" />
                            <span>创建任务</span>
                          </button>
                        </div>

                        {msg.hasWebSources && webSourcesList.length > 0 && (
                          <button
                            onClick={(event) => { event.stopPropagation(); setSourcesSearch(''); setSourcesModalOpen(true); }}
                            className="px-2.5 py-1 rounded-full bg-surface border border-border hover:border-primary/25 text-[11px] font-medium text-secondary hover:text-primary flex items-center gap-1.5 shadow-2xs transition-all"
                          >
                            <Icon name="globe" className="w-3 h-3 text-secondary" />
                            <span>{webSourcesList.length} 个来源</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </main>

        {/* 4. 底部三层统一悬浮输入台（Composer） */}
        <div className="px-3 sm:px-4 pb-3 pt-1 bg-gradient-to-t from-canvas via-canvas to-transparent shrink-0 relative z-20">
          {/* 超限错误柔和轻提示条 */}
          {uploadError && (
            <div className="mb-2 px-3 py-2 rounded-xl bg-rose-50/90 border border-rose-200/80 text-rose-800 text-[11.5px] flex items-center justify-between gap-2 animate-fadeIn">
              <div className="flex items-center gap-2 min-w-0">
                <Icon name="alertCircle" className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                <span className="truncate">
                  「<strong className="font-medium">{uploadError.fileName}</strong>」超出 {uploadError.limit} 限制（{uploadError.size}），未添加
                </span>
              </div>
              <button onClick={() => setUploadError(null)} className="text-rose-500 hover:text-rose-800 shrink-0 p-0.5">
                <Icon name="x" className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* 旧对话未授权给新账号：单行极简磨砂授权条（取代原版双重堆叠大框） */}
          {chatAuthNeeded && (
            <div className="mb-2 px-3 py-2 rounded-xl bg-amber-50/95 border border-amber-200/90 text-amber-900 text-[11.5px] flex flex-wrap items-center justify-between gap-2 animate-fadeIn">
              <div className="flex items-center gap-2 min-w-0">
                <Icon name="lock" className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span className="truncate">
                  此旧对话尚未授权给 <strong className="font-semibold">{currentAccountObj.email}</strong>（{currentAccountObj.workspace}）
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                <button
                  onClick={() => { setChatAuthNeeded(false); triggerToast(`已允许 ${currentAccountObj.email} 读取本对话历史`); }}
                  className="px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-medium hover:opacity-90"
                >
                  允许读取
                </button>
                <button
                  onClick={() => {
                    setActiveAccountId('follow');
                    setChatAuthNeeded(false);
                    setAccountSwitchedBanner(null);
                    triggerToast('已切回原账号（跟随 Codex 桌面）');
                  }}
                  className="px-2 py-1 rounded-lg bg-surface border border-amber-200 text-amber-900 hover:bg-amber-100/60 text-[11px] font-medium"
                >
                  换回原账号
                </button>
              </div>
            </div>
          )}

          {/* 账号已切换轻胶囊提示（移出输入框内部，不挤压打字区） */}
          {accountSwitchedBanner && !chatAuthNeeded && (
            <div className="mb-2 px-3 py-1.5 rounded-xl bg-surface/90 border border-border text-[11.5px] text-secondary flex items-center justify-between gap-2 shadow-2xs animate-fadeIn">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-green shrink-0"></span>
                <span className="truncate">
                  当前使用 <strong className="font-medium text-primary">{accountSwitchedBanner.email}</strong> · {accountSwitchedBanner.workspace}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => { closeAllPopovers(); setAccountSheetOpen(true); }}
                  className="text-primary font-medium hover:underline text-[11px]"
                >
                  管理账号
                </button>
                <button onClick={() => setAccountSwitchedBanner(null)} className="text-muted hover:text-primary p-0.5" title="隐藏提示">
                  <Icon name="x" className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}

          {/* 主输入卡片 */}
          <div className="bg-surface rounded-[20px] border border-border shadow-composer flex flex-col overflow-visible transition-all focus-within:border-primary/25">
            {/* 标签助手专属胶囊槽位（仅在标签助手模式下出现） */}
            {taskMode === 'tag' && (
              <div className="px-3 pt-2.5 pb-1.5 border-b border-emerald-200/60 bg-emerald-50/30 flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => { closeAllPopovers(); setTagSearchQuery(''); setTagPickerSlot('target'); }}
                  className={`h-[26px] px-2.5 rounded-lg border text-[11.5px] font-medium inline-flex items-center gap-1 transition-colors ${targetTag ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-surface border-dashed border-emerald-300 text-emerald-700 hover:bg-emerald-50/60'}`}
                >
                  <Icon name="tag" className="w-3 h-3" />
                  <span>{targetTag ? (tagWorkspace ? '#' + targetTag : targetTag) : '选择目标标签'}</span>
                </button>
                {tagSubTab === 'compare' && (
                  <button
                    onClick={() => { closeAllPopovers(); setTagSearchQuery(''); setTagPickerSlot('compare'); }}
                    className={`h-[26px] px-2.5 rounded-lg border text-[11.5px] font-medium inline-flex items-center gap-1 transition-colors ${compareTag ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-surface border-dashed border-border text-secondary hover:text-primary'}`}
                  >
                    <Icon name="tag" className="w-3 h-3" />
                    <span>{compareTag ? (tagWorkspace ? '#' + compareTag : compareTag) : '选择比较标签'}</span>
                  </button>
                )}
                {tagSubTab === 'find' && (
                  <span className="text-[11px] text-secondary ml-1">将仅核查当前资料库中缺失该标签的页面</span>
                )}
              </div>
            )}

            {/* 第 1 层：结构化上下文胶囊 + 独立 68×68 纯图缩略图轨 */}
            {(selectedDocs.length > 0 || attachedSkills.length > 0 || attachedLocalFiles.length > 0 || attachedImages.length > 0) && (
              <div className="px-3 pt-2.5 pb-1.5 border-b border-border/50 space-y-2">
                {/* 等高紧凑胶囊行 */}
                <div className={`flex flex-wrap items-center gap-1.5 ${workspaceContext ? 'max-h-24 overflow-y-auto' : ''}`}>
                  {selectedDocs.map(id => availableDocs.find(doc => doc.id === id)).filter(Boolean).map(doc => (
                    <span key={doc.id} className="h-[26px] pl-2 pr-1.5 rounded-lg bg-subtle border border-border/70 text-[11.5px] text-primary inline-flex items-center gap-1.5 max-w-[160px]">
                      <Icon name="fileText" className="w-3 h-3 text-secondary shrink-0" />
                      <span className="truncate" title={doc.name}>{doc.name}</span>
                      <button aria-label={`移除资料 ${doc.name}`} onClick={() => setSelectedDocs(prev => prev.filter(id => id !== doc.id))} className="text-muted hover:text-primary">
                        <Icon name="x" className="w-3 h-3" />
                      </button>
                    </span>
                  ))}

                  {attachedSkills.map(sk => (
                    <span key={sk} className="h-[26px] pl-2 pr-1.5 rounded-lg bg-accent-indigo/10 border border-accent-indigo/20 text-[11.5px] text-accent-indigo font-medium inline-flex items-center gap-1.5 max-w-[160px]">
                      <Icon name="zap" className="w-3 h-3 shrink-0" />
                      <span className="truncate">{sk}</span>
                      <button onClick={() => setAttachedSkills(prev => prev.filter(s => s !== sk))} className="text-accent-indigo/70 hover:text-accent-indigo">
                        <Icon name="x" className="w-3 h-3" />
                      </button>
                    </span>
                  ))}

                  {visibleLocalFiles.map(file => {
                    const st = renderFileStyle(file.type);
                    return (
                      <span key={file.id} className="h-[26px] pl-2 pr-1.5 rounded-lg bg-surface border border-border text-[11.5px] text-primary inline-flex items-center gap-1.5 max-w-[165px]">
                        <Icon name={st.icon} className={`w-3 h-3 shrink-0 ${st.color}`} />
                        <span className="truncate">{file.name}</span>
                        <button onClick={() => setAttachedLocalFiles(prev => prev.filter(f => f.id !== file.id))} className="text-muted hover:text-primary">
                          <Icon name="x" className="w-3 h-3" />
                        </button>
                      </span>
                    );
                  })}

                  {hiddenFilesCount > 0 && (
                    <button
                      onClick={() => setExpandAllFiles(v => !v)}
                      className="h-[26px] px-2 rounded-lg bg-subtle hover:bg-hover border border-border text-[11px] font-medium text-secondary hover:text-primary transition-colors"
                    >
                      {expandAllFiles ? '收起文件' : `+${hiddenFilesCount} 个文件`}
                    </button>
                  )}
                </div>

                {/* 独立 68×68 纯图缩略图轨（绝不与文字胶囊混排） */}
                {attachedImages.length > 0 && (
                  <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-0.5">
                    {attachedImages.map(img => (
                      <div
                        key={img.id}
                        onClick={() => setPreviewImage(img)}
                        className="relative w-[68px] h-[68px] rounded-xl overflow-hidden border border-border shadow-2xs shrink-0 cursor-pointer group"
                        title={`${img.name} (${img.size}) - 点击放大`}
                      >
                        <ThumbArtwork kind={img.kind} />
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent px-1.5 py-0.5 text-[9.5px] text-white truncate">
                          {img.name}
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); setAttachedImages(prev => prev.filter(i => i.id !== img.id)); }}
                          className="absolute top-1 right-1 w-[18px] h-[18px] rounded-full bg-black/55 glass text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Icon name="x" className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 第 2 层：清爽输入区 */}
            <div className="px-3.5 pt-2.5 pb-1">
              <textarea
                rows={2}
                value={inputText}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                placeholder="继续追问，输入 / 调用技能，@ 引用资料..."
                className="w-full resize-none bg-transparent text-[13.5px] text-primary placeholder:text-muted focus:outline-none leading-relaxed"
              />
            </div>

            {/* 第 3 层：极简操作底栏 */}
            <div className="px-2.5 pb-2 pt-1 flex items-center justify-between gap-2">
              {/* 左侧控制组 */}
              <div className="flex items-center gap-1 min-w-0">
                <button
                  onClick={() => {
                    const next = !plusMenuOpen;
                    closeAllPopovers();
                    setPlusMenuOpen(next);
                  }}
                  className="w-7 h-7 rounded-lg hover:bg-hover text-secondary hover:text-primary flex items-center justify-center transition-colors shrink-0"
                  title="添加附件或图片"
                >
                  <Icon name="plus" className="w-4 h-4" />
                </button>

                <button
                  onClick={() => { closeAllPopovers(); setScopeModalOpen(true); }}
                  className="h-7 px-2 rounded-lg hover:bg-hover border border-transparent hover:border-border text-[11.5px] text-primary font-medium flex items-center gap-1.5 transition-colors shrink-0"
                  title="配置核心材料与可检索资料库"
                >
                  <Icon name="database" className="w-3.5 h-3.5 text-secondary" />
                  <span className="truncate max-w-[96px]">
                    {availableLibs.find(lib => lib.id === selectedLibs[0])?.name || '未选库'} · {selectedDocs.length}篇
                  </span>
                  <Icon name="chevronDown" className="w-3 h-3 opacity-55" />
                </button>

                <button
                  onClick={() => {
                    const next = !skillsPopoverOpen;
                    closeAllPopovers();
                    setSkillsDetailView(null);
                    setSkillsPopoverOpen(next);
                  }}
                  className="relative w-7 h-7 rounded-lg hover:bg-hover text-secondary hover:text-primary flex items-center justify-center transition-colors shrink-0"
                  title={`挂载技能 (${attachedSkills.length} 个已挂载)`}
                >
                  <Icon name="zap" className={`w-3.5 h-3.5 ${attachedSkills.length > 0 ? 'text-accent-indigo' : ''}`} />
                  {attachedSkills.length > 0 && (
                    <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-accent-indigo"></span>
                  )}
                </button>

                <button
                  onClick={() => { closeAllPopovers(); setMemorySheetOpen(true); }}
                  className="relative h-7 px-1.5 sm:px-2 rounded-lg hover:bg-hover text-[11.5px] font-medium flex items-center gap-1.5 text-secondary hover:text-primary transition-colors shrink-0"
                  title={`管理对话记忆（${memoryActive ? memoryScope : '已关闭'}）`}
                >
                  <span className="relative flex items-center justify-center">
                    <Icon name="brain" className={`w-3.5 h-3.5 ${memoryActive ? 'text-amber-600' : 'text-muted'}`} />
                    {memoryActive && (
                      <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-500 ring-1 ring-surface"></span>
                    )}
                  </span>
                  <span className="hidden sm:inline truncate max-w-[78px] text-primary/90">
                    {memoryActive ? memoryScope : '已关记忆'}
                  </span>
                </button>
              </div>

              {/* 右侧：厂商图标 + 型号短名 + 思考强度 + 发送 */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => {
                    const next = !modelPopoverOpen;
                    closeAllPopovers();
                    setModelPopoverOpen(next);
                  }}
                  className="h-7 px-2 rounded-lg hover:bg-hover border border-transparent hover:border-border text-[11.5px] text-primary font-medium flex items-center gap-1.5 transition-colors"
                  title={`当前模型：${currentModelObj.id}（思考强度：${reasoningLabels[reasoningLevel]}）`}
                >
                  <VendorIcon vendor={currentModelObj.vendor} className="w-3.5 h-3.5" />
                  <span className="max-w-[84px] truncate">{currentModelObj.shortName}</span>
                  <span className="text-muted/70">·</span>
                  <span className="text-secondary">{reasoningLabels[reasoningLevel]}</span>
                  <Icon name="chevronDown" className="w-3 h-3 opacity-55" />
                </button>

                <button
                  onClick={handleSendMessage}
                  disabled={!canSend}
                  className="w-7 h-7 rounded-xl bg-primary text-white flex items-center justify-center disabled:opacity-25 hover:opacity-90 transition-opacity shrink-0"
                  title="发送 (Enter)"
                >
                  <Icon name="arrowUp" className="w-3.5 h-3.5" strokeWidth={2.2} />
                </button>
              </div>
            </div>
          </div>

          {/* + 附件菜单 Popover */}
          {plusMenuOpen && (
            <div className="absolute bottom-[74px] left-4 w-56 bg-surface/95 glass rounded-2xl border border-border shadow-popover p-1.5 z-40 text-xs animate-fadeIn">
              <button
                onClick={() => {
                  setAttachedImages(prev => [...prev, { id: 'img_' + Date.now(), name: `capture_${prev.length + 1}.png`, size: '310 KB', kind: 'terminal' }]);
                  setPlusMenuOpen(false);
                  triggerToast('已添加图片缩略图');
                }}
                className="w-full px-2.5 py-2 rounded-xl hover:bg-hover flex items-center gap-2 text-primary"
              >
                <Icon name="image" className="w-3.5 h-3.5 text-secondary" />
                <span>添加示例图片</span>
              </button>
              <button
                onClick={() => {
                  setUploadError({ fileName: '会话示例录音.flac', size: '34.2 MB', limit: '10 MB' });
                  setPlusMenuOpen(false);
                }}
                className="w-full px-2.5 py-2 rounded-xl hover:bg-hover flex items-center gap-2 text-rose-700"
              >
                <Icon name="audio" className="w-3.5 h-3.5" />
                <span>模拟超限音频提示</span>
              </button>
            </div>
          )}

          {/* / 技能快捷触发菜单 */}
          {slashMenuOpen && (
            <div className="absolute bottom-[74px] left-4 w-64 bg-surface/95 glass rounded-2xl border border-border shadow-popover p-1.5 z-40 text-xs animate-fadeIn">
              <div className="px-2 py-1 text-[10.5px] font-semibold text-muted">快捷调用技能 (/)</div>
              {managedSkills.filter(s => s.enabled).map(sk => (
                <button
                  key={sk.id}
                  onClick={() => {
                    if (!attachedSkills.includes(sk.name)) setAttachedSkills(prev => [...prev, sk.name]);
                    setInputText(prev => prev.replace(/\/$/, ''));
                    setSlashMenuOpen(false);
                  }}
                  className="w-full px-2.5 py-1.5 rounded-xl hover:bg-hover text-left flex items-center justify-between gap-2"
                >
                  <span className="font-medium text-primary truncate">{sk.name}</span>
                  <span className="text-[10px] text-accent-indigo shrink-0">挂载</span>
                </button>
              ))}
            </div>
          )}

          {/* @ 资料引用快捷触发菜单 */}
          {atMenuOpen && (
            <div className="absolute bottom-[74px] left-4 w-64 max-h-[40vh] overflow-y-auto bg-surface/95 glass rounded-2xl border border-border shadow-popover p-1.5 z-40 text-xs animate-fadeIn">
              <div className="px-2 py-1 text-[10.5px] font-semibold text-muted">引用核心资料 (@)</div>
              {availableDocs.map(doc => (
                <button
                  key={doc.id}
                  onClick={() => {
                    if (!selectedDocs.includes(doc.id)) setSelectedDocs(prev => [...prev, doc.id]);
                    setInputText(prev => prev.replace(/@$/, ''));
                    setAtMenuOpen(false);
                  }}
                  className="w-full px-2.5 py-1.5 rounded-xl hover:bg-hover text-left flex items-center justify-between gap-2"
                >
                  <span className="font-medium text-primary truncate">{doc.name}</span>
                  <span className="text-[10px] text-muted shrink-0">引用</span>
                </button>
              ))}
            </div>
          )}

          {/* 标签助手可搜索标签浮层 */}
          {tagPickerSlot && (
            <div className="absolute bottom-[132px] left-4 w-72 bg-surface/95 glass rounded-2xl border border-border shadow-popover p-2.5 z-40 space-y-2 animate-fadeIn">
              <div className="flex items-center justify-between px-0.5">
                <span className="text-[11px] font-semibold text-primary">
                  {tagPickerSlot === 'target' ? '选择目标标签' : '选择比较标签'}
                </span>
                <button onClick={() => setTagPickerSlot(null)} className="text-muted hover:text-primary">
                  <Icon name="x" className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="relative">
                <Icon name="search" className="w-3.5 h-3.5 text-muted absolute left-2.5 top-2" />
                <input
                  autoFocus
                  value={tagSearchQuery}
                  onChange={(e) => setTagSearchQuery(e.target.value)}
                  placeholder="搜索全部标签..."
                  className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-subtle border border-border text-xs focus:outline-none"
                />
              </div>
              <div className="max-h-48 overflow-y-auto space-y-0.5">
                {availableTags
                  .filter(t => t.name.toLowerCase().includes(tagSearchQuery.toLowerCase()))
                  .map(t => (
                    <button
                      key={t.name}
                      onClick={() => {
                        if (tagPickerSlot === 'target') setTargetTag(t.value ?? t.name);
                        else setCompareTag(t.value ?? t.name);
                        setTagPickerSlot(null);
                      }}
                      className="w-full px-2.5 py-1.5 rounded-xl hover:bg-hover flex items-center justify-between text-xs"
                    >
                      <span className="font-medium text-primary">{t.name}</span>
                      <span className="font-mono text-[10.5px] text-muted">{t.count} 篇</span>
                    </button>
                  ))}
              </div>
            </div>
          )}

          {/* 模型与推理深度 Popover */}
          {modelPopoverOpen && (
            <div className="absolute bottom-[74px] right-4 w-[296px] bg-surface/95 glass rounded-2xl border border-border shadow-popover p-2.5 z-40 space-y-2.5 animate-fadeIn">
              <div className="flex items-center justify-between px-1">
                <span className="text-[11px] font-semibold text-primary">模型与推理深度</span>
                <button onClick={() => setModelPopoverOpen(false)} className="text-muted hover:text-primary">
                  <Icon name="x" className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="space-y-1">
                {availableModels.map(m => {
                  const active = selectedModel === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => handleSelectModel(m)}
                      className={`w-full p-2 rounded-xl text-left flex items-center justify-between gap-2 transition-all ${active ? 'bg-subtle border border-primary/20' : 'hover:bg-hover border border-transparent'}`}
                    >
                      <div className="flex items-start gap-2 min-w-0">
                        <VendorIcon vendor={m.vendor} className="w-4 h-4 mt-0.5" />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-primary flex items-center gap-1.5">
                            <span className="truncate">{m.id}</span>
                            {active && <Icon name="check" className="w-3.5 h-3.5 text-primary shrink-0" />}
                          </div>
                          <div className="text-[10.5px] text-muted truncate">{m.desc}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {m.web && <Icon name="globe" className="w-3.5 h-3.5 text-secondary" />}
                        {m.reasoning && <Icon name="brain" className="w-3.5 h-3.5 text-accent-indigo" />}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="pt-2 border-t border-border/70 space-y-2">
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-secondary px-1">思考强度</div>
                  <div className="grid bg-subtle p-0.5 rounded-xl border border-border text-xs" style={{ gridTemplateColumns: "repeat(" + currentReasoningTiers.length + ", minmax(0, 1fr))" }}>
                    {currentReasoningTiers.map(({ id: lv }) => (
                      <button
                        key={lv}
                        onClick={() => setReasoningLevel(lv)}
                        className={`py-1 rounded-lg font-medium transition-all ${reasoningLevel === lv ? 'bg-surface text-primary shadow-xs' : 'text-secondary hover:text-primary'}`}
                      >
                        {reasoningLabels[lv]}
                      </button>
                    ))}
                  </div>
                </div>
                {currentReasoning && <p className="px-1 text-[10px] text-muted">{currentReasoning.desc}</p>}
                <div className="flex items-center justify-between px-1 pt-0.5">
                  <span className="text-[11px] font-medium text-secondary">响应速度</span>
                  <div className="flex bg-subtle p-0.5 rounded-lg border border-border text-[11px]">
                    <button
                      onClick={() => setResponseSpeed('standard')}
                      className={`px-2 py-0.5 rounded-md font-medium transition-all ${responseSpeed === 'standard' ? 'bg-surface text-primary shadow-xs' : 'text-secondary'}`}
                    >
                      标准
                    </button>
                    <button
                      disabled={!currentModelObj.supportsFastMode} onClick={() => setResponseSpeed('fast')}
                      className={`px-2 py-0.5 rounded-md font-medium transition-all ${responseSpeed === 'fast' ? 'bg-surface text-primary shadow-xs' : 'text-secondary'}`}
                    >
                      加速
                    </button>
                  </div>
                </div>
                {/* Codex 账号高频快捷入口（无需再钻三级系统设置） */}
                <div className="pt-2 border-t border-border/60">
                  <button
                    onClick={() => { setModelPopoverOpen(false); setAccountSheetOpen(true); }}
                    className="w-full px-2 py-1.5 rounded-xl bg-subtle/70 hover:bg-hover border border-border/60 flex items-center justify-between gap-2 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${currentAccountObj.status === 'active' ? 'bg-accent-green' : 'bg-rose-500'}`}></span>
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium text-primary truncate">
                          {currentAccountObj.email} · {currentAccountObj.workspace}
                        </div>
                        <div className="text-[9.5px] text-muted truncate">
                          {currentAccountObj.type === 'follow' ? '跟随 Codex 桌面登录' : `固定账号 · ${currentAccountObj.plan}`}
                        </div>
                      </div>
                    </div>
                    <span className="text-[10.5px] font-medium text-secondary shrink-0">切换 ›</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 技能选择 Popover（高频一键挂载 + 底部直达 Hub/Codex 技能管理） */}
          {skillsPopoverOpen && (
            <div className="absolute bottom-[74px] left-4 w-[296px] bg-surface/95 glass rounded-2xl border border-border shadow-popover overflow-hidden z-40 animate-fadeIn">
              {!skillsDetailView ? (
                <div className="flex flex-col">
                  <div className="px-3 py-2.5 border-b border-border/60 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11.5px] font-semibold text-primary">技能库</span>
                      <span className="px-1.5 py-0.5 rounded-md bg-accent-indigo/10 text-accent-indigo text-[9.5px] font-medium">
                        Hub · Codex 通用
                      </span>
                    </div>
                    <button onClick={() => setSkillsPopoverOpen(false)} className="text-muted hover:text-primary">
                      <Icon name="x" className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="p-2 space-y-1 max-h-56 overflow-y-auto">
                    {managedSkills.filter(s => s.enabled).map(sk => {
                      const isAttached = attachedSkills.includes(sk.name);
                      return (
                        <div
                          key={sk.id}
                          onClick={() => setSkillsDetailView(sk)}
                          className="p-2 rounded-xl hover:bg-hover border border-border/40 flex items-center justify-between gap-2 cursor-pointer transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-primary flex items-center gap-1.5">
                              <span className="truncate">{sk.name}</span>
                              {sk.kind === 'package' && (
                                <span className="px-1 py-0.2 rounded bg-subtle border border-border text-[9.5px] font-normal text-secondary shrink-0">
                                  {sk.version}
                                </span>
                              )}
                            </div>
                            <div className="text-[10.5px] text-muted truncate mt-0.5">{sk.desc}</div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isAttached) setAttachedSkills(prev => prev.filter(s => s !== sk.name));
                              else setAttachedSkills(prev => [...prev, sk.name]);
                            }}
                            className={`p-1.5 rounded-lg shrink-0 transition-colors ${isAttached ? 'bg-accent-indigo text-white' : 'bg-subtle text-secondary hover:text-primary'}`}
                          >
                            <Icon name={isAttached ? 'check' : 'plus'} className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="px-3 py-2 border-t border-border/60 bg-subtle/40 flex items-center justify-between text-[11px]">
                    <span className="text-muted flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${codexSyncEnabled ? 'bg-accent-green' : 'bg-muted'}`}></span>
                      <span>{codexSyncEnabled ? '已与 Codex 同步' : '仅本地生效'}</span>
                    </span>
                    <button
                      onClick={() => { setSkillsPopoverOpen(false); setSkillsManagerOpen(true); }}
                      className="text-primary font-medium hover:underline flex items-center gap-0.5"
                    >
                      <span>管理技能</span>
                      <Icon name="chevronRight" className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-3 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between pb-1.5 border-b border-border/60">
                    <button onClick={() => setSkillsDetailView(null)} className="flex items-center gap-1 text-secondary hover:text-primary font-medium">
                      <Icon name="arrowLeft" className="w-3.5 h-3.5" />
                      <span>返回</span>
                    </button>
                    <button
                      onClick={() => triggerToast(`已在外部编辑器打开 ${skillsDetailView.file}`)}
                      className="text-[11px] text-accent-indigo hover:underline"
                    >
                      ↗ 查看源文件
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-primary text-sm">{skillsDetailView.name}</span>
                    <span className="px-1.5 py-0.5 rounded-md bg-subtle border border-border text-[10px] text-secondary">{skillsDetailView.version}</span>
                  </div>
                  <p className="text-secondary leading-relaxed">{skillsDetailView.desc}</p>
                  <button
                    onClick={() => {
                      if (!attachedSkills.includes(skillsDetailView.name)) setAttachedSkills(prev => [...prev, skillsDetailView.name]);
                      setSkillsDetailView(null);
                      setSkillsPopoverOpen(false);
                    }}
                    className="w-full py-2 rounded-xl bg-primary text-white font-medium text-xs hover:opacity-90"
                  >
                    添加到本次对话
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ================= 抽屉与模态面板区 ================= */}

        {/* 左侧对话历史抽屉 */}
        {historyOpen && (
          <div className="absolute inset-0 z-40 flex">
            <div className="w-72 bg-surface/95 glass h-full border-r border-border shadow-sheet flex flex-col animate-fadeIn">
              <div className="h-12 px-3.5 border-b border-border flex items-center justify-between">
                <span className="text-xs font-semibold text-primary">对话历史</span>
                <button onClick={() => setHistoryOpen(false)} className="p-1 text-muted hover:text-primary rounded-lg">
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {workspaceContext ? (
                  <button onClick={() => setHistoryOpen(false)} className="w-full px-2.5 py-2 rounded-xl hover:bg-hover text-left text-xs font-medium text-primary truncate">
                    {threadTitle}
                  </button>
                ) : historyList.map(item => (
                  <div
                    key={item.id}
                    onClick={() => {
                      switchDemoCase(item.caseKey || 'report');
                      setThreadTitle(item.title);
                      setHistoryOpen(false);
                    }}
                    className="group px-2.5 py-2 rounded-xl hover:bg-hover flex items-center justify-between gap-2 cursor-pointer transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-primary truncate">{item.title}</div>
                      <div className="text-[10.5px] text-muted mt-0.5">{item.time}</div>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setHistoryList(prev => prev.map(h => h.id === item.id ? { ...h, pinned: !h.pinned } : h));
                        }}
                        className={`p-1 rounded-md ${item.pinned ? 'text-primary' : 'text-muted hover:text-primary'}`}
                      >
                        <Icon name="pin" className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setHistoryList(prev => prev.filter(h => h.id !== item.id));
                        }}
                        className="p-1 rounded-md text-muted hover:text-rose-600"
                      >
                        <Icon name="trash" className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex-1 bg-black/15" onClick={() => setHistoryOpen(false)} />
          </div>
        )}

        {/* 右侧 Inspector 检查器抽屉 */}
        {inspectorOpen && (
          <div className="absolute inset-0 z-40 flex justify-end">
            <div className="flex-1 bg-black/10" onClick={() => setInspectorOpen(false)} />
            <div className="w-[332px] max-w-[88%] bg-canvas/95 glass h-full border-l border-border shadow-sheet flex flex-col animate-fadeIn">
              <div className="h-12 px-4 border-b border-border flex items-center justify-between">
                <span className="text-xs font-semibold text-primary">对话详情</span>
                <button aria-label="关闭对话详情" onClick={() => setInspectorOpen(false)} className="p-1 text-muted hover:text-primary rounded-lg">
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-3.5 space-y-3 text-xs">
                {/* 卡片 1：视图与工具 */}
                <div className="bg-surface rounded-2xl p-3.5 border border-border shadow-card space-y-2.5">
                  <div className="text-[10.5px] font-semibold text-muted uppercase tracking-wider">视图与工具</div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-primary">只看最新回复</span>
                    <Toggle label="只看最新回复" checked={onlyLatestReply} onChange={setOnlyLatestReply} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-primary">联网搜索</span>
                    <Toggle label="联网搜索" checked={webSearchEnabled} onChange={setWebSearchEnabled} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-primary">MCP 外部工具</span>
                    <Toggle label="MCP 外部工具" checked={mcpEnabled} onChange={setMcpEnabled} />
                  </div>
                </div>

                {/* 卡片 2：当前上下文入口 */}
                <div className="bg-surface rounded-2xl p-3.5 border border-border shadow-card space-y-2.5">
                  <div className="text-[10.5px] font-semibold text-muted uppercase tracking-wider">当前上下文</div>
                  <button
                    onClick={() => { setInspectorOpen(false); setAccountSheetOpen(true); }}
                    className="w-full flex items-center justify-between gap-3 py-0.5 text-left text-secondary hover:text-primary"
                  >
                    <span className="shrink-0">Codex 账号</span>
                    <span className="text-primary font-medium truncate flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${currentAccountObj.status === 'active' ? 'bg-accent-green' : 'bg-rose-500'}`}></span>
                      <span className="truncate">{currentAccountObj.workspace} · {currentAccountObj.plan} ›</span>
                    </span>
                  </button>
                  <button
                    onClick={() => { setInspectorOpen(false); setScopeModalOpen(true); }}
                    className="w-full flex items-center justify-between gap-3 py-0.5 text-left text-secondary hover:text-primary"
                  >
                    <span className="shrink-0">资料范围</span>
                    <span className="text-primary font-medium truncate">{selectedDocs.length} 篇 · {selectedLibs.length} 库 ›</span>
                  </button>
                  <button
                    onClick={() => { setInspectorOpen(false); setMemorySheetOpen(true); }}
                    className="w-full flex items-center justify-between gap-3 py-0.5 text-left text-secondary hover:text-primary"
                  >
                    <span className="shrink-0">管理版本记忆</span>
                    <span className="text-accent-amber font-medium truncate">{memoryActive ? memoryScope : '已关闭'} ›</span>
                  </button>
                  <button
                    onClick={() => { setInspectorOpen(false); setSkillsManagerOpen(true); }}
                    className="w-full flex items-center justify-between gap-3 py-0.5 text-left text-secondary hover:text-primary"
                  >
                    <span className="shrink-0">管理通用技能</span>
                    <span className="text-accent-indigo font-medium truncate">{managedSkills.filter(s => s.enabled).length} 个启用 ›</span>
                  </button>
                </div>

                {/* 卡片 3：底层诊断信息默认折叠 */}
                <div className="rounded-xl border border-border/80 bg-subtle/50 overflow-hidden">
                  <button
                    onClick={() => setDiagExpanded(v => !v)}
                    className="w-full px-3 py-2 flex items-center justify-between text-[11px] text-secondary hover:text-primary font-medium"
                  >
                    <span>运行诊断与用量</span>
                    <Icon name={diagExpanded ? 'chevronDown' : 'chevronRight'} className="w-3.5 h-3.5" />
                  </button>
                  {diagExpanded && (
                    <div className="px-3 pb-2.5 pt-1 border-t border-border/60 font-mono text-[10.5px] text-muted space-y-1">
                      <div>模型：{currentModelObj.id}</div>
                      <div>本轮回传：26,633 tokens</div>
                      <div>检索上限：15 块 / 16 次调用</div>
                      <div aria-label="用量示例">示例数据</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 资料范围居中命令面板（统一三段 Tab + 保存为自定义专题） */}
        {scopeModalOpen && (
          <div className="absolute inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn">
            <div className="w-full max-w-md bg-surface rounded-2xl border border-border shadow-sheet overflow-hidden flex flex-col max-h-[85%]">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <span className="text-xs font-semibold text-primary">资料范围</span>
                <button onClick={() => setScopeModalOpen(false)} className="text-muted hover:text-primary">
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>

              <div className="px-4 pt-3">
                <div className="grid grid-cols-3 bg-subtle p-0.5 rounded-xl border border-border text-[11.5px]">
                  {[
                    { id: 'docs', label: `核心材料 (${selectedDocs.length})` },
                    { id: 'libs', label: `资料库 (${selectedLibs.length})` },
                    { id: 'strategy', label: '使用策略' }
                  ].map(t => (
                    <button
                      key={t.id}
                      onClick={() => setScopeTab(t.id)}
                      className={`py-1.5 rounded-lg font-medium transition-all ${scopeTab === t.id ? 'bg-surface text-primary shadow-xs' : 'text-secondary hover:text-primary'}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-4 flex-1 overflow-y-auto space-y-2 text-xs">
                {scopeTab === 'docs' && (
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <Icon name="search" className="w-3.5 h-3.5 text-muted absolute left-2.5 top-2" />
                        <input
                          value={docSearchQuery}
                          onChange={(e) => setDocSearchQuery(e.target.value)}
                          placeholder="搜索标题、路径或资料库名..."
                          className="w-full pl-8 pr-2.5 py-1.5 rounded-xl bg-subtle border border-border text-xs focus:outline-none"
                        />
                      </div>
                      <div className="flex bg-subtle p-0.5 rounded-lg border border-border text-[11px] shrink-0">
                        <button
                          onClick={() => setDocFilterMode('all')}
                          className={`px-2 py-1 rounded-md font-medium ${docFilterMode === 'all' ? 'bg-surface text-primary shadow-xs' : 'text-secondary'}`}
                        >
                          全部
                        </button>
                        <button
                          onClick={() => setDocFilterMode('selected')}
                          className={`px-2 py-1 rounded-md font-medium ${docFilterMode === 'selected' ? 'bg-surface text-primary shadow-xs' : 'text-secondary'}`}
                        >
                          已选 {selectedDocs.length}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      {availableDocs
                        .filter(doc =>
                          (docFilterMode === 'all' || selectedDocs.includes(doc.id)) &&
                          (doc.name.toLowerCase().includes(docSearchQuery.toLowerCase()) || doc.path.toLowerCase().includes(docSearchQuery.toLowerCase()))
                        )
                        .map(doc => {
                          const checked = selectedDocs.includes(doc.id);
                          return (
                            <label key={doc.id} className={`p-2.5 rounded-xl border flex items-center justify-between gap-3 cursor-pointer transition-colors ${checked ? 'bg-subtle border-primary/20' : 'border-border hover:bg-hover'}`}>
                              <div className="min-w-0">
                                <div className="font-medium text-primary flex items-center gap-1.5">
                                  <span className="truncate">{doc.name}</span>
                                  {doc.current && <span className="px-1.5 py-0.2 rounded bg-primary text-white text-[9.5px]">{doc.current}</span>}
                                </div>
                                <div className="text-[10.5px] text-muted truncate mt-0.5">{doc.path}</div>
                              </div>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setSelectedDocs(prev => checked ? prev.filter(id => id !== doc.id) : [...prev, doc.id])}
                                className="accent-primary w-4 h-4 rounded"
                              />
                            </label>
                          );
                        })}
                    </div>
                  </div>
                )}

                {scopeTab === 'libs' && availableLibs.map(lib => {
                  const checked = selectedLibs.includes(lib.id);
                  return (
                    <div key={lib.id} className="p-2.5 rounded-xl border border-border flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className={`w-2.5 h-2.5 rounded-full ${lib.color} shrink-0`}></span>
                        <div className="min-w-0">
                          <div className="font-semibold text-primary">{lib.name}</div>
                          <div className="text-[10.5px] text-muted">{lib.source} · {lib.count}</div>
                        </div>
                      </div>
                      <Toggle checked={checked} label={lib.name} onChange={() => setSelectedLibs(prev => checked ? prev.filter(l => l !== lib.id) : [...prev, lib.id])} />
                    </div>
                  );
                })}

                {scopeTab === 'strategy' && (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      {[
                        { id: 'prefer', title: '优先用所选资料', desc: '先读所选资料，再按联网设置补充背景信息' },
                        { id: 'only', title: '只用所选资料', desc: '严格限定在已选核心页面与资料库内作答，不发散' }
                      ].map(opt => (
                        <button
                          key={opt.id}
                          onClick={() => setRetrievalStrategy(opt.id)}
                          className={`w-full p-3 rounded-xl border text-left flex items-center justify-between gap-2 ${retrievalStrategy === opt.id ? 'bg-subtle border-primary/25' : 'border-border hover:bg-hover'}`}
                        >
                          <div>
                            <div className="font-semibold text-primary">{opt.title}</div>
                            <div className="text-[11px] text-muted mt-0.5">{opt.desc}</div>
                          </div>
                          {retrievalStrategy === opt.id && <Icon name="check" className="w-4 h-4 text-primary shrink-0" />}
                        </button>
                      ))}
                    </div>

                    <details className="rounded-xl border border-border/80 bg-subtle/40 overflow-hidden text-[11.5px]">
                      <summary className="px-3 py-2 font-medium text-secondary hover:text-primary cursor-pointer">
                        固定清单与覆盖核对
                      </summary>
                      <div className="px-3 pb-3 pt-1.5 border-t border-border/60 flex items-center justify-between gap-3">
                        <span className="text-[11px] text-muted leading-relaxed">
                          开启后，每轮回答前会逐篇核对已选核心材料清单，防止遗漏任何一篇。
                        </span>
                        <Toggle checked={fixedChecklistCheck} onChange={setFixedChecklistCheck} />
                      </div>
                    </details>
                  </div>
                )}
              </div>

              <div className="px-4 py-3 border-t border-border bg-subtle/40 flex items-center justify-between gap-2">
                {savingTopicMode ? (
                  <div className="flex items-center gap-1.5 flex-1">
                    <input
                      autoFocus
                      value={newTopicName}
                      onChange={(e) => setNewTopicName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveCurrentAsTopic()}
                      placeholder="输入自定义专题名称..."
                      className="flex-1 px-2.5 py-1.5 rounded-xl bg-surface border border-primary/30 text-xs focus:outline-none"
                    />
                    <button
                      onClick={handleSaveCurrentAsTopic}
                      className="px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-medium shrink-0"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => setSavingTopicMode(false)}
                      className="p-1.5 text-muted hover:text-primary"
                    >
                      <Icon name="x" className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => setSavingTopicMode(true)}
                      className="px-3 py-1.5 rounded-xl bg-surface border border-border hover:bg-hover text-xs font-medium text-primary flex items-center gap-1.5"
                    >
                      <Icon name="layers" className="w-3.5 h-3.5 text-accent-indigo" />
                      <span>保存为专题</span>
                    </button>
                    <button
                      onClick={() => { setScopeModalOpen(false); triggerToast('资料范围已更新，将用于下一轮'); }}
                      className="px-4 py-1.5 rounded-xl bg-primary text-white text-xs font-medium hover:opacity-90"
                    >
                      应用范围
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 合并后的「存入笔记」Modal（追加到已有页面 | 新建笔记） */}
        {saveNoteModalOpen && (
          <div className="absolute inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn">
            <div className="w-full max-w-md bg-surface rounded-2xl border border-border shadow-sheet overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <span className="text-xs font-semibold text-primary">存入笔记</span>
                <button onClick={() => setSaveNoteModalOpen(false)} className="text-muted hover:text-primary">
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
              <div className="p-4 space-y-3.5 text-xs">
                <div className="grid grid-cols-2 bg-subtle p-0.5 rounded-xl border border-border">
                  <button
                    onClick={() => setSaveNoteTab('append')}
                    className={`py-1.5 rounded-lg font-medium ${saveNoteTab === 'append' ? 'bg-surface text-primary shadow-xs' : 'text-secondary'}`}
                  >
                    追加到已有页面
                  </button>
                  <button
                    onClick={() => setSaveNoteTab('new')}
                    className={`py-1.5 rounded-lg font-medium ${saveNoteTab === 'new' ? 'bg-surface text-primary shadow-xs' : 'text-secondary'}`}
                  >
                    新建独立笔记
                  </button>
                </div>

                {saveNoteTab === 'append' ? (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-medium text-secondary">目标页面</div>
                    <div className="flex flex-wrap gap-1.5">
                      {(workspaceContext ? [workspaceContext.name] : ['2023-02-02', '8_竞品和参考', 'DXF 线表规范']).map(p => (
                        <button
                          key={p}
                          onClick={() => setSaveNoteTarget(p)}
                          className={`px-2.5 py-1.5 rounded-xl border text-xs font-medium ${saveNoteTarget === p ? 'bg-primary text-white border-primary' : 'bg-subtle text-primary border-border'}`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="text-[11px] font-medium text-secondary">笔记标题（已自动提炼）</div>
                    <input
                      value={saveNoteTitle}
                      onChange={(e) => setSaveNoteTitle(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-subtle border border-border text-primary font-medium focus:outline-none"
                    />
                  </div>
                )}

                <div className="p-3 rounded-xl bg-canvas border border-border text-[11.5px] text-secondary leading-relaxed">
                  <div className="font-semibold text-primary mb-1">{saveNoteTitle}</div>
                  <p className="line-clamp-3">{workspaceContext ? currentMessagesList.findLast(msg => msg.role === 'assistant')?.text : '建议采用普通回执列表和一处 status 状态区。用户展开回执或离开列表末尾后，Hub 继续接收结果，同时保留阅读位置、展开状态和键盘焦点...'}</p>
                </div>
              </div>
              <div className="px-4 py-3 border-t border-border bg-subtle/40 flex items-center justify-end gap-2">
                <button onClick={() => setSaveNoteModalOpen(false)} className="px-3 py-1.5 rounded-xl text-xs text-secondary hover:bg-hover">
                  取消
                </button>
                <button
                  onClick={() => {
                    setSaveNoteModalOpen(false);
                    triggerToast(saveNoteTab === 'append' ? `已演示追加到「${saveNoteTarget}」` : `已演示新建笔记「${saveNoteTitle}」`);
                  }}
                  className="px-4 py-1.5 rounded-xl bg-primary text-white text-xs font-medium hover:opacity-90"
                >
                  {saveNoteTab === 'append' ? '确认追加' : '创建笔记'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 重构后的极简「创建任务」Modal（Things 3 / Linear 风格） */}
        {createTaskModalOpen && (
          <div className="absolute inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn">
            <div className="w-full max-w-md bg-surface rounded-2xl border border-border shadow-sheet overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <span className="text-xs font-semibold text-primary">创建行动任务</span>
                <button onClick={() => setCreateTaskModalOpen(false)} className="text-muted hover:text-primary">
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
              <div className="p-4 space-y-3.5 text-xs">
                <input
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  placeholder="任务名称..."
                  className="w-full text-sm font-semibold text-primary bg-transparent border-b border-border/70 pb-2 focus:outline-none focus:border-primary/40"
                />

                {/* 一行紧凑元数据胶囊 */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => setTaskList(prev => prev === '收件箱' ? 'Hub 开发' : '收件箱')}
                    className="px-2.5 py-1 rounded-lg bg-subtle border border-border text-[11px] font-medium text-primary flex items-center gap-1 hover:bg-hover"
                  >
                    <Icon name="database" className="w-3 h-3 text-secondary" />
                    <span>滴答 · {taskList}</span>
                  </button>
                  <button
                    onClick={() => setTaskDue(prev => prev === '明天' ? '本周五' : '明天')}
                    className="px-2.5 py-1 rounded-lg bg-subtle border border-border text-[11px] font-medium text-primary flex items-center gap-1 hover:bg-hover"
                  >
                    <Icon name="calendar" className="w-3 h-3 text-secondary" />
                    <span>{taskDue}</span>
                  </button>
                  <button
                    onClick={() => setTaskPriority(prev => prev === '高' ? '中' : '高')}
                    className="px-2.5 py-1 rounded-lg bg-amber-50 border border-amber-200/80 text-[11px] font-medium text-amber-800 flex items-center gap-1"
                  >
                    <Icon name="flag" className="w-3 h-3" />
                    <span>优先级：{taskPriority}</span>
                  </button>
                </div>

                {/* 自动提炼的子任务清单 */}
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-secondary">已提炼待办子项</div>
                  <div className="space-y-1.5">
                    {taskSubItems.map(st => (
                      <label key={st.id} className="p-2 rounded-xl bg-subtle/60 border border-border/60 flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={st.checked}
                          onChange={() => setTaskSubItems(prev => prev.map(item => item.id === st.id ? { ...item, checked: !item.checked } : item))}
                          className="accent-primary mt-0.5"
                        />
                        <span className={`text-[11.5px] leading-snug ${st.checked ? 'text-primary' : 'text-muted line-through'}`}>{st.text}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="pt-1 flex items-center justify-between text-[11.5px] text-secondary">
                  <span>附带完整复核报告作为备注</span>
                  <Toggle checked={taskAttachReport} onChange={setTaskAttachReport} />
                </div>
              </div>
              <div className="px-4 py-3 border-t border-border bg-subtle/40 flex items-center justify-end gap-2">
                <button onClick={() => setCreateTaskModalOpen(false)} className="px-3 py-1.5 rounded-xl text-xs text-secondary hover:bg-hover">
                  取消
                </button>
                <button
                  onClick={() => {
                    setCreateTaskModalOpen(false);
                    triggerToast(`已演示创建滴答任务至「${taskList}」`);
                  }}
                  className="px-4 py-1.5 rounded-xl bg-primary text-white text-xs font-medium hover:opacity-90"
                >
                  创建任务
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 网页来源 */}
        {sourcesModalOpen && (
          <div className="absolute inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn" onClick={event => { if (event.target === event.currentTarget) setSourcesModalOpen(false); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSourcesModalOpen(false); } }}>
            <div className="w-full max-w-md bg-surface rounded-2xl border border-border shadow-sheet overflow-hidden flex flex-col max-h-[80%]" role="dialog" aria-modal="true" aria-labelledby="reference-web-sources">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                  <Icon name="globe" className="w-3.5 h-3.5 text-secondary" />
                  <span id="reference-web-sources">网页追溯来源 ({webSourcesList.length})</span>
                </div>
                <button type="button" aria-label="关闭网页追溯来源" onClick={() => setSourcesModalOpen(false)} className="text-muted hover:text-primary p-1 rounded-lg">
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
              <div className="p-3 border-b border-border/60">
                <div className="relative">
                  <Icon name="search" className="w-3.5 h-3.5 text-muted absolute left-2.5 top-2" />
                  <input
                    autoFocus aria-label="筛选引用来源" value={sourcesSearch}
                    onChange={(e) => setSourcesSearch(e.target.value)}
                    placeholder="筛选引用来源..."
                    className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-subtle border border-border text-xs focus:outline-none"
                  />
                </div>
              </div>
              <div className="p-3 flex-1 overflow-y-auto space-y-1.5 text-xs">
                {visibleWebSources.map(src => (
                    <a
                      key={src.host}
                      href={"https://" + src.host} target="_blank" rel="noreferrer"
                      className="w-full p-2.5 rounded-xl border border-border/70 hover:bg-hover flex items-center justify-between gap-2.5 text-left transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <SiteFavicon site={src.badge} />
                        <div className="min-w-0">
                          <div className="font-medium text-primary truncate">{src.title}</div>
                          <div className="text-[10.5px] font-mono text-muted truncate mt-0.5">{src.host}</div>
                        </div>
                      </div>
                      <Icon name="externalLink" className="w-3.5 h-3.5 text-muted shrink-0" />
                    </a>
                  ))}
                {!visibleWebSources.length && <p role="status" className="px-2 py-2 text-secondary">未找到匹配来源。</p>}
              </div>
            </div>
          </div>
        )}

        {/* 重构后的「Codex 账号管理与切换」居中 Sheet（支持完整增删改查） */}
        {accountSheetOpen && (
          <div className="absolute inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn"
            onClick={event => { if (event.target === event.currentTarget) closeAccountSheet(); }}
            onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeAccountSheet(); } }}>
            <div className="w-full max-w-md bg-surface rounded-2xl border border-border shadow-sheet overflow-hidden flex flex-col max-h-[86%]" role="dialog" aria-modal="true" aria-label="Codex 账号管理">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Icon name="user" className="w-4 h-4 text-primary" />
                  <span className="text-xs font-semibold text-primary">Codex 账号管理</span><span className="text-[10.5px] text-muted">示例</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => triggerToast('已刷新全部账号登录状态')}
                    className="p-1.5 rounded-lg text-muted hover:text-primary hover:bg-hover"
                    title="刷新账号状态"
                  >
                    <Icon name="refresh" className="w-3.5 h-3.5" />
                  </button>
                  <button
                    autoFocus type="button" aria-label="关闭 Codex 账号管理" onClick={closeAccountSheet}
                    className="p-1.5 rounded-lg text-muted hover:text-primary hover:bg-hover"
                  >
                    <Icon name="x" className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="p-4 flex-1 overflow-y-auto space-y-2.5 text-xs">
                {/* 账号列表卡片（查 / 改 / 删） */}
                {codexAccounts.map(acc => {
                  const isCurrent = activeAccountId === acc.id;
                  const isPending = pendingSwitchId === acc.id;
                  const isExpired = acc.status === 'expired';
                  return (
                    <div
                      key={acc.id}
                      onClick={() => {
                        if (isCurrent || isExpired) return;
                        setPendingSwitchId(isPending ? null : acc.id);
                      }}
                      className={`rounded-2xl border p-3 transition-all ${
                        isCurrent
                          ? 'bg-subtle/80 border-primary/25 shadow-2xs'
                          : isPending
                          ? 'bg-surface border-primary/40 shadow-card'
                          : isExpired
                          ? 'bg-rose-50/35 border-rose-200/70'
                          : 'bg-surface border-border hover:bg-hover/60 cursor-pointer'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2.5">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-xs font-semibold shrink-0 border ${
                            isCurrent ? 'bg-primary text-white border-primary' : 'bg-subtle text-primary border-border'
                          }`}>
                            {acc.type === 'follow' ? <Icon name="link" className="w-3.5 h-3.5" /> : acc.workspace.slice(0, 1)}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-primary truncate">{acc.label}</span>
                              <span className="px-1.5 py-0.2 rounded bg-subtle border border-border text-[9.5px] font-medium text-secondary shrink-0">
                                {acc.plan}
                              </span>
                            </div>
                            <div className="text-[10.5px] text-muted mt-0.5 flex items-center gap-1.5 truncate">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isExpired ? 'bg-rose-500' : 'bg-accent-green'}`}></span>
                              <span className="truncate">
                                {acc.type === 'follow' ? `当前识别：${acc.email} · ${acc.workspace}` : `${acc.workspace} · ${isExpired ? '登录已失效' : '正常可用'}`}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          {isCurrent && (
                            <span className="px-2 py-0.5 rounded-md bg-primary/10 text-primary text-[10.5px] font-medium">使用中</span>
                          )}
                          {isExpired && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setCodexAccounts(prev => prev.map(item => item.id === acc.id ? { ...item, status: 'active' } : item));
                                triggerToast(`已重新登录并恢复 ${acc.email}`);
                              }}
                              className="px-2.5 py-1 rounded-lg bg-rose-600 text-white text-[10.5px] font-medium hover:opacity-90"
                            >
                              重新登录
                            </button>
                          )}
                          {acc.type !== 'follow' && !isCurrent && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setCodexAccounts(prev => prev.filter(item => item.id !== acc.id));
                                if (pendingSwitchId === acc.id) setPendingSwitchId(null);
                                triggerToast(`已移除账号 ${acc.email}`);
                              }}
                              className="p-1.5 rounded-lg text-muted hover:text-rose-600 hover:bg-rose-50 transition-colors"
                              title="移除此账号"
                            >
                              <Icon name="trash" className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* 选中另一账号时原地平滑展开策略选择与确认（告别传统下拉表单） */}
                      {isPending && (
                        <div className="mt-3 pt-3 border-t border-border/70 space-y-2.5 animate-fadeIn" onClick={(e) => e.stopPropagation()}>
                          <div className="grid grid-cols-2 bg-subtle p-0.5 rounded-xl border border-border text-[11px]">
                            <button
                              onClick={() => setSwitchStrategy('continue')}
                              className={`py-1.5 rounded-lg font-medium transition-all ${switchStrategy === 'continue' ? 'bg-surface text-primary shadow-xs' : 'text-secondary'}`}
                            >
                              继续当前对话
                            </button>
                            <button
                              onClick={() => setSwitchStrategy('new')}
                              className={`py-1.5 rounded-lg font-medium transition-all ${switchStrategy === 'new' ? 'bg-surface text-primary shadow-xs' : 'text-secondary'}`}
                            >
                              新建独立对话
                            </button>
                          </div>
                          <div className="text-[10.5px] text-muted leading-relaxed px-0.5">
                            {switchStrategy === 'continue'
                              ? '保留当前画面，发送下一条消息时会将续聊所需的必要历史提供给新账号。'
                              : '开启空白新对话，原对话与草稿保留在历史记录中，不向新账号共享旧内容。'}
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => setPendingSwitchId(null)}
                              className="px-3 py-1.5 rounded-xl text-xs text-secondary hover:bg-hover"
                            >
                              取消
                            </button>
                            <button
                              onClick={() => confirmSwitchAccount(acc.id, switchStrategy)}
                              className="px-3.5 py-1.5 rounded-xl bg-primary text-white text-xs font-medium hover:opacity-90"
                            >
                              确认切换
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* 模拟浏览器 OAuth 添加账号流程（消除添加后再手动选一遍的断层） */}
                {oauthFlow === 'pending' && (
                  <div className="rounded-2xl border border-accent-indigo/30 bg-accent-indigo/5 p-3.5 space-y-2.5 animate-fadeIn">
                    <div className="text-xs font-semibold text-primary">等待完成示例授权…</div>
                    <p className="text-[11px] text-secondary leading-relaxed">
                      请在刚打开的浏览器页面中选择要添加的账号并同意授权，完成后将自动同步回 Hub。
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => {
                          const newAcc = {
                            id: 'acc_' + Date.now(),
                            type: 'account',
                            label: 'team***@corp.ai',
                            email: 'team***@corp.ai',
                            plan: 'Pro',
                            workspace: '研发团队',
                            status: 'active'
                          };
                          setCodexAccounts(prev => [...prev, newAcc]);
                          setNewlyAddedAccId(newAcc.id);
                          setOauthFlow('ready');
                        }}
                        className="px-3 py-1.5 rounded-xl bg-primary text-white text-[11px] font-medium hover:opacity-90"
                      >
                        模拟授权完成
                      </button>
                      <button
                        onClick={() => triggerToast('已重新打开浏览器授权页')}
                        className="px-2.5 py-1.5 rounded-xl bg-surface border border-border text-[11px] text-primary hover:bg-hover"
                      >
                        重新打开登录页
                      </button>
                      <button
                        onClick={() => setOauthFlow('idle')}
                        className="px-2 py-1.5 rounded-xl text-[11px] text-muted hover:text-primary ml-auto"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}

                {oauthFlow === 'ready' && newlyAddedAccId && (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3 flex items-center justify-between gap-2 animate-fadeIn">
                    <div className="text-[11.5px] text-emerald-900 font-medium">
                      已添加新账号，是否立即切换？
                    </div>
                    <button
                      onClick={() => {
                        const targetId = newlyAddedAccId;
                        setOauthFlow('idle');
                        setNewlyAddedAccId(null);
                        confirmSwitchAccount(targetId, 'continue');
                      }}
                      className="px-3 py-1 rounded-xl bg-emerald-700 text-white text-[11px] font-medium hover:opacity-90 shrink-0"
                    >
                      立即切换
                    </button>
                  </div>
                )}
              </div>

              {/* 底栏：添加账号 + 模拟旧对话未授权测试入口 */}
              <div className="px-4 py-3 border-t border-border bg-subtle/40 flex items-center justify-between gap-2">
                <button
                  onClick={() => setOauthFlow('pending')}
                  disabled={oauthFlow === 'pending'}
                  className="px-3 py-1.5 rounded-xl bg-surface border border-border hover:bg-hover text-xs font-medium text-primary flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Icon name="plus" className="w-3.5 h-3.5" />
                  <span>添加 Codex 账号</span>
                </button>
                <button
                  onClick={() => {
                    setActiveAccountId(codexAccounts.find(account => account.type === 'account' && account.status === 'active')?.id || 'follow');
                    setAccountSheetOpen(false);
                    setChatAuthNeeded(true);
                  }}
                  className="text-[11px] text-secondary hover:text-primary hover:underline"
                  title="演示切换账号后打开旧对话触发的单行授权条"
                >
                  预览旧对话授权条 ›
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Craft 风格「管理记忆」全屏 Sheet（含红绿 Diff、来源溯源与完整编辑操作） */}
        {memorySheetOpen && (
          <div className="absolute inset-0 bg-canvas z-50 flex flex-col animate-fadeIn">
            <div className="h-12 border-b border-border px-4 flex items-center justify-between shrink-0 bg-canvas">
              <div className="flex items-center gap-2">
                <button onClick={() => setMemorySheetOpen(false)} className="p-1 text-secondary hover:text-primary rounded-lg hover:bg-hover">
                  <Icon name="arrowLeft" className="w-4 h-4" />
                </button>
                <span className="text-xs font-semibold text-primary">记忆管理</span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-muted text-[11.5px]">本对话启用</span>
                  <Toggle checked={memoryActive} onChange={setMemoryActive} />
                </div>
                <button
                  onClick={() => setAddingMemory(v => !v)}
                  className="px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-medium flex items-center gap-1 hover:opacity-90"
                >
                  <Icon name="plus" className="w-3 h-3" />
                  <span>新建记忆</span>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 max-w-xl mx-auto w-full text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <select
                    value={memoryScope}
                    onChange={(e) => setMemoryScope(e.target.value)}
                    className="px-3 py-1.5 rounded-xl bg-surface border border-border font-medium text-primary focus:outline-none shadow-2xs"
                  >
                    <option value="工程资料整理">工程资料整理</option>
                    <option value="个人通用">个人通用</option>
                    <option value="Hub 开发">Hub 开发</option>
                  </select>
                  <span className="text-[11px] text-muted hidden sm:inline">切换查看范围不影响当前对话</span>
                </div>
                <div className="flex bg-subtle p-0.5 rounded-xl border border-border">
                  <button onClick={() => setMemoryTab('saved')} className={`px-3 py-1 rounded-lg font-medium ${memoryTab === 'saved' ? 'bg-surface text-primary shadow-xs' : 'text-secondary'}`}>
                    已保存 ({memoryItems.length})
                  </button>
                  <button onClick={() => setMemoryTab('pending')} className={`px-3 py-1 rounded-lg font-medium ${memoryTab === 'pending' ? 'bg-surface text-primary shadow-xs' : 'text-secondary'}`}>
                    待确认 (0)
                  </button>
                </div>
              </div>

              {/* 新建记忆内联卡片 */}
              {addingMemory && (
                <div className="bg-surface rounded-2xl p-4 border border-primary/25 shadow-card space-y-2.5 animate-fadeIn">
                  <input
                    autoFocus
                    value={newMemoryTitle}
                    onChange={(e) => setNewMemoryTitle(e.target.value)}
                    placeholder="记忆标题（例如：DXF 线表字段命名约定）"
                    className="w-full text-xs font-semibold text-primary bg-subtle px-3 py-2 rounded-xl border border-border focus:outline-none"
                  />
                  <textarea
                    rows={2}
                    value={newMemoryContent}
                    onChange={(e) => setNewMemoryContent(e.target.value)}
                    placeholder="输入需要助手长期记住的事实、边界或偏好..."
                    className="w-full text-xs text-primary bg-subtle px-3 py-2 rounded-xl border border-border focus:outline-none resize-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setAddingMemory(false)} className="px-3 py-1 rounded-lg text-secondary hover:bg-hover">取消</button>
                    <button
                      onClick={() => {
                        if (!newMemoryTitle.trim()) return;
                        setMemoryItems(prev => [
                          {
                            id: 'mem_' + Date.now(),
                            scope: memoryScope,
                            title: newMemoryTitle.trim(),
                            version: '第 1 版',
                            updatedAt: '刚刚',
                            content: newMemoryContent.trim() || '用户手动添加的长期记忆规则。',
                            sourceId: '手动创建 · 当前工作空间',
                            enabled: true
                          },
                          ...prev
                        ]);
                        setNewMemoryTitle('');
                        setNewMemoryContent('');
                        setAddingMemory(false);
                        triggerToast('已保存新记忆');
                      }}
                      className="px-3 py-1 rounded-lg bg-primary text-white font-medium"
                    >
                      保存记忆
                    </button>
                  </div>
                </div>
              )}

              {memoryTab === 'saved' ? (
                <div className="space-y-3">
                  {memoryItems.map(item => (
                    <div key={item.id} className={`bg-surface rounded-2xl p-4 border shadow-card space-y-3 transition-opacity ${item.enabled ? 'border-border' : 'border-border/60 opacity-60'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-sm text-primary">{item.title}</span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {!item.enabled && <span className="px-1.5 py-0.5 rounded-md bg-subtle text-muted text-[10px]">已停用</span>}
                          <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200/80 text-[10.5px] font-medium">{item.version}</span>
                        </div>
                      </div>

                      {editingMemoryId === item.id ? (
                        <div className="space-y-2">
                          <textarea
                            rows={3}
                            value={editingMemoryText}
                            onChange={(e) => setEditingMemoryText(e.target.value)}
                            className="w-full p-2.5 rounded-xl bg-subtle border border-primary/25 text-xs text-primary focus:outline-none"
                          />
                          <div className="flex justify-end gap-2">
                            <button onClick={() => setEditingMemoryId(null)} className="px-2.5 py-1 rounded-lg text-secondary hover:bg-hover">取消</button>
                            <button
                              onClick={() => {
                                setMemoryItems(prev => prev.map(m => m.id === item.id ? { ...m, content: editingMemoryText } : m));
                                setEditingMemoryId(null);
                                triggerToast('已更新记忆内容');
                              }}
                              className="px-3 py-1 rounded-lg bg-primary text-white font-medium"
                            >
                              保存修改
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-secondary leading-relaxed">{item.content}</p>
                      )}

                      {/* 柔和红绿 Diff 版本历史 */}
                      {item.diffOld && (
                        <div className="pt-2 border-t border-border/60 space-y-2">
                          <button
                            onClick={() => setMemoryDiffExpanded(v => !v)}
                            className="text-[11px] font-medium text-secondary hover:text-primary flex items-center gap-1"
                          >
                            <Icon name={memoryDiffExpanded ? 'chevronDown' : 'chevronRight'} className="w-3.5 h-3.5" />
                            <span>版本变更对比 ({item.updatedAt})</span>
                          </button>
                          {memoryDiffExpanded && (
                            <div className="rounded-xl border border-border overflow-hidden text-[11.5px] font-mono">
                              <div className="px-3 py-2 bg-rose-50/80 text-rose-800 border-b border-rose-100">
                                - {item.diffOld}
                              </div>
                              <div className="px-3 py-2 bg-emerald-50/80 text-emerald-800">
                                + {item.diffNew}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* 来源溯源 + 编辑 / 停用 / 遗忘完整操作栏 */}
                      <div className="pt-2 border-t border-border/50 space-y-2">
                        <div className="flex items-center justify-between text-[11px]">
                          <button
                            onClick={() => setMemorySourceExpanded(v => !v)}
                            className="text-secondary hover:text-primary flex items-center gap-1"
                          >
                            <Icon name={memorySourceExpanded ? 'chevronDown' : 'chevronRight'} className="w-3 h-3" />
                            <span>查看来源</span>
                          </button>
                          <div className="flex items-center gap-3 text-secondary">
                            <button
                              onClick={() => { setEditingMemoryId(item.id); setEditingMemoryText(item.content); }}
                              className="hover:text-primary font-medium"
                            >
                              编辑
                            </button>
                            <button
                              onClick={() => {
                                setMemoryItems(prev => prev.map(m => m.id === item.id ? { ...m, enabled: !m.enabled } : m));
                                triggerToast(item.enabled ? '已停用该条记忆' : '已重新启用该条记忆');
                              }}
                              className="hover:text-primary font-medium"
                            >
                              {item.enabled ? '停用' : '启用'}
                            </button>
                            <button
                              onClick={() => {
                                setMemoryItems(prev => prev.filter(m => m.id !== item.id));
                                triggerToast('已遗忘该条记忆');
                              }}
                              className="hover:text-rose-600 font-medium"
                            >
                              遗忘
                            </button>
                          </div>
                        </div>
                        {memorySourceExpanded && (
                          <div className="px-2.5 py-1.5 rounded-lg bg-subtle font-mono text-[10.5px] text-secondary">
                            {item.sourceId}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {memoryItems.length === 0 && (
                    <div className="py-12 text-center text-muted">当前范围暂无已保存记忆，点击右上角「新建记忆」添加。</div>
                  )}
                </div>
              ) : (
                <div className="py-12 text-center text-muted">当前范围暂无待确认的记忆建议。</div>
              )}
            </div>
          </div>
        )}

        {/* Craft / Apple 风格「Hub & Codex 通用技能管理中心」Sheet */}
        {skillsManagerOpen && (
          <div className="absolute inset-0 bg-canvas z-50 flex flex-col animate-fadeIn">
            <div className="h-12 border-b border-border px-4 flex items-center justify-between shrink-0 bg-canvas">
              <div className="flex items-center gap-2">
                <button onClick={() => setSkillsManagerOpen(false)} className="p-1 text-secondary hover:text-primary rounded-lg hover:bg-hover">
                  <Icon name="arrowLeft" className="w-4 h-4" />
                </button>
                <span className="text-xs font-semibold text-primary">技能管理</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => triggerToast('已刷新示例技能索引')}
                  className="p-1.5 rounded-lg text-secondary hover:text-primary hover:bg-hover"
                  title="刷新技能索引"
                >
                  <Icon name="refresh" className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => {
                    setManagedSkills(prev => [
                      {
                        id: 'sk_' + Date.now(),
                        name: 'dxf-wire-audit',
                        desc: '从导入的 SKILL.md 文件夹自动识别，支持 DXF 线束合规检查。',
                        file: 'dxf-wire-audit/SKILL.md',
                        kind: 'package',
                        shared: true,
                        enabled: true,
                        version: 'v1.0'
                      },
                      ...prev
                    ]);
                    triggerToast('已演示导入技能：dxf-wire-audit');
                  }}
                  className="px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-medium flex items-center gap-1 hover:opacity-90"
                >
                  <Icon name="upload" className="w-3 h-3" />
                  <span>导入技能</span>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 max-w-xl mx-auto w-full">
              {/* Hub ↔ Codex 统一技能池状态卡 */}
              <div className="bg-surface rounded-2xl p-3.5 border border-border shadow-card space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-accent-indigo/10 text-accent-indigo flex items-center justify-center shrink-0 mt-0.5">
                      <Icon name="link" className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-primary flex items-center gap-1.5">
                        <span>Hub 与 Codex 共享技能库</span>
                        <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium ${codexSyncEnabled ? 'bg-accent-green/10 text-accent-green' : 'bg-subtle text-muted'}`}>
                          {codexSyncEnabled ? 'MCP 互通已开启' : '已暂停互通'}
                        </span>
                      </div>
                      <p className="text-[11px] text-secondary mt-0.5 leading-relaxed">
                        同一套 <code className="font-mono text-[10.5px] bg-subtle px-1 rounded">SKILL.md</code> 技能在 Hub 助手与外部 Codex 客户端中自动通用。
                      </p>
                    </div>
                  </div>
                  <Toggle checked={codexSyncEnabled} onChange={setCodexSyncEnabled} />
                </div>
                <div className="pt-2.5 border-t border-border/60 flex items-center justify-between gap-2 text-[11px]">
                  <button
                    onClick={() => triggerToast('已在系统文件管理器打开 agent-skills 文件夹')}
                    className="px-2.5 py-1 rounded-lg bg-subtle hover:bg-hover border border-border text-primary font-medium flex items-center gap-1.5"
                  >
                    <Icon name="folder" className="w-3.5 h-3.5 text-secondary" />
                    <span>打开本地技能目录</span>
                    <Icon name="externalLink" className="w-3 h-3 text-muted" />
                  </button>
                  <button
                    onClick={() => handleCopyText('.../com.craftsearch.desktop/agent-skills')}
                    className="text-muted hover:text-primary font-mono text-[10.5px]"
                  >
                    .../agent-skills
                  </button>
                </div>
              </div>

              {/* 分类筛选 */}
              <div className="flex items-center bg-subtle p-0.5 rounded-xl border border-border text-xs w-fit">
                {[
                  { id: 'all', label: `全部 (${managedSkills.length})` },
                  { id: 'local', label: '本地技能' },
                  { id: 'package', label: '方法包' }
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setSkillsManagerTab(tab.id)}
                    className={`px-3 py-1 rounded-lg font-medium transition-all ${skillsManagerTab === tab.id ? 'bg-surface text-primary shadow-xs' : 'text-secondary hover:text-primary'}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* 技能卡片流 */}
              <div className="space-y-2">
                {managedSkills
                  .filter(s => skillsManagerTab === 'all' || s.kind === skillsManagerTab)
                  .map(sk => (
                    <div key={sk.id} className={`bg-surface rounded-2xl p-3.5 border transition-all space-y-2 ${sk.enabled ? 'border-border shadow-card' : 'border-border/60 opacity-65'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs font-semibold text-primary">{sk.name}</span>
                            <span className="px-1.5 py-0.5 rounded-md bg-subtle border border-border text-[10px] text-secondary font-medium">{sk.version}</span>
                            {sk.shared && codexSyncEnabled && (
                              <span className="px-1.5 py-0.5 rounded-md bg-accent-indigo/10 text-accent-indigo text-[10px] font-medium">Codex 通用</span>
                            )}
                          </div>
                          <p className="text-[11.5px] text-secondary mt-1 leading-relaxed">{sk.desc}</p>
                        </div>
                        <Toggle
                          checked={sk.enabled}
                          onChange={(val) => setManagedSkills(prev => prev.map(item => item.id === sk.id ? { ...item, enabled: val } : item))}
                        />
                      </div>
                      <div className="pt-2 border-t border-border/50 flex items-center justify-between text-[11px] text-muted">
                        <span className="font-mono text-[10.5px] truncate">{sk.file}</span>
                        <div className="flex items-center gap-2.5 shrink-0">
                          {sk.kind === 'package' && (
                            <button onClick={() => triggerToast(`${sk.name} 已是最新版本 (${sk.version})`)} className="hover:text-primary">检查更新</button>
                          )}
                          <button onClick={() => triggerToast(`已打开 ${sk.file}`)} className="hover:text-primary">编辑</button>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>

              <details className="rounded-xl border border-border/70 bg-subtle/40 overflow-hidden text-[11px]">
                <summary className="px-3 py-2 text-secondary hover:text-primary cursor-pointer font-medium">导入格式与容量规范</summary>
                <div className="px-3 pb-2.5 pt-1 text-muted leading-relaxed border-t border-border/50">
                  每个技能文件夹需包含 <code className="font-mono text-secondary">SKILL.md</code>。单包上限 33 个文件、原始内容 128 KiB、固定记录 256 KiB；单份模板上限 32 KiB。
                </div>
              </details>
            </div>
          </div>
        )}

        {/* 图片缩略图放大 Lightbox 预览 */}
        {previewImage && (
          <div className="absolute inset-0 z-50 bg-black/50 glass flex items-center justify-center p-6 animate-fadeIn" onClick={() => setPreviewImage(null)}>
            <div className="w-full max-w-md bg-surface rounded-2xl border border-border shadow-sheet overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="px-4 py-2.5 border-b border-border flex items-center justify-between text-xs">
                <span className="font-medium text-primary">{previewImage.name} · {previewImage.size}</span>
                <button onClick={() => setPreviewImage(null)} className="text-muted hover:text-primary">
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
              <div className="aspect-[4/3] w-full bg-subtle flex items-center justify-center overflow-hidden">
                <ThumbArtwork kind={previewImage.kind} large />
              </div>
            </div>
          </div>
        )}

        {/* 全局轻提示 Toast */}
        {toastMsg && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 px-3.5 py-1.5 rounded-full bg-primary/90 glass text-white text-xs font-medium shadow-popover z-50 animate-fadeIn pointer-events-none">
            {toastMsg}
          </div>
        )}
      </div>
    </div>
  );
}
