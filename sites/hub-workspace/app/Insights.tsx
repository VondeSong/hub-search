"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AssistantContext } from "./Assistant";
import type { HubItem } from "./data";
import { MIGRATED_DISCOVERIES, MIGRATED_CHECKLIST_STEPS, SOURCE_COMPARISONS, SOURCE_VERSION_EXCERPTS, SOURCE_SIMULATION_NOTE } from "./insight-migration";
import { WORKFLOW_KEY, SCOPE_OPTIONS, readWorkflow, type InsightDraft, type WorkflowEvent, type TopicState } from "./insight-workflow";
import { getLedger, subscribeLedger, getVisibleFinding, isInsightAccessible, isSourceAccessible, type LedgerState } from "./insight-ledger";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  Flag,
  GitBranch,
  Layers3,
  Lightbulb,
  Link2,
  MessageSquare,
  PencilLine,
  RotateCcw,
  Sparkles,
  X,
  SlidersHorizontal,
  RefreshCw,
  History,
  Pause,
  Play,
  ListTodo,
  Save,
  Archive,
  LoaderCircle,
} from "lucide-react";

type Category = "knowledge" | "life" | "decision";
type Status = "active" | "later" | "done" | "dismissed";
type Evidence = { id: string; title: string; source: string; date: string; quote: string };
type Discovery = {
  id: string;
  category: Category;
  kind: string;
  title: string;
  summary: string;
  why: string;
  finding: string;
  condition: string;
  date: string;
  displayDate: string;
  action: string;
  actionSource?: string;
  assistant: string;
  evidence: Evidence[];
  workId?: string;
  workTitle?: string;
  scopeIds?: string[];
  mergedCount?: number;
};
type LocalState = {
  status?: Status;
  following?: boolean;
  needsReview?: boolean;
  correction?: { kind: string; text: string; date: string };
  history?: { text: string; date: string }[];
  snooze?: string;
  verifiedVersions?: Record<string, number>;
};
type LocalStates = Record<string, LocalState>;

type SavedHubReceipt = { id: string; item: HubItem; workTitle: string; targetRevision: number; createdAt: string };

/** A saved note must remain readable under both its current and original dependencies. */
export function visibleHubReceipts(items: HubItem[], ledger: LedgerState): SavedHubReceipt[] {
  const result: SavedHubReceipt[] = [];
  const seen = new Set<string>();
  for (const event of ledger.events) {
    if (event.type !== "receipt" || !event.createdItemId || !event.insightId || !event.targetRevision || seen.has(event.createdItemId)) continue;
    const insight = ledger.insights.find(candidate => candidate.id === event.insightId);
    const item = items.find(candidate => candidate.id === event.createdItemId);
    if (!insight || !item || item.originInsightId !== insight.id || !["note", "task"].includes(item.kind)
      || !isInsightAccessible(insight.id, ledger) || !getVisibleFinding(ledger, insight, event.targetRevision)) continue;
    const originSourceIds = (item as HubItem & { originSourceIds?: string[] }).originSourceIds;
    if (originSourceIds && !originSourceIds.every(id => isSourceAccessible(id, ledger))) continue;
    seen.add(item.id);
    result.push({ id: event.id, item, workTitle: insight.workTitle, targetRevision: event.targetRevision, createdAt: event.createdAt });
  }
  return result;
}

export type InsightsProps = {
  onOpenSource: (id: string) => void;
  onAssistant: (context: string | AssistantContext) => void;
  onCreateDraft: (kind: "note" | "task", title: string, body: string, origin: { insightId: string; workId?: string; sourceIds?: string[] }) => string;
  onSourceVersionChange: (id: string, version: number, note: string) => void;
  onOverlayOpen: () => void;
  onFilterChange: (value: string) => void;
  items: HubItem[];
  notify: (message: string) => void;
  query: string;
  filter: string;
  review: boolean;
  onReviewChange: (value: boolean) => void;
};

const STORAGE_KEY = "hub-proto-insights-v1";
const VIEW_STATE_KEY = "hub-proto-insights-view-v1";

const existingDiscoveries: Discovery[] = [
  {
    id: "dxf-connection",
    category: "knowledge",
    kind: "知识应用",
    title: "孔位笔记，可以用到这次 DXF 验证中",
    summary: "已有材料覆盖了连接器、孔位和回路编号，可以先整理一份小样本核对清单。",
    why: "示例任务正在准备线表导出验证。你收集的孔位与回路资料，恰好能帮助确定第一轮需要核对的字段。",
    finding: "先选一张图纸，逐项核对连接器编号、孔位、回路编号和导线信息。已有笔记可以成为验证起点，减少重新整理背景的时间。",
    condition: "字段名称相近，不等于图纸含义一致。还需要核对图纸版本、标注约定和缺失项；这些资料本身不能证明解析结果正确。",
    date: "2026-11-08",
    displayDate: "今天 · 10:20",
    action: "准备验证清单",
    assistant: "围绕“孔位笔记可以用到这次 DXF 验证中”这条示例发现，结合 DXF 线表导出、孔位与回路编号笔记，整理一份小样本验证清单。区分已有依据、需要人工确认的字段和未覆盖的情况。",
    evidence: [
      { id: "circuit", title: "CIRCUIT NBR、Cav 与 wire 的区别", source: "Craft · Car", date: "11月5日", quote: "先区分连接器、孔位与回路编号，再核对导线信息；不能只凭单个字段确认完整去向。" },
      { id: "dxf-guide", title: "DXF → 线表：先验证一个样本", source: "Craft · Car", date: "11月7日", quote: "第一轮以可人工对照的小样本为准，记录字段缺失和识别不确定的位置。" },
      { id: "task-dxf", title: "验证一张 DXF 图纸的线表导出", source: "滴答清单 · 汽车线束", date: "11月8日", quote: "选择一张脱敏图纸，核对连接器编号、Cav、CIRCUIT NBR 和 wire。" },
    ],
  },
  {
    id: "waiting-condition",
    category: "life",
    kind: "推进条件",
    title: "下一步，可能是先等到一份材料",
    summary: "任务仍未完成，但日志补充了等待图纸的原因。先核对条件，再调整安排。",
    why: "单看任务状态，只能知道验证还没完成。把当天的日志放在一起，才看得到影响下一步的具体条件。",
    finding: "当前可确认的阻碍是缺少适合验证的脱敏图纸。可以先确定材料何时可用；如果有现成样本，也可以缩小这次验证的范围。",
    condition: "当前示例没有完整的任务改期历史，不能据此推断反复拖延，也不能判断你的执行力。等待条件是否仍然存在，需要你确认。",
    date: "2026-11-08",
    displayDate: "今天 · 09:45",
    action: "查看相关任务",
    actionSource: "task-dxf",
    assistant: "请基于“下一步可能是先等到一份材料”这条示例发现，帮助核对 DXF 验证的等待条件，并给出在图纸未到和图纸已到两种情况下可选择的下一步。不要把未完成解释成拖延。",
    evidence: [
      { id: "task-dxf", title: "验证一张 DXF 图纸的线表导出", source: "滴答清单 · 汽车线束", date: "11月8日", quote: "任务尚未完成，当前下一步是准备可对照的图纸样本。" },
      { id: "journal-today", title: "今天的工作与想法", source: "Hub · 日志", date: "11月8日", quote: "想继续做线表验证，但还需要一份合适的脱敏图纸；可以先把字段清单整理好。" },
    ],
  },
  {
    id: "status-check",
    category: "life",
    kind: "状态核对",
    title: "日志已记录验证，任务还没有勾选",
    summary: "两处记录可能没有同步。先看一眼原任务，确认是不是同一项工作。",
    why: "示例周记记录了卡扣安装顺序的核对结果，而任务列表里的对应条目仍显示未完成。这个差异值得核对一次。",
    finding: "可能是验证完成后还没更新任务，也可能是任务还有额外验收项。将两处记录放在一起，能更快确认剩余工作。",
    condition: "标题相似并不能证明两条记录指向同一批次或同一个验收范围。请先确认对象、版本与完成条件。处理本条发现不会自动完成原任务。",
    date: "2026-11-07",
    displayDate: "昨天 · 17:30",
    action: "核对原任务",
    actionSource: "task-clip",
    assistant: "请帮我核对“日志已记录验证，任务还没有勾选”这条示例发现。先比较对象、版本和验收范围，列出需要确认的差异，不直接改变任务状态。",
    evidence: [
      { id: "journal-week", title: "本周回顾：从记录走向验证", source: "Hub · 日志", date: "11月7日", quote: "卡扣安装顺序已经完成一轮样本核对，结果整理到工作记录中。" },
      { id: "task-clip", title: "核对卡扣安装顺序并整理说明", source: "滴答清单 · 汽车线束", date: "11月7日", quote: "状态：待处理。需确认安装顺序与记录的样本范围。" },
    ],
  },
  {
    id: "prototype-progress",
    category: "life",
    kind: "阶段进展",
    title: "Hub 正从功能构想，走到原型验证",
    summary: "讨论开始围绕真实界面和完整流程展开，这个阶段变化值得留下来。",
    why: "几份示例记录的关注点发生了变化：从“有哪些能力”，转向“材料怎样进入工作，结果怎样回到记录”。",
    finding: "这一阶段的收获，是把抽象功能变成可以点击、比较和纠正的工作流程。下一次评审可以围绕一个具体场景展开，而不必重新讨论整个软件。",
    condition: "原型验证是阶段成果，不代表真实来源、模型和业务操作已经接通。这里记录的是设计推进，没有为整个项目判定完成度。",
    date: "2026-11-08",
    displayDate: "今天 · 11:10",
    action: "放到阶段回顾里看",
    assistant: "请围绕“Hub 从功能构想走到原型验证”整理一段阶段回顾，保留已经具体化的工作流程、仍待验证的问题和可复用的经验；明确原型与真实接入的区别。",
    evidence: [
      { id: "codex-hub", title: "把 Codex 接入 Hub 的意义", source: "滴答清单 · 收件箱", date: "11月6日", quote: "让已有资料成为可以推进工作的上下文，让成果回到自己的知识和任务系统。" },
      { id: "ui-design", title: "UI 设计示例", source: "Craft · main", date: "11月8日", quote: "保留窄图标栏、二级导航、时间分组列表和右侧阅读面板，让洞察融入现有 Hub。" },
      { id: "journal-week", title: "本周回顾：从记录走向验证", source: "Hub · 日志", date: "11月7日", quote: "先用一个真实场景串起资料、分析和结果，再检查每一处是否顺手。" },
    ],
  },
  {
    id: "decision-assumption",
    category: "decision",
    kind: "决策回看",
    title: "云端归档的前提，需要再核对一次",
    summary: "“一个入口访问全部资料”的设想，遇到了本地资料的访问边界。",
    why: "示例决定希望减少在不同设备之间搬运资料。新的记录提示，部分来源仍在本地；这影响的是接入顺序，而不是这个目标本身。",
    finding: "可以先挑一个可访问的来源，把读取、整理和保存流程走通，再决定怎样接入其他来源。原来的整体目标可以保留，验证范围需要更具体。",
    condition: "这里并未实测各来源的授权或同步能力。是否改变方案，要结合真实连接结果、维护成本和你的使用频率判断。",
    date: "2026-11-08",
    displayDate: "今天 · 08:50",
    action: "对照当时的决定",
    actionSource: "decision-cloud",
    assistant: "围绕“云端归档的前提需要再核对一次”，对照当时的选择、理由与关键假设，再列出新记录触及了哪些前提。给出最小验证范围，不替我改写过去的动机，也不自动改变原决定。",
    evidence: [
      { id: "decision-cloud", title: "决定记录：先验证云端归档", source: "Hub · 决策记录", date: "11月1日", quote: "希望减少资料在设备之间的搬运。先验证一个来源能否完整完成读取、整理和保存。" },
      { id: "journal-today", title: "今天的工作与想法", source: "Hub · 日志", date: "11月8日", quote: "部分资料还在本地。浏览器原型可以先验证流程，真实接入还需要逐项核对。" },
    ],
  },
];

const workDetails: Record<string, { workId: string; workTitle: string }> = {
  "dxf-connection": { workId: "work-dxf-validation", workTitle: "DXF 线表 · 小样例验证" },
  "waiting-condition": { workId: "work-dxf-validation", workTitle: "DXF 线表 · 小样例验证" },
  "status-check": { workId: "work-clip-verification", workTitle: "卡扣安装 · 样本核对" },
  "prototype-progress": { workId: "work-hub-prototype", workTitle: "Hub · 原型验证" },
  "decision-assumption": { workId: "work-cloud-archive", workTitle: "云端归档 · 最小验证" },
};
function evidenceScope(evidence: Evidence): string {
  return evidence.source.startsWith("Craft") ? "craft-car" : evidence.source.startsWith("Obsidian") ? "obsidian-main" : evidence.source.startsWith("滴答") ? "dida-work" : "hub-local";
}
const discoveries: Discovery[] = [
  ...MIGRATED_DISCOVERIES,
  ...existingDiscoveries.map(item => ({ ...item, ...workDetails[item.id], scopeIds: [...new Set(item.evidence.map(evidenceScope))] })),
];

const categoryNames: Record<Category, string> = { knowledge: "知识与应用", life: "生活与进展", decision: "决定与假设" };
const categoryIcons = { knowledge: BookOpen, life: Layers3, decision: GitBranch };

const reviewEvents = [
  { date: "2026-11-01", day: "01", weekday: "周日", title: "为云端归档留下当时的理由", body: "先记录希望解决的问题，再选一个来源验证，保留以后回看的依据。", source: "decision-cloud", sourceName: "决定记录" },
  { date: "2026-11-03", day: "03", weekday: "周二", title: "把线束资料整理成可核对的字段", body: "连接器、孔位与回路编号开始有了明确区分，为小样本验证准备材料。", source: "circuit", sourceName: "孔位与回路笔记" },
  { date: "2026-11-05", day: "05", weekday: "周四", title: "把验证范围收小到一张图纸", body: "用能够人工对照的样本，先找出缺失与不确定的字段。", source: "dxf-guide", sourceName: "DXF 验证笔记" },
  { date: "2026-11-07", day: "07", weekday: "周六", title: "从讨论功能，转向检验完整流程", body: "Hub 的设计开始围绕一个具体场景串联资料、分析与结果。", source: "journal-week", sourceName: "本周回顾" },
  { date: "2026-11-08", day: "08", weekday: "周日", title: "给下一步留出真实的等待条件", body: "缺少材料时先整理清单；资料到位后，再继续验证。", source: "journal-today", sourceName: "今天的工作与想法" },
];

function stamp() {
  return new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function safeStates(value: unknown): LocalStates {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: LocalStates = {};
  for (const item of discoveries) {
    const candidate = (value as Record<string, unknown>)[item.id];
    if (!candidate || typeof candidate !== "object") continue;
    const state = candidate as LocalState;
    const correction = state.correction && typeof state.correction.text === "string" && typeof state.correction.kind === "string" && typeof state.correction.date === "string" ? state.correction : undefined;
    result[item.id] = {
      status: ["active", "later", "done", "dismissed"].includes(state.status || "") ? state.status : "active",
      following: state.following === true,
      needsReview: state.needsReview === true,
      correction,
      snooze: typeof state.snooze === "string" ? state.snooze.slice(0, 80) : undefined,
      verifiedVersions: state.verifiedVersions && typeof state.verifiedVersions === "object" ? Object.fromEntries(Object.entries(state.verifiedVersions).filter(([id, version]) => item.evidence.some(e => e.id === id) && Number.isInteger(version) && version > 0)) : undefined,
      history: Array.isArray(state.history) ? state.history.filter((entry) => entry && typeof entry.text === "string" && typeof entry.date === "string").slice(0, 8) : [],
    };
  }
  return result;
}

type FlowDialog = { type: "scope" | "correct" | "snooze" | "version" | "draft" | "topic"; id?: string } | null;
type DraftEditor = Omit<InsightDraft, "id" | "time"> & { id?: string };
const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function WorkflowModal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    ref.current?.querySelector<HTMLElement>('textarea, input:not([type="checkbox"]), select')?.focus({ preventScroll: true });
    return () => { ref.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className={`insight-flow-dialog ${wide ? "is-wide" : ""}`} aria-label={title} onCancel={onClose} onKeyDown={event => event.stopPropagation()} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><div><span className="insight-eyebrow">HUB · 洞察</span><h2>{title}</h2></div><button type="button" className="insight-icon-button" aria-label="关闭洞察窗口" onClick={onClose}><X size={18} /></button></header>
    {children}
  </dialog>;
}

export default function Insights({ onOpenSource, onAssistant, onCreateDraft, onSourceVersionChange, onOverlayOpen, onFilterChange, items, notify, query, filter, review, onReviewChange }: InsightsProps) {
  const [states, setStates] = useState<LocalStates>({});
  const [demoDraftsVersion, setDemoDraftsVersion] = useState(0);
  const [ledger, setLedger] = useState<LedgerState>(() => getLedger());
  const [ready, setReady] = useState(false);
  const [selectedId, setSelectedId] = useState(discoveries[0].id);
  const [period, setPeriod] = useState<"week" | "month" | "all">("week");
  const [mobileDetail, setMobileDetail] = useState(false);
  const [scope, setScope] = useState<string[]>(SCOPE_OPTIONS.map(source => source.id));
  const [scopeDraft, setScopeDraft] = useState<string[]>([]);
  const [topics, setTopics] = useState<Record<string, TopicState>>({});
  const [sourceVersions, setSourceVersions] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<InsightDraft[]>([]);
  const [eventsLog, setEventsLog] = useState<WorkflowEvent[]>([]);
  const [lastUpdated, setLastUpdated] = useState("11/08 10:45");
  const [refreshStage, setRefreshStage] = useState(-1);
  const [undo, setUndo] = useState<{ id: string; previous: LocalState | undefined; label: string } | null>(null);
  const [flow, setFlow] = useState<FlowDialog>(null);
  const [correctionKind, setCorrectionKind] = useState("关联不对");
  const [correctionText, setCorrectionText] = useState("");
  const [formError, setFormError] = useState("");
  const [draftEditor, setDraftEditor] = useState<DraftEditor | null>(null);
  const [topicEditor, setTopicEditor] = useState<TopicState | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const refreshTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const contextRef = useRef({ filter, query, review });
  const auxiliary = ["topics", "drafts", "history"].includes(filter);
  const search = query.trim().toLowerCase();

  useEffect(() => {
    const saved = readWorkflow();
    setDemoDraftsVersion(saved.demoDraftsVersion);
    setStates(safeStates(saved.states)); setScope(saved.scope); setTopics(saved.topics);
    setDrafts(saved.drafts); setEventsLog(saved.events); setSourceVersions(saved.sourceVersions); setLastUpdated(saved.lastUpdated);
    try {
      const view = JSON.parse(sessionStorage.getItem(VIEW_STATE_KEY) || "null");
      if (view && typeof view === "object") {
        if (discoveries.some(item => item.id === view.selectedId)) setSelectedId(view.selectedId);
        if (["week", "month", "all"].includes(view.period)) setPeriod(view.period);
        if (view.mobileDetail === true) setMobileDetail(true);
      }
    } catch { /* The default view is available without storage. */ }
    setReady(true);
    return () => refreshTimers.current.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(WORKFLOW_KEY, JSON.stringify({ version: 2, demoDraftsVersion, states, scope, topics, drafts, events: eventsLog, sourceVersions, lastUpdated })); } catch { /* Keep the current session usable. */ }
  }, [ready, demoDraftsVersion, states, scope, topics, drafts, eventsLog, sourceVersions, lastUpdated]);

  useEffect(() => {
    if (!ready) return;
    try { sessionStorage.setItem(VIEW_STATE_KEY, JSON.stringify({ selectedId, period, mobileDetail })); } catch { /* The current selection remains usable. */ }
  }, [ready, selectedId, period, mobileDetail]);

  useEffect(() => {
    const receive = () => { const saved = readWorkflow(); setDrafts(saved.drafts); setEventsLog(saved.events); };
    window.addEventListener("hub-insight-draft", receive);
    return () => window.removeEventListener("hub-insight-draft", receive);
  }, []);

  useEffect(() => subscribeLedger(() => setLedger(getLedger())), []);

  function draftReadable(draft: Pick<InsightDraft, "insightId">): boolean {
    const discovery = discoveries.find(item => item.id === draft.insightId);
    return !!discovery && isInsightAccessible(draft.insightId, ledger) && discovery.evidence.every(evidence => isSourceAccessible(evidence.id, ledger));
  }

  useEffect(() => {
    if (flow?.type === "draft" && draftEditor && !draftReadable(draftEditor)) {
      setFlow(null); setDraftEditor(null); notify("这份草稿的来源暂不可用，相关内容已隐藏。");
    }
  }, [ledger, flow, draftEditor]);

  function log(text: string, detail = "", insightId?: string) {
    setEventsLog(current => [{ id: makeId(), text, detail, date: stamp(), insightId }, ...current].slice(0, 100));
  }
  function openFlow(next: NonNullable<FlowDialog>) { setFormError(""); onOverlayOpen(); setFlow(next); }
  function openScope() { setScopeDraft([...scope]); openFlow({ type: "scope" }); }
  function inScope(item: Discovery, selectedScope = scope) { return (item.scopeIds || []).every(id => selectedScope.includes(id)); }
  function isStale(item: Discovery) {
    return !!states[item.id]?.needsReview || item.evidence.some(evidence => (sourceVersions[evidence.id] || 1) > (states[item.id]?.verifiedVersions?.[evidence.id] || 1));
  }
  function assistantContext(item: Discovery): AssistantContext {
    const correction = states[item.id]?.correction;
    return {
      id: item.id, title: item.title, workId: item.workId || `work-${item.id}`, workTitle: item.workTitle || item.title,
      excerpt: item.assistant + `\n\n适用条件：${item.condition}` + (correction ? `\n\n用户补充（仍需核对）：${correction.kind} · ${correction.text}` : "") + (isStale(item) ? "\n\n此发现待复核，请先核对来源版本与补充条件。" : ""),
      evidence: item.evidence.map(evidence => ({ id: evidence.id, title: evidence.title, source: evidence.source, excerpt: evidence.quote })),
    };
  }

  const filtered = useMemo(() => discoveries.filter(item => {
    const status = states[item.id]?.status || "active";
    const categoryMatches = !["knowledge", "life", "decision"].includes(filter) || item.category === filter;
    const filterMatches = search ? categoryMatches : filter === "later" ? status === "later" : filter === "done" ? ["done", "dismissed"].includes(status) : status === "active" && categoryMatches;
    const text = `${item.title} ${item.summary} ${item.finding} ${item.kind} ${item.workTitle} ${categoryNames[item.category]} ${item.evidence.map(source => `${source.title} ${source.source} ${source.quote}`).join(" ")} ${states[item.id]?.correction?.text || ""}`.toLowerCase();
    return inScope(item) && filterMatches && text.includes(search) && (search || period === "all" || item.date >= (period === "week" ? "2026-11-02" : "2026-11-01"));
  }), [states, scope, filter, search, period]);

  useEffect(() => {
    if (!ready || auxiliary || review) return;
    if (!filtered.some(item => item.id === selectedId)) { setSelectedId(filtered[0]?.id || ""); setMobileDetail(false); }
  }, [filtered, selectedId, ready, auxiliary, review]);

  useEffect(() => {
    const previous = contextRef.current;
    if (previous.filter !== filter || previous.query !== query || previous.review !== review) setMobileDetail(false);
    contextRef.current = { filter, query, review };
  }, [filter, query, review]);

  const selected = filtered.find(item => item.id === selectedId) || filtered[0];
  const selectedState = selected ? states[selected.id] || {} : {};
  const selectedStatus = selectedState.status || "active";
  const selectedEvents = selected ? eventsLog.filter(event => event.insightId === selected.id) : [];
  const eventKeys = new Set(selectedEvents.map(event => `${event.text}|${event.date}`));
  const selectedHistory = [...selectedEvents, ...(selectedState.history || []).filter(event => !eventKeys.has(`${event.text}|${event.date}`)).map((event,index) => ({ ...event, id: `legacy-${index}`, detail: undefined }))];
  const selectedStale = selected ? isStale(selected) : false;
  const selectedTopic = selected ? Object.values(topics).find(topic => topic.workId === selected.workId) : undefined;
  const topicCoversSelection = selected && selectedTopic ? inScope(selected, selectedTopic.sourceIds) : false;
  const activeTopics = Object.values(topics).filter(topic => topic.enabled && topic.remaining > 0 && Date.parse(topic.expiresAt) > Date.now());
  const currentEvidence = flow?.type === "version" ? discoveries.flatMap(item => item.evidence).find(evidence => evidence.id === flow.id) : undefined;
  const matchingDrafts = drafts.filter(draft => draftReadable(draft) && `${draft.title} ${draft.body}`.toLowerCase().includes(search));
  const pendingDrafts = matchingDrafts.filter(draft => !draft.createdItemId);
  const adoptedDrafts = matchingDrafts.filter(draft => !!draft.createdItemId && items.some(item => item.id === draft.createdItemId));
  const savedHubReceipts = visibleHubReceipts(items, ledger).filter(receipt =>
    `${receipt.item.title} ${receipt.item.excerpt} ${receipt.workTitle}`.toLowerCase().includes(search)
  );
  const evidenceIds = new Set(discoveries.flatMap(item => item.evidence.map(evidence => evidence.id)));
  const matchingSources = search ? items.filter(item => evidenceIds.has(item.id) && `${item.title} ${item.excerpt} ${item.sections.map(section => section.text || section.items?.join(" ") || "").join(" ")}`.toLowerCase().includes(search)).slice(0, 5) : [];
  const events = reviewEvents.filter(event => period === "all" || event.date >= (period === "week" ? "2026-11-02" : "2026-11-01"));
  const reviewSources = [...new Map([...events.map(event => ({ id: event.source, title: event.sourceName })), { id: "codex-hub", title: "把 Codex 接入 Hub 的意义" }, { id: "ui-design", title: "UI 设计示例" }, { id: "decision-cloud", title: "决定记录：先验证云端归档" }].map(source => [source.id, source])).values()];
  const dateRange = period === "week" ? "2026.11.02 — 11.08" : period === "month" ? "2026.11.01 — 11.08" : "全部示例时间";
  useEffect(() => { detailRef.current?.scrollTo({ top: 0, behavior: "auto" }); }, [selected?.id]);

  function patchState(id: string, patch: Partial<LocalState>, text: string) {
    setUndo(null);
    setStates(current => ({ ...current, [id]: { ...current[id], ...patch, history: [{ text, date: stamp() }, ...(current[id]?.history || [])].slice(0, 20) } }));
    log(text, discoveries.find(item => item.id === id)?.title, id);
  }
  function changeStatus(id: string, status: Status, snooze?: string) {
    const label = status === "later" ? `已留到稍后 · ${snooze || "明天再看"}` : status === "done" ? "已标记为已处理" : status === "dismissed" ? "已忽略这条发现" : "已移回待关注";
    const previous = states[id];
    setStates(current => ({ ...current, [id]: { ...current[id], status, snooze, history: [{ text: label, date: stamp() }, ...(current[id]?.history || [])].slice(0, 20) } }));
    setUndo({ id, previous, label }); setFlow(null); log(label, "发现的处理状态已保存", id); notify(label);
  }
  function undoStatus() {
    if (!undo) return;
    const restore = undo;
    setStates(current => ({ ...current, [restore.id]: { ...restore.previous, history: [{ text: "撤销了上一次处理", date: stamp() }, ...(restore.previous?.history || [])].slice(0, 20) } }));
    setUndo(null); log("撤销了上一次处理", restore.label, restore.id); notify("已撤销上一次处理");
  }
  function beginCorrection() {
    if (!selected) return;
    setCorrectionKind(selectedState.correction?.kind || "关联不对"); setCorrectionText(selectedState.correction?.text || "");
    openFlow({ type: "correct", id: selected.id });
  }
  function recheck(item: Discovery) {
    patchState(item.id, { needsReview: false, verifiedVersions: Object.fromEntries(item.evidence.map(evidence => [evidence.id, sourceVersions[evidence.id] || 1])) }, "完成一次演示核对；补充条件继续保留");
    notify("已重新展示示例依据，适用条件仍需确认");
  }
  function simulateVersion(evidence: Evidence) {
    const version = (sourceVersions[evidence.id] || 1) + 1;
    const related = discoveries.filter(item => item.evidence.some(source => source.id === evidence.id));
    setUndo(null); setSourceVersions(current => ({ ...current, [evidence.id]: version }));
    setStates(current => ({ ...current, ...Object.fromEntries(related.map(item => [item.id, { ...current[item.id], needsReview: true }])) }));
    related.forEach(item => log("来源版本发生变化", `${evidence.title} · v${version}，关联发现待复核`, item.id));
    onSourceVersionChange(evidence.id, version, SOURCE_VERSION_EXCERPTS[evidence.id]?.simulationNote || SOURCE_SIMULATION_NOTE);
    notify(`已模拟 v${version}，${related.length} 条关联发现待复核`);
  }
  function refresh() {
    if (refreshStage >= 0 || !scope.length) return;
    setRefreshStage(0);
    refreshTimers.current = [setTimeout(() => setRefreshStage(1), 650), setTimeout(() => setRefreshStage(2), 1350), setTimeout(() => {
      setRefreshStage(-1); setLastUpdated(stamp()); log("完成一次演示更新", "核对当前来源范围，合并已有发现，保留处理状态与草稿"); notify("没有新增示例发现，已有记录已保留");
    }, 2200)];
  }
  function stopRefresh() { refreshTimers.current.forEach(clearTimeout); setRefreshStage(-1); log("停止演示更新"); notify("已停止本次更新"); }
  function jumpTo(id: string) {
    const item = discoveries.find(candidate => candidate.id === id); if (!item) return;
    if (!inScope(item)) { openScope(); notify("请先把这条发现需要的来源加入范围"); return; }
    const status = states[id]?.status || "active";
    onFilterChange(status === "later" ? "later" : ["done", "dismissed"].includes(status) ? "done" : "all");
    onReviewChange(false); setPeriod("all"); setSelectedId(id); setMobileDetail(true); setFlow(null);
  }

  function openDraft(item: Discovery, kind: InsightDraft["kind"] = "checklist", saved?: InsightDraft) {
    const steps = item.workId === "work-dxf-validation" ? MIGRATED_CHECKLIST_STEPS : ["先确认对象、版本与适用范围", "对照原文，区分已知事实和待确认的解释", "补齐一项关键条件，再决定下一步"];
    const body = `关联工作\n${item.workTitle || item.title}\n\n为什么现在需要看\n${item.why}\n\n核对内容\n${steps.map(step => "□ " + step).join("\n")}\n\n尚待确认\n${item.condition}\n\n原文依据\n${item.evidence.map(evidence => `• ${evidence.title} · ${evidence.source} · v${sourceVersions[evidence.id] || 1}\n  ${evidence.quote}`).join("\n\n")}${states[item.id]?.correction ? `\n\n你补充的条件（仍需核对）\n${states[item.id].correction?.text}` : ""}`;
    setDraftEditor(saved ? { ...saved } : { insightId: item.id, workId: item.workId, title: kind === "task" ? `${item.workTitle || item.title} · 下一步` : kind === "archive" ? "试装复核 · 阅读要点" : `${item.workTitle || item.title} · 验证清单`, body, target: kind === "task" ? "Hub · 任务清单" : "Hub · 我的笔记", kind });
    openFlow({ type: "draft", id: item.id });
  }
  function editDraftField(patch: Partial<DraftEditor>) {
    setDraftEditor(current => current ? { ...current, ...patch, ...(current.createdItemId ? { id: undefined, createdItemId: undefined } : {}) } : null);
    setFormError("");
  }
  function saveDraft(publish = false) {
    if (!draftEditor || !draftEditor.title.trim() || !draftEditor.body.trim()) { setFormError("请填写草稿标题和内容。"); return; }
    if (!draftReadable(draftEditor)) { setFormError("这份草稿的来源暂不可用，请先恢复来源访问。"); return; }
    const actualTarget = draftEditor.kind === "task" ? "Hub · 任务清单" : "Hub · 我的笔记";
    const draft: InsightDraft = { ...draftEditor, title: draftEditor.title.trim(), body: draftEditor.body.trim(), target: publish ? actualTarget : draftEditor.target.trim() || actualTarget, id: draftEditor.id || makeId(), time: stamp() };
    if (publish && !draft.createdItemId) {
      const sourceIds = discoveries.find(item => item.id === draft.insightId)?.evidence.map(evidence => evidence.id) || [];
      const createdItemId = onCreateDraft(draft.kind === "task" ? "task" : "note", draft.title, draft.body, { insightId: draft.insightId, workId: draft.workId, sourceIds });
      if (!createdItemId) { setFormError("这次未能保存到工作台。草稿仍在这里，可以核对来源后重试。"); return; }
      draft.createdItemId = createdItemId;
    }
    setDrafts(current => [draft, ...current.filter(item => item.id !== draft.id)].slice(0, 100));
    setDraftEditor(draft); log(publish ? "草稿已保存到工作台" : "保留了工作草稿", draft.title, draft.insightId); setFlow(null);
    notify(publish ? `已保存为 Hub ${draft.kind === "task" ? "任务" : "笔记"}，可从关联草稿打开` : "草稿已保留在这条发现中");
  }
  function showSavedDraft(draft: InsightDraft) {
    if (!draftReadable(draft)) { notify("这份草稿的来源暂不可用，相关内容已隐藏。"); return; }
    const item = discoveries.find(candidate => candidate.id === draft.insightId);
    if (item) openDraft(item, draft.kind, draft);
    else if (draft.createdItemId) onOpenSource(draft.createdItemId);
  }
  function openTopic(item: Discovery) {
    const saved = Object.values(topics).find(topic => topic.workId === item.workId);
    setTopicEditor(saved ? { ...saved, sourceIds: [...saved.sourceIds] } : { id: `follow-${item.id}`, title: item.workTitle || item.title, question: `${item.title}，相关依据有没有新的变化？`, trigger: "在所选资料新增了影响当前判断的依据或适用条件时提醒。", sourceIds: [...(item.scopeIds || [])], relatedInsightId: item.id, workId: item.workId || `work-${item.id}`, enabled: true, remaining: 3, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
    openFlow({ type: "topic", id: saved?.id || `follow-${item.id}` });
  }
  function topicExpired(topic: TopicState) { return Date.parse(topic.expiresAt) <= Date.now(); }
  function toggleTopic(topic: TopicState) {
    if (!topic.remaining || topicExpired(topic)) { notify("本次关注已结束，可以编辑后重新开始一轮"); return; }
    setTopics(current => ({ ...current, [topic.id]: { ...current[topic.id], enabled: !topic.enabled } }));
    log(topic.enabled ? "暂停了关注主题" : "启用了关注主题", topic.question, topic.relatedInsightId);
  }
  function simulateTopic(topic: TopicState) {
    if (!topic.enabled || !topic.remaining || topicExpired(topic)) return;
    const related = discoveries.filter(item => item.workId === topic.workId && inScope(item, topic.sourceIds) && inScope(item));
    if (!related.length) { notify("当前主题或分析范围不足以核对这组资料，未扣除轮次"); return; }
    const remaining = Math.max(0, topic.remaining - 1);
    setTopics(current => ({ ...current, [topic.id]: { ...current[topic.id], remaining, enabled: remaining > 0 } }));
    setUndo(null); setStates(current => ({ ...current, ...Object.fromEntries(related.map(item => [item.id, { ...current[item.id], needsReview: true }])) }));
    related.forEach(item => log("关注主题完成一次演示复查", `${topic.question} · 剩余 ${remaining} 轮`, item.id));
    notify(`已演示一次复查，${related.length} 条发现待复核${remaining ? `，还剩 ${remaining} 轮` : "；本轮关注已自动暂停"}`);
  }
  function primaryAction() {
    if (!selected) return;
    if (selected.actionSource) onOpenSource(selected.actionSource);
    else if (selected.id === "prototype-progress") onReviewChange(true);
    else if (MIGRATED_DISCOVERIES.some(item => item.id === selected.id)) openDraft(selected, selected.id === "archive" ? "archive" : "checklist");
    else onAssistant(assistantContext(selected));
  }
  function renderDraft(draft: InsightDraft) {
    return <button type="button" className="insight-saved-draft" key={draft.id} onClick={() => showSavedDraft(draft)}><span className="insight-draft-icon">{draft.kind === "task" ? <ListTodo size={16} /> : <FileText size={16} />}</span><span><strong>{draft.title}</strong><small>{draft.createdItemId ? "已保存到工作台" : "待采用草稿"} · {draft.target} · {draft.time}</small></span><ChevronRight size={14} /></button>;
  }

  return <section className={`insight-workspace ${review ? "insight-review-mode" : ""}`} aria-label="Hub 洞察">
    <header className="insight-toolbar">
      <div className="insight-section-context">{review ? <Clock3 size={15}/> : filter === "topics" ? <Flag size={15}/> : filter === "drafts" ? <FileText size={15}/> : filter === "history" ? <History size={15}/> : <Sparkles size={15}/>}<span>{review ? "阶段回顾" : filter === "topics" ? "关注主题" : filter === "drafts" ? "工作草稿" : filter === "history" ? "示例处理记录" : "更多发现示例"}</span><small>示例</small></div>
      {!auxiliary || review ? <div className="insight-toolbar-actions">
        {!review && <button type="button" className="insight-scope-button" onClick={openScope}><SlidersHorizontal size={14} /><span>资料范围</span><b>{scope.length}/{SCOPE_OPTIONS.length}</b></button>}
        <label className="insight-period-select"><select aria-label="洞察时间范围" value={period} onChange={event => setPeriod(event.target.value as typeof period)}><option value="week">最近 7 天</option><option value="month">本月</option><option value="all">全部时间</option></select><ChevronDown size={12} /></label>
        {!review && <button type="button" className="insight-refresh" onClick={refreshStage >= 0 ? stopRefresh : refresh} disabled={!scope.length} title={refreshStage >= 0 ? "停止演示更新" : `上次更新 ${lastUpdated}；演示更新不调用真实来源`}><RefreshCw size={14} className={refreshStage >= 0 ? "insight-spinning" : ""} /><span>{refreshStage >= 0 ? "停止更新" : "更新"}</span></button>}
      </div> : <span className="insight-context-storage">更改保存在当前浏览器</span>}
    </header>
    {refreshStage >= 0 && <div className="insight-update-progress" role="status"><LoaderCircle size={13} className="insight-spinning" />{["正在核对所选范围…", "正在比对示例记录…", "正在合并已有发现…"][refreshStage]}<span>演示更新</span></div>}
    {review ? (
        <div className="insight-review-scroll">
          <article className="insight-review-article">
            <div className="insight-review-eyebrow"><span className="insight-glyph"><Clock3 size={19} /></span><span>阶段回顾 <span className="insight-dot">·</span> {period === "week" ? "这一周" : "11月，到现在"}</span></div>
            <h1>事情，开始连起来了</h1>
            <p className="insight-review-deck">从收集资料，到用一个具体场景验证想法。</p>
            <div className="insight-demo-note"><span />基于 {reviewSources.length} 条示例记录 · 仅用于交互演示</div>
            <p className="insight-review-intro">这组记录围绕两条线展开：把线束知识用到具体的验证中，以及让 Hub 更顺手地承接工作。关注点正从“还能增加什么功能”，推进到“这一条流程能不能用起来”。</p>

            <section className="insight-review-section">
              <h2><Lightbulb size={17} />值得留下的进展</h2>
              <div className="insight-progress-block">
                <div className="insight-progress-icon"><ArrowUpRight size={20} /></div>
                <div><h3>把问题变小，反而更容易验证</h3><p>一张图纸、一条资料归档流程、一个原型场景，让模糊的设想有了可以核对的结果。</p><button type="button" className="insight-text-button" onClick={() => onOpenSource("journal-week")}>回到这条记录 <ArrowUpRight size={13} /></button></div>
              </div>
            </section>

            <section className="insight-review-section">
              <div className="insight-section-title"><h2>这段时间的几个片段</h2><span>按示例事件日期</span></div>
              <div className="insight-timeline">
                {events.map((event) => <div className="insight-event" key={event.date}>
                  <div className="insight-event-date"><strong>{event.day}</strong><span>11月 · {event.weekday}</span></div>
                  <div className="insight-event-line"><span /></div>
                  <div className="insight-event-content"><h3>{event.title}</h3><p>{event.body}</p><button type="button" className="insight-event-source" onClick={() => onOpenSource(event.source)}><FileText size={12} />{event.sourceName}<ArrowUpRight size={12} /></button></div>
                </div>)}
              </div>
            </section>

            <section className="insight-review-section">
              <h2><GitBranch size={17} />值得再看一眼的决定</h2>
              <h3 className="insight-decision-heading">云端归档，先从哪一步开始？</h3>
              <div className="insight-decision-compare">
                <div><span className="insight-comparison-label">当时的记录 · 11月1日</span><p>希望减少资料在设备之间的搬运，先用一个来源验证读取、整理和保存。</p><button type="button" className="insight-text-button" onClick={() => onOpenSource("decision-cloud")}>查看当时的理由 <ArrowUpRight size={12} /></button></div>
                <div><span className="insight-comparison-label">后续的观察 · 11月8日</span><p>部分资料仍在本地；原型可以验证交互，真实访问能力仍需逐项核对。</p><button type="button" className="insight-text-button" onClick={() => onOpenSource("journal-today")}>查看新记录 <ArrowUpRight size={12} /></button></div>
              </div>
              <p className="insight-decision-note"><span>可回看的问题</span> 先接入哪个来源，最能证明这条流程确实减少了搬运？</p>
            </section>

            <section className="insight-review-section insight-experience">
              <h2>一个可以继续尝试的做法</h2>
              <p>先把已有资料放到一个具体问题里。验证过一次，再决定要不要扩大范围。</p>
              <span>这是这组记录给出的经验候选，可以补充或纠正。</span>
            </section>

            <details className="insight-review-sources">
              <summary><FileText size={14} />查看本次回顾的 {reviewSources.length} 条依据<ChevronDown size={14} /></summary>
              <div>{reviewSources.map((source) => <button type="button" key={source.id} onClick={() => onOpenSource(source.id)}><span>{source.title}</span><ArrowUpRight size={13} /></button>)}</div>
              <p>仅覆盖当前示例记录。缺少记录不代表没有发生；记录条数也不代表时间投入。</p>
            </details>
            <footer className="insight-review-footer"><span>保留经历，也保留不确定的地方。</span><button type="button" className="insight-primary" onClick={() => onAssistant(`请根据 ${dateRange} 的示例记录整理一段阶段回顾草稿，包含关键事件、积极进展、有效经验与值得回看的决定。重要判断保留来源，不为缺失的生活记录作推断。`)}><MessageSquare size={14} />在助手中整理回顾</button></footer>
          </article>
        </div>
    ) : auxiliary ? (
      <div className="insight-management-scroll">
        <div className="insight-management-header"><span className="insight-eyebrow">从发现，接着做下去</span><h1>{filter === "topics" ? "关注主题" : filter === "drafts" ? "工作草稿" : "示例处理记录"}</h1><p>{filter === "topics" ? "围绕一个具体问题，约定资料范围、触发条件和有限复查轮次。" : filter === "drafts" ? "先改好一份草稿，再决定采用。已经保存的笔记与任务也可以从这里继续。" : "查看范围调整、资料版本、发现处理与草稿去向。"}</p></div>
        {filter === "topics" && <><div className="insight-management-note"><Flag size={15} /><span>{activeTopics.length} 个主题正在关注 · 每轮 7 天内最多 3 次<br /><small>点击“演示复查”体验流程；此原型不会在后台扫描资料或发送通知。</small></span></div><div className="insight-topic-grid">{Object.values(topics).map(topic => <article className="insight-topic-card" key={topic.id}>
          <div className="insight-topic-heading"><span className="insight-glyph"><Flag size={18} /></span><span className={`insight-topic-status ${topic.enabled && topic.remaining > 0 && !topicExpired(topic) ? "is-enabled" : ""}`}>{topicExpired(topic) ? "本轮已到期" : !topic.remaining ? "轮次已用完" : topic.enabled ? "正在关注" : "已暂停"}</span></div>
          <h2>{topic.question}</h2><p>{topic.trigger}</p><div className="insight-topic-sources">{topic.sourceIds.map(id => <span key={id}>{SCOPE_OPTIONS.find(source => source.id === id)?.name || id}</span>)}</div>
          <div className="insight-topic-limit"><strong>剩余 {topic.remaining} 轮</strong><span>至 {new Date(topic.expiresAt).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}</span></div>
          <div className="insight-topic-actions"><button type="button" className="insight-secondary" onClick={() => simulateTopic(topic)} disabled={!topic.enabled || !topic.remaining || topicExpired(topic)}><RefreshCw size={13} />演示复查</button><button type="button" className="insight-quiet" onClick={() => toggleTopic(topic)} disabled={!topic.remaining || topicExpired(topic)}>{topic.enabled ? <Pause size={13} /> : <Play size={13} />}{topic.enabled ? "暂停" : "启用"}</button><button type="button" className="insight-quiet" onClick={() => { setTopicEditor({ ...topic, sourceIds: [...topic.sourceIds] }); openFlow({ type: "topic", id: topic.id }); }}><PencilLine size={13} />编辑</button></div>
          <button type="button" className="insight-text-button" onClick={() => jumpTo(topic.relatedInsightId)}>回到关联发现 <ArrowUpRight size={12} /></button>
        </article>)}</div></>}
        {filter === "drafts" && <div className="insight-management-list">
          <section className="insight-draft-group"><header><div><h2>待采用草稿 <span>{pendingDrafts.length}</span></h2><p>两份起始示例可直接编辑，也可以从发现中准备自己的草稿。</p></div><span className="insight-draft-group-hint">核对清单 · 任务</span></header>
            {pendingDrafts.map(renderDraft)}{!pendingDrafts.length && <div className="insight-draft-empty"><FileText size={20}/><p>{search ? "没有匹配的待采用草稿。" : "当前没有待采用草稿，可以从一条发现继续整理。"}</p></div>}
          </section>
          <section className="insight-draft-group"><header><div><h2>已保存到 Hub <span>{adoptedDrafts.length + savedHubReceipts.length}</span></h2><p>包含这里采用的草稿，以及从发现和助手保存的笔记或任务。</p></div><CheckCheck size={17}/></header>
            {adoptedDrafts.map(renderDraft)}
            {savedHubReceipts.map(receipt => <button type="button" className="insight-saved-draft" key={receipt.id} onClick={() => onOpenSource(receipt.item.id)}><span className="insight-draft-icon">{receipt.item.kind === "task" ? <ListTodo size={16}/> : <FileText size={16}/>}</span><span><strong>{receipt.item.title}</strong><small>{receipt.item.kind === "task" ? "Hub 任务" : "Hub 笔记"} · {receipt.workTitle} · 来自修订 {receipt.targetRevision}</small><small>{new Date(receipt.createdAt).toLocaleString("zh-CN", {month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit", hour12:false})} 保存</small></span><ArrowUpRight size={14}/></button>)}
            {!adoptedDrafts.length && !savedHubReceipts.length && <div className="insight-draft-empty"><BookOpen size={20}/><p>{search ? "没有匹配的已保存内容。" : "确认保存后，笔记或任务会出现在这里。"}</p></div>}
          </section>
        </div>}
        {filter === "history" && <div className="insight-log-list">{eventsLog.filter(event => `${event.text} ${event.detail || ""}`.toLowerCase().includes(search)).map(event => <div className="insight-log-event" key={event.id}><History size={15} /><div><strong>{event.text}</strong><p>{event.detail}</p>{event.insightId && <button type="button" className="insight-text-button" onClick={() => jumpTo(event.insightId!)}>打开关联发现 <ArrowUpRight size={11} /></button>}</div><time>{event.date}</time></div>)}{!eventsLog.length && <div className="insight-empty"><History size={28} /><h2>从第一次操作开始</h2><p>处理发现、保存草稿、更新来源或调整关注范围后，记录会留在这里。</p></div>}</div>}
      </div>
    ) : (
      <div className={`insight-body ${mobileDetail && selected ? "insight-mobile-detail" : ""}`}>
        <div className="insight-list-pane">
          <div className="insight-list-heading"><div className="insight-eyebrow">让记录，彼此照应</div><h1>{search ? "从已有记录中找线索" : filter === "later" ? "留给合适的时候" : filter === "done" ? "已经看过的发现" : "值得留意的联系"}</h1><p>工作、知识与生活 · 示例发现</p></div>
          <div className="insight-list-label"><span>{search ? "搜索全部状态与时间" : filter === "later" ? "稍后" : filter === "done" ? "已处理与已忽略" : filter in categoryNames ? categoryNames[filter as Category] : "待关注"}</span><span>{filtered.length} 条发现</span></div>
          <div className="insight-discoveries" role="list" aria-label="发现列表">
            {filtered.map(item => {
              const Icon = categoryIcons[item.category]; const local = states[item.id] || {}; const topic = Object.values(topics).find(candidate => candidate.workId === item.workId);
              return <div role="listitem" key={item.id}><button type="button" className={`insight-discovery ${selected?.id === item.id ? "is-selected" : ""}`} onClick={() => { setSelectedId(item.id); setMobileDetail(true); }} aria-pressed={selected?.id === item.id}>
                <span className="insight-discovery-type"><span><Icon size={13} />{item.kind}</span>{isStale(item) ? <span className="insight-review-required">待复核</span> : local.status === "dismissed" ? <span>已忽略</span> : local.status === "done" ? <CheckCheck size={14} /> : local.status === "later" ? <Clock3 size={14} /> : <span className="insight-unread-dot" />}</span>
                <strong>{item.title}</strong><span className="insight-discovery-summary">{item.summary}</span><span className="insight-discovery-meta"><span><Link2 size={11} />{item.evidence.length} 条依据{topic?.enabled && topic.remaining > 0 && !topicExpired(topic) && inScope(item, topic.sourceIds) ? " · 关注中" : !topic && local.following ? " · 提醒偏好" : ""}</span><span>{local.status === "later" && local.snooze ? local.snooze : item.displayDate.split(" · ")[0]}</span></span>
              </button></div>;
            })}
            {!filtered.length && <div className="insight-empty"><span className="insight-empty-icon"><Sparkles size={25} /></span><h2>{!scope.length ? "先选择一组资料" : search ? "没有匹配的发现" : filter === "later" ? "暂时没有稍后的发现" : filter === "done" ? "还没有处理过的发现" : "这一页已经看完了"}</h2><p>{!scope.length ? "选定资料范围后，查看这些记录之间的联系。" : search ? "试试搜索“图纸”“任务”或“决定”，也可以查看下面的原文和草稿。" : "可以调整时间、资料范围，或从其他观察视角继续。"}</p>{scope.length < SCOPE_OPTIONS.length && <button type="button" className="insight-secondary" onClick={openScope}>调整资料范围</button>}</div>}
            {search && !!(matchingSources.length || matchingDrafts.length) && <section className="insight-search-assets"><h3>原文与草稿</h3>{matchingSources.map(item => <button type="button" key={item.id} onClick={() => onOpenSource(item.id)}><FileText size={13} /><span>{item.title}<small>原文资料</small></span><ArrowUpRight size={12} /></button>)}{matchingDrafts.slice(0, 5).map(draft => <button type="button" key={draft.id} onClick={() => showSavedDraft(draft)}><PencilLine size={13} /><span>{draft.title}<small>工作草稿</small></span><ChevronRight size={12} /></button>)}</section>}
          </div>
          {undo && <div className="insight-undo" role="status"><span><Check size={13} />{undo.label}</span><button type="button" onClick={undoStatus}><RotateCcw size={12} />撤销</button></div>}
          <div className="insight-list-footer"><Sparkles size={13} /><span>{scope.length < SCOPE_OPTIONS.length ? `基于 ${scope.length} 组来源 · 跨来源发现需完整依据` : "有依据的发现，适度地出现"}</span></div>
        </div>
        <div className="insight-detail-pane" ref={detailRef}>
          {selected ? <>
            <div className="insight-detail-toolbar"><button type="button" className="insight-mobile-back insight-icon-button" aria-label="返回发现列表" onClick={() => setMobileDetail(false)}><ArrowLeft size={16} /></button><span><span className={`insight-kind-dot insight-kind-${selected.category}`} />{selected.kind}<ChevronRight size={11} /><span>发现详情</span></span><div><button type="button" className={`insight-follow ${selectedTopic?.enabled ? "is-following" : ""}`} onClick={() => openTopic(selected)}><Flag size={13} /><span>{selectedTopic?.enabled && selectedTopic.remaining > 0 && !topicExpired(selectedTopic) && topicCoversSelection ? `已关注 · ${selectedTopic.remaining} 轮` : !selectedTopic && selectedState.following ? "已保存提醒偏好" : "关注这项工作"}</span></button><button type="button" className="insight-icon-button" title="补充或纠正这条发现" aria-label="补充或纠正这条发现" onClick={beginCorrection}><PencilLine size={15} /></button></div></div>
            <article className="insight-detail-article" key={selected.id}>
              <div className="insight-detail-kicker"><span>{selected.displayDate}</span><span>{selectedStale ? "待复核" : "基于示例记录"}</span></div><h1>{selected.title}</h1><p className="insight-detail-summary">{selected.summary}</p>
              <div className="insight-work-context"><Layers3 size={14} /><div><span>关联工作</span><strong>{selected.workTitle}</strong></div><button type="button" className="insight-text-button" onClick={() => onAssistant(assistantContext(selected))}>继续讨论 <ArrowUpRight size={12} /></button></div>
              {selectedStale && <div className="insight-correction-banner"><RefreshCw size={16} /><div><strong>依据或补充条件有变化，这条发现需要复核</strong><p>{selectedState.correction?.text || "请对照当前来源版本，再确认原判断的适用范围。"}</p><span>演示核对会保留原判断、反馈和待确认条件。</span><button type="button" className="insight-text-button" onClick={() => recheck(selected)}>演示重新核对 <RefreshCw size={12} /></button></div></div>}
              {!selectedStale && selectedState.correction && <div className="insight-retained-correction"><PencilLine size={14} /><span>已保留你的补充：{selectedState.correction.text}</span></div>}
              <section className="insight-detail-section"><h2>为什么现在与你有关</h2><p>{selected.why}</p></section>
              <div className="insight-finding"><Lightbulb size={17} /><div><h2>值得留意的是</h2><p>{selected.finding}</p></div></div>
              {!!SOURCE_COMPARISONS[selected.id]?.length && <section className="insight-detail-section"><h2>先把两份记录放在一起</h2>{SOURCE_COMPARISONS[selected.id].map((comparison, index) => <div className="insight-source-compare" key={index}>{[comparison.before, comparison.after].map(side => <button type="button" key={side.evidenceId} onClick={() => onOpenSource(side.evidenceId)}><span>{side.label}</span><p>{side.text}</p><small>打开对应原文 <ArrowUpRight size={11} /></small></button>)}</div>)}</section>}
              <section className="insight-detail-section"><div className="insight-section-title"><h2>把依据放在一起</h2><span>{selected.evidence.length} 条示例记录</span></div><div className="insight-evidence-list">{selected.evidence.map((evidence, index) => <div className="insight-evidence-wrap" key={evidence.id}><button type="button" className="insight-evidence" onClick={() => onOpenSource(evidence.id)}><span className="insight-evidence-number">{String(index + 1).padStart(2, "0")}</span><span className="insight-evidence-content"><span className="insight-evidence-source"><span>{evidence.source}</span><span>{evidence.date}</span></span><strong>{evidence.title}</strong><span className="insight-evidence-quote">{evidence.quote}</span></span><ArrowUpRight size={14} className="insight-source-arrow" /></button><button type="button" className="insight-version-button" onClick={() => openFlow({ type: "version", id: evidence.id })}>示例 v{sourceVersions[evidence.id] || 1}<span>版本与摘录</span><ChevronRight size={11} /></button></div>)}</div><p className="insight-source-footnote">点击资料可阅读完整原文，核对上下文与适用范围。</p></section>
              <section className="insight-detail-section insight-conditions"><h2>还需要确认</h2><p>{selected.condition}</p><button type="button" className="insight-text-button" onClick={beginCorrection}><PencilLine size={13} />补充背景或纠正关联</button></section>
              <section className="insight-next-step"><div><span className="insight-eyebrow">你可以选择</span><h2>{selected.action}</h2><p>{selected.id === "prototype-progress" ? "把这段进展放回本周的经历中。" : selected.actionSource ? "回到原记录，核对后再决定怎么处理。" : "带上依据与待确认条件，准备下一步。"}</p></div><button type="button" className="insight-primary" onClick={primaryAction}>{selected.actionSource ? "打开原记录" : selected.id === "prototype-progress" ? "查看回顾" : MIGRATED_DISCOVERIES.some(item => item.id === selected.id) ? "准备草稿" : "在助手中继续"}<ArrowRight size={14} /></button></section>
              <div className="insight-draft-shortcuts"><button type="button" className="insight-quiet" onClick={() => openDraft(selected, "checklist")}><FileText size={13} />核对清单</button><button type="button" className="insight-quiet" onClick={() => openDraft(selected, "task")}><ListTodo size={13} />任务草稿</button><button type="button" className="insight-quiet" onClick={() => openDraft(selected, "archive")}><Archive size={13} />笔记草稿</button></div>
              {!!drafts.filter(draft => draft.insightId === selected.id).length && <section className="insight-linked-drafts"><h2>关联草稿与成果</h2>{drafts.filter(draft => draft.insightId === selected.id).map(renderDraft)}</section>}
              <div className="insight-processing"><div className="insight-processing-actions">{selectedStatus === "active" ? <><button type="button" className="insight-secondary" onClick={() => changeStatus(selected.id, "done")}><Check size={14} />已了解</button><button type="button" className="insight-quiet" onClick={() => openFlow({ type: "snooze", id: selected.id })}><Clock3 size={14} />稍后再看</button><button type="button" className="insight-quiet" onClick={() => changeStatus(selected.id, "dismissed")}><X size={13} />忽略</button></> : <><span className="insight-current-status">{selectedStatus === "later" ? <Clock3 size={14} /> : <CheckCheck size={14} />}{selectedStatus === "later" ? selectedState.snooze || "留待稍后" : selectedStatus === "dismissed" ? "已忽略" : "已处理"}</span><button type="button" className="insight-quiet" onClick={() => changeStatus(selected.id, "active")}><RotateCcw size={14} />移回待关注</button></>}<button type="button" className="insight-quiet insight-discuss" onClick={() => onAssistant(assistantContext(selected))}><MessageSquare size={14} />继续讨论</button></div><p>处理发现只保存本条记录的状态。原资料与任务由你在工作台中操作。</p></div>
              <details className="insight-history"><summary>处理记录 <span>{selectedHistory.length}</span><ChevronDown size={13} /></summary><ol>{selectedHistory.map(event => <li key={event.id}><span>{event.text}{event.detail && <small>{event.detail}</small>}</span><time>{event.date}</time></li>)}</ol></details>
            </article>
          </> : <div className="insight-detail-empty"><span className="insight-empty-icon"><Link2 size={28} /></span><h2>让发现有来处</h2><p>选择一条发现，查看依据、关联和可选择的下一步。</p></div>}
        </div>
      </div>
    )}

    {flow && <WorkflowModal key={flow.type + (flow.id || "")} title={flow.type === "scope" ? "选择洞察的资料范围" : flow.type === "correct" ? "补充背景或纠正关联" : flow.type === "snooze" ? "留到合适的时候" : flow.type === "version" ? "来源版本与摘录" : flow.type === "draft" ? "编辑工作草稿" : "设置关注主题"} onClose={() => setFlow(null)} wide={flow.type === "draft" || flow.type === "version"}>
      {flow.type === "scope" && <><p className="insight-flow-intro">洞察只展示依据完整落在所选范围内的发现。原文搜索和工作台内容仍可单独查看。</p><div className="insight-scope-choices">{SCOPE_OPTIONS.map(source => <label key={source.id}><input type="checkbox" checked={scopeDraft.includes(source.id)} onChange={event => setScopeDraft(current => event.target.checked ? [...current, source.id] : current.filter(id => id !== source.id))} /><span><strong>{"provider" in source ? `${source.provider} · ` : ""}{source.name}</strong><small>{source.description}</small></span></label>)}</div><div className="insight-scope-tools"><button type="button" className="insight-text-button" onClick={() => setScopeDraft(SCOPE_OPTIONS.map(source => source.id))}>全选</button><button type="button" className="insight-text-button" onClick={() => setScopeDraft([])}>清空</button></div><footer><span>已选择 {scopeDraft.length} 组资料</span><button type="button" className="insight-primary" onClick={() => { setScope(scopeDraft); setFlow(null); log("更新了洞察资料范围", scopeDraft.map(id => SCOPE_OPTIONS.find(source => source.id === id)?.name).join("、") || "未选择来源"); notify("洞察资料范围已更新"); }}>应用范围</button></footer></>}
      {flow.type === "correct" && <form onSubmit={event => { event.preventDefault(); if (!correctionText.trim()) { setFormError("请写下需要补充或纠正的内容。"); return; } patchState(flow.id!, { needsReview: true, correction: { kind: correctionKind, text: correctionText.trim(), date: stamp() } }, `补充了“${correctionKind}”反馈，结论待复核`); setFlow(null); notify("反馈已保留，后续草稿和讨论会带入这项条件"); }}><p className="insight-flow-intro">补充会和发现一起保留，并在准备草稿和继续讨论时带入上下文。</p><label>想补充什么<select value={correctionKind} onChange={event => setCorrectionKind(event.target.value)}><option>关联不对</option><option>事实有误</option><option>补充背景</option></select></label><label>具体说明<textarea autoFocus value={correctionText} onChange={event => { setCorrectionText(event.target.value); setFormError(""); }} rows={5} maxLength={1500} placeholder="例如：两份记录使用了不同的支架版本，需要先核对。" /></label>{formError && <p className="insight-field-error" role="alert">{formError}</p>}<footer><span>保存在当前浏览器</span><button type="submit" className="insight-primary"><Check size={14} />保存反馈</button></footer></form>}
      {flow.type === "snooze" && <><p className="insight-flow-intro">留在“稍后”列表，合适的时候再回来看看。这里保存查看意向，不创建系统通知。</p><div className="insight-snooze-options">{["今天晚些时候", "明天再看", "下周再看"].map(label => <button type="button" key={label} onClick={() => changeStatus(flow.id!, "later", label)}><Clock3 size={16} /><span>{label}</span><ChevronRight size={14} /></button>)}</div></>}
      {flow.type === "version" && currentEvidence && <><div className="insight-source-version-meta"><span>{currentEvidence.source}</span><b>示例 v{sourceVersions[currentEvidence.id] || 1}</b></div><h3 className="insight-version-title">{currentEvidence.title}</h3><blockquote>{currentEvidence.quote}</blockquote><p className="insight-flow-intro">{(sourceVersions[currentEvidence.id] || 1) > 1 ? SOURCE_VERSION_EXCERPTS[currentEvidence.id]?.simulationNote || SOURCE_SIMULATION_NOTE : "可模拟一次版本变化，观察关联发现如何进入待复核。这里只更新演示版本标记，原文与引用摘录保持原样。"}</p><div className="insight-version-dependencies"><strong>依赖这份资料的发现</strong>{discoveries.filter(item => item.evidence.some(evidence => evidence.id === currentEvidence.id)).map(item => <button type="button" key={item.id} onClick={() => jumpTo(item.id)}><span>{item.title}</span>{isStale(item) && <small>待复核</small>}<ChevronRight size={12} /></button>)}</div><footer><button type="button" className="insight-secondary" onClick={() => { setFlow(null); onOpenSource(currentEvidence.id); }}><BookOpen size={14} />阅读完整原文</button><button type="button" className="insight-primary" onClick={() => simulateVersion(currentEvidence)}><RefreshCw size={14} />模拟来源更新</button></footer></>}
      {flow.type === "draft" && draftEditor && <form onSubmit={event => { event.preventDefault(); saveDraft(); }}><p className="insight-flow-intro">草稿保留来源与待确认条件。保存到工作台后，会成为当前浏览器中的示例笔记或任务。</p><label>标题<input autoFocus value={draftEditor.title} onChange={event => editDraftField({ title: event.target.value })} maxLength={180} /></label><div className="insight-form-columns"><label>草稿类型<select value={draftEditor.kind} onChange={event => { const kind = event.target.value as InsightDraft["kind"]; editDraftField({ kind, target: kind === "task" ? "Hub · 任务清单" : "Hub · 我的笔记" }); }}><option value="checklist">核对清单</option><option value="task">任务</option><option value="archive">阅读归档</option><option value="note">笔记</option></select></label><label>后续位置备注<input value={draftEditor.target} onChange={event => editDraftField({ target: event.target.value })} maxLength={120} /></label></div><label>内容<textarea value={draftEditor.body} onChange={event => editDraftField({ body: event.target.value })} rows={13} maxLength={18000} /></label>{formError && <p className="insight-field-error" role="alert">{formError}</p>}<footer><span>{draftEditor.createdItemId ? "已有对应工作台记录" : "你确认后再采用"}</span><div><button type="submit" className="insight-secondary"><Save size={14} />保留草稿</button>{draftEditor.createdItemId ? <button type="button" className="insight-primary" onClick={() => { setFlow(null); onOpenSource(draftEditor.createdItemId!); }}>打开已保存记录 <ArrowUpRight size={14} /></button> : <button type="button" className="insight-primary" onClick={() => saveDraft(true)}><Check size={14} />保存到工作台</button>}</div></footer></form>}
      {flow.type === "topic" && topicEditor && <form onSubmit={event => { event.preventDefault(); if (!topicEditor.question.trim() || !topicEditor.trigger.trim() || !topicEditor.sourceIds.length) { setFormError("请填写关注问题、提醒条件，并至少选择一个来源。"); return; } const next = { ...topicEditor, enabled: topicEditor.enabled && topicEditor.remaining > 0 && !topicExpired(topicEditor), question: topicEditor.question.trim(), trigger: topicEditor.trigger.trim() }; setTopics(current => ({ ...current, [next.id]: next })); patchState(next.relatedInsightId, { following: next.enabled }, "保存了关注问题、来源范围与触发条件"); setFlow(null); notify("关注主题已保存，可在“关注主题”中演示复查"); }}><p className="insight-flow-intro">一轮关注持续 7 天，最多 3 次复查。通过按钮体验变化后的提醒，原型不会启动后台任务。</p><label>关注的问题<textarea autoFocus value={topicEditor.question} onChange={event => setTopicEditor({ ...topicEditor, question: event.target.value })} rows={2} maxLength={400} /></label><label>什么变化值得提醒<textarea value={topicEditor.trigger} onChange={event => setTopicEditor({ ...topicEditor, trigger: event.target.value })} rows={3} maxLength={600} /></label><fieldset><legend>资料范围</legend>{SCOPE_OPTIONS.map(source => <label className="insight-checkbox-label" key={source.id}><input type="checkbox" checked={topicEditor.sourceIds.includes(source.id)} onChange={event => setTopicEditor({ ...topicEditor, sourceIds: event.target.checked ? [...topicEditor.sourceIds, source.id] : topicEditor.sourceIds.filter(id => id !== source.id) })} /><span>{source.name}</span></label>)}</fieldset><div className="insight-topic-editor-status"><label className="insight-checkbox-label"><input type="checkbox" checked={topicEditor.enabled} disabled={!topicEditor.remaining || topicExpired(topicEditor)} onChange={event => setTopicEditor({ ...topicEditor, enabled: event.target.checked })} /><span>启用本轮关注</span></label><span>剩余 {topicEditor.remaining} 轮</span>{(!topicEditor.remaining || topicExpired(topicEditor)) && <button type="button" className="insight-text-button" onClick={() => setTopicEditor({ ...topicEditor, enabled: true, remaining: 3, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() })}>重新开始 7 天 / 3 轮</button>}</div>{formError && <p className="insight-field-error" role="alert">{formError}</p>}<footer><span>可随时暂停</span><button type="submit" className="insight-primary"><Check size={14} />保存主题</button></footer></form>}
    </WorkflowModal>}
  </section>;
}
