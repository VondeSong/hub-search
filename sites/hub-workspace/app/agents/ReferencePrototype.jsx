'use client';

import { useState, useEffect, useRef } from 'react';

/* ============================================================
 * 1. 统一极简线框图标库 (SVG)
 * ============================================================ */
function Icon({ name, className = 'w-4 h-4' }) {
  const icons = {
    menu: <path d="M4 7h16M4 12h16M4 17h12" />,
    plus: <path d="M12 5v14M5 12h14" />,
    x: <path d="M18 6L6 18M6 6l12 12" />,
    check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
    chevronDown: <path d="M6 9l6 6 6-6" />,
    chevronRight: <path d="M9 6l6 6-6 6" />,
    chevronLeft: <path d="M15 6l-6 6 6 6" />,
    sliders: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="17" r="2" fill="currentColor" stroke="none" />
      </>
    ),
    sparkles: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 3l.7 2L22 5.7l-2.3.7-.7 2-.7-2L16 5.7l2.3-.7.7-2z" />,
    target: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      </>
    ),
    tag: (
      <>
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
        <circle cx="7" cy="7" r="1.2" fill="currentColor" stroke="none" />
      </>
    ),
    layers: (
      <>
        <polygon points="12 3 3 8 12 13 21 8 12 3" />
        <polyline points="3 12.5 12 17.5 21 12.5" />
        <polyline points="3 17 12 22 21 17" />
      </>
    ),
    pin: <path d="M15 4.5l4.5 4.5-2 2-1.5-.5-3.5 3.5.5 2.5-1.5 1.5-3.5-3.5-4 4-.5-.5 4-4-3.5-3.5 1.5-1.5 2.5.5 3.5-3.5-.5-1.5 2-2z" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" />
      </>
    ),
    fileText: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <path d="M8 13h8M8 17h5" />
      </>
    ),
    fileSearch: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <circle cx="11.5" cy="14.5" r="2.2" />
        <path d="M13.3 16.3l1.7 1.7" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
        <path d="M4.5 5.5v13c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8v-13" />
        <path d="M4.5 12c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8" />
      </>
    ),
    zap: <polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2" />,
    brain: (
      <>
        <path d="M9.5 4.5a3 3 0 0 0-3 3c0 .4.08.78.22 1.12A3.2 3.2 0 0 0 5 11.5a3.2 3.2 0 0 0 1.6 2.77A3 3 0 0 0 9.5 19.5c1.1 0 2-.55 2.5-1.4.5.85 1.4 1.4 2.5 1.4a3 3 0 0 0 2.9-5.23A3.2 3.2 0 0 0 19 11.5a3.2 3.2 0 0 0-1.72-2.88c.14-.34.22-.72.22-1.12a3 3 0 0 0-5.5-1.65A3 3 0 0 0 9.5 4.5z" />
        <path d="M12 6v12" />
      </>
    ),
    copy: (
      <>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    checkSquare: (
      <>
        <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
        <path d="M8.5 12l2.5 2.5L16 9.5" />
      </>
    ),
    externalLink: (
      <>
        <path d="M14 5h5v5" />
        <path d="M19 5l-9 9" />
        <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
      </>
    ),
    arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
    trash: (
      <>
        <path d="M4 7h16M10 11v6M14 11v6" />
        <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
        <path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
      </>
    ),
    edit: <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5z" />,
    refresh: (
      <>
        <path d="M20 11a8 8 0 0 0-14.5-4.5L3 9" />
        <path d="M3 4v5h5" />
        <path d="M4 13a8 8 0 0 0 14.5 4.5L21 15" />
        <path d="M21 20v-5h-5" />
      </>
    ),
    folder: <path d="M3 7a2 2 0 0 1 2-2h4.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />,
    shield: <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" />,
    wrench: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-5.6 5.6a1.5 1.5 0 1 0 2.1 2.1l5.6-5.6a4 4 0 0 0 5.4-5.4l-2.3 2.3-2.1-2.1 2.3-2.3z" />,
    alertTriangle: (
      <>
        <path d="M10.3 3.8L2.6 17.2A1.8 1.8 0 0 0 4.1 20h15.8a1.8 1.8 0 0 0 1.5-2.8L13.7 3.8a1.8 1.8 0 0 0-3.4 0z" />
        <path d="M12 9v4" />
        <circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none" />
      </>
    ),
    alertCircle: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4.5" />
        <circle cx="12" cy="16" r="0.8" fill="currentColor" stroke="none" />
      </>
    ),
    video: (
      <>
        <rect x="3" y="6" width="13" height="12" rx="2" />
        <polygon points="16 10 21 7 21 17 16 14 16 10" />
      </>
    ),
    code: <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />,
    image: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="M21 16l-5-5-6 6-3-3-4 4" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 19.5c1.5-3.2 4.2-4.5 7-4.5s5.5 1.3 7 4.5" />
      </>
    ),
    dockRight: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M14 4v16" />
      </>
    ),
    floatWin: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2.5" strokeOpacity="0.45" />
        <rect x="10.5" y="7" width="8.5" height="10" rx="1.8" fill="currentColor" fillOpacity="0.14" />
      </>
    ),
    expandWin: (
      <>
        <path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6" />
      </>
    ),
    calendar: (
      <>
        <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
        <path d="M8 3v4M16 3v4M3.5 10h17" />
      </>
    ),
    flag: <path d="M5 21V4m0 0h11l-2 4.5L16 13H5" />,
    play: <polygon points="7 5 19 12 7 19 7 5" fill="currentColor" stroke="none" />
  };

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {icons[name] || icons.fileText}
    </svg>
  );
}

/* ============================================================
 * 2. 精准厂商矢量图标 (OpenAI 六瓣交织 / DeepSeek 鲸鱼剪影)
 * ============================================================ */
function VendorIcon({ vendor, className = 'w-3.5 h-3.5' }) {
  if (vendor === 'DeepSeek') {
    return (
      <svg viewBox="0 0 24 24" className={`${className} text-[#4D6BFE] shrink-0`} fill="currentColor">
        <path d="M19.8 8.3c-1.1-.8-2.6-.5-3.4.3-.6-.9-1.8-2.1-3.9-2.5-3.2-.7-6.8.7-8.7 3.5-1.7 2.5-1.6 5.9.4 8.1 2.2 2.4 6.1 2.8 9.2 1.3 2.4-1.1 4.1-3.3 4.8-5.7.9-.3 2.1-.9 2.5-2.1.3-1-.1-2.2-.9-2.9zm-8.6 8.3c-2.2.3-4.3-.8-5.1-2.6-.7-1.6-.3-3.7 1.1-4.8 1.5-1.2 3.8-1.4 5.5-.3 1.4.9 2.2 2.4 2.1 4-.1 1.9-1.6 3.4-3.6 3.7z" />
        <circle cx="9.6" cy="11.2" r="1.15" fill="#FFFFFF" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={`${className} text-primary shrink-0`} fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.2 3.6a3.9 3.9 0 0 1 6.7 2.6c1.9.7 3.1 2.8 2.6 4.9-.2.9-.7 1.7-1.4 2.3.5 2-.5 4.2-2.4 5.1-.9.4-1.9.5-2.8.3-1.4 1.6-3.9 1.9-5.7.7-.8-.5-1.4-1.3-1.7-2.2-2-.5-3.4-2.5-3-4.6.2-1 .7-1.8 1.5-2.4-.5-2 .5-4.2 2.4-5.1.9-.4 1.9-.5 2.8-.3.3-.5.6-.9 1-1.3z" />
      <path d="M9.5 9.2L14.5 6.3M14.5 9.2l4.2 2.4M14.5 14.8v4.8M9.5 14.8l-4.2-2.4M9.5 9.2V4.4M14.5 14.8l-5 2.9" />
    </svg>
  );
}

/* ============================================================
 * 3. 叠放微缩站点图标 (W3C / MDN / WAI / WHATWG / Hub / 媒体)
 * ============================================================ */
function SiteFavicon({ site }) {
  const configs = {
    W3C: { title: 'W3C 官方规范', bg: 'bg-[#005A9C] text-white', content: <span className="text-[7px] font-bold tracking-tighter leading-none">W3</span> },
    MDN: { title: 'MDN Web Docs', bg: 'bg-[#1B1B1B] text-white', content: <span className="text-[8px] font-bold font-mono leading-none">M</span> },
    WAI: { title: 'W3C WAI 无障碍指南', bg: 'bg-[#0E7490] text-white', content: <span className="text-[6.5px] font-bold leading-none">WAI</span> },
    WHATWG: { title: 'WHATWG HTML Living Standard', bg: 'bg-[#3B82F6] text-white', content: <span className="text-[8px] font-bold leading-none">W</span> },
    Hub: { title: 'Hub 本地知识库与任务工具', bg: 'bg-primary text-white', content: <span className="text-[8px] font-bold leading-none">H</span> },
    Sky: { title: 'Sky News 天空新闻', bg: 'bg-[#0284C7] text-white', content: <span className="text-[7px] font-bold leading-none">SK</span> },
    Bloomberg: { title: 'Bloomberg 彭博社', bg: 'bg-[#18181B] text-white', content: <span className="text-[8px] font-bold leading-none">B</span> },
    Oxford: { title: '牛津烈酒与鸡尾酒指南', bg: 'bg-[#7C2D12] text-white', content: <span className="text-[8px] font-bold leading-none">O</span> }
  };
  const cfg = configs[site] || { title: site, bg: 'bg-subtle text-secondary', content: <span className="text-[7px] font-bold">{String(site).slice(0, 2)}</span> };
  return (
    <span
      title={cfg.title}
      className={`w-[18px] h-[18px] rounded-[5px] ${cfg.bg} ring-1 ring-surface inline-flex items-center justify-center shrink-0 shadow-2xs`}
    >
      {cfg.content}
    </span>
  );
}

/* ============================================================
 * 4. 行内代码芯片 / 知识库数字引用组 / 句末微胶囊 / 柔和句内链接
 * ============================================================ */
function InlineCodeText({ text }) {
  const parts = String(text || '').split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code key={i} className="mx-0.5 px-1.5 py-0.5 rounded-md bg-subtle border border-border font-mono text-[11px] text-primary">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function NoteCitationGroup({ citations, onJump }) {
  const [hoveredIdx, setHoveredIdx] = useState(null);
  return (
    <span className="inline-flex items-center gap-0.5 align-baseline ml-1 whitespace-nowrap">
      {citations.map((c, idx) => (
        <span
          key={c.num}
          className="relative inline-flex"
          onMouseEnter={() => setHoveredIdx(idx)}
          onMouseLeave={() => setHoveredIdx(null)}
                  onFocus={() => setHoveredIdx(idx)}
          onBlur={() => setHoveredIdx(null)}
        >
          <button
            type="button"
            aria-label={'定位原文第 ' + c.num + ' 段'}
            onClick={() => onJump(c)}
            className="h-[17px] min-w-[17px] px-1 rounded-[5px] bg-subtle border border-border text-[10px] font-mono tabular-nums text-secondary hover:bg-accent-indigo/10 hover:text-accent-indigo hover:border-accent-indigo/40 transition-colors inline-flex items-center justify-center leading-none"
          >
            {c.num}
          </button>
          {hoveredIdx === idx && (
            <div className="absolute bottom-full right-0 mb-2 w-64 p-2.5 rounded-xl bg-surface/95 glass border border-border shadow-popover z-50 text-left whitespace-normal pointer-events-none animate-fadeIn">
              <div className="flex items-center justify-between gap-2 text-[10.5px] text-muted mb-1">
                <span className="flex items-center gap-1 font-medium text-primary truncate">
                  <Icon name="fileText" className="w-3 h-3 text-accent-indigo shrink-0" />
                  <span className="truncate">{c.doc}</span>
                </span>
                <span className="font-mono shrink-0">第 {c.num} 段</span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-secondary line-clamp-2">{c.excerpt}</p>
              <div className="mt-1.5 text-[10px] text-accent-indigo font-medium">点击定位到左侧原文 ↗</div>
            </div>
          )}
        </span>
      ))}
    </span>
  );
}

function SourcePill({ label, site, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 h-[20px] pl-1 pr-1.5 rounded-md bg-subtle hover:bg-hover border border-border text-[11px] font-medium text-secondary hover:text-primary whitespace-nowrap align-middle mx-0.5 transition-colors"
    >
      {site ? (
        <span className="scale-[0.72] -mx-0.5 inline-flex">
          <SiteFavicon site={site} />
        </span>
      ) : (
        <Icon name="globe" className="w-2.5 h-2.5 text-muted shrink-0" />
      )}
      <span>{label}</span>
    </button>
  );
}

function SoftInlineLink({ children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-baseline gap-0.5 text-primary border-b border-primary/25 hover:border-primary/70 transition-colors mx-0.5 group"
    >
      <span>{children}</span>
      <span className="text-[10px] text-muted group-hover:text-primary transition-colors leading-none">↗</span>
    </button>
  );
}

/* ============================================================
 * 5. 本地缩略图渲染（不依赖外部图床）
 * ============================================================ */
function MockThumbVisual({ type }) {
  if (type === 'terminal') {
    return (
      <div className="w-full h-full bg-[#15171A] p-2 flex flex-col justify-between font-mono text-[7px] leading-tight text-emerald-400/90 select-none">
        <div className="flex gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-400/80"></span>
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400/80"></span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80"></span>
        </div>
        <div className="space-y-0.5 opacity-90">
          <div>aria-live=&quot;polite&quot;</div>
          <div className="text-sky-300">status verified</div>
          <div className="text-zinc-400">scroll-anchor ok</div>
        </div>
      </div>
    );
  }
  return (
    <div className="w-full h-full bg-[#F7F6F2] flex items-center justify-center p-1.5 select-none">
      <svg viewBox="0 0 64 64" className="w-11 h-11 text-primary/75" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 48c0-14 6-28 18-30 9-1.5 16 4 17 11 1 5-2 9-6 10" />
        <circle cx="38" cy="26" r="1.5" fill="currentColor" stroke="none" />
        <path d="M46 31c3 .5 5 2 5 4.5s-2.5 3.5-5.5 3" />
        <path d="M22 25c-2-3 0-7 3-6" />
      </svg>
    </div>
  );
}

/* ============================================================
 * 6. 主应用组件
 * ============================================================ */
export default function ReferencePrototype({ onDismiss, onOpenDemos }) {
  const surfaceRef = useRef(null);
  const paragraphTimer = useRef(null);
  const messageList = useRef(null);
  const [emptyMessages, setEmptyMessages] = useState([]);
  // 宿主形态：'docked' | 'floating' | 'expanded'
  const [agentMorphology, setAgentMorphology] = useState('docked');
  const [agentOpen, setAgentOpen] = useState(true);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);

  // 案例切换：'diary' | 'report' | 'interrupted' | 'empty'
  const [activeCase, setActiveCase] = useState('diary');
  const [highlightedPara, setHighlightedPara] = useState(null);
  const [narrowCitation, setNarrowCitation] = useState(null);
  useEffect(() => {
    if (messageList.current) messageList.current.scrollTop = 0;
  }, [activeCase]);

  // 标题 & 模式
  const [threadTitle, setThreadTitle] = useState('2023-05-06 日记核对与背景查证');
  const [editingTitle, setEditingTitle] = useState(false);
  const [taskMode, setTaskMode] = useState('standard'); // 'standard' | 'goal' | 'tag' | 'topic'
  const [goalCondition, setGoalCondition] = useState('完成 15 条桌面验证项，遇到权限阻碍时暂停');
  const [tagSubMode, setTagSubMode] = useState('draft'); // 'draft' | 'missing' | 'compare'
  const [selectedTargetTag, setSelectedTargetTag] = useState('#archive');
  const [selectedCompareTag, setSelectedCompareTag] = useState('#movie');
  const [tagPickerSlot, setTagPickerSlot] = useState(null);
  const [tagSearch, setTagSearch] = useState('');

  // 专题
  const [topics, setTopics] = useState([
    { id: 't1', name: 'OS 标签与原文核对', docs: ['2023-05-06', '案例'], libs: ['OS'], strategy: 'only', pinned: true },
    { id: 't2', name: '折腾记录单页核对', docs: ['2023-05-06'], libs: [], strategy: 'only', pinned: true },
    { id: 't3', name: '工程线束资料整理', docs: ['8_竞品和参考'], libs: ['Car', 'OS'], strategy: 'prefer', pinned: false }
  ]);
  const [activeTopicId, setActiveTopicId] = useState('t1');
  const [modePopoverView, setModePopoverView] = useState('main'); // 'main' | 'allTopics'
  const [topicSearch, setTopicSearch] = useState('');
  const [newTopicName, setNewTopicName] = useState('');

  // 浮层与抽屉开关
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [scopeModalOpen, setScopeModalOpen] = useState(false);
  const [scopeTab, setScopeTab] = useState('docs'); // 'docs' | 'libs' | 'strategy'
  const [docSearch, setDocSearch] = useState('');
  const [docFilter, setDocFilter] = useState('all'); // 'all' | 'selected'
  const [saveTopicInline, setSaveTopicInline] = useState(false);
  const [saveTopicInput, setSaveTopicInput] = useState('');
  const [fixedChecklistOpen, setFixedChecklistOpen] = useState(false);

  const [skillsPopoverOpen, setSkillsPopoverOpen] = useState(false);
  const [skillDetailId, setSkillDetailId] = useState(null);
  const [skillsManagerOpen, setSkillsManagerOpen] = useState(false);
  const [skillsManagerTab, setSkillsManagerTab] = useState('all'); // 'all' | 'local' | 'package'
  const [codexMcpSync, setCodexMcpSync] = useState(true);
  const [showImportGuide, setShowImportGuide] = useState(false);

  const [memorySheetOpen, setMemorySheetOpen] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryScope, setMemoryScope] = useState('工程资料整理');
  const [memoryTab, setMemoryTab] = useState('saved'); // 'saved' | 'pending'
  const [newMemoryOpen, setNewMemoryOpen] = useState(false);
  const [newMemoryTitle, setNewMemoryTitle] = useState('');
  const [newMemoryBody, setNewMemoryBody] = useState('');

  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [atMenuOpen, setAtMenuOpen] = useState(false);

  const [saveNoteModalOpen, setSaveNoteModalOpen] = useState(false);
  const [saveNoteMode, setSaveNoteMode] = useState('append'); // 'append' | 'new'
  const [saveNoteTarget, setSaveNoteTarget] = useState('2023-05-06');
  const [saveNoteTitle, setSaveNoteTitle] = useState('2023-05-06 日记核对与背景查证');

  const [createTaskModalOpen, setCreateTaskModalOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState('整理 2023-05-06 待办与数据迁移缺口');
  const [taskListName, setTaskListName] = useState('收件箱');
  const [taskDue, setTaskDue] = useState('明天');
  const [taskPriority, setTaskPriority] = useState('高');
  const [taskIncludeReport, setTaskIncludeReport] = useState(false);
  const [taskSubItems, setTaskSubItems] = useState([
    { id: 'st1', text: '梳理未整理数据并排定核对顺序', checked: true },
    { id: 'st2', text: '复盘数据迁移与回滚方案', checked: true },
    { id: 'st3', text: '列出出现问题时的人工检查清单', checked: false }
  ]);

  const [sourcesModalOpen, setSourcesModalOpen] = useState(false);
  const [sourcesSearch, setSourcesSearch] = useState('');
  const [lightboxImage, setLightboxImage] = useState(null);

  // 对话详情开关
  const [onlyLatestReply, setOnlyLatestReply] = useState(false);
  const [webSearchOn, setWebSearchOn] = useState(true);
  const [mcpToolsOn, setMcpToolsOn] = useState(true);
  const [diagOpen, setDiagOpen] = useState(false);

  // Codex 账号切换
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [codexAccounts, setCodexAccounts] = useState([
    { id: 'follow', label: '跟随 Codex 桌面登录', email: 'p***@example.test', plan: 'Plus', workspace: '个人', status: 'active', isFollow: true },
    { id: 'work', label: 'w***@example.test', email: 'w***@example.test', plan: 'Pro', workspace: '工作空间', status: 'active', isFollow: false },
    { id: 'studio', label: 'dev***@example.test', email: 'dev***@example.test', plan: 'Team', workspace: '实验组', status: 'expired', isFollow: false }
  ]);
  const [activeAccountId, setActiveAccountId] = useState('follow');
  const [pendingSwitchId, setPendingSwitchId] = useState(null);
  const [switchCarryMode, setSwitchCarryMode] = useState('continue'); // 'continue' | 'new'
  const [oauthAdding, setOauthAdding] = useState(false);
  const [switchedBanner, setSwitchedBanner] = useState(null);
  const [oldChatAuthNeeded, setOldChatAuthNeeded] = useState(false);

  // 模型 & 推理强度 & 响应速度
  const [selectedModel, setSelectedModel] = useState('DeepSeek V4.1 Flash');
  const [reasoningLevel, setReasoningLevel] = useState('high');
  const [responseSpeed, setResponseSpeed] = useState('standard');

  // 附件 & 报错提示
  const [selectedDocs, setSelectedDocs] = useState(['2023-05-06', '8_竞品和参考']);
  const [selectedLibs, setSelectedLibs] = useState(['Car', 'OS']);
  const [retrievalStrategy, setRetrievalStrategy] = useState('prefer');
  const [attachedSkills, setAttachedSkills] = useState(['阅读材料归档']);
  const [attachedLocalFiles, setAttachedLocalFiles] = useState([
    { id: 'f1', name: '初步策略', kind: 'task' },
    { id: 'f2', name: 'codex2.mp4', kind: 'video' },
    { id: 'f3', name: 'style.css', kind: 'code' },
    { id: 'f4', name: 'index.html', kind: 'code' },
    { id: 'f5', name: '扭矩扳手量具操作指导书2025.pdf', kind: 'pdf' }
  ]);
  const [expandAllFiles, setExpandAllFiles] = useState(false);
  const [attachedImages, setAttachedImages] = useState([
    { id: 'img1', name: 'image.png', type: 'terminal' },
    { id: 'img2', name: 'unnamed.jpg', type: 'sketch' }
  ]);
  const [uploadError, setUploadError] = useState('「会话示例录音.flac」超出 10 MB 限制（34.2 MB），未添加');
  const [inputText, setInputText] = useState('');

  // 思维链与工具组展开状态
  const [timelineOpenMap, setTimelineOpenMap] = useState({ c3_m2: true, m2: true, c2_m2: true });
  const [toolGroupOpenMap, setToolGroupOpenMap] = useState({
    'c3-ctx': false, 'c3-g1': true, 'c3-g2': true,
    'm2-ctx': false, 'm2-g1': true, 'm2-g2': false, 'm2-g3': false,
    'c2-ctx': true, 'c2-g1': true
  });
  const [stepDetailOpenMap, setStepDetailOpenMap] = useState({ 'c3-note-1': true, 'c3-web-2': true, 'm2-s2': true });
  const [techLogOpenMap, setTechLogOpenMap] = useState({ 'c3-note-1': false, 'c2-step-err': false });
  const [draftPreviewOpenMap, setDraftPreviewOpenMap] = useState({ c2_m2: false });
  const [checklistExpanded, setChecklistExpanded] = useState(false);

  // 记忆数据
  const [memories, setMemories] = useState([
    {
      id: 'mem1',
      scope: '工程资料整理',
      title: '工程资料整理时的事实与建议边界',
      version: '第 2 版',
      updatedAt: '2026/11/15 13:31',
      body: '整理工程资料时，区分方法建议、原始问题和已核对的事实；没有实际操作记录，不声称已迁移。工程文件已归档或 Craft 范围已覆盖，补充：PARA 的 Archives 与工程交付物的归档，语义不是同一回事，应按照材料所属状态的语义拆分。',
      diffOld: '工程文件已归档或 Craft 范围已覆盖。',
      diffNew: '补充：PARA 的 Archives 与工程交付物的归档，语义不是同一回事，不因为都叫“归档”就混在一起。',
      sourceId: 'example-work',
      enabled: true,
      showDiff: true,
      showSource: false
    }
  ]);

  // 通用技能库
  const [skillsList, setSkillsList] = useState([
    { id: 'sk1', name: '阅读材料归档', desc: '为阅读材料准备归档方案与目标位置确认。', file: 'hub-archive/SKILL.md', kind: 'package', shared: true, enabled: true, version: '内置' },
    { id: 'sk2', name: 'record-to-log', desc: '将零散工作记录按时间线归档至项目日志。', file: 'record-to-log/SKILL.md', kind: 'package', shared: true, enabled: true, version: '登记第 5 版' },
    { id: 'sk3', name: '笔记整理与修改', desc: '整理、改写当前所编辑的 Obsidian 笔记。', file: 'obsidian-edit/SKILL.md', kind: 'local', shared: true, enabled: true, version: '本地' },
    { id: 'sk4', name: 'DXF 线表核对', desc: '自动核对 DXF Pin 脚定义、线径规格与差异项。', file: 'wire-table/SKILL.md', kind: 'package', shared: true, enabled: true, version: 'v2.1' },
    { id: 'sk5', name: '会议纪要提炼行动', desc: '从非结构化文字中抽离 Action Items 与责任人。', file: 'meeting-extract/SKILL.md', kind: 'local', shared: false, enabled: false, version: '本地' }
  ]);

  // 历史会话
  const [historyList, setHistoryList] = useState([
    { id: 'h0', caseKey: 'diary', title: '2023-05-06 日记核对与背景查证', time: '刚刚', pinned: true },
    { id: 'h1', caseKey: 'report', title: 'Hub 助手工作过程和展示方案', time: '3 小时前', pinned: true },
    { id: 'h2', caseKey: 'interrupted', title: '找一下我最近的任务，帮我安排一下', time: '4 小时前', pinned: false },
    { id: 'h3', caseKey: 'report', title: '根据摘要，哪三个 PowerShell 分数最高', time: '5 小时前', pinned: false }
  ]);

  // Toast 轻提示
  const [toastMsg, setToastMsg] = useState('');
  const toastTimerRef = useRef(null);
  useEffect(() => () => {
    clearTimeout(toastTimerRef.current);
    clearTimeout(paragraphTimer.current);
  }, []);
  const triggerToast = (msg) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(''), 2400);
  };

  const handleCopyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      triggerToast('已复制到剪贴板');
    } catch {
      triggerToast('复制失败，请手动选中复制');
    }
  };

  // 基础静态目录数据
  const availableDocs = [
    { id: '2023-05-06', path: 'OS · Journals/2023/05/2023-05-06.md', current: true },
    { id: '8_竞品和参考', path: 'Car · 调研资料', current: false },
    { id: '案例', path: 'Private · 未分类', current: false },
    { id: '2024.08.31', path: 'Private · 未分类', current: false },
    { id: '母子相关经历与公开案件 来源核查目录', path: 'Private · 核查', current: false }
  ];

  const availableLibs = [
    { id: 'Car', source: 'Craft', count: 49 },
    { id: 'main', source: 'Craft', count: 155 },
    { id: 'OS', source: 'Obsidian', count: 2066 },
    { id: '滴答清单', source: '滴答清单', count: 407 },
    { id: 'Vonde', source: '飞书', count: 13 }
  ];

  const availableTags = [
    { name: '#craft', count: 121 },
    { name: '#main', count: 86 },
    { name: '#结构学', count: 73 },
    { name: '#movie', count: 59 },
    { name: '#archive', count: 45 },
    { name: '#teleplay', count: 41 }
  ];

  const webSourcesList = [
    { site: 'Bloomberg', title: '彭博社报道转载 · 21 Club 晚宴与菜单记录', url: 'bloomberg.com/news/articles/21-club' },
    { site: 'Sky', title: '天空新闻 · 2016 大选后家庭聚餐现场报道', url: 'news.sky.com/story/trump-21-club' },
    { site: 'Oxford', title: '牛津烈酒与鸡尾酒指南 (1939 早期记录)', url: 'oxfordreference.com/bloody-mary' },
    { site: 'W3C', title: 'WAI-ARIA 1.2 · log & status Role Definitions', url: 'w3.org/TR/wai-aria-1.2/' },
    { site: 'MDN', title: 'MDN Web Docs · ARIA Live Regions & Scroll Anchoring', url: 'developer.mozilla.org/en-US/docs/Web/Accessibility' },
    { site: 'WAI', title: 'WCAG 2.1 · SC 4.1.3 Status Messages & Focus Visible', url: 'w3.org/WAI/WCAG21/Understanding/status-messages' },
    { site: 'WHATWG', title: 'HTML Living Standard · The details and summary elements', url: 'html.spec.whatwg.org/multipage/interactive-elements.html' }
  ];

  const availableModels = [
    { id: 'GPT-6.2 Sol', shortName: '6.2 Sol', vendor: 'OpenAI', web: true, reasoning: true, supportsSpeed: true, desc: '旗舰综合推理与长上下文' },
    { id: 'GPT-6.1 Terra', shortName: '6.1 Terra', vendor: 'OpenAI', web: true, reasoning: true, supportsSpeed: true, desc: '均衡稳定，适合工程资料整理' },
    { id: 'DeepSeek V4.1 Flash', shortName: 'V4.1 Flash', vendor: 'DeepSeek', web: false, reasoning: true, supportsSpeed: false, desc: '极速响应，本地资料检索优选' },
    { id: 'DeepSeek V4 Pro', shortName: 'V4 Pro', vendor: 'DeepSeek', web: true, reasoning: true, supportsSpeed: false, desc: '深度逻辑分析与代码核对' }
  ];

  const reasoningPresets = {
    OpenAI: [
      { key: 'low', label: '低', hint: '较少推理投入，适合简单问答' },
      { key: 'mid', label: '中', hint: '适合日常讨论与资料整理' },
      { key: 'high', label: '高', hint: '增强推理投入，适合复杂问题' },
      { key: 'xhigh', label: '极高', hint: '更充分地推理与核查，耗时更久' },
      { key: 'max', label: '最大', hint: '使用该模型最高档推理投入' },
      { key: 'ultra', label: '极限', hint: '深度多步证据交叉验证' }
    ],
    DeepSeek: [
      { key: 'off', label: '关闭', hint: '直接输出答案，响应最快' },
      { key: 'mid', label: '中', hint: '标准深度思考，兼顾速度与准确度' },
      { key: 'high', label: '高', hint: '充分展开思考链，适合复杂核对' }
    ]
  };

  const currentModelObj = availableModels.find(m => m.id === selectedModel) || availableModels[0];
  const activeReasoningOptions = reasoningPresets[currentModelObj.vendor] || reasoningPresets.OpenAI;
  const currentReasoningObj = activeReasoningOptions.find(r => r.key === reasoningLevel) || activeReasoningOptions[activeReasoningOptions.length - 1];

  const handleSelectModel = (m) => {
    setSelectedModel(m.id);
    const nextOpts = reasoningPresets[m.vendor];
    if (!nextOpts.some(o => o.key === reasoningLevel)) {
      setReasoningLevel('high');
    }
  };

  // ============================================================
  // 三个演示案例的消息数据
  // ============================================================
  const [diaryMessages, setDiaryMessages] = useState([
    {
      id: 'c3_m1',
      role: 'user',
      time: '15:20',
      text: '补读 2023-05-06 这篇日记的后半部分，帮我梳理尚未解决的问题并标注原文段落；另外顺便核对一下“特朗普与血腥玛丽”的典故来源。'
    },
    {
      id: 'c3_m2',
      role: 'assistant',
      duration: '1 分 24 秒',
      sourcesCount: 6,
      text: '未解决的问题：\n1. 迁移流程怎样恢复，未整理的数据怎么处理？（2023-05-06 第 14–16 段）\n2. 恢复批量导入的目标是否还成立？（第 17 段）\n3. 停用自动重试后，怎样处理同类问题？（第 29–30 段）\n\n关联背景核对：\n特朗普在纽约 21 Club 常点无酒精版血腥玛丽（彭博社、天空新闻），该餐厅早在 1939 年《牛津烈酒与鸡尾酒指南》中就有血腥玛丽的早期文字记录。',
      timeline: [
        {
          type: 'contextPrep',
          id: 'c3-ctx',
          summary: '已载入上下文 · 1 份材料 · 1 条规则',
          items: [
            { kind: 'doc', name: '2023-05-06', meta: 'Obsidian · OS / Journals' },
            { kind: 'rule', name: 'OS 知识库工作规则', file: 'AGENTS.md', hash: 'ae2f4fc', fullPath: 'OS/AGENTS.md' }
          ]
        },
        {
          type: 'thought',
          text: '我会补读这篇日记的后半部分，核对哪些事项已经做过、哪些仍待解决，并为每项附上可跳转的段落引用；同时检索公开报道核实“血腥玛丽”相关背景。'
        },
        {
          type: 'toolGroup',
          id: 'c3-g1',
          icon: 'fileText',
          title: '已读取知识库 · 1 篇笔记',
          badges: ['Hub'],
          steps: [
            {
              id: 'c3-note-1',
              icon: 'fileText',
              label: '读取笔记「2023-05-06」',
              detail: '3 处片段',
              noteExcerpt: {
                doc: '2023-05-06',
                anchorId: 'para-14',
                text: '这周的迁移计划比预期慢，需要先稳定导入……几批测试数据仍待整理，要确认来源和检查顺序。计划至少通过两轮回归后再恢复批量导入，开始时间和回滚条件还待确认。已停用自动重试，遇到同类问题时先用人工检查。',
                rawJson: '{\n  "tool": "hub_read_note",\n  "doc": "OS/Journals/2023-05-06.md",\n  "chunks": [14, 15, 16, 17, 29, 30]\n}'
              }
            }
          ]
        },
        {
          type: 'toolGroup',
          id: 'c3-g2',
          icon: 'search',
          title: '网页检索 · 2 步',
          badges: ['Bloomberg', 'Sky', 'Oxford'],
          steps: [
            { icon: 'search', label: '搜索网页', detail: 'Trump Virgin Bloody Mary 21 Club 2016 Bloomberg Sky News', extra: '另 2 条查询' },
            {
              id: 'c3-web-2',
              icon: 'globe',
              label: '已浏览 3 个页面',
              browsedPages: [
                { site: 'Bloomberg', title: '彭博社报道转载 · 21 Club 晚宴', url: 'bloomberg.com/news/articles/21-club' },
                { site: 'Sky', title: '天空新闻 · 大选后家庭聚餐', url: 'news.sky.com/story/trump-21-club' },
                { site: 'Oxford', title: '牛津烈酒与鸡尾酒指南 (1939)', url: 'oxfordreference.com/bloody-mary' }
              ]
            }
          ]
        }
      ],
      diaryReport: {
        unresolved: [
          {
            title: '迁移流程怎样恢复，未整理的数据怎么处理？',
            body: '周记记录进度滞后、导入需要稳定，以及还有数据待整理。下一步要确认每批数据的来源和检查顺序。',
            citations: [
              { num: 14, doc: '2023-05-06', anchorId: 'para-14', excerpt: '这周的迁移计划比预期慢。' },
              { num: 15, doc: '2023-05-06', anchorId: 'para-14', excerpt: '需要先稳定导入流程。' },
              { num: 16, doc: '2023-05-06', anchorId: 'para-14', excerpt: '测试数据还有几批没整理，要确认来源和检查先后。' }
            ]
          },
          {
            title: '恢复批量导入的目标是否还成立？',
            body: '周记提到两轮回归通过后恢复批量导入。开始时间和回滚条件仍待明确。',
            citations: [
              { num: 17, doc: '2023-05-06', anchorId: 'para-17', excerpt: '等两轮回归通过后，再恢复批量导入。' }
            ]
          },
          {
            title: '停用自动重试后，怎样处理同类问题？',
            body: '已经停用自动重试。遇到同类问题时，提醒用户和进入人工检查仍需取舍。',
            citations: [
              { num: 29, doc: '2023-05-06', anchorId: 'para-29', excerpt: '今天先停用了自动重试，避免反复执行同一项。' },
              { num: 30, doc: '2023-05-06', anchorId: 'para-29', excerpt: '接下来仍要决定提示用户还是进入人工检查。' }
            ]
          }
        ],
        webSection: {
          lead: '特朗普和“血腥玛丽”最直接的联系是，他在纽约餐厅常点无酒精版，他的酒店也曾卖过含伏特加的“特朗普风格”版。',
          leadSources: [
            { label: '彭博社', site: 'Bloomberg' },
            { label: '威基基酒店旧菜单', site: null }
          ],
          items: [
            {
              title: '2016 年大选后的那顿饭。',
              body: '11 月 15 日，刚赢得大选的特朗普与家人在纽约曼哈顿的 21 Club 吃晚饭。现场记者称他点了无酒精血腥玛丽（Virgin Bloody Mary）。彭博社后来采访餐厅方，也把这款饮料列为他在那里的常点选项之一。',
              sources: [
                { label: '天空新闻', site: 'Sky' },
                { label: '彭博社', site: 'Bloomberg' }
              ]
            },
            {
              title: '同一家餐厅早在 1939 年就有这款酒的文字记录。',
              inlineLinkText: '《牛津烈酒与鸡尾酒指南》',
              bodyAfterLink: '找到的早期记录，正是当年一篇介绍 21 Club 的专栏，文中把伏特加和番茄汁调成的饮料称为 Bloody Mary。这款酒究竟由谁首创，仍有不同说法。',
              sources: [
                { label: '牛津鸡尾酒指南', site: 'Oxford' }
              ]
            }
          ]
        }
      }
    }
  ]);

  const [messages, setMessages] = useState([
    {
      id: 'm1',
      role: 'user',
      time: '14:12',
      text: '请为 Hub 桌面助手做一份「流式状态与工作过程证据复核」。把三个实现取舍逐项查清：一、连续进展和工具回执怎么播报；二、展开回执后的滚动锚定与焦点维持；三、回到最新按钮与减少动态效果偏好。最后整理成 15 条桌面测试项。'
    },
    {
      id: 'm2',
      role: 'assistant',
      duration: '4 分 7 秒',
      sourcesCount: 14,
      text: 'Hub 桌面助手｜流式状态与工作过程证据复核\n建议采用普通回执列表和一处 status 状态区。用户展开回执或离开列表末尾后，Hub 继续接收结果，同时保留阅读位置、展开状态和键盘焦点。',
      timeline: [
        {
          type: 'contextPrep',
          id: 'm2-ctx',
          summary: '已载入上下文 · 1 份材料 · 1 条规则',
          items: [
            { kind: 'doc', name: '仪表线束 GUA - 数模原理图待查清单', meta: '飞书 · 待查清单' },
            { kind: 'rule', name: 'OS 知识库工作规则', file: 'AGENTS.md', hash: 'ae2f4fc', fullPath: 'OS/AGENTS.md' }
          ]
        },
        {
          type: 'thought',
          text: '我会分三轮核对公开原文，依次查播报语义、展开回执后的滚动与焦点，以及回到最新与减少动态效果。每轮核对后会简短汇报，再把结论整理成 15 条桌面测试。'
        },
        {
          type: 'toolGroup',
          id: 'm2-g1',
          icon: 'search',
          title: '网页检索 · 4 步',
          badges: ['W3C', 'MDN', 'WAI'],
          steps: [
            { icon: 'search', label: '搜索网页', detail: 'site:w3.org WAI ARIA Recommendation log status implicit aria-live polite aria-atomic', extra: '另 2 条查询' },
            {
              id: 'm2-s2',
              icon: 'globe',
              label: '已浏览 3 个页面',
              browsedPages: [
                { site: 'W3C', title: 'Disclosure (Show/Hide) Pattern', url: 'w3.org/WAI/ARIA/apg/patterns/disclosure/' },
                { site: 'W3C', title: 'Button Pattern · APG', url: 'w3.org/WAI/ARIA/apg/patterns/button/' },
                { site: 'WAI', title: 'Focus Visible (SC 2.4.7)', url: 'w3.org/WAI/WCAG21/Understanding/focus-visible' }
              ]
            },
            { icon: 'fileSearch', label: '在网页内查找', detail: 'new information is added in meaningful order' },
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
          icon: 'search',
          title: '网页检索 · 2 步',
          badges: ['WHATWG', 'MDN'],
          steps: [
            { icon: 'search', label: '搜索网页', detail: 'WHATWG HTML details summary toggle focus preservation scroll anchoring' },
            { icon: 'globe', label: '网页操作', detail: '打开 CSS Scroll Anchoring Level 1 草案' }
          ]
        },
        {
          type: 'thought',
          text: '第二轮确认了两个边界。原生 `summary` 负责切换展开状态，浏览器的滚动锚定只在符合条件时补偿布局变化。新回执、首段答案和完成事件到达时，Hub 仍需保留现有回执节点，并维持视口与焦点。'
        },
        {
          type: 'toolGroup',
          id: 'm2-g3',
          icon: 'search',
          title: '网页检索 · 2 步',
          badges: ['W3C', 'MDN'],
          steps: [
            { icon: 'search', label: '搜索网页', detail: 'prefers-reduced-motion scroll behavior auto vs smooth WAI' },
            { icon: 'fileSearch', label: '在网页内查找', detail: 'reduced motion preference affects animation, not follow state' }
          ]
        }
      ],
      report: {
        title: 'Hub 桌面助手｜流式状态与工作过程证据复核',
        lead: '建议采用普通回执列表和一处 `status` 状态区。用户展开回执或离开列表末尾后，Hub 继续接收结果，同时保留阅读位置、展开状态和键盘焦点。用户主动按「回到最新」后恢复跟随。',
        table: [
          { topic: '播报语义', decision: '普通回执列表 + 独立 status 状态区', evidence: 'log 适合逐条事件流，status 适合简短状态变更，避免屏幕阅读器刷屏。', cite: 'WAI-ARIA 1.2' },
          { topic: '滚动与焦点', decision: '保留已有 DOM 节点，不强制吸底', evidence: '滚动锚定仅在节点稳定时生效，切忌流式更新时重挂载整段回执。', cite: 'MDN 锚定行为' },
          { topic: '减少动态效果', decision: '仅降级过渡动画，不改变跟随策略', evidence: 'prefers-reduced-motion 决定滚动方式为 instant，是否吸底仍取决于用户操作。', cite: 'WHATWG / MDN' }
        ],
        bullets: [
          { title: '流式追加不抢焦点', body: '当用户上滚查看旧回执或聚焦在某条工具记录时，立即暂停自动吸底，并在底栏上方浮现轻量「回到最新」胶囊。', cite: 'WAI 键盘焦点' },
          { title: '稳定 Key 避免展开态丢失', body: '即使流式输出仍在继续，已展开的工具回执节点不得被重置折叠。', cite: 'W3C Disclosure' }
        ],
        checklist: [
          { id: 1, title: '连续追加 5 条回执时仅播报最新状态摘要', env: '读屏器' },
          { id: 2, title: '展开某条工具回执期间，新回执到达不打断阅读', env: '桌面端' },
          { id: 3, title: '上滚离开底部 80px 后自动暂停跟随并显示「回到最新」', env: '桌面端' },
          { id: 4, title: '键盘 Tab 聚焦在回执按钮时，流式更新不丢失焦点', env: '键盘' },
          { id: 5, title: '开启系统减少动态效果后，「回到最新」改为瞬时跳转', env: '系统偏好' },
          { id: 6, title: '切换标签页或最小化恢复后，未读回执计数准确', env: '桌面端' }
        ]
      }
    }
  ]);

  const [interruptedMessages, setInterruptedMessages] = useState([
    {
      id: 'c2_m1',
      role: 'user',
      time: '14:46',
      text: '找一下我最近的任务，帮我安排一下'
    },
    {
      id: 'c2_m2',
      role: 'assistant',
      duration: '38 秒 · 未完成',
      isInterrupted: true,
      text: '未完成最终交付核验，已为你保留草稿。',
      timeline: [
        {
          type: 'contextPrep',
          id: 'c2-ctx',
          summary: '已载入上下文 · 1 条规则 · 未限定资料库',
          items: [
            { kind: 'rule', name: 'OS 知识库工作规则', file: 'AGENTS.md', hash: 'ae2f4fc', fullPath: 'OS/AGENTS.md' }
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
          title: '调用工具、搜索资料 · 10 步',
          badges: ['Hub'],
          steps: [
            { icon: 'database', label: '列出 Hub 资料库', detail: '已识别 Car / OS / 滴答清单 等 6 个库' },
            {
              id: 'c2-step-err',
              icon: 'alertTriangle',
              label: '搜索相关任务',
              countBadge: '× 8',
              detail: '1 项参数异常（取证查询需要 1–200 个字符）',
              isWarning: true,
              techJson: '{\n  "error": "取证查询需要 1-200 个字符",\n  "origin": "host",\n  "attempts": 8\n}'
            },
            { icon: 'fileText', label: '枚举授权材料', detail: '未勾选核心材料，仅基于默认收件箱尝试读取' }
          ]
        }
      ],
      interruptedCard: {
        title: '未完成最终核验，已为你保留草稿',
        desc: '本轮检索命中参数限制，回答尚未通过交付核验（不会自动反复重试）。你可以核对资料范围后继续，或先查看未发布草稿。',
        draft: '【草稿预览】根据滴答清单收件箱与近期记录，建议本周优先处理：\n1. 仪表线束 GUA 待查清单（高优先 · 截止本周五）\n2. Hub 助手工作过程与交互规范定稿（中优先）\n3. 整理 Car 与 OS 资料库中的归档标签边界。'
      }
    }
  ]);

  // 通用浮层关闭
  const closeAllPopovers = () => {
    setModeMenuOpen(false);
    setModelPopoverOpen(false);
    setSkillsPopoverOpen(false);
    setAttachMenuOpen(false);
    setLayoutMenuOpen(false);
    setSlashMenuOpen(false);
    setAtMenuOpen(false);
    setTagPickerSlot(null);
  };

  const switchDemoCase = (caseKey) => {
    setActiveCase(caseKey);
    setSourcesSearch('');
    setThreadTitle(
      caseKey === 'empty'
        ? '新对话'
        : caseKey === 'diary'
        ? '2023-05-06 日记核对与背景查证'
        : caseKey === 'interrupted'
        ? '找一下我最近的任务，帮我安排一下'
        : 'Hub 助手工作过程和展示方案'
    );
  };

  const handleJumpToNotePara = (anchorId, labelText) => {
    const el = surfaceRef.current?.querySelector('#' + anchorId);
    if (!el) return;
    setHighlightedPara(anchorId);
    if (el.getBoundingClientRect().width < 180) {
      setNarrowCitation({ label: labelText, text: el.querySelector('p').textContent.trim() });
    } else {
      el.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        block: 'center',
        inline: 'nearest',
      });
    }
    triggerToast('已定位至 ' + labelText);
    clearTimeout(paragraphTimer.current);
    paragraphTimer.current = setTimeout(() => setHighlightedPara(null), 2600);
  };

  const handleContinueInterrupted = (msgId) => {
    setInterruptedMessages(prev =>
      prev.map(m =>
        m.id === msgId
          ? {
              ...m,
              duration: '52 秒 · 已续跑完成',
              isInterrupted: false,
              interruptedCard: null,
              text: '已补充检索参数并完成交付核验：\n\n1. 【高优先 · 本周五前】核对仪表线束 GUA 待查清单（10 项待确认线索）\n2. 【中优先】敲定 Hub 助手多形态停靠与思维链交互方案\n3. 【日常整理】拆分 PARA Archives 与工程交付物归档标签。'
            }
          : m
      )
    );
    triggerToast('已续跑完成并通过核验');
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
      setSlashMenuOpen(false);
      setAtMenuOpen(false);
    }
  };

  const handleSendMessage = () => {
    if (!inputText.trim()) return;
    if (oldChatAuthNeeded) {
      triggerToast('请先确认是否允许当前账号读取本段旧对话历史');
      return;
    }
    const activeTopic = topics.find(t => t.id === activeTopicId);
    const modeLabel =
      taskMode === 'topic' && activeTopic ? activeTopic.name :
      taskMode === 'goal' ? '目标模式' :
      taskMode === 'tag' ? '标签助手' : '通用助手';

    const userMsg = { id: 'u_' + Date.now(), role: 'user', time: '刚刚', text: inputText.trim() };
    const aiMsg = {
      id: 'a_' + (Date.now() + 1),
      role: 'assistant',
      duration: '6 秒',
      text: `已按「${modeLabel}」结合 ${selectedDocs.length} 份核心资料与 ${selectedLibs.length} 个资料库处理完毕（模型：${currentModelObj.id} · 思考强度${currentReasoningObj.label}）。如需沉淀成果，可直接点击下方「存入笔记」或「创建任务」。`
    };
    if (activeCase === 'interrupted') {
      setInterruptedMessages(prev => [...prev, userMsg, aiMsg]);
    } else if (activeCase === 'diary') {
      setDiaryMessages(prev => [...prev, userMsg, aiMsg]);
    } else if (activeCase === 'empty') {
      setEmptyMessages(prev => [...prev, userMsg, aiMsg]);
      setThreadTitle(userMsg.text.slice(0, 18));
    } else {
      setMessages(prev => [...prev, userMsg, aiMsg]);
    }
    setInputText('');
    closeAllPopovers();
  };

  const applyTopic = (topic) => {
    setActiveTopicId(topic.id);
    setTaskMode('topic');
    setSelectedDocs(topic.docs);
    setSelectedLibs(topic.libs);
    setRetrievalStrategy(topic.strategy);
    setModeMenuOpen(false);
    setModePopoverView('main');
    triggerToast(`已切换至专题「${topic.name}」`);
  };

  const handleCreateCustomTopic = (nameText, docsArr, libsArr, strat) => {
    const clean = nameText.trim();
    if (!clean) return;
    const newTopic = {
      id: 't_' + Date.now(),
      name: clean,
      docs: docsArr,
      libs: libsArr,
      strategy: strat,
      pinned: true
    };
    setTopics(prev => [newTopic, ...prev]);
    setActiveTopicId(newTopic.id);
    setTaskMode('topic');
    triggerToast(`已保存并置顶专题「${clean}」`);
  };

  const handleConfirmAccountSwitch = (acc) => {
    setActiveAccountId(acc.id);
    setPendingSwitchId(null);
    setAccountModalOpen(false);
    setSwitchedBanner(`${acc.email} · ${acc.workspace}`);
    if (switchCarryMode === 'new') {
      setThreadTitle('新对话');
      setOldChatAuthNeeded(false);
      triggerToast(`已切至 ${acc.workspace} 账号并开启新对话`);
    } else {
      triggerToast(`已切至 ${acc.workspace} 账号，下条消息将带入必要历史`);
    }
  };

  const activeAccount = codexAccounts.find(a => a.id === activeAccountId) || codexAccounts[0];
  const activeTopic = topics.find(t => t.id === activeTopicId);
  const currentModeName =
    taskMode === 'goal' ? '目标模式' :
    taskMode === 'tag' ? '标签助手' :
    taskMode === 'topic' && activeTopic ? activeTopic.name : '标准';

  const modePillStyle =
    taskMode === 'goal'
      ? 'bg-amber-50 text-amber-800 border-amber-200/80 hover:bg-amber-100/70'
      : taskMode === 'tag'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200/80 hover:bg-emerald-100/70'
      : taskMode === 'topic'
      ? 'bg-indigo-50 text-indigo-700 border-indigo-200/80 hover:bg-indigo-100/70'
      : 'bg-surface text-secondary border-border hover:bg-hover hover:text-primary';

  const modeDotStyle =
    taskMode === 'goal' ? 'bg-amber-500' :
    taskMode === 'tag' ? 'bg-emerald-500' :
    taskMode === 'topic' ? 'bg-accent-indigo' : null;

  const currentMessagesList =
    activeCase === 'empty' ? emptyMessages :
    activeCase === 'diary' ? diaryMessages :
    activeCase === 'interrupted' ? interruptedMessages : messages;
  const visibleMessages = onlyLatestReply && currentMessagesList.length > 0
    ? [currentMessagesList[currentMessagesList.length - 1]]
    : currentMessagesList;

  const visibleLocalFiles = expandAllFiles ? attachedLocalFiles : attachedLocalFiles.slice(0, 3);
  const hiddenFilesCount = attachedLocalFiles.length > 3 ? attachedLocalFiles.length - 3 : 0;

  const fileKindStyle = (kind) => {
    if (kind === 'video') return { icon: 'video', color: 'text-purple-600' };
    if (kind === 'code') return { icon: 'code', color: 'text-sky-600' };
    if (kind === 'pdf') return { icon: 'fileText', color: 'text-rose-600' };
    if (kind === 'task') return { icon: 'checkSquare', color: 'text-emerald-600' };
    return { icon: 'fileText', color: 'text-secondary' };
  };

  const dialogState = [historyOpen, inspectorOpen, scopeModalOpen, saveNoteModalOpen, createTaskModalOpen,
    sourcesModalOpen, memorySheetOpen, skillsManagerOpen, accountModalOpen, !!lightboxImage, !!narrowCitation].join(':');
  useEffect(() => {
    const surface = surfaceRef.current;
    const dialog = Array.from(surface.querySelectorAll('[data-reference-dialog]')).at(-1);
    if (!dialog) return;
    const opener = surface.getRootNode().activeElement;
    if (!dialog.contains(opener)) dialog.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected && !dialog.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [dialogState]);

  function handleSurfaceKeyDown(event) {
    if (event.key === 'Tab') {
      const dialog = Array.from(surfaceRef.current.querySelectorAll('[data-reference-dialog]')).at(-1);
      if (dialog) {
        const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')]
          .filter(element => element.getClientRects().length);
        const current = surfaceRef.current.getRootNode().activeElement;
        const first = controls[0];
        const last = controls.at(-1);
        if (!controls.includes(current) || (event.shiftKey ? current === first : current === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
      return;
    }
    if (event.key !== 'Escape') return;
    const dismiss = [
      [narrowCitation, () => setNarrowCitation(null)],
      [lightboxImage, () => setLightboxImage(null)],
      [accountModalOpen, () => setAccountModalOpen(false)],
      [skillsManagerOpen, () => setSkillsManagerOpen(false)],
      [memorySheetOpen, () => setMemorySheetOpen(false)],
      [sourcesModalOpen, () => setSourcesModalOpen(false)],
      [createTaskModalOpen, () => setCreateTaskModalOpen(false)],
      [saveNoteModalOpen, () => setSaveNoteModalOpen(false)],
      [scopeModalOpen, () => setScopeModalOpen(false)],
      [inspectorOpen, () => setInspectorOpen(false)],
      [historyOpen, () => setHistoryOpen(false)],
      [modeMenuOpen || modelPopoverOpen || layoutMenuOpen || skillsPopoverOpen || attachMenuOpen || slashMenuOpen || atMenuOpen || tagPickerSlot, closeAllPopovers],
      [agentOpen, () => setAgentOpen(false)],
    ].find(([open]) => open);
    if (dismiss) {
      event.preventDefault();
      event.stopPropagation();
      dismiss[1]();
    }
  }

  // Agent 容器按宿主形态切换样式
  const agentShellClass =
    agentMorphology === 'docked'
      ? 'relative w-full md:w-[460px] lg:w-[510px] h-full bg-canvas border-l border-border flex flex-col shrink-0 z-20 transition-all duration-200'
      : agentMorphology === 'floating'
      ? 'fixed md:absolute top-3 right-3 bottom-3 w-[calc(100%-24px)] md:w-[460px] bg-canvas rounded-2xl border border-border shadow-float flex flex-col z-30 transition-all duration-200 overflow-hidden'
      : 'fixed md:absolute inset-3 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[820px] max-w-[calc(100%-24px)] bg-canvas rounded-2xl border border-border shadow-float flex flex-col z-30 transition-all duration-200 overflow-hidden';

  return (
    <div ref={surfaceRef} data-reference-prototype className="h-dvh w-full flex flex-col bg-frame overflow-hidden"
      onKeyDown={handleSurfaceKeyDown}>
      {/* ==================== 顶部原型控制条 ==================== */}
      <header className="reference-case-bar h-11 px-3.5 bg-frame border-b border-border flex items-center justify-between gap-2 shrink-0 z-40">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-lg bg-primary text-white flex items-center justify-center text-[11px] font-bold shrink-0">H</div>
          <span className="text-[12.5px] font-semibold text-primary truncate">Hub 助手 · 高保真原型</span>
          <span className="text-border hidden sm:inline">|</span>
          <div className="reference-case-picker flex items-center bg-subtle p-0.5 rounded-xl border border-border">
            <button
              aria-pressed={activeCase === 'diary'}
              onClick={() => { switchDemoCase('diary'); setAgentOpen(true); }}
              className={`px-2 py-0.5 rounded-lg text-[11px] font-medium transition-all flex items-center gap-1 ${activeCase === 'diary' ? 'bg-surface text-primary shadow-2xs' : 'text-secondary hover:text-primary'}`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-accent-indigo"></span>
              <span className="hidden sm:inline">案例1：</span><span>引用与摘录</span>
            </button>
            <button
              aria-pressed={activeCase === 'report'}
              onClick={() => { switchDemoCase('report'); setAgentOpen(true); }}
              className={`px-2 py-0.5 rounded-lg text-[11px] font-medium transition-all ${activeCase === 'report' ? 'bg-surface text-primary shadow-2xs' : 'text-secondary hover:text-primary'}`}
            >
              <span className="hidden sm:inline">案例2：</span><span>流式复核</span>
            </button>
            <button
              aria-pressed={activeCase === 'interrupted'}
              onClick={() => { switchDemoCase('interrupted'); setAgentOpen(true); }}
              className={`px-2 py-0.5 rounded-lg text-[11px] font-medium transition-all flex items-center gap-1 ${activeCase === 'interrupted' ? 'bg-surface text-primary shadow-2xs' : 'text-secondary hover:text-primary'}`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
              <span className="hidden sm:inline">案例3：</span><span>中断与规则</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!agentOpen && (
            <button
              onClick={() => setAgentOpen(true)}
              className="h-7 px-2.5 rounded-lg bg-primary text-white text-[11.5px] font-medium flex items-center gap-1.5 hover:opacity-90 transition-opacity shadow-2xs"
            >
              <Icon name="sparkles" className="w-3.5 h-3.5" />
              <span>唤起 Hub 助手</span>
            </button>
          )}
          {agentOpen && (
            <span className="hidden lg:inline text-[11px] text-muted">
              当前形态：{agentMorphology === 'docked' ? '右侧分屏停靠' : agentMorphology === 'floating' ? '悬浮浮窗' : '专注展开'}
            </span>
          )}
          {onOpenDemos && <button type="button" onClick={onOpenDemos} className="reference-workspace-link">更多演示</button>}
          {onDismiss && <button type="button" onClick={onDismiss} className="reference-workspace-link">返回工作台</button>}
        </div>
      </header>

      {/* ==================== Hub 宿主工作台 + Agent 多形态容器 ==================== */}
      <div className="flex-1 relative flex min-h-0 overflow-hidden">
        {/* 底层 Hub 工作台（左侧资料列表 + 中间 Obsidian 阅读区） */}
        <div className={`flex-1 flex min-w-0 bg-surface transition-opacity duration-200 ${agentOpen && agentMorphology === 'expanded' ? 'opacity-40 pointer-events-none' : 'opacity-100'}`}>
          {/* Hub 左侧极简列表（宽屏显示） */}
          <aside className="hidden lg:flex w-52 border-r border-border bg-canvas flex-col shrink-0">
            <div className="h-11 px-3 border-b border-border flex items-center justify-between text-[12px] font-semibold text-primary">
              <span>全部资料</span>
              <span className="text-[11px] font-mono text-muted">69</span>
            </div>
            <div className="p-2 space-y-1 overflow-y-auto text-[12px]">
              <div className="px-2 py-1 text-[10.5px] font-medium text-muted">今天</div>
              <div className="px-2.5 py-2 rounded-xl bg-surface border border-border shadow-2xs">
                <div className="font-medium text-primary truncate">2023-05-06</div>
                <div className="text-[11px] text-muted truncate mt-0.5">Obsidian · OS / Journals</div>
              </div>
              <div className="px-2.5 py-2 rounded-xl hover:bg-hover transition-colors cursor-pointer">
                <div className="font-medium text-secondary truncate">把 Codex 接入 Hub 的意义</div>
                <div className="text-[11px] text-muted truncate mt-0.5">滴答清单 · 收件箱</div>
              </div>
              <div className="px-2.5 py-2 rounded-xl hover:bg-hover transition-colors cursor-pointer">
                <div className="font-medium text-secondary truncate">仪表线束 GUA 待查清单</div>
                <div className="text-[11px] text-muted truncate mt-0.5">飞书 · 工程资料</div>
              </div>
            </div>
          </aside>

          {/* Hub 主文档阅读区（与右侧引用联动滚动高亮） */}
          <section className="flex-1 flex flex-col min-w-0 bg-surface overflow-y-auto select-text">
            <div className="h-11 px-5 border-b border-border flex items-center justify-between text-[12px] text-muted shrink-0 sticky top-0 bg-surface/90 glass z-10">
              <div className="flex items-center gap-2 min-w-0">
                <span className="px-1.5 py-0.5 rounded-md bg-purple-50 text-purple-700 text-[10.5px] font-medium">Obsidian</span>
                <span className="truncate">OS / Journals / 2023-05-06.md</span>
              </div>
              <span className="text-[11px] hidden sm:inline">预览样式 · 纸张</span>
            </div>

            <div className="max-w-2xl mx-auto w-full px-6 py-7 space-y-4 text-[14px] leading-[1.85] text-primary/90">
              <h2 className="text-xl font-bold tracking-tight text-primary">2023-05-06 · 项目周记与复盘示例</h2>
              <p>
                把 Codex 接入 Hub，希望做到：让已有资料成为可以推进工作的上下文，让成果回到自己的知识和任务系统。在右侧点击任意知识库引用编号（如 <code className="font-mono text-xs bg-subtle px-1 rounded">14</code> <code className="font-mono text-xs bg-subtle px-1 rounded">17</code> <code className="font-mono text-xs bg-subtle px-1 rounded">29</code>），左侧正文会自动滚动并暖黄高亮对应段落。
              </p>
              <div className="flex flex-wrap gap-1.5 py-1">
                <span className="px-2 py-0.5 rounded-md bg-sky-50 text-sky-700 text-xs font-medium">#行动模式/积极复盘</span>
                <span className="px-2 py-0.5 rounded-md bg-sky-50 text-sky-700 text-xs font-medium">#认知和行为习惯</span>
              </div>

              <div data-reading-anchor id="para-14" className={`p-3 -mx-3 rounded-xl transition-all duration-300 ${highlightedPara === 'para-14' ? 'bg-amber-100/80 ring-1 ring-amber-300' : ''}`}>
                <div className="text-[10.5px] font-mono text-muted mb-1">段落 14–16</div>
                <p>
                  这周的迁移计划比预期慢，需要先稳定导入流程。逐项核对后发现测试数据还有几批没整理，接下来要确认各批数据的来源和检查先后。
                </p>
              </div>

              <div data-reading-anchor id="para-17" className={`p-3 -mx-3 rounded-xl transition-all duration-300 ${highlightedPara === 'para-17' ? 'bg-amber-100/80 ring-1 ring-amber-300' : ''}`}>
                <div className="text-[10.5px] font-mono text-muted mb-1">段落 17</div>
                <p>
                  当时想等两轮回归通过后，再恢复批量导入。现在还要核对，恢复的时间和回滚条件能否同时满足。
                </p>
              </div>

              <div data-reading-anchor id="para-29" className={`p-3 -mx-3 rounded-xl transition-all duration-300 ${highlightedPara === 'para-29' ? 'bg-amber-100/80 ring-1 ring-amber-300' : ''}`}>
                <div className="text-[10.5px] font-mono text-muted mb-1">段落 29–30</div>
                <p>
                  今天先停用了自动重试，避免反复执行同一项。接下来还要决定出现同类问题时，是先提示用户还是进入人工检查。
                </p>
              </div>

              <blockquote className="pl-3.5 py-1.5 border-l-2 border-purple-300 bg-purple-50/35 rounded-r-xl text-[13.5px] text-secondary">
                选中几篇材料 → 结合已有知识比较整理 → 更新专题笔记 → 提炼行动 → 下次继续。
              </blockquote>
            </div>
          </section>
        </div>

        {/* ==================== Hub Agent 面板 ==================== */}
        {agentOpen && (
          <section className={agentShellClass} aria-label="助手对话" data-reference-window={agentMorphology}>
            {/* ---------- 1. Agent 顶栏（彻底解耦：左历史+新建 / 中单行标题 / 右模式+详情 | 形态+关闭） ---------- */}
            <header className="h-12 px-3 bg-canvas/90 glass border-b border-border flex items-center justify-between gap-2 shrink-0 relative z-30">
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => { closeAllPopovers(); setHistoryOpen(v => !v); }}
                  title="对话历史"
                  className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${historyOpen ? 'bg-hover text-primary' : 'text-secondary hover:bg-hover hover:text-primary'}`}
                >
                  <Icon name="menu" className="w-4 h-4" />
                </button>
                <button
                  onClick={() => {
                    closeAllPopovers();
                    switchDemoCase('empty');
                    setEmptyMessages([]);
                    setOldChatAuthNeeded(false);
                    triggerToast('已新建空白对话');
                  }}
                  title="新建对话"
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-secondary hover:bg-hover hover:text-primary transition-colors"
                >
                  <Icon name="plus" className="w-4 h-4" />
                </button>
              </div>

              {/* 单行可内联重命名标题 */}
              <div className="flex-1 min-w-0 px-1 flex justify-center">
                {editingTitle ? (
                  <input
                    autoFocus
                    value={threadTitle}
                    onChange={(e) => setThreadTitle(e.target.value)}
                    onBlur={() => setEditingTitle(false)}
                    onKeyDown={(e) => e.key === 'Enter' && setEditingTitle(false)}
                    className="w-full max-w-[240px] text-center text-[13px] font-semibold bg-surface border border-border rounded-lg px-2 py-0.5 outline-none focus:border-primary/40"
                  />
                ) : (
                  <button
                    onClick={() => setEditingTitle(true)}
                    title="点击重命名对话"
                    className="max-w-full truncate text-[13px] font-semibold text-primary hover:bg-hover px-2 py-1 rounded-lg transition-colors"
                  >
                    {threadTitle}
                  </button>
                )}
              </div>

              {/* 右侧分组：对话层（模式 + 详情） | 窗口层（形态 + 收起） */}
              <div className="flex items-center gap-1 shrink-0">
                {/* 任务模式与专题胶囊 */}
                <div className="relative">
                  <button
                    onClick={() => {
                      const next = !modeMenuOpen;
                      closeAllPopovers();
                      setModeMenuOpen(next);
                      setModePopoverView('main');
                    }}
                    className={`h-7 px-2 rounded-lg border text-[11.5px] font-medium flex items-center gap-1.5 transition-colors max-w-[118px] ${modePillStyle}`}
                  >
                    {modeDotStyle && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${modeDotStyle}`}></span>}
                    <span className="truncate">{currentModeName}</span>
                    <Icon name="chevronDown" className="w-3 h-3 opacity-70 shrink-0" />
                  </button>

                  {/* 任务模式 & 专题统一浮层 */}
                  {modeMenuOpen && (
                    <div className="absolute right-0 top-full mt-2 w-[310px] rounded-2xl bg-surface/95 glass border border-border shadow-popover p-2.5 z-50 animate-fadeIn">
                      {modePopoverView === 'main' ? (
                        <div className="space-y-1.5">
                          <div className="px-1.5 py-0.5 flex items-center justify-between">
                            <span className="text-[11.5px] font-semibold text-primary">任务模式</span>
                            <button onClick={() => setModeMenuOpen(false)} className="text-muted hover:text-primary">
                              <Icon name="x" className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          {[
                            { id: 'standard', name: '通用助手', desc: '自由提问，保留当前对话与设置', icon: 'sparkles', iconCls: 'bg-subtle text-primary border-border' },
                            { id: 'goal', name: '目标模式', desc: '按完成条件推进，遇到阻碍时暂停', icon: 'target', iconCls: 'bg-amber-50 text-amber-600 border-amber-200/70' },
                            { id: 'tag', name: '标签助手', desc: '起草定义、查找漏标、比较关系', icon: 'tag', iconCls: 'bg-emerald-50 text-emerald-600 border-emerald-200/70' }
                          ].map(m => (
                            <button
                              key={m.id}
                              onClick={() => { setTaskMode(m.id); setModeMenuOpen(false); }}
                              className={`w-full p-2 rounded-xl flex items-center gap-2.5 text-left transition-colors ${taskMode === m.id ? 'bg-subtle' : 'hover:bg-hover/70'}`}
                            >
                              <span className={`w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 ${m.iconCls}`}>
                                <Icon name={m.icon} className="w-3.5 h-3.5" />
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="text-[12.5px] font-medium text-primary">{m.name}</div>
                                <div className="text-[11px] text-muted truncate">{m.desc}</div>
                              </div>
                              {taskMode === m.id && <Icon name="check" className="w-4 h-4 text-primary shrink-0" />}
                            </button>
                          ))}

                          <div className="pt-2 mt-1 border-t border-border">
                            <div className="px-1.5 mb-1.5 flex items-center justify-between">
                              <span className="text-[11px] font-medium text-muted">置顶专题</span>
                              <button
                                onClick={() => setModePopoverView('allTopics')}
                                className="text-[11px] font-medium text-accent-indigo hover:underline"
                              >
                                全部专题 ({topics.length}) ›
                              </button>
                            </div>
                            <div className="space-y-1">
                              {topics.filter(t => t.pinned).map(t => {
                                const active = taskMode === 'topic' && activeTopicId === t.id;
                                return (
                                  <button
                                    key={t.id}
                                    onClick={() => applyTopic(t)}
                                    className={`w-full p-2 rounded-xl flex items-center gap-2.5 text-left transition-colors ${active ? 'bg-indigo-50/70 ring-1 ring-indigo-200/80' : 'hover:bg-hover/70'}`}
                                  >
                                    <span className="w-7 h-7 rounded-lg bg-indigo-50 border border-indigo-200/70 text-accent-indigo flex items-center justify-center shrink-0">
                                      <Icon name="layers" className="w-3.5 h-3.5" />
                                    </span>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-[12.5px] font-medium text-primary truncate">{t.name}</div>
                                      <div className="text-[10.5px] text-muted truncate">
                                        {t.strategy === 'only' ? '只用所选' : '优先所选'} · {t.docs.length} 篇 · {t.libs.length} 库
                                      </div>
                                    </div>
                                    {active && <Icon name="check" className="w-4 h-4 text-accent-indigo shrink-0" />}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="pt-2 mt-1 border-t border-border px-1.5 flex items-center justify-between text-[11px]">
                            <span className="text-muted">执行安排 · 自动</span>
                            <button
                              onClick={() => { setModeMenuOpen(false); setInspectorOpen(true); }}
                              className="text-primary font-medium hover:underline"
                            >
                              查看任务状态
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between px-1">
                            <button
                              onClick={() => setModePopoverView('main')}
                              className="flex items-center gap-1 text-[11.5px] font-medium text-secondary hover:text-primary"
                            >
                              <Icon name="chevronLeft" className="w-3.5 h-3.5" />
                              <span>全部专题</span>
                            </button>
                            <button onClick={() => setModeMenuOpen(false)} className="text-muted hover:text-primary">
                              <Icon name="x" className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          <div className="relative">
                            <Icon name="search" className="w-3.5 h-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
                            <input
                              value={topicSearch}
                              onChange={(e) => setTopicSearch(e.target.value)}
                              placeholder="搜索专题..."
                              className="w-full h-8 pl-8 pr-2.5 rounded-xl bg-subtle border border-border text-[12px] outline-none focus:border-primary/30"
                            />
                          </div>

                          <div className="max-h-48 overflow-y-auto space-y-1">
                            {topics
                              .filter(t => t.name.toLowerCase().includes(topicSearch.toLowerCase()))
                              .map(t => (
                                <div key={t.id} className="p-2 rounded-xl hover:bg-hover/70 flex items-center gap-2">
                                  <button onClick={() => applyTopic(t)} className="flex-1 min-w-0 text-left flex items-center gap-2">
                                    <span className="w-6 h-6 rounded-lg bg-indigo-50 text-accent-indigo flex items-center justify-center shrink-0">
                                      <Icon name="layers" className="w-3.5 h-3.5" />
                                    </span>
                                    <div className="min-w-0">
                                      <div className="text-[12px] font-medium text-primary truncate">{t.name}</div>
                                      <div className="text-[10.5px] text-muted">{t.docs.length} 篇 · {t.libs.length} 库</div>
                                    </div>
                                  </button>
                                  <button
                                    onClick={() => setTopics(prev => prev.map(item => item.id === t.id ? { ...item, pinned: !item.pinned } : item))}
                                    title={t.pinned ? '取消置顶' : '置顶到模式菜单'}
                                    className={`w-6 h-6 rounded-lg flex items-center justify-center transition-colors ${t.pinned ? 'text-accent-indigo bg-indigo-50' : 'text-muted hover:bg-subtle'}`}
                                  >
                                    <Icon name="pin" className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ))}
                          </div>

                          <div className="pt-2 border-t border-border flex items-center gap-1.5">
                            <input
                              value={newTopicName}
                              onChange={(e) => setNewTopicName(e.target.value)}
                              placeholder="新建自定义专题名..."
                              className="flex-1 h-8 px-2.5 rounded-xl bg-subtle border border-border text-[12px] outline-none focus:border-primary/30"
                            />
                            <button
                              onClick={() => {
                                if (!newTopicName.trim()) return;
                                handleCreateCustomTopic(newTopicName, selectedDocs, selectedLibs, retrievalStrategy);
                                setNewTopicName('');
                                setModeMenuOpen(false);
                              }}
                              className="h-8 px-3 rounded-xl bg-primary text-white text-[11.5px] font-medium hover:opacity-90 shrink-0"
                            >
                              创建
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 对话详情 (Inspector) 按钮 — 用 Sliders 彻底与侧栏形态区分 */}
                <button
                  onClick={() => { closeAllPopovers(); setInspectorOpen(v => !v); }}
                  title="对话详情与工具"
                  className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${inspectorOpen ? 'bg-hover text-primary' : 'text-secondary hover:bg-hover hover:text-primary'}`}
                >
                  <Icon name="sliders" className="w-3.5 h-3.5" />
                </button>

                <span className="w-px h-3.5 bg-border mx-0.5"></span>

                {/* 窗口形态 3 选 1 切换 */}
                <div className="relative">
                  <button
                    onClick={() => {
                      const next = !layoutMenuOpen;
                      closeAllPopovers();
                      setLayoutMenuOpen(next);
                    }}
                    title="切换助手窗口形态"
                    className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${layoutMenuOpen ? 'bg-hover text-primary' : 'text-secondary hover:bg-hover hover:text-primary'}`}
                  >
                    <Icon name={agentMorphology === 'docked' ? 'dockRight' : agentMorphology === 'floating' ? 'floatWin' : 'expandWin'} className="w-4 h-4" />
                  </button>

                  {layoutMenuOpen && (
                    <div className="absolute right-0 top-full mt-2 w-56 rounded-2xl bg-surface/95 glass border border-border shadow-popover p-1.5 z-50 animate-fadeIn">
                      <div className="px-2 py-1 text-[10.5px] font-medium text-muted">助手窗口形态</div>
                      {[
                        { id: 'docked', name: '右侧分屏停靠', desc: '与文档并排对照，互不遮挡', icon: 'dockRight' },
                        { id: 'floating', name: '悬浮浮窗', desc: '浮在文档上方，不触发重排', icon: 'floatWin' },
                        { id: 'expanded', name: '专注展开', desc: '居中宽屏阅读长报告与表格', icon: 'expandWin' }
                      ].map(opt => (
                        <button
                          key={opt.id}
                          onClick={() => { setAgentMorphology(opt.id); setLayoutMenuOpen(false); }}
                          className={`w-full p-2 rounded-xl flex items-center gap-2.5 text-left transition-colors ${agentMorphology === opt.id ? 'bg-subtle' : 'hover:bg-hover/70'}`}
                        >
                          <Icon name={opt.icon} className="w-4 h-4 text-primary shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-[12px] font-medium text-primary">{opt.name}</div>
                            <div className="text-[10.5px] text-muted">{opt.desc}</div>
                          </div>
                          {agentMorphology === opt.id && <Icon name="check" className="w-3.5 h-3.5 text-primary shrink-0" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* 收起助手 */}
                <button
                  onClick={() => setAgentOpen(false)}
                  title="收起助手"
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-secondary hover:bg-hover hover:text-primary transition-colors"
                >
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
            </header>

            {/* ---------- 2. 轻量模式上下文条 (36px，不堆叠巨型横幅) ---------- */}
            {taskMode === 'goal' && (
              <div className="h-9 px-3 bg-amber-50/70 border-b border-amber-200/70 flex items-center justify-between gap-2 text-[11.5px] shrink-0 animate-fadeIn">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <Icon name="target" className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                  <input
                    value={goalCondition}
                    onChange={(e) => setGoalCondition(e.target.value)}
                    className="bg-transparent text-amber-900 font-medium w-full outline-none truncate"
                  />
                </div>
                <button onClick={() => setTaskMode('standard')} className="text-amber-700/70 hover:text-amber-900 shrink-0">
                  <Icon name="x" className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {taskMode === 'tag' && (
              <div className="h-10 px-3 bg-emerald-50/50 border-b border-emerald-200/70 flex items-center justify-between gap-2 shrink-0 animate-fadeIn">
                <div className="flex items-center bg-surface/80 p-0.5 rounded-lg border border-emerald-200/80 text-[11px]">
                  {[
                    { id: 'draft', label: '起草定义' },
                    { id: 'missing', label: '查找漏标' },
                    { id: 'compare', label: '比较关系' }
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setTagSubMode(tab.id)}
                      className={`px-2.5 py-0.5 rounded-md font-medium transition-all ${tagSubMode === tab.id ? 'bg-emerald-600 text-white shadow-2xs' : 'text-emerald-800 hover:bg-emerald-50'}`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => setTaskMode('standard')} className="text-emerald-700/70 hover:text-emerald-900">
                  <Icon name="x" className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {taskMode === 'topic' && activeTopic && (
              <div className="h-9 px-3 bg-indigo-50/60 border-b border-indigo-200/70 flex items-center justify-between gap-2 text-[11.5px] shrink-0 animate-fadeIn">
                <div className="flex items-center gap-1.5 min-w-0 text-indigo-800">
                  <Icon name="layers" className="w-3.5 h-3.5 shrink-0" />
                  <span className="font-medium truncate">{activeTopic.name}</span>
                  <span className="text-indigo-600/75 text-[11px] shrink-0">
                    · {activeTopic.strategy === 'only' ? '只用所选' : '优先所选'}
                  </span>
                </div>
                <button onClick={() => setTaskMode('standard')} className="text-[11px] text-indigo-700 hover:underline shrink-0">
                  退出专题
                </button>
              </div>
            )}

            {/* ---------- 3. 对话内容流 ---------- */}
            <main ref={messageList} aria-label="对话记录" className="flex-1 overflow-y-auto px-4 py-4 space-y-6 select-text" onClick={closeAllPopovers}>
              {visibleMessages.length === 0 ? (
                <div className="h-full min-h-[320px] flex flex-col items-center justify-center px-3 py-8 text-center animate-fadeIn">
                  <div className="w-11 h-11 rounded-2xl bg-surface border border-border shadow-xs flex items-center justify-center mb-4 text-primary">
                    <Icon name="sparkles" className="w-5 h-5" />
                  </div>
                  <h2 className="text-[18px] font-semibold tracking-tight text-primary">准备从哪里开始？</h2>
                  <p className="text-[12.5px] text-muted mt-1.5 max-w-[280px] leading-relaxed">
                    直接提问，或输入 <code className="px-1 py-0.5 rounded bg-subtle border border-border font-mono text-[11px] text-secondary">/</code> 调用技能、<code className="px-1 py-0.5 rounded bg-subtle border border-border font-mono text-[11px] text-secondary">@</code> 引用知识库资料
                  </p>
                  <div className="w-full max-w-[380px] grid grid-cols-1 gap-2 mt-6 text-left">
                    {[
                      { title: '整理当前页面资料', desc: '梳理 2023-05-06 原文待查项与段落引用', icon: 'fileText', action: () => switchDemoCase('diary') },
                      { title: '比对标签关系', desc: '进入标签助手起草定义或查找漏标', icon: 'tag', action: () => { setTaskMode('tag'); setTagSubMode('compare'); setInputText('帮我比较 #archive 与 #movie 的归档边界'); } },
                      { title: '检索 Car 资料库', desc: '核对工程图纸说明、线表与近期任务', icon: 'database', action: () => { setSelectedLibs(['Car', 'OS']); setInputText('检索 Car 资料库中最新的线束待查清单'); } }
                    ].map((card, ci) => (
                      <button
                        key={ci}
                        onClick={card.action}
                        className="p-3 rounded-2xl bg-surface hover:bg-hover/70 border border-border shadow-2xs flex items-center gap-3 transition-colors group"
                      >
                        <span className="w-8 h-8 rounded-xl bg-subtle border border-border flex items-center justify-center text-secondary group-hover:text-primary shrink-0">
                          <Icon name={card.icon} className="w-4 h-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[12.5px] font-medium text-primary truncate">{card.title}</div>
                          <div className="text-[11px] text-muted truncate mt-0.5">{card.desc}</div>
                        </div>
                        <Icon name="chevronRight" className="w-3.5 h-3.5 text-muted/60 group-hover:text-primary shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              ) : visibleMessages.map(msg =>
                msg.role === 'user' ? (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[88%] rounded-2xl bg-subtle border border-border px-3.5 py-2.5 text-[13.5px] leading-relaxed text-primary">
                      {msg.text}
                    </div>
                  </div>
                ) : (
                  <div key={msg.id} className="space-y-3.5">
                    {/* A. Codex 风格两层可钻取思维链 */}
                    {msg.timeline && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <button
                            aria-expanded={!!timelineOpenMap[msg.id]}
                            onClick={() => setTimelineOpenMap(prev => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 -ml-2 rounded-lg text-[12px] font-medium text-secondary hover:bg-hover hover:text-primary transition-colors"
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${msg.isInterrupted ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
                            <span className="font-mono tabular-nums">用时 {msg.duration}</span>
                            <Icon name={timelineOpenMap[msg.id] ? 'chevronDown' : 'chevronRight'} className="w-3.5 h-3.5 text-muted" />
                          </button>
                        </div>

                        {timelineOpenMap[msg.id] && (
                          <div className="pl-3 border-l border-border space-y-2.5 text-[12.5px] text-secondary animate-fadeIn">
                            {msg.timeline.map((node, ni) => {
                              if (node.type === 'contextPrep') {
                                const open = !!toolGroupOpenMap[node.id];
                                return (
                                  <div key={ni} className="space-y-1.5">
                                    <button
                                      aria-expanded={open}
                                      onClick={() => setToolGroupOpenMap(prev => ({ ...prev, [node.id]: !prev[node.id] }))}
                                      className="inline-flex items-center gap-1.5 text-[12px] text-secondary hover:text-primary"
                                    >
                                      <Icon name="layers" className="w-3.5 h-3.5 text-muted" />
                                      <span>{node.summary}</span>
                                      <Icon name={open ? 'chevronDown' : 'chevronRight'} className="w-3 h-3 text-muted" />
                                    </button>
                                    {open && (
                                      <div className="pl-4 border-l border-border space-y-1.5 py-0.5 text-[11.5px] animate-fadeIn">
                                        {node.items.map((it, ii) => (
                                          <div key={ii} className="flex items-center justify-between gap-2 py-0.5">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                              <Icon name={it.kind === 'rule' ? 'shield' : 'fileText'} className={`w-3.5 h-3.5 shrink-0 ${it.kind === 'rule' ? 'text-accent-indigo' : 'text-muted'}`} />
                                              <span className="text-primary/85 truncate">{it.name}</span>
                                              {it.kind === 'rule' ? (
                                                <span className="px-1.5 py-0.5 rounded bg-subtle border border-border font-mono text-[10px] text-muted shrink-0">
                                                  {it.file} · {it.hash}
                                                </span>
                                              ) : (
                                                <span className="text-[11px] text-muted truncate">{it.meta}</span>
                                              )}
                                            </div>
                                            {it.kind === 'rule' && (
                                              <button
                                                onClick={() => triggerToast(`已打开规则文件 ${it.fullPath}`)}
                                                className="text-[11px] text-accent-indigo hover:underline shrink-0"
                                              >
                                                查看 ↗
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
                                  <p key={ni} className="leading-relaxed text-primary/80">
                                    <InlineCodeText text={node.text} />
                                  </p>
                                );
                              }

                              if (node.type === 'toolGroup') {
                                const open = !!toolGroupOpenMap[node.id];
                                return (
                                  <div key={ni} className="space-y-1.5">
                                    <button
                                      aria-expanded={open}
                                      onClick={() => setToolGroupOpenMap(prev => ({ ...prev, [node.id]: !prev[node.id] }))}
                                      className="inline-flex items-center gap-2 text-[12px] text-secondary hover:text-primary"
                                    >
                                      <Icon name={node.icon || 'search'} className="w-3.5 h-3.5 text-muted" />
                                      <span className="font-medium text-primary/85">{node.title}</span>
                                      {node.badges && (
                                        <span className="inline-flex items-center -space-x-1">
                                          {node.badges.map((b, bi) => <SiteFavicon key={bi} site={b} />)}
                                        </span>
                                      )}
                                      <Icon name={open ? 'chevronDown' : 'chevronRight'} className="w-3 h-3 text-muted" />
                                    </button>

                                    {open && (
                                      <div className="pl-4 border-l border-border space-y-1.5 py-0.5 text-[12px] animate-fadeIn">
                                        {node.steps.map((st, si) =>
                                          st.browsedPages ? (
                                            <div key={si} className="space-y-1.5">
                                              <button
                                                aria-expanded={!!stepDetailOpenMap[st.id]}
                                                onClick={() => setStepDetailOpenMap(prev => ({ ...prev, [st.id]: !prev[st.id] }))}
                                                className="inline-flex items-center gap-1.5 text-secondary hover:text-primary py-0.5"
                                              >
                                                <Icon name={st.icon} className="w-3.5 h-3.5 text-muted" />
                                                <span className="font-medium text-primary/80">{st.label}</span>
                                                <Icon name={stepDetailOpenMap[st.id] ? 'chevronDown' : 'chevronRight'} className="w-3 h-3 text-muted" />
                                              </button>
                                              {stepDetailOpenMap[st.id] && (
                                                <div className="pl-5 flex flex-wrap gap-1.5 animate-fadeIn">
                                                  {st.browsedPages.map((pg, pgi) => (
                                                    <button
                                                      key={pgi}
                                                      onClick={() => triggerToast(`将在浏览器打开 ${pg.url}`)}
                                                      className="h-[24px] pl-1 pr-2 rounded-lg bg-surface hover:bg-hover border border-border text-[11px] text-primary/90 inline-flex items-center gap-1.5 shadow-2xs max-w-[230px]"
                                                      title={pg.url}
                                                    >
                                                      <span className="scale-[0.82] inline-flex"><SiteFavicon site={pg.site} /></span>
                                                      <span className="truncate">{pg.title}</span>
                                                    </button>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                          ) : st.noteExcerpt ? (
                                            <div key={si} className="space-y-1.5">
                                              <button
                                                aria-expanded={!!stepDetailOpenMap[st.id]}
                                                onClick={() => setStepDetailOpenMap(prev => ({ ...prev, [st.id]: !prev[st.id] }))}
                                                className="w-full flex items-center gap-1.5 text-left text-secondary hover:text-primary py-0.5"
                                              >
                                                <Icon name={st.icon} className="w-3.5 h-3.5 text-muted shrink-0" />
                                                <span className="font-medium text-primary/85">{st.label}</span>
                                                <span className="text-muted">·</span>
                                                <span className="text-[11px] text-muted">{st.detail}</span>
                                                <Icon name={stepDetailOpenMap[st.id] ? 'chevronDown' : 'chevronRight'} className="w-3 h-3 text-muted ml-auto" />
                                              </button>
                                              {stepDetailOpenMap[st.id] && (
                                                <div className="ml-5 rounded-xl bg-surface border border-border p-2.5 space-y-2 shadow-2xs animate-fadeIn">
                                                  <p className="text-[11.5px] leading-relaxed text-secondary line-clamp-3">
                                                    {st.noteExcerpt.text}
                                                  </p>
                                                  <div className="pt-1.5 border-t border-border flex items-center justify-between text-[10.5px]">
                                                    <button
                                                      onClick={() => handleJumpToNotePara(st.noteExcerpt.anchorId, `「${st.noteExcerpt.doc}」原文片段`)}
                                                      className="text-accent-indigo hover:underline font-medium inline-flex items-center gap-1"
                                                    >
                                                      <span>定位原文</span>
                                                      <Icon name="externalLink" className="w-2.5 h-2.5" />
                                                    </button>
                                                    <button
                                                      onClick={() => setTechLogOpenMap(prev => ({ ...prev, [st.id]: !prev[st.id] }))}
                                                      className="text-muted hover:text-primary"
                                                    >
                                                      {techLogOpenMap[st.id] ? '收起原始数据' : '原始数据'}
                                                    </button>
                                                  </div>
                                                  {techLogOpenMap[st.id] && (
                                                    <pre className="p-2 rounded-lg bg-subtle border border-border font-mono text-[10.5px] text-secondary overflow-x-auto leading-relaxed">
                                                      {st.noteExcerpt.rawJson}
                                                    </pre>
                                                  )}
                                                </div>
                                              )}
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
                                                  <span className="px-1.5 py-0.5 rounded bg-subtle border border-border text-[10px] font-mono text-secondary shrink-0">
                                                    {st.countBadge}
                                                  </span>
                                                )}
                                                <span className="text-muted">·</span>
                                                <span className="truncate font-mono text-[11px] text-secondary">
                                                  <InlineCodeText text={st.detail} />
                                                </span>
                                                {st.extra && <span className="shrink-0 text-[10.5px] text-muted">{st.extra}</span>}
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
                                                <pre className="ml-5 p-2.5 rounded-xl bg-subtle border border-border font-mono text-[10.5px] text-secondary overflow-x-auto leading-relaxed">
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

                    {/* B. 正文内容（按案例渲染） */}
                    {msg.diaryReport ? (
                      <article className="space-y-5 text-[14px] leading-[1.78] text-primary">
                        <div className="space-y-2.5">
                          <h2 className="text-[15.5px] font-bold tracking-tight text-primary">未解决的问题</h2>
                          <ul className="space-y-2.5">
                            {msg.diaryReport.unresolved.map((item, idx) => (
                              <li key={idx} className="flex items-start gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-primary/40 mt-2.5 shrink-0"></span>
                                <div className="text-primary/90">
                                  <strong className="font-semibold text-primary">{item.title}</strong>{' '}
                                  <span>{item.body}</span>
                                  <NoteCitationGroup
                                    citations={item.citations}
                                    onJump={(c) => handleJumpToNotePara(c.anchorId, `「${c.doc}」第 ${c.num} 段`)}
                                  />
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>

                        <div className="pt-4 border-t border-border space-y-2.5">
                          <h2 className="text-[15.5px] font-bold tracking-tight text-primary">关联背景核对</h2>
                          <p className="text-primary/90">
                            {msg.diaryReport.webSection.lead}
                            <span className="inline-flex items-center flex-wrap gap-0.5 ml-1 align-middle">
                              {msg.diaryReport.webSection.leadSources.map((src, si) => (
                                <SourcePill key={si} label={src.label} site={src.site} onClick={() => setSourcesModalOpen(true)} />
                              ))}
                            </span>
                          </p>
                          <ul className="space-y-2.5">
                            {msg.diaryReport.webSection.items.map((w, wi) => (
                              <li key={wi} className="flex items-start gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-primary/40 mt-2.5 shrink-0"></span>
                                <div className="text-primary/90">
                                  <strong className="font-semibold text-primary">{w.title}</strong>{' '}
                                  {w.inlineLinkText ? (
                                    <>
                                      <SoftInlineLink onClick={() => setSourcesModalOpen(true)}>{w.inlineLinkText}</SoftInlineLink>
                                      <span>{w.bodyAfterLink}</span>
                                    </>
                                  ) : (
                                    <span>{w.body}</span>
                                  )}
                                  <span className="inline-flex items-center flex-wrap gap-0.5 ml-1 align-middle">
                                    {w.sources.map((src, si) => (
                                      <SourcePill key={si} label={src.label} site={src.site} onClick={() => setSourcesModalOpen(true)} />
                                    ))}
                                  </span>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </article>
                    ) : msg.interruptedCard ? (
                      <div className="rounded-2xl bg-amber-50/70 border border-amber-200/80 p-3.5 space-y-3">
                        <div className="flex items-start gap-2.5">
                          <Icon name="alertTriangle" className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                          <div className="space-y-1">
                            <div className="text-[13px] font-semibold text-amber-950">{msg.interruptedCard.title}</div>
                            <p className="text-[12px] leading-relaxed text-amber-900/80">{msg.interruptedCard.desc}</p>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pl-6">
                          <button
                            onClick={() => handleContinueInterrupted(msg.id)}
                            className="h-7 px-3 rounded-lg bg-primary text-white text-[11.5px] font-medium hover:opacity-90 flex items-center gap-1"
                          >
                            <Icon name="play" className="w-3 h-3" />
                            <span>继续完成</span>
                          </button>
                          <button
                            onClick={() => setScopeModalOpen(true)}
                            className="h-7 px-2.5 rounded-lg bg-surface border border-border text-[11.5px] font-medium text-primary hover:bg-hover"
                          >
                            核对资料范围
                          </button>
                          <button
                            onClick={() => setDraftPreviewOpenMap(prev => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                            className="h-7 px-2 rounded-lg text-[11.5px] font-medium text-amber-800 hover:bg-amber-100/70"
                          >
                            {draftPreviewOpenMap[msg.id] ? '收起草稿预览' : '查看草稿预览'}
                          </button>
                        </div>
                        {draftPreviewOpenMap[msg.id] && (
                          <div className="ml-6 p-3 rounded-xl bg-surface border border-amber-200/70 text-[12px] leading-relaxed text-secondary whitespace-pre-line animate-fadeIn">
                            {msg.interruptedCard.draft}
                          </div>
                        )}
                      </div>
                    ) : msg.report ? (
                      <article className="space-y-4 text-[14px] leading-[1.75] text-primary">
                        <h2 className="text-[16px] font-bold tracking-tight text-primary">{msg.report.title}</h2>
                        <p className="text-primary/90"><InlineCodeText text={msg.report.lead} /></p>

                        <div className="rounded-xl border border-border bg-surface overflow-x-auto shadow-2xs">
                          <table className="w-full text-left border-collapse text-[12px]">
                            <thead>
                              <tr className="bg-subtle border-b border-border text-secondary">
                                <th className="py-2 px-3 font-medium whitespace-nowrap">核对维度</th>
                                <th className="py-2 px-3 font-medium">建议方案</th>
                                <th className="py-2 px-3 font-medium">依据说明</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {msg.report.table.map((row, ri) => (
                                <tr key={ri}>
                                  <td className="py-2.5 px-3 font-medium text-primary align-top whitespace-nowrap">{row.topic}</td>
                                  <td className="py-2.5 px-3 text-primary/90 align-top">{row.decision}</td>
                                  <td className="py-2.5 px-3 text-secondary align-top">
                                    {row.evidence}
                                    <SourcePill
                                      label={row.cite}
                                      site={row.cite.includes('MDN') ? 'MDN' : row.cite.includes('WHATWG') ? 'WHATWG' : 'WAI'}
                                      onClick={() => setSourcesModalOpen(true)}
                                    />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <ul className="space-y-2 text-[13.5px]">
                          {msg.report.bullets.map((b, bi) => (
                            <li key={bi} className="flex items-start gap-2">
                              <span className="w-1.5 h-1.5 rounded-full bg-primary/40 mt-2.5 shrink-0"></span>
                              <div>
                                <strong className="font-semibold text-primary">{b.title}：</strong>
                                <span className="text-primary/85">{b.body}</span>
                                <SourcePill
                                  label={b.cite}
                                  site={b.cite.includes('WAI') ? 'WAI' : 'W3C'}
                                  onClick={() => setSourcesModalOpen(true)}
                                />
                              </div>
                            </li>
                          ))}
                        </ul>

                        <div className="rounded-xl border border-border bg-surface p-3 space-y-2 shadow-2xs">
                          <div className="flex items-center justify-between text-[12px]">
                            <span className="font-semibold text-primary">桌面端核对清单（示例 6 项）</span>
                            <button
                              onClick={() => setChecklistExpanded(v => !v)}
                              className="text-accent-indigo hover:underline font-medium"
                            >
                              {checklistExpanded ? '收起' : '展开全部'}
                            </button>
                          </div>
                          <div className="divide-y divide-border text-[12px]">
                            {(checklistExpanded ? msg.report.checklist : msg.report.checklist.slice(0, 3)).map(item => (
                              <div key={item.id} className="py-2 flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="font-mono text-[11px] text-muted w-4 shrink-0">{item.id}.</span>
                                  <span className="text-primary/90 truncate">{item.title}</span>
                                </div>
                                <span className="px-1.5 py-0.5 rounded bg-subtle border border-border text-[10.5px] text-secondary shrink-0">
                                  {item.env}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </article>
                    ) : (
                      <div className="text-[14px] leading-[1.78] text-primary whitespace-pre-line">{msg.text}</div>
                    )}

                    {/* C. 回复底部统一动作条（复制 / 合并后的存入笔记 / 极简创建任务 / 右侧轻量来源胶囊） */}
                    {!msg.interruptedCard && (
                      <div className="pt-1 flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleCopyText(msg.text || '')}
                            className="h-7 px-2 rounded-lg text-[11.5px] text-secondary hover:bg-hover hover:text-primary flex items-center gap-1 transition-colors"
                          >
                            <Icon name="copy" className="w-3.5 h-3.5" />
                            <span>复制</span>
                          </button>
                          <button
                            onClick={() => {
                              setSaveNoteTitle(threadTitle);
                              setSaveNoteModalOpen(true);
                            }}
                            className="h-7 px-2 rounded-lg text-[11.5px] text-secondary hover:bg-hover hover:text-primary flex items-center gap-1 transition-colors"
                          >
                            <Icon name="fileText" className="w-3.5 h-3.5" />
                            <span>存入笔记</span>
                          </button>
                          <button
                            onClick={() => setCreateTaskModalOpen(true)}
                            className="h-7 px-2 rounded-lg text-[11.5px] text-secondary hover:bg-hover hover:text-primary flex items-center gap-1 transition-colors"
                          >
                            <Icon name="checkSquare" className="w-3.5 h-3.5" />
                            <span>创建任务</span>
                          </button>
                        </div>

                        {msg.sourcesCount && (
                          <button
                            onClick={() => setSourcesModalOpen(true)}
                            className="h-7 px-2.5 rounded-full bg-subtle hover:bg-hover border border-border text-[11px] font-medium text-secondary hover:text-primary flex items-center gap-1.5 transition-colors"
                          >
                            <span className="inline-flex -space-x-1 scale-[0.82]">
                              <SiteFavicon site={activeCase === 'diary' ? 'Bloomberg' : 'W3C'} />
                              <SiteFavicon site={activeCase === 'diary' ? 'Sky' : 'MDN'} />
                            </span>
                            <span>{webSourcesList.length} 个来源</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              )}
            </main>

            {/* ---------- 4. 底部三层统一输入台 (Composer) ---------- */}
            <footer className="px-3 pb-3 pt-1.5 bg-canvas shrink-0 relative z-20 space-y-2">
              {/* 标签助手槽位胶囊 */}
              {taskMode === 'tag' && (
                <div className="flex items-center gap-1.5 flex-wrap relative">
                  <button
                    onClick={() => setTagPickerSlot(tagPickerSlot === 'target' ? null : 'target')}
                    className="h-6 px-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] font-medium flex items-center gap-1"
                  >
                    <span>目标：{selectedTargetTag}</span>
                    <Icon name="chevronDown" className="w-3 h-3" />
                  </button>
                  {tagSubMode === 'compare' && (
                    <button
                      onClick={() => setTagPickerSlot(tagPickerSlot === 'compare' ? null : 'compare')}
                      className="h-6 px-2 rounded-lg bg-surface border border-border text-secondary text-[11px] font-medium flex items-center gap-1 hover:bg-hover"
                    >
                      <span>对比：{selectedCompareTag}</span>
                      <Icon name="chevronDown" className="w-3 h-3" />
                    </button>
                  )}

                  {tagPickerSlot && (
                    <div className="absolute bottom-full left-0 mb-2 w-60 rounded-2xl bg-surface/95 glass border border-border shadow-popover p-2 z-50 animate-fadeIn">
                      <input
                        value={tagSearch}
                        onChange={(e) => setTagSearch(e.target.value)}
                        placeholder="搜索标签..."
                        className="w-full h-7 px-2.5 mb-1.5 rounded-lg bg-subtle border border-border text-[11.5px] outline-none"
                      />
                      <div className="max-h-36 overflow-y-auto space-y-0.5">
                        {availableTags
                          .filter(t => t.name.toLowerCase().includes(tagSearch.toLowerCase()))
                          .map(t => (
                            <button
                              key={t.name}
                              onClick={() => {
                                if (tagPickerSlot === 'target') setSelectedTargetTag(t.name);
                                else setSelectedCompareTag(t.name);
                                setTagPickerSlot(null);
                              }}
                              className="w-full px-2 py-1.5 rounded-lg hover:bg-hover flex items-center justify-between text-[12px]"
                            >
                              <span className="text-primary font-medium">{t.name}</span>
                              <span className="text-[10.5px] font-mono text-muted">{t.count}</span>
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 旧对话未授权提示条（单行极简磨砂） */}
              {oldChatAuthNeeded && (
                <div className="px-3 py-2 rounded-xl bg-amber-50/90 border border-amber-200/80 flex items-center justify-between gap-2 text-[11.5px] animate-fadeIn">
                  <span className="text-amber-900 truncate">
                    当前账号（{activeAccount.workspace}）尚未获准读取此旧对话历史
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => { setOldChatAuthNeeded(false); triggerToast('已授权当前账号读取本段历史'); }}
                      className="h-6 px-2 rounded-md bg-primary text-white font-medium text-[11px]"
                    >
                      允许读取
                    </button>
                    <button
                      onClick={() => { setActiveAccountId('follow'); setOldChatAuthNeeded(false); triggerToast('已换回个人账号'); }}
                      className="h-6 px-2 rounded-md bg-surface border border-border text-secondary hover:text-primary text-[11px]"
                    >
                      换回原账号
                    </button>
                  </div>
                </div>
              )}

              {/* 切号提示轻胶囊 */}
              {switchedBanner && !oldChatAuthNeeded && (
                <div className="px-3 py-1.5 rounded-xl bg-subtle border border-border flex items-center justify-between gap-2 text-[11.5px] animate-fadeIn">
                  <span className="text-secondary truncate">
                    已切换账号：<strong className="text-primary font-medium">{switchedBanner}</strong>
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => setAccountModalOpen(true)} className="text-accent-indigo hover:underline font-medium">管理</button>
                    <button onClick={() => setSwitchedBanner(null)} className="text-muted hover:text-primary">
                      <Icon name="x" className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* 附件超限暖红轻提示条 */}
              {uploadError && (
                <div className="px-3 py-1.5 rounded-xl bg-rose-50/90 border border-rose-200/80 flex items-center justify-between gap-2 text-[11.5px] text-rose-800 animate-fadeIn">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Icon name="alertCircle" className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                    <span className="truncate">{uploadError}</span>
                  </div>
                  <button onClick={() => setUploadError('')} className="text-rose-500 hover:text-rose-800 shrink-0">
                    <Icon name="x" className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* 输入台卡片主体 */}
              <div className="rounded-2xl bg-surface border border-border shadow-card focus-within:border-primary/25 transition-colors relative">
                {/* / 与 @ 快捷菜单 */}
                {(slashMenuOpen || atMenuOpen) && (
                  <div className="absolute bottom-full left-2 mb-2 w-64 rounded-2xl bg-surface/95 glass border border-border shadow-popover p-1.5 z-50 animate-fadeIn">
                    <div className="px-2 py-1 text-[10.5px] font-medium text-muted">
                      {slashMenuOpen ? '输入 / 快速挂载技能' : '输入 @ 引用知识库文档'}
                    </div>
                    {slashMenuOpen
                      ? skillsList.filter(s => s.enabled).map(s => (
                          <button
                            key={s.id}
                            onClick={() => {
                              if (!attachedSkills.includes(s.name)) setAttachedSkills(prev => [...prev, s.name]);
                              setInputText(prev => prev.slice(0, -1));
                              setSlashMenuOpen(false);
                            }}
                            className="w-full px-2 py-1.5 rounded-xl hover:bg-hover text-left flex items-center gap-2 text-[12px]"
                          >
                            <Icon name="zap" className="w-3.5 h-3.5 text-accent-indigo shrink-0" />
                            <span className="font-medium text-primary truncate">{s.name}</span>
                          </button>
                        ))
                      : availableDocs.map(d => (
                          <button
                            key={d.id}
                            onClick={() => {
                              if (!selectedDocs.includes(d.id)) setSelectedDocs(prev => [...prev, d.id]);
                              setInputText(prev => prev.slice(0, -1));
                              setAtMenuOpen(false);
                            }}
                            className="w-full px-2 py-1.5 rounded-xl hover:bg-hover text-left flex items-center gap-2 text-[12px]"
                          >
                            <Icon name="fileText" className="w-3.5 h-3.5 text-muted shrink-0" />
                            <span className="font-medium text-primary truncate">{d.id}</span>
                          </button>
                        ))}
                  </div>
                )}

                {/* 第 1 层：统一胶囊区 + 独立 68x68 图片缩略图轨 */}
                {(selectedDocs.length > 0 || attachedSkills.length > 0 || attachedLocalFiles.length > 0 || attachedImages.length > 0) && (
                  <div className="px-3 pt-2.5 pb-2 border-b border-border/70 space-y-2">
                    {(selectedDocs.length > 0 || attachedSkills.length > 0 || attachedLocalFiles.length > 0) && (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedDocs.map(doc => (
                          <span key={doc} className="h-[26px] pl-2 pr-1.5 rounded-lg bg-subtle border border-border text-[11.5px] text-primary inline-flex items-center gap-1.5 max-w-[160px]">
                            <Icon name="fileText" className="w-3 h-3 text-muted shrink-0" />
                            <span className="truncate">{doc}</span>
                            <button onClick={() => setSelectedDocs(prev => prev.filter(x => x !== doc))} className="text-muted hover:text-primary">
                              <Icon name="x" className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {attachedSkills.map(sk => (
                          <span key={sk} className="h-[26px] pl-2 pr-1.5 rounded-lg bg-indigo-50/80 border border-indigo-200/70 text-[11.5px] text-indigo-700 inline-flex items-center gap-1.5">
                            <Icon name="zap" className="w-3 h-3 shrink-0" />
                            <span>{sk}</span>
                            <button onClick={() => setAttachedSkills(prev => prev.filter(x => x !== sk))} className="text-indigo-400 hover:text-indigo-700">
                              <Icon name="x" className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {visibleLocalFiles.map(f => {
                          const st = fileKindStyle(f.kind);
                          return (
                            <span key={f.id} className="h-[26px] pl-2 pr-1.5 rounded-lg bg-surface border border-border text-[11.5px] text-primary/90 inline-flex items-center gap-1.5 max-w-[165px]">
                              <Icon name={st.icon} className={`w-3 h-3 shrink-0 ${st.color}`} />
                              <span className="truncate">{f.name}</span>
                              <button onClick={() => setAttachedLocalFiles(prev => prev.filter(x => x.id !== f.id))} className="text-muted hover:text-primary">
                                <Icon name="x" className="w-3 h-3" />
                              </button>
                            </span>
                          );
                        })}
                        {hiddenFilesCount > 0 && (
                          <button
                            onClick={() => setExpandAllFiles(v => !v)}
                            className="h-[26px] px-2 rounded-lg bg-subtle hover:bg-hover border border-border text-[11px] font-medium text-secondary"
                          >
                            {expandAllFiles ? '收起文件' : `+${hiddenFilesCount} 个文件`}
                          </button>
                        )}
                      </div>
                    )}

                    {attachedImages.length > 0 && (
                      <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
                        {attachedImages.map(img => (
                          <div key={img.id} className="relative w-[68px] h-[68px] rounded-xl overflow-hidden border border-border shrink-0 group cursor-pointer shadow-2xs">
                            <button type="button" className="w-full h-full text-left" aria-label={'预览图片 ' + img.name} onClick={() => setLightboxImage(img)}>
                              <MockThumbVisual type={img.type} />
                            </button>
                            <div className="absolute inset-x-0 bottom-0 px-1.5 py-0.5 bg-gradient-to-t from-black/65 to-transparent text-[9.5px] text-white truncate pointer-events-none">
                              {img.name}
                            </div>
                            <button
                              onClick={(e) => { e.stopPropagation(); setAttachedImages(prev => prev.filter(x => x.id !== img.id)); }}
                              className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/55 glass text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <Icon name="x" className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* 第 2 层：输入区 */}
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
                    className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-primary placeholder:text-muted outline-none"
                  />
                </div>

                {/* 第 3 层：统一极简操作底栏 */}
                <div className="px-2.5 pb-2 pt-1 flex items-center justify-between gap-1">
                  <div className="flex items-center gap-0.5 min-w-0">
                    {/* + 添加附件 */}
                    <div className="relative">
                      <button
                        onClick={() => {
                          const next = !attachMenuOpen;
                          closeAllPopovers();
                          setAttachMenuOpen(next);
                        }}
                        title="添加文件或图片"
                        className="w-7 h-7 rounded-lg text-secondary hover:bg-hover hover:text-primary flex items-center justify-center transition-colors"
                      >
                        <Icon name="plus" className="w-4 h-4" />
                      </button>
                      {attachMenuOpen && (
                        <div className="absolute bottom-full left-0 mb-2 w-52 rounded-2xl bg-surface/95 glass border border-border shadow-popover p-1.5 z-50 animate-fadeIn text-[12px]">
                          <button
                            onClick={() => {
                              setAttachedLocalFiles(prev => [...prev, { id: 'f_' + Date.now(), name: 'README.md', kind: 'code' }]);
                              setAttachMenuOpen(false);
                            }}
                            className="w-full px-2.5 py-2 rounded-xl hover:bg-hover text-left flex items-center gap-2 text-primary"
                          >
                            <Icon name="fileText" className="w-3.5 h-3.5 text-muted" />
                            <span>添加本地文件</span>
                          </button>
                          <button
                            onClick={() => {
                              setUploadError('「会话示例录音.flac」超出 10 MB 限制（34.2 MB），未添加');
                              setAttachMenuOpen(false);
                            }}
                            className="w-full px-2.5 py-2 rounded-xl hover:bg-hover text-left flex items-center gap-2 text-rose-700"
                          >
                            <Icon name="alertCircle" className="w-3.5 h-3.5 text-rose-500" />
                            <span>模拟触发超限提示</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* 资料范围 */}
                    <button
                      onClick={() => { closeAllPopovers(); setScopeModalOpen(true); }}
                      className="h-7 px-2 rounded-lg text-[12px] font-medium text-secondary hover:bg-hover hover:text-primary flex items-center gap-1.5 transition-colors"
                    >
                      <Icon name="database" className="w-3.5 h-3.5 text-muted" />
                      <span className="truncate max-w-[90px]">
                        {selectedLibs.length > 0 ? `${selectedLibs[0]} · ${selectedDocs.length}篇` : `资料 (${selectedDocs.length})`}
                      </span>
                      <Icon name="chevronDown" className="w-3 h-3 opacity-60" />
                    </button>

                    {/* 技能弹窗 */}
                    <div className="relative">
                      <button
                        onClick={() => {
                          const next = !skillsPopoverOpen;
                          closeAllPopovers();
                          setSkillsPopoverOpen(next);
                          setSkillDetailId(null);
                        }}
                        title="挂载技能"
                        className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${attachedSkills.length > 0 ? 'text-accent-indigo bg-indigo-50/70 hover:bg-indigo-100/70' : 'text-secondary hover:bg-hover hover:text-primary'}`}
                      >
                        <Icon name="zap" className="w-3.5 h-3.5" />
                      </button>

                      {skillsPopoverOpen && (
                        <div className="absolute bottom-full left-0 mb-2 w-72 rounded-2xl bg-surface/95 glass border border-border shadow-popover p-2 z-50 animate-fadeIn">
                          {skillDetailId ? (() => {
                            const sk = skillsList.find(s => s.id === skillDetailId);
                            if (!sk) return null;
                            return (
                              <div className="space-y-2.5 p-1">
                                <div className="flex items-center justify-between">
                                  <button onClick={() => setSkillDetailId(null)} className="text-[11.5px] text-secondary hover:text-primary flex items-center gap-1">
                                    <Icon name="chevronLeft" className="w-3.5 h-3.5" />
                                    <span>返回列表</span>
                                  </button>
                                  <button
                                    onClick={() => triggerToast(`已定位源文件 ${sk.file}`)}
                                    className="text-[11px] text-accent-indigo hover:underline flex items-center gap-0.5"
                                  >
                                    <span>查看源文件</span>
                                    <Icon name="externalLink" className="w-2.5 h-2.5" />
                                  </button>
                                </div>
                                <div>
                                  <div className="text-[13px] font-semibold text-primary">{sk.name}</div>
                                  <p className="text-[11.5px] text-secondary mt-1 leading-relaxed">{sk.desc}</p>
                                </div>
                                <button
                                  onClick={() => {
                                    if (!attachedSkills.includes(sk.name)) setAttachedSkills(prev => [...prev, sk.name]);
                                    setSkillsPopoverOpen(false);
                                    triggerToast(`已挂载技能「${sk.name}」`);
                                  }}
                                  className="w-full h-8 rounded-xl bg-primary text-white text-[12px] font-medium hover:opacity-90"
                                >
                                  添加到本次对话
                                </button>
                              </div>
                            );
                          })() : (
                            <div className="space-y-1">
                              <div className="px-2 py-1 flex items-center justify-between text-[11px] text-muted">
                                <span>通用技能（Hub &amp; Codex）</span>
                                <span>点 + 快速挂载</span>
                              </div>
                              <div className="max-h-52 overflow-y-auto space-y-0.5">
                                {skillsList.filter(s => s.enabled).map(sk => {
                                  const mounted = attachedSkills.includes(sk.name);
                                  return (
                                    <div key={sk.id} className="p-1.5 rounded-xl hover:bg-hover flex items-center gap-2">
                                      <button onClick={() => setSkillDetailId(sk.id)} className="flex-1 min-w-0 text-left">
                                        <div className="text-[12px] font-medium text-primary truncate">{sk.name}</div>
                                        <div className="text-[10.5px] text-muted truncate">{sk.desc}</div>
                                      </button>
                                      <button
                                        onClick={() => {
                                          if (mounted) setAttachedSkills(prev => prev.filter(x => x !== sk.name));
                                          else setAttachedSkills(prev => [...prev, sk.name]);
                                        }}
                                        className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 transition-colors ${mounted ? 'bg-indigo-50 text-accent-indigo' : 'bg-subtle text-secondary hover:bg-primary hover:text-white'}`}
                                      >
                                        <Icon name={mounted ? 'check' : 'plus'} className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                              <div className="pt-1.5 mt-1 border-t border-border">
                                <button
                                  onClick={() => { setSkillsPopoverOpen(false); setSkillsManagerOpen(true); }}
                                  className="w-full px-2 py-1.5 rounded-lg hover:bg-hover text-[11.5px] font-medium text-secondary hover:text-primary flex items-center justify-between"
                                >
                                  <span>管理与同步技能</span>
                                  <Icon name="chevronRight" className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 记忆（与左侧统一无边框极简重量，窄栏也可见状态点） */}
                    <button
                      onClick={() => { closeAllPopovers(); setMemorySheetOpen(true); }}
                      title={`记忆：${memoryEnabled ? memoryScope : '已关闭'}`}
                      className="h-7 px-2 rounded-lg text-[12px] font-medium text-secondary hover:bg-hover hover:text-primary flex items-center gap-1.5 transition-colors"
                    >
                      <span className="relative inline-flex">
                        <Icon name="brain" className={`w-3.5 h-3.5 ${memoryEnabled ? 'text-amber-600' : 'text-muted'}`} />
                        {memoryEnabled && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 absolute -top-0.5 -right-0.5 ring-1 ring-surface"></span>}
                      </span>
                      <span className="hidden sm:inline truncate max-w-[78px]">{memoryEnabled ? memoryScope : '记忆关'}</span>
                    </button>
                  </div>

                  {/* 右侧：带厂商图标的模型短名 + 发送 */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <div className="relative">
                      <button
                        onClick={() => {
                          const next = !modelPopoverOpen;
                          closeAllPopovers();
                          setModelPopoverOpen(next);
                        }}
                        className="h-7 px-2 rounded-lg text-[11.5px] font-medium text-secondary hover:bg-hover hover:text-primary flex items-center gap-1.5 transition-colors"
                      >
                        <VendorIcon vendor={currentModelObj.vendor} className="w-3.5 h-3.5" />
                        <span className="text-primary">{currentModelObj.shortName}</span>
                        <span className="text-muted">·</span>
                        <span>{currentReasoningObj.label}</span>
                        <Icon name="chevronDown" className="w-3 h-3 opacity-60" />
                      </button>

                      {modelPopoverOpen && (
                        <div className="absolute bottom-full right-0 mb-2 w-72 rounded-2xl bg-surface/95 glass border border-border shadow-popover p-2.5 z-50 animate-fadeIn space-y-2.5">
                          <div className="space-y-1">
                            <div className="px-1.5 text-[11px] font-semibold text-primary">模型与推理深度</div>
                            {availableModels.map(m => {
                              const active = m.id === selectedModel;
                              return (
                                <button
                                  key={m.id}
                                  onClick={() => handleSelectModel(m)}
                                  className={`w-full p-2 rounded-xl flex items-center gap-2.5 text-left transition-colors ${active ? 'bg-subtle ring-1 ring-border' : 'hover:bg-hover/70'}`}
                                >
                                  <VendorIcon vendor={m.vendor} className="w-4 h-4" />
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[12px] font-medium text-primary flex items-center gap-1.5">
                                      <span className="truncate">{m.id}</span>
                                      {active && <Icon name="check" className="w-3.5 h-3.5 text-primary shrink-0" />}
                                    </div>
                                    <div className="text-[10.5px] text-muted truncate">{m.desc}</div>
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0 text-muted">
                                    {m.web && <Icon name="globe" className="w-3.5 h-3.5" />}
                                    {m.reasoning && <Icon name="brain" className="w-3.5 h-3.5 text-accent-indigo" />}
                                  </div>
                                </button>
                              );
                            })}
                          </div>

                          {/* 动态思考强度档位（GPT 6 档 / DeepSeek 3 档） */}
                          <div className="pt-2 border-t border-border space-y-1.5">
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-secondary font-medium">思考强度</span>
                              <span className="text-muted text-[10.5px]">{currentModelObj.vendor}</span>
                            </div>
                            <div className="grid gap-1 p-0.5 rounded-xl bg-subtle border border-border" style={{ gridTemplateColumns: `repeat(${activeReasoningOptions.length}, minmax(0, 1fr))` }}>
                              {activeReasoningOptions.map(opt => (
                                <button
                                  key={opt.key}
                                  onClick={() => setReasoningLevel(opt.key)}
                                  className={`py-1 rounded-lg text-[11px] font-medium transition-all ${reasoningLevel === opt.key ? 'bg-surface text-primary shadow-2xs' : 'text-secondary hover:text-primary'}`}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                            <div className="text-[10.5px] text-muted px-0.5">{currentReasoningObj.hint}</div>
                          </div>

                          {/* 响应速度：仅支持该项的模型（GPT）显示 */}
                          {currentModelObj.supportsSpeed && (
                            <div className="pt-2 border-t border-border flex items-center justify-between text-[11.5px]">
                              <span className="text-secondary font-medium">响应速度</span>
                              <div className="flex bg-subtle p-0.5 rounded-lg border border-border">
                                {['standard', 'fast'].map(sp => (
                                  <button
                                    key={sp}
                                    onClick={() => setResponseSpeed(sp)}
                                    className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium transition-all ${responseSpeed === sp ? 'bg-surface text-primary shadow-2xs' : 'text-secondary'}`}
                                  >
                                    {sp === 'standard' ? '标准' : '加速'}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* 快捷 Codex 账号条 */}
                          <div className="pt-2 border-t border-border">
                            <button
                              onClick={() => { setModelPopoverOpen(false); setAccountModalOpen(true); }}
                              className="w-full px-2 py-1.5 rounded-xl bg-subtle/70 hover:bg-hover flex items-center justify-between text-[11px]"
                            >
                              <span className="flex items-center gap-1.5 min-w-0">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>
                                <span className="text-primary font-medium truncate">{activeAccount.email} · {activeAccount.workspace}</span>
                              </span>
                              <span className="text-accent-indigo font-medium shrink-0 ml-2">切换 ›</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    <button
                      onClick={handleSendMessage}
                      aria-label="发送"
                      disabled={!inputText.trim()}
                      className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${inputText.trim() ? 'bg-primary text-white hover:opacity-90 shadow-2xs' : 'bg-subtle text-muted cursor-not-allowed'}`}
                    >
                      <Icon name="arrowUp" className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </footer>

            {/* ---------- 5. 左侧对话历史滑出抽屉 ---------- */}
            {historyOpen && (
              <div className="absolute inset-0 z-40 flex animate-fadeIn" role="dialog" aria-label="对话历史" tabIndex={-1} data-reference-dialog>
                <div className="w-64 h-full bg-surface/95 glass border-r border-border shadow-popover flex flex-col">
                  <div className="h-12 px-3.5 border-b border-border flex items-center justify-between">
                    <span className="text-[12.5px] font-semibold text-primary">对话历史</span>
                    <button onClick={() => setHistoryOpen(false)} className="w-6 h-6 rounded-lg hover:bg-hover flex items-center justify-center text-muted">
                      <Icon name="x" className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {historyList.map(h => (
                      <div key={h.id} className="group px-2.5 py-2 rounded-xl hover:bg-hover flex items-center justify-between gap-2">
                        <button
                          onClick={() => {
                            switchDemoCase(h.caseKey);
                            setHistoryOpen(false);
                            if (activeAccountId !== 'follow') setOldChatAuthNeeded(true);
                          }}
                          className="flex-1 min-w-0 text-left"
                        >
                          <div className="text-[12px] font-medium text-primary truncate">{h.title}</div>
                          <div className="text-[10.5px] text-muted mt-0.5">{h.time}</div>
                        </button>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button
                            onClick={() => setHistoryList(prev => prev.map(x => x.id === h.id ? { ...x, pinned: !x.pinned } : x))}
                            className={`w-6 h-6 rounded-md flex items-center justify-center ${h.pinned ? 'text-accent-indigo' : 'text-muted hover:text-primary'}`}
                          >
                            <Icon name="pin" className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => setHistoryList(prev => prev.filter(x => x.id !== h.id))}
                            className="w-6 h-6 rounded-md text-muted hover:text-rose-600 flex items-center justify-center"
                          >
                            <Icon name="trash" className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex-1 bg-black/10" onClick={() => setHistoryOpen(false)}></div>
              </div>
            )}

            {/* ---------- 6. 右侧对话详情抽屉 (Inspector, w-[332px] max-w-[88%]) ---------- */}
            {inspectorOpen && (
              <div className="absolute inset-0 z-40 flex justify-end animate-fadeIn" role="dialog" aria-label="对话详情" tabIndex={-1} data-reference-dialog>
                <div className="flex-1 bg-black/10" onClick={() => setInspectorOpen(false)}></div>
                <aside className="w-[332px] max-w-[88%] h-full bg-canvas/95 glass border-l border-border shadow-popover flex flex-col">
                  <div className="h-12 px-4 border-b border-border flex items-center justify-between">
                    <span className="text-[13px] font-semibold text-primary">对话详情</span>
                    <button onClick={() => setInspectorOpen(false)} className="w-7 h-7 rounded-lg hover:bg-hover flex items-center justify-center text-muted">
                      <Icon name="x" className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-3.5 space-y-3 text-[12.5px]">
                    {/* 卡片 1：视图与工具 */}
                    <div className="rounded-2xl bg-surface border border-border p-3.5 space-y-3 shadow-2xs">
                      <div className="text-[11px] font-medium text-muted">视图与工具</div>
                      {[
                        { label: '只看最新回复', val: onlyLatestReply, set: setOnlyLatestReply },
                        { label: '联网搜索', val: webSearchOn, set: setWebSearchOn },
                        { label: 'MCP 外部工具', val: mcpToolsOn, set: setMcpToolsOn }
                      ].map(item => (
                        <div key={item.label} className="flex items-center justify-between gap-3">
                          <span className="text-primary">{item.label}</span>
                          <button
                            role="switch"
                            aria-label={item.label}
                            aria-checked={item.val}
                            onClick={() => item.set(!item.val)}
                            className={`w-9 h-5 rounded-full p-0.5 transition-colors ${item.val ? 'bg-primary' : 'bg-border'}`}
                          >
                            <span className={`block w-4 h-4 rounded-full bg-white shadow-2xs transition-transform ${item.val ? 'translate-x-4' : 'translate-x-0'}`}></span>
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* 卡片 2：当前上下文 */}
                    <div className="rounded-2xl bg-surface border border-border p-3.5 space-y-2.5 shadow-2xs">
                      <div className="text-[11px] font-medium text-muted">当前上下文</div>
                      <button onClick={() => { setInspectorOpen(false); setScopeModalOpen(true); }} className="w-full flex items-center justify-between gap-3 py-0.5 hover:opacity-80">
                        <span className="text-secondary">资料范围</span>
                        <span className="text-primary font-medium">{selectedDocs.length} 篇 · {selectedLibs.length} 库 ›</span>
                      </button>
                      <button onClick={() => { setInspectorOpen(false); setMemorySheetOpen(true); }} className="w-full flex items-center justify-between gap-3 py-0.5 hover:opacity-80">
                        <span className="text-secondary">管理版本记忆</span>
                        <span className="text-amber-700 font-medium">{memoryEnabled ? memoryScope : '已关闭'} ›</span>
                      </button>
                      <button onClick={() => { setInspectorOpen(false); setSkillsManagerOpen(true); }} className="w-full flex items-center justify-between gap-3 py-0.5 hover:opacity-80">
                        <span className="text-secondary">管理通用技能</span>
                        <span className="text-accent-indigo font-medium">{skillsList.filter(s => s.enabled).length} 个启用 ›</span>
                      </button>
                      <button onClick={() => { setInspectorOpen(false); setAccountModalOpen(true); }} className="w-full flex items-center justify-between gap-3 py-0.5 hover:opacity-80">
                        <span className="text-secondary">Codex 账号</span>
                        <span className="text-primary font-medium truncate max-w-[150px]">{activeAccount.workspace} · {activeAccount.plan} ›</span>
                      </button>
                    </div>

                    {/* 卡片 3：默认折叠的运行诊断与用量 */}
                    <div className="rounded-2xl bg-surface border border-border overflow-hidden shadow-2xs">
                      <button
                        onClick={() => setDiagOpen(v => !v)}
                        className="w-full px-3.5 py-2.5 flex items-center justify-between text-[11.5px] font-medium text-secondary hover:text-primary"
                      >
                        <span>运行诊断与用量</span>
                        <Icon name={diagOpen ? 'chevronDown' : 'chevronRight'} className="w-3.5 h-3.5 text-muted" />
                      </button>
                      {diagOpen && (
                        <div className="px-3.5 pb-3 pt-1 border-t border-border font-mono text-[11px] text-muted space-y-1">
                          <div>模型：{selectedModel}</div>
                          <div>本轮回传：26,633 tokens</div>
                          <div>检索上限：15 块 / 16 次调用</div>
                        </div>
                      )}
                    </div>
                  </div>
                </aside>
              </div>
            )}
          </section>
        )}
      </div>

      {/* ============================================================
       * 7. 全局居中 Modal / Sheet 面板区
       * ============================================================ */}

      {/* 7.1 资料范围 Modal（三段 Tab + 保存为自定义专题） */}
      {scopeModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn" onClick={() => setScopeModalOpen(false)} role="dialog" aria-label="资料范围" aria-modal="true" tabIndex={-1} data-reference-dialog>
          <div className="w-full max-w-lg rounded-2xl bg-surface border border-border shadow-float overflow-hidden flex flex-col max-h-[82vh]" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
              <span className="text-[14px] font-semibold text-primary">资料范围</span>
              <button onClick={() => setScopeModalOpen(false)} className="w-7 h-7 rounded-lg hover:bg-hover flex items-center justify-center text-muted">
                <Icon name="x" className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 pt-3">
              <div className="grid grid-cols-3 p-0.5 rounded-xl bg-subtle border border-border text-[12px]">
                {[
                  { id: 'docs', label: `核心材料 (${selectedDocs.length})` },
                  { id: 'libs', label: `资料库 (${selectedLibs.length})` },
                  { id: 'strategy', label: '使用策略' }
                ].map(t => (
                  <button
                    key={t.id}
                    onClick={() => setScopeTab(t.id)}
                    className={`py-1.5 rounded-lg font-medium transition-all ${scopeTab === t.id ? 'bg-surface text-primary shadow-2xs' : 'text-secondary hover:text-primary'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {scopeTab === 'docs' && (
                <>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Icon name="search" className="w-3.5 h-3.5 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        value={docSearch}
                        onChange={(e) => setDocSearch(e.target.value)}
                        placeholder="搜索标题、路径或资料库..."
                        className="w-full h-9 pl-8 pr-3 rounded-xl bg-subtle border border-border text-[12.5px] outline-none focus:border-primary/30"
                      />
                    </div>
                    <div className="flex bg-subtle p-0.5 rounded-xl border border-border text-[11.5px]">
                      <button onClick={() => setDocFilter('all')} className={`px-2.5 py-1 rounded-lg ${docFilter === 'all' ? 'bg-surface text-primary font-medium shadow-2xs' : 'text-secondary'}`}>全部</button>
                      <button onClick={() => setDocFilter('selected')} className={`px-2.5 py-1 rounded-lg ${docFilter === 'selected' ? 'bg-surface text-primary font-medium shadow-2xs' : 'text-secondary'}`}>已选</button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {availableDocs
                      .filter(d => d.id.toLowerCase().includes(docSearch.toLowerCase()) || d.path.toLowerCase().includes(docSearch.toLowerCase()))
                      .filter(d => docFilter === 'all' || selectedDocs.includes(d.id))
                      .map(d => {
                        const checked = selectedDocs.includes(d.id);
                        return (
                          <button
                            key={d.id}
                            onClick={() => setSelectedDocs(prev => checked ? prev.filter(x => x !== d.id) : [...prev, d.id])}
                            className={`w-full p-2.5 rounded-xl border text-left flex items-center gap-3 transition-colors ${checked ? 'bg-subtle border-primary/25' : 'bg-surface border-border hover:bg-hover/60'}`}
                          >
                            <span className={`w-4 h-4 rounded-md border flex items-center justify-center shrink-0 ${checked ? 'bg-primary border-primary text-white' : 'border-muted/50'}`}>
                              {checked && <Icon name="check" className="w-3 h-3" />}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="text-[12.5px] font-medium text-primary flex items-center gap-1.5">
                                <span className="truncate">{d.id}</span>
                                {d.current && <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-accent-indigo text-[10px]">当前页面</span>}
                              </div>
                              <div className="text-[11px] text-muted truncate">{d.path}</div>
                            </div>
                          </button>
                        );
                      })}
                  </div>
                </>
              )}

              {scopeTab === 'libs' && (
                <div className="space-y-2">
                  {availableLibs.map(lib => {
                    const on = selectedLibs.includes(lib.id);
                    return (
                      <div key={lib.id} className="p-3 rounded-xl border border-border bg-surface flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[13px] font-medium text-primary">{lib.id}</div>
                          <div className="text-[11px] text-muted">{lib.source} · {lib.count} 篇文档 · 已连接</div>
                        </div>
                        <button
                          onClick={() => setSelectedLibs(prev => on ? prev.filter(x => x !== lib.id) : [...prev, lib.id])}
                          className={`w-9 h-5 rounded-full p-0.5 transition-colors ${on ? 'bg-primary' : 'bg-border'}`}
                        >
                          <span className={`block w-4 h-4 rounded-full bg-white shadow-2xs transition-transform ${on ? 'translate-x-4' : 'translate-x-0'}`}></span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {scopeTab === 'strategy' && (
                <div className="space-y-2.5">
                  {[
                    { id: 'prefer', title: '优先用所选资料', desc: '先读所选核心材料与资料库，再按联网设置补充外部依据。' },
                    { id: 'only', title: '只用所选资料', desc: '回答严格限定在所选资料内，无依据时直接说明未找到。' }
                  ].map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => setRetrievalStrategy(opt.id)}
                      className={`w-full p-3 rounded-xl border text-left flex items-start justify-between gap-3 transition-colors ${retrievalStrategy === opt.id ? 'bg-subtle border-primary/30' : 'border-border hover:bg-hover/50'}`}
                    >
                      <div>
                        <div className="text-[13px] font-medium text-primary">{opt.title}</div>
                        <div className="text-[11.5px] text-muted mt-0.5">{opt.desc}</div>
                      </div>
                      {retrievalStrategy === opt.id && <Icon name="check" className="w-4 h-4 text-primary shrink-0 mt-0.5" />}
                    </button>
                  ))}

                  <div className="rounded-xl border border-border overflow-hidden">
                    <button
                      onClick={() => setFixedChecklistOpen(v => !v)}
                      className="w-full px-3 py-2.5 flex items-center justify-between text-[12px] font-medium text-secondary hover:text-primary"
                    >
                      <span>固定清单与覆盖核对</span>
                      <Icon name={fixedChecklistOpen ? 'chevronDown' : 'chevronRight'} className="w-3.5 h-3.5" />
                    </button>
                    {fixedChecklistOpen && (
                      <div className="px-3 pb-3 text-[11.5px] text-muted border-t border-border pt-2">
                        开启后，将按所选核心材料清单逐篇核对覆盖情况，避免遗漏长文档末尾段落。
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-border bg-canvas flex items-center justify-between gap-2">
              {saveTopicInline ? (
                <div className="flex items-center gap-1.5 flex-1">
                  <input
                    autoFocus
                    value={saveTopicInput}
                    onChange={(e) => setSaveTopicInput(e.target.value)}
                    placeholder="输入新专题名称..."
                    className="h-8 flex-1 px-2.5 rounded-lg bg-surface border border-border text-[12px] outline-none"
                  />
                  <button
                    onClick={() => {
                      if (!saveTopicInput.trim()) return;
                      handleCreateCustomTopic(saveTopicInput, selectedDocs, selectedLibs, retrievalStrategy);
                      setSaveTopicInput('');
                      setSaveTopicInline(false);
                      setScopeModalOpen(false);
                    }}
                    className="h-8 px-3 rounded-lg bg-accent-indigo text-white text-[12px] font-medium"
                  >
                    保存
                  </button>
                  <button onClick={() => setSaveTopicInline(false)} className="h-8 px-2 text-[12px] text-muted">取消</button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => setSaveTopicInline(true)}
                    className="h-8 px-3 rounded-xl bg-surface border border-border text-[12px] font-medium text-primary hover:bg-hover flex items-center gap-1.5"
                  >
                    <Icon name="layers" className="w-3.5 h-3.5 text-accent-indigo" />
                    <span>保存为专题</span>
                  </button>
                  <button
                    onClick={() => { setScopeModalOpen(false); triggerToast('已更新当前对话资料范围'); }}
                    className="h-8 px-4 rounded-xl bg-primary text-white text-[12px] font-medium hover:opacity-90"
                  >
                    应用范围
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 7.2 合并后的「存入笔记」Modal（追加到页面 | 新建独立笔记） */}
      {saveNoteModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn" onClick={() => setSaveNoteModalOpen(false)} role="dialog" aria-label="存入笔记" aria-modal="true" tabIndex={-1} data-reference-dialog>
          <div className="w-full max-w-md rounded-2xl bg-surface border border-border shadow-float overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
              <span className="text-[14px] font-semibold text-primary">存入笔记</span>
              <button onClick={() => setSaveNoteModalOpen(false)} className="w-7 h-7 rounded-lg hover:bg-hover flex items-center justify-center text-muted">
                <Icon name="x" className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 p-0.5 rounded-xl bg-subtle border border-border text-[12px]">
                <button onClick={() => setSaveNoteMode('append')} className={`py-1.5 rounded-lg font-medium ${saveNoteMode === 'append' ? 'bg-surface text-primary shadow-2xs' : 'text-secondary'}`}>追加到已有页面</button>
                <button onClick={() => setSaveNoteMode('new')} className={`py-1.5 rounded-lg font-medium ${saveNoteMode === 'new' ? 'bg-surface text-primary shadow-2xs' : 'text-secondary'}`}>新建独立笔记</button>
              </div>

              {saveNoteMode === 'append' ? (
                <div className="space-y-1.5">
                  <label className="text-[11.5px] font-medium text-secondary">目标页面</label>
                  <div className="flex flex-wrap gap-1.5">
                    {['2023-05-06', '8_竞品和参考', '案例'].map(p => (
                      <button
                        key={p}
                        onClick={() => setSaveNoteTarget(p)}
                        className={`h-8 px-3 rounded-xl border text-[12px] font-medium ${saveNoteTarget === p ? 'bg-primary text-white border-primary' : 'bg-subtle border-border text-primary hover:bg-hover'}`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="text-[11.5px] font-medium text-secondary">笔记标题（已自动提取）</label>
                  <input
                    value={saveNoteTitle}
                    onChange={(e) => setSaveNoteTitle(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl bg-subtle border border-border text-[13px] font-medium text-primary outline-none focus:border-primary/30"
                  />
                </div>
              )}

              <div className="rounded-xl bg-canvas border border-border p-3 text-[12px] text-secondary leading-relaxed line-clamp-4">
                已整理本轮核心结论、原文段落引用与核对来源，保存后将保留 Markdown 结构。
              </div>
            </div>
            <div className="px-5 py-3 border-t border-border bg-canvas flex justify-end gap-2">
              <button onClick={() => setSaveNoteModalOpen(false)} className="h-8 px-3 rounded-xl text-[12px] text-secondary hover:bg-hover">取消</button>
              <button
                onClick={() => {
                  setSaveNoteModalOpen(false);
                  triggerToast(saveNoteMode === 'append' ? `已追加到「${saveNoteTarget}」文末` : `已新建笔记「${saveNoteTitle}」`);
                }}
                className="h-8 px-4 rounded-xl bg-primary text-white text-[12px] font-medium hover:opacity-90"
              >
                确认保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7.3 极简「创建任务」Modal（Things 3 / Linear 风格） */}
      {createTaskModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn" onClick={() => setCreateTaskModalOpen(false)} role="dialog" aria-label="创建行动任务" aria-modal="true" tabIndex={-1} data-reference-dialog>
          <div className="w-full max-w-md rounded-2xl bg-surface border border-border shadow-float overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 pt-4 pb-2 flex items-center justify-between">
              <span className="text-[11.5px] font-medium text-muted">创建滴答行动任务</span>
              <button onClick={() => setCreateTaskModalOpen(false)} className="w-6 h-6 rounded-lg hover:bg-hover flex items-center justify-center text-muted">
                <Icon name="x" className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="px-5 pb-4 space-y-3.5">
              <input
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                className="w-full text-[15px] font-semibold text-primary bg-transparent outline-none"
                placeholder="输入任务标题..."
              />

              <div className="flex flex-wrap gap-1.5 text-[11.5px]">
                <button
                  onClick={() => setTaskListName(taskListName === '收件箱' ? '工程推进' : '收件箱')}
                  className="h-7 px-2.5 rounded-lg bg-subtle hover:bg-hover border border-border text-primary flex items-center gap-1.5"
                >
                  <Icon name="folder" className="w-3 h-3 text-muted" />
                  <span>{taskListName}</span>
                </button>
                <button
                  onClick={() => setTaskDue(taskDue === '明天' ? '本周五' : '明天')}
                  className="h-7 px-2.5 rounded-lg bg-subtle hover:bg-hover border border-border text-primary flex items-center gap-1.5"
                >
                  <Icon name="calendar" className="w-3 h-3 text-muted" />
                  <span>{taskDue}</span>
                </button>
                <button
                  onClick={() => setTaskPriority(taskPriority === '高' ? '中' : '高')}
                  className="h-7 px-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 flex items-center gap-1.5"
                >
                  <Icon name="flag" className="w-3 h-3" />
                  <span>优先级：{taskPriority}</span>
                </button>
              </div>

              <div className="rounded-xl bg-canvas border border-border p-3 space-y-2">
                <div className="text-[11px] font-medium text-muted">自动提炼子任务</div>
                {taskSubItems.map(st => (
                  <button
                    key={st.id}
                    onClick={() => setTaskSubItems(prev => prev.map(x => x.id === st.id ? { ...x, checked: !x.checked } : x))}
                    className="w-full flex items-start gap-2 text-left text-[12.5px]"
                  >
                    <span className={`w-4 h-4 mt-0.5 rounded border flex items-center justify-center shrink-0 ${st.checked ? 'bg-primary border-primary text-white' : 'border-muted/50'}`}>
                      {st.checked && <Icon name="check" className="w-3 h-3" />}
                    </span>
                    <span className={st.checked ? 'text-primary' : 'text-muted line-through'}>{st.text}</span>
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between text-[12px] pt-1">
                <span className="text-secondary">附带完整报告作为备注</span>
                <button
                  onClick={() => setTaskIncludeReport(v => !v)}
                  className={`w-8 h-[18px] rounded-full p-0.5 transition-colors ${taskIncludeReport ? 'bg-primary' : 'bg-border'}`}
                >
                  <span className={`block w-3.5 h-3.5 rounded-full bg-white transition-transform ${taskIncludeReport ? 'translate-x-3.5' : 'translate-x-0'}`}></span>
                </button>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-border bg-canvas flex justify-end gap-2">
              <button onClick={() => setCreateTaskModalOpen(false)} className="h-8 px-3 rounded-xl text-[12px] text-secondary hover:bg-hover">取消</button>
              <button
                onClick={() => {
                  setCreateTaskModalOpen(false);
                  triggerToast(`已创建任务至滴答「${taskListName}」`);
                }}
                className="h-8 px-4 rounded-xl bg-primary text-white text-[12px] font-medium hover:opacity-90"
              >
                创建任务
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7.4 网页来源 Modal */}
      {sourcesModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn" onClick={() => setSourcesModalOpen(false)} role="dialog" aria-label="参考来源" aria-modal="true" tabIndex={-1} data-reference-dialog>
          <div className="w-full max-w-md rounded-2xl bg-surface border border-border shadow-float overflow-hidden max-h-[75vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
              <span className="text-[14px] font-semibold text-primary">参考来源 ({webSourcesList.length})</span>
              <button onClick={() => setSourcesModalOpen(false)} className="w-7 h-7 rounded-lg hover:bg-hover flex items-center justify-center text-muted">
                <Icon name="x" className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 border-b border-border">
              <input
                value={sourcesSearch}
                onChange={(e) => setSourcesSearch(e.target.value)}
                placeholder="筛选来源标题或域名..."
                className="w-full h-8 px-3 rounded-xl bg-subtle border border-border text-[12px] outline-none"
              />
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              {webSourcesList
                .filter(s => s.title.toLowerCase().includes(sourcesSearch.toLowerCase()) || s.url.toLowerCase().includes(sourcesSearch.toLowerCase()))
                .map((s, idx) => (
                  <button
                    key={idx}
                    onClick={() => triggerToast(`将在浏览器打开 ${s.url}`)}
                    className="w-full p-2.5 rounded-xl hover:bg-hover border border-transparent hover:border-border flex items-center gap-2.5 text-left transition-colors"
                  >
                    <SiteFavicon site={s.site} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[12.5px] font-medium text-primary truncate">{s.title}</div>
                      <div className="text-[11px] font-mono text-muted truncate">{s.url}</div>
                    </div>
                    <Icon name="externalLink" className="w-3.5 h-3.5 text-muted shrink-0" />
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* 7.5 记忆管理 Sheet（Craft 卡片流 + Diff + 溯源 + 编辑/停用/遗忘） */}
      {memorySheetOpen && (
        <div className="fixed inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn" onClick={() => setMemorySheetOpen(false)} role="dialog" aria-label="记忆管理" aria-modal="true" tabIndex={-1} data-reference-dialog>
          <div className="w-full max-w-xl rounded-2xl bg-canvas border border-border shadow-float overflow-hidden max-h-[84vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3.5 bg-surface border-b border-border flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-primary">记忆管理</span>
                <span className="text-[11px] text-muted hidden sm:inline">本对话生效：{memoryEnabled ? memoryScope : '已关闭'}</span>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => setNewMemoryOpen(v => !v)}
                  className="h-7 px-2.5 rounded-lg bg-subtle hover:bg-hover border border-border text-[11.5px] font-medium text-primary flex items-center gap-1"
                >
                  <Icon name="plus" className="w-3.5 h-3.5" />
                  <span>新建</span>
                </button>
                <button
                  onClick={() => setMemoryEnabled(v => !v)}
                  className={`w-9 h-5 rounded-full p-0.5 transition-colors ${memoryEnabled ? 'bg-primary' : 'bg-border'}`}
                  title="启用或关闭本对话记忆"
                >
                  <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${memoryEnabled ? 'translate-x-4' : 'translate-x-0'}`}></span>
                </button>
                <button onClick={() => setMemorySheetOpen(false)} className="w-7 h-7 rounded-lg hover:bg-hover flex items-center justify-center text-muted">
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="px-5 py-3 flex items-center justify-between gap-2 border-b border-border bg-surface/60">
              <select
                value={memoryScope}
                onChange={(e) => setMemoryScope(e.target.value)}
                className="h-8 px-2.5 rounded-xl bg-surface border border-border text-[12px] font-medium text-primary outline-none"
              >
                <option value="工程资料整理">工程资料整理</option>
                <option value="个人通用">个人通用</option>
                <option value="Hub 开发">Hub 开发</option>
              </select>
              <div className="flex bg-subtle p-0.5 rounded-xl border border-border text-[11.5px]">
                <button onClick={() => setMemoryTab('saved')} className={`px-3 py-1 rounded-lg font-medium ${memoryTab === 'saved' ? 'bg-surface text-primary shadow-2xs' : 'text-secondary'}`}>已保存 ({memories.length})</button>
                <button onClick={() => setMemoryTab('pending')} className={`px-3 py-1 rounded-lg font-medium ${memoryTab === 'pending' ? 'bg-surface text-primary shadow-2xs' : 'text-secondary'}`}>待确认 (0)</button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {newMemoryOpen && (
                <div className="rounded-2xl bg-surface border border-primary/25 p-4 space-y-2.5 shadow-2xs animate-fadeIn">
                  <input
                    value={newMemoryTitle}
                    onChange={(e) => setNewMemoryTitle(e.target.value)}
                    placeholder="记忆标题..."
                    className="w-full h-8 px-2.5 rounded-lg bg-subtle border border-border text-[12.5px] font-medium outline-none"
                  />
                  <textarea
                    rows={2}
                    value={newMemoryBody}
                    onChange={(e) => setNewMemoryBody(e.target.value)}
                    placeholder="输入需要助手长期记住的事实或偏好..."
                    className="w-full p-2.5 rounded-lg bg-subtle border border-border text-[12px] outline-none resize-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setNewMemoryOpen(false)} className="h-7 px-2.5 text-[11.5px] text-secondary">取消</button>
                    <button
                      onClick={() => {
                        if (!newMemoryTitle.trim()) return;
                        setMemories(prev => [{
                          id: 'mem_' + Date.now(),
                          scope: memoryScope,
                          title: newMemoryTitle.trim(),
                          version: '第 1 版',
                          updatedAt: '刚刚',
                          body: newMemoryBody.trim() || '已手动录入该条工作记忆。',
                          sourceId: 'manual-entry',
                          enabled: true,
                          showDiff: false,
                          showSource: false
                        }, ...prev]);
                        setNewMemoryTitle('');
                        setNewMemoryBody('');
                        setNewMemoryOpen(false);
                        triggerToast('已保存新记忆');
                      }}
                      className="h-7 px-3 rounded-lg bg-primary text-white text-[11.5px] font-medium"
                    >
                      保存记忆
                    </button>
                  </div>
                </div>
              )}

              {memoryTab === 'pending' ? (
                <div className="py-12 text-center text-[12.5px] text-muted">此范围暂无待确认的记忆建议。</div>
              ) : (
                memories.map(mem => (
                  <div key={mem.id} className={`rounded-2xl bg-surface border border-border p-4 space-y-3 shadow-2xs ${!mem.enabled ? 'opacity-60' : ''}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[13.5px] font-semibold text-primary">{mem.title}</div>
                      <span className="px-2 py-0.5 rounded-md bg-amber-50 border border-amber-200/80 text-amber-800 text-[10.5px] font-medium shrink-0">
                        {mem.version}
                      </span>
                    </div>
                    <p className="text-[12.5px] leading-relaxed text-secondary">{mem.body}</p>

                    {mem.diffOld && (
                      <div className="pt-2 border-t border-border space-y-2">
                        <button
                          onClick={() => setMemories(prev => prev.map(x => x.id === mem.id ? { ...x, showDiff: !x.showDiff } : x))}
                          className="text-[11.5px] text-secondary hover:text-primary flex items-center gap-1"
                        >
                          <Icon name={mem.showDiff ? 'chevronDown' : 'chevronRight'} className="w-3.5 h-3.5" />
                          <span>版本变更对比 ({mem.updatedAt})</span>
                        </button>
                        {mem.showDiff && (
                          <div className="rounded-xl overflow-hidden border border-border font-mono text-[11.5px]">
                            <div className="px-3 py-2 bg-rose-50/80 text-rose-800">- {mem.diffOld}</div>
                            <div className="px-3 py-2 bg-emerald-50/80 text-emerald-900 border-t border-border">+ {mem.diffNew}</div>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="pt-2 border-t border-border flex items-center justify-between text-[11.5px]">
                      <button
                        onClick={() => setMemories(prev => prev.map(x => x.id === mem.id ? { ...x, showSource: !x.showSource } : x))}
                        className="text-muted hover:text-primary"
                      >
                        {mem.showSource ? `来源：${mem.sourceId}` : '查看来源'}
                      </button>
                      <div className="flex items-center gap-3">
                        <button onClick={() => triggerToast('已进入编辑模式')} className="text-secondary hover:text-primary">编辑</button>
                        <button
                          onClick={() => setMemories(prev => prev.map(x => x.id === mem.id ? { ...x, enabled: !x.enabled } : x))}
                          className="text-secondary hover:text-primary"
                        >
                          {mem.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          onClick={() => { setMemories(prev => prev.filter(x => x.id !== mem.id)); triggerToast('已遗忘该条记忆'); }}
                          className="text-rose-600 hover:underline"
                        >
                          遗忘
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 7.6 Hub & Codex 通用技能管理中心 Sheet */}
      {skillsManagerOpen && (
        <div className="fixed inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn" onClick={() => setSkillsManagerOpen(false)} role="dialog" aria-label="通用技能管理" aria-modal="true" tabIndex={-1} data-reference-dialog>
          <div className="w-full max-w-xl rounded-2xl bg-canvas border border-border shadow-float overflow-hidden max-h-[84vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3.5 bg-surface border-b border-border flex items-center justify-between">
              <span className="text-[14px] font-semibold text-primary">Hub &amp; Codex 通用技能中心</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => triggerToast('已导入新方法包文件夹')}
                  className="h-7 px-3 rounded-lg bg-primary text-white text-[11.5px] font-medium hover:opacity-90"
                >
                  + 导入技能
                </button>
                <button onClick={() => setSkillsManagerOpen(false)} className="w-7 h-7 rounded-lg hover:bg-hover flex items-center justify-center text-muted">
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* 互通状态卡片 */}
              <div className="rounded-2xl bg-surface border border-border p-4 flex items-center justify-between gap-3 shadow-2xs">
                <div className="space-y-0.5">
                  <div className="text-[13px] font-semibold text-primary flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${codexMcpSync ? 'bg-emerald-500' : 'bg-muted'}`}></span>
                    <span>Hub &amp; Codex 技能库互通</span>
                  </div>
                  <div className="text-[11.5px] text-muted">外部 Codex 客户端通过 Hub MCP 读取本地 SKILL.md 技能</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => triggerToast('已在资源管理器打开本地技能目录')}
                    className="h-7 px-2.5 rounded-lg bg-subtle hover:bg-hover border border-border text-[11px] font-medium text-primary"
                  >
                    打开目录 ↗
                  </button>
                  <button
                    onClick={() => setCodexMcpSync(v => !v)}
                    className={`w-9 h-5 rounded-full p-0.5 transition-colors ${codexMcpSync ? 'bg-primary' : 'bg-border'}`}
                  >
                    <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${codexMcpSync ? 'translate-x-4' : 'translate-x-0'}`}></span>
                  </button>
                </div>
              </div>

              {/* 分段筛选 */}
              <div className="flex items-center justify-between">
                <div className="flex bg-subtle p-0.5 rounded-xl border border-border text-[11.5px]">
                  {[
                    { id: 'all', label: '全部' },
                    { id: 'local', label: '本地技能' },
                    { id: 'package', label: '方法包' }
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setSkillsManagerTab(tab.id)}
                      className={`px-3 py-1 rounded-lg font-medium ${skillsManagerTab === tab.id ? 'bg-surface text-primary shadow-2xs' : 'text-secondary'}`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => triggerToast('已刷新本地技能索引')} className="text-[11.5px] text-secondary hover:text-primary flex items-center gap-1">
                  <Icon name="refresh" className="w-3.5 h-3.5" />
                  <span>刷新</span>
                </button>
              </div>

              {/* 技能卡片流 */}
              <div className="space-y-2">
                {skillsList
                  .filter(s => skillsManagerTab === 'all' || s.kind === skillsManagerTab)
                  .map(sk => (
                    <div key={sk.id} className="rounded-2xl bg-surface border border-border p-3.5 flex items-center justify-between gap-3 shadow-2xs">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-primary">{sk.name}</span>
                          <span className="px-1.5 py-0.5 rounded bg-subtle border border-border text-[10px] font-mono text-secondary">{sk.version}</span>
                          {sk.shared && codexMcpSync && (
                            <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-accent-indigo text-[10px] font-medium">Codex 通用</span>
                          )}
                        </div>
                        <p className="text-[11.5px] text-secondary truncate">{sk.desc}</p>
                      </div>
                      <button
                        onClick={() => setSkillsList(prev => prev.map(x => x.id === sk.id ? { ...x, enabled: !x.enabled } : x))}
                        className={`w-9 h-5 rounded-full p-0.5 shrink-0 transition-colors ${sk.enabled ? 'bg-primary' : 'bg-border'}`}
                      >
                        <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${sk.enabled ? 'translate-x-4' : 'translate-x-0'}`}></span>
                      </button>
                    </div>
                  ))}
              </div>

              <div>
                <button onClick={() => setShowImportGuide(v => !v)} className="text-[11px] text-muted hover:text-primary">
                  {showImportGuide ? '▾ 隐藏导入规范' : '▸ 导入格式与容量规范'}
                </button>
                {showImportGuide && (
                  <p className="mt-1.5 text-[11px] text-muted leading-relaxed">
                    每个技能包需包含 SKILL.md，单包上限 33 个文件 / 128 KiB 原始内容，模板文件单份不超过 32 KiB。
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 7.7 Codex 账号快捷管理与切换 Modal */}
      {accountModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4 animate-fadeIn" onClick={() => setAccountModalOpen(false)} role="dialog" aria-label="Codex 账号管理" aria-modal="true" tabIndex={-1} data-reference-dialog>
          <div className="w-full max-w-md rounded-2xl bg-surface border border-border shadow-float overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
              <span className="text-[14px] font-semibold text-primary">助手 Codex 账号</span>
              <div className="flex items-center gap-1">
                <button onClick={() => triggerToast('已刷新所有账号登录状态')} title="刷新状态" className="w-7 h-7 rounded-lg hover:bg-hover flex items-center justify-center text-secondary">
                  <Icon name="refresh" className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setAccountModalOpen(false)} className="w-7 h-7 rounded-lg hover:bg-hover flex items-center justify-center text-muted">
                  <Icon name="x" className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="p-4 space-y-2.5 max-h-[65vh] overflow-y-auto">
              {codexAccounts.map(acc => {
                const isCurrent = acc.id === activeAccountId;
                const isPending = acc.id === pendingSwitchId;
                return (
                  <div key={acc.id} className={`rounded-2xl border p-3 transition-colors ${isCurrent ? 'bg-subtle/70 border-primary/30' : 'bg-surface border-border'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        onClick={() => {
                          if (isCurrent || acc.status === 'expired') return;
                          setPendingSwitchId(isPending ? null : acc.id);
                        }}
                        className="flex-1 min-w-0 text-left flex items-center gap-2.5"
                      >
                        <span className={`w-2 h-2 rounded-full shrink-0 ${acc.status === 'active' ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                        <div className="min-w-0">
                          <div className="text-[12.5px] font-semibold text-primary truncate flex items-center gap-1.5">
                            <span>{acc.label}</span>
                            <span className="px-1.5 py-0.5 rounded bg-subtle border border-border text-[10px] font-mono text-secondary">{acc.plan}</span>
                          </div>
                          <div className="text-[11px] text-muted truncate">
                            {acc.isFollow ? `当前识别：${acc.email} · ${acc.workspace}` : acc.workspace}
                          </div>
                        </div>
                      </button>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {acc.status === 'expired' ? (
                          <button
                            onClick={() => {
                              setCodexAccounts(prev => prev.map(x => x.id === acc.id ? { ...x, status: 'active' } : x));
                              triggerToast(`已重新授权 ${acc.email}`);
                            }}
                            className="h-6 px-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-[11px] font-medium"
                          >
                            已失效 · 重登
                          </button>
                        ) : isCurrent ? (
                          <span className="text-[11px] font-medium text-emerald-700">使用中</span>
                        ) : (
                          <button
                            onClick={() => setPendingSwitchId(isPending ? null : acc.id)}
                            className="h-6 px-2.5 rounded-lg bg-subtle hover:bg-hover border border-border text-[11px] font-medium text-primary"
                          >
                            选择
                          </button>
                        )}
                        {!acc.isFollow && !isCurrent && (
                          <button
                            onClick={() => setCodexAccounts(prev => prev.filter(x => x.id !== acc.id))}
                            title="解绑账号"
                            className="w-6 h-6 rounded-lg text-muted hover:text-rose-600 flex items-center justify-center"
                          >
                            <Icon name="trash" className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {isPending && (
                      <div className="mt-3 pt-2.5 border-t border-border space-y-2 animate-fadeIn">
                        <div className="grid grid-cols-2 gap-1.5 text-[11.5px]">
                          <button
                            onClick={() => setSwitchCarryMode('continue')}
                            className={`p-2 rounded-xl border text-left ${switchCarryMode === 'continue' ? 'bg-subtle border-primary/30 text-primary font-medium' : 'border-border text-secondary'}`}
                          >
                            <div>继续当前对话</div>
                            <div className="text-[10px] text-muted font-normal">下条消息带入必要历史</div>
                          </button>
                          <button
                            onClick={() => setSwitchCarryMode('new')}
                            className={`p-2 rounded-xl border text-left ${switchCarryMode === 'new' ? 'bg-subtle border-primary/30 text-primary font-medium' : 'border-border text-secondary'}`}
                          >
                            <div>新建独立对话</div>
                            <div className="text-[10px] text-muted font-normal">与新账号从头开始聊</div>
                          </button>
                        </div>
                        <button
                          onClick={() => handleConfirmAccountSwitch(acc)}
                          className="w-full h-8 rounded-xl bg-primary text-white text-[12px] font-medium hover:opacity-90"
                        >
                          确认切换至 {acc.workspace}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {oauthAdding && (
                <div className="rounded-2xl bg-indigo-50/70 border border-indigo-200/80 p-3 text-[12px] text-indigo-900 flex items-center justify-between gap-2 animate-fadeIn">
                  <span>正在演示 ChatGPT 授权流程...</span>
                  <button
                    onClick={() => {
                      const newAcc = { id: 'acc_' + Date.now(), label: 'team***@example.test', email: 'team***@example.test', plan: 'Pro', workspace: '新工作组', status: 'active', isFollow: false };
                      setCodexAccounts(prev => [...prev, newAcc]);
                      setOauthAdding(false);
                      handleConfirmAccountSwitch(newAcc);
                    }}
                    className="h-7 px-2.5 rounded-lg bg-accent-indigo text-white text-[11px] font-medium shrink-0"
                  >
                    模拟授权并立即切换
                  </button>
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-border bg-canvas flex items-center justify-between text-[11.5px]">
              <button
                onClick={() => setOauthAdding(true)}
                className="font-medium text-primary hover:underline flex items-center gap-1"
              >
                <Icon name="plus" className="w-3.5 h-3.5" />
                <span>添加 Codex 账号</span>
              </button>
              <button
                onClick={() => {
                  setAccountModalOpen(false);
                  setOldChatAuthNeeded(true);
                }}
                className="text-muted hover:text-primary"
              >
                预览旧对话授权条 ›
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7.8 图片 Lightbox 大图预览 */}
      {lightboxImage && (
        <div className="fixed inset-0 z-50 bg-black/70 glass flex items-center justify-center p-6 animate-fadeIn" onClick={() => setLightboxImage(null)} role="dialog" aria-label="图片预览" aria-modal="true" tabIndex={-1} data-reference-dialog>
          <div className="w-full max-w-md rounded-2xl overflow-hidden bg-surface border border-border shadow-float" onClick={e => e.stopPropagation()}>
            <div className="h-72 w-full">
              <MockThumbVisual type={lightboxImage.type} />
            </div>
            <div className="px-4 py-3 flex items-center justify-between text-[12.5px]">
              <span className="font-medium text-primary">{lightboxImage.name}</span>
              <button onClick={() => setLightboxImage(null)} className="px-2.5 py-1 rounded-lg bg-subtle text-secondary hover:text-primary text-[11.5px]">关闭</button>
            </div>
          </div>
        </div>
      )}

      {narrowCitation && (
        <div className="fixed inset-0 z-50 bg-black/25 glass flex items-center justify-center p-4"
          onClick={() => setNarrowCitation(null)}>
          <article role="dialog" aria-modal="true" aria-label="原文段落" tabIndex={-1} data-reference-dialog className="w-full max-w-md rounded-2xl bg-surface p-4 shadow-float"
            onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-sm font-semibold">{narrowCitation.label}</h2>
              <button type="button" autoFocus onClick={() => setNarrowCitation(null)} className="p-2 hover:bg-hover rounded-lg text-xs">关闭</button>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed">{narrowCitation.text}</p>
          </article>
        </div>
      )}

      {/* 7.9 全局轻提示 Toast */}
      {toastMsg && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-3.5 py-2 rounded-full bg-primary text-white text-[12px] font-medium shadow-popover animate-fadeIn pointer-events-none">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
