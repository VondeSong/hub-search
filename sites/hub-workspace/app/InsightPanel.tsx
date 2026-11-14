"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, CheckCheck, CheckCircle2,
  ChevronDown, ChevronRight, Clock3, FileCheck2, FileText, History, Info, Layers3,
  Link2, LockKeyhole, MessageSquare, MoreHorizontal, PencilLine, Plus, RefreshCw,
  RotateCcw, ShieldCheck, SlidersHorizontal, Sparkles, Star, X, AlertCircle, Circle,
  BellOff, GitBranch, LayoutGrid, PanelLeft, PanelRight, CalendarDays, FlaskConical,
  Globe2, ListChecks, Maximize2, Minimize2, ChevronLeft, BookmarkCheck,
} from "lucide-react";
import type { AssistantContext } from "./Assistant";
import type { InsightsProps } from "./Insights";
import {InsightRecall} from "./InsightRecall";
import {InsightNotebookDemo} from "./InsightNotebookDemo";
import {
  getLedger, subscribeLedger, executeLedger, ensureLedgerSeed, ensureInteractionDemo, ensurePublicCaseDemo, ledgerId,
  candidateAvailability, getVisibleFinding, getInsightValidity,
  type LedgerState, type LedgerInsight, type LedgerEvent, type LedgerCommand,
} from "./insight-ledger";
import {
  REPORT_FIXTURES, SOURCE_FIXTURES, SEED_SELECTIONS,
  SAMPLE_U1,
  type ReportFixture, type ReportFinding, type ReportEvidence,
} from "./insight-reports";

export type InsightScope = "all" | "review" | "starred" | "knowledge" | "life" | "decision" | "cases";
type Props = InsightsProps & {
  onExplore: () => void;
  scope?: InsightScope;
  onScopeChange?: (scope: string) => void;
  navigationOpen?: boolean;
  onOpenNavigation?: () => void;
  onQueryChange?: (value: string) => void;
};
type Modal =
  | { type: "recall" }
  | { type: "decisions" }
  | { type: "reports"; targetId?: string; baseRevision?: number }
  | { type: "feedback"; insightId: string; baseRevision: number }
  | { type: "snooze"; insightId: string; baseRevision: number }
  | { type: "practice"; insightId: string; baseRevision: number }
  | { type: "sources" }
  | { type: "about" }
  | null;
const VIEW_KEY = "hub-insights-r2-view";
const statusNames = { active: "待关注", later: "稍后", done: "已处理" };
const validityNames = { available: "可用", review: "待复核", unavailable: "不可用" };
const categoryNames = { knowledge: "知识与应用", life: "生活与进展", decision: "决定与条件" };
const scopeNames: Record<InsightScope, string> = { all: "全部发现", review: "待复核", starred: "星标发现", knowledge: "知识与工作", life: "生活与进展", decision: "决定与变化", cases: "真实案例" };
const feedbackNames = { fact: "事实有误", association: "关联不对", context: "补充背景" };
const eventNames: Record<string, string> = {
  import: "保存发现", update: "更新内容", status: "处理状态", feedback: "用户反馈",
  mute: "出现偏好", star: "关注标记", source: "来源变化", check: "来源核对",
  undo: "撤销处理", "update-outcome": "更新未完成", "snooze-expired": "稍后到期",
};
function dateText(value?: string, withTime = false) {
  if (!value || Number.isNaN(Date.parse(value))) return "时间未知";
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", ...(withTime && value.length > 10 ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  });
}
function localInputDate(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function headOf(insight: LedgerInsight) { return insight.revisions[insight.revisions.length - 1]; }
function shownTitle(state: LedgerState, insight: LedgerInsight) {
  return getVisibleFinding(state, insight)?.title || "来源暂不可用的发现";
}
function StatusPill({ status }: { status: LedgerInsight["status"] }) {
  const Icon = status === "done" ? CheckCheck : status === "later" ? Clock3 : Circle;
  return <span className={"ip-pill ip-status-" + status}><Icon size={12}/>{statusNames[status]}</span>;
}
function ValidityPill({ value }: { value: LedgerInsight["validity"] }) {
  const Icon = value === "available" ? ShieldCheck : value === "review" ? RefreshCw : LockKeyhole;
  return <span className={"ip-pill ip-validity-" + value}><Icon size={12}/>{validityNames[value]}</span>;
}
function Dialog({ title, subtitle, children, onClose, wide = false }: {
  title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    const field = dialog?.querySelector<HTMLElement>("[data-autofocus]");
    field?.focus();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog className={"ip-dialog" + (wide ? " ip-dialog-wide" : "")} ref={ref}
    onCancel={e => { e.preventDefault(); closeRef.current(); }}
    onClick={e => { if (e.target === e.currentTarget) closeRef.current(); }}>
    <header className="ip-dialog-header"><div><span className="ip-overline">HUB · 洞察</span><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      <button className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={18}/></button>
    </header>{children}
  </dialog>;
}

function contextFor(state: LedgerState, insight: LedgerInsight): AssistantContext | null {
  const finding = getVisibleFinding(state, insight);
  if (!finding) return null;
  const revision = headOf(insight);
  const feedback = insight.feedback.filter(item => !!getVisibleFinding(state, insight, item.targetRevision)).map(item =>
    feedbackNames[item.kind] + "（针对第 " + item.targetRevision + " 次修订）：" + item.text
  ).join("\n");
  return {
    id: insight.id, title: finding.title, workId: insight.ownerWorkId, workTitle: insight.workTitle, revision: insight.headRevision,
    excerpt: [
      finding.caseStudy ? "这是一条基于官方公开文档整理的案例。资料事实可核对，应用场景与行动建议属于推演，不是用户实际经历。" : "这是一条来自已发布示例成果的发现。继续当前事项，不新建独立工作。",
      "当前内容：第 " + insight.headRevision + " 次修订；处理状态：" + statusNames[insight.status] +
      "；结论有效性：" + validityNames[getInsightValidity(state, insight)] + "。",
      finding.summary, "为什么相关：" + finding.why, "待确认：" + finding.condition,
      finding.caseStudy ? "应用场景：" + finding.caseStudy.scenario + "\n可以尝试：\n" + finding.caseStudy.actionSteps.map((step, index) => `${index + 1}. ${step}`).join("\n") : "",
      "成果：" + revision.reportTitle + "。资料截至 " + dateText(revision.coverageAsOf, true) + "。",
      feedback ? "用户已保存的反馈：\n" + feedback : "",
      "请核对依据并在原工作形成成果。助手回复不会自动更新这条发现；须由用户选择新成果，显式发布修订。",
    ].filter(Boolean).join("\n\n"),
    evidence: finding.evidence.map(e => ({
      id: e.sourceItemId || e.sourceId, title: e.title, source: e.provider,
      excerpt: e.quote + "（引用版本 v" + e.version + "；" + e.location + "）",
    })),
  };
}

export default function InsightPanel(props: Props) {
  const { filter, onFilterChange, query, notify, onOverlayOpen, onAssistant, onOpenSource, onExplore, onCreateDraft,
    scope = "all", onScopeChange, navigationOpen = true, onOpenNavigation, onQueryChange } = props;
  const [state, setState] = useState<LedgerState>(() => getLedger());
  const [selectedId, setSelectedId] = useState("");
  const [period, setPeriod] = useState("all");
  const [workFilter, setWorkFilter] = useState("all");
  const [validityFilter, setValidityFilter] = useState("all");
  const [mobileDetail, setMobileDetail] = useState(false);
  const [viewMode, setViewMode] = useState<"cards" | "split">("cards");
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [shownCount, setShownCount] = useState(7);
  const [historyRevision, setHistoryRevision] = useState<number | null>(null);
  const [undoEvent, setUndoEvent] = useState<{ eventId: string; insightId: string } | null>(null);
  const [feedbackKind, setFeedbackKind] = useState<"fact" | "association" | "context">("fact");
  const [feedbackText, setFeedbackText] = useState("");
  const [continueAfterFeedback, setContinueAfterFeedback] = useState(true);
  const [snoozeDate, setSnoozeDate] = useState("");
  const [reportId, setReportId] = useState(REPORT_FIXTURES[0]?.id || "");
  const [reportGroup, setReportGroup] = useState("normal");
  const [reportWork, setReportWork] = useState("all");
  const [reportQuery, setReportQuery] = useState("");
  const [chosenPointers, setChosenPointers] = useState<string[]>([]);
  const [dependenciesConfirmed, setDependenciesConfirmed] = useState(false);
  const [acknowledgedFeedback, setAcknowledgedFeedback] = useState<string[]>([]);
  const [originalReport, setOriginalReport] = useState(false);
  const [operationId, setOperationId] = useState(() => ledgerId());
  const [conflict, setConflict] = useState(false);
  const [focusedReading, setFocusedReading] = useState(false);
  const [practiceTitle, setPracticeTitle] = useState("");
  const [practiceBody, setPracticeBody] = useState("");
  const workspaceRef = useRef<HTMLElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const returnCard = useRef<{ id: string; scroll: number } | null>(null);
  const focusDetail = useRef(false);
  const restoreCards = useRef(false);
  const previousFilters = useRef<string | null>(null);
  const revealAfterNavigation = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribeLedger(() => setState(getLedger()));
    let live = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) || "{}");
      if (typeof saved.selectedId === "string") setSelectedId(saved.selectedId);
      if (["all", "week", "month"].includes(saved.period)) setPeriod(saved.period);
      if (typeof saved.workFilter === "string") setWorkFilter(saved.workFilter);
      if (["all", "available", "review", "unavailable"].includes(saved.validityFilter)) setValidityFilter(saved.validityFilter);
      if (["cards", "split"].includes(saved.viewMode)) setViewMode(saved.viewMode);
      if (typeof saved.mobileDetail === "boolean") setMobileDetail(saved.mobileDetail);
    } catch { /* View preferences do not affect saved discoveries. */ }
    ensureLedgerSeed(REPORT_FIXTURES, SEED_SELECTIONS, SOURCE_FIXTURES).then(async result => {
      if (result && !result.ok) return result;
      return await ensureInteractionDemo();
    }).then(async result => {
      if (result && !result.ok) return result;
      return await ensurePublicCaseDemo();
    }).then(result => {
      if (live) { setState(getLedger()); setInitializing(false); if (result && !result.ok) setNotice(result.message); }
    }).catch(() => { if (live) { setInitializing(false); setNotice("暂时无法读取本地发现，请保留当前页面并重试。"); } });
    return () => { live = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (initializing) return;
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ selectedId, period, workFilter, validityFilter, viewMode, mobileDetail })); } catch { /* Optional preference. */ }
  }, [selectedId, period, workFilter, validityFilter, viewMode, mobileDetail, initializing]);
  useEffect(() => {
    const signature = JSON.stringify([filter, query, period, workFilter, validityFilter, scope]);
    if (!initializing && previousFilters.current !== signature) {
      setShownCount(7);
      setFocusedReading(false);
      if (!revealAfterNavigation.current) setMobileDetail(false);
    }
    previousFilters.current = signature;
    if (!initializing) revealAfterNavigation.current = false;
  }, [filter, query, period, workFilter, validityFilter, scope, initializing]);
  useEffect(() => { setHistoryRevision(null); }, [selectedId]);
  useEffect(() => {
    if (viewMode === "split" && focusDetail.current) {
      const reader = detailTitleRef.current?.closest<HTMLElement>(".ip-detail-scroll");
      if (reader) reader.scrollTop = 0;
      detailTitleRef.current?.focus({ preventScroll: true });
      focusDetail.current = false;
    }
  }, [selectedId, viewMode]);
  useEffect(() => {
    if (viewMode === "cards" && restoreCards.current) {
      if (cardsRef.current) cardsRef.current.scrollTop = returnCard.current?.scroll || 0;
      document.getElementById("ip-card-open-" + (returnCard.current?.id || selectedId))?.focus({ preventScroll: true });
      restoreCards.current = false;
    }
  }, [viewMode, selectedId]);
  useEffect(() => {
    function closeMenus(event: MouseEvent) {
      workspaceRef.current?.querySelectorAll<HTMLDetailsElement>("details.ip-menu[open]").forEach(menu => {
        if (!menu.contains(event.target as Node)) menu.open = false;
      });
    }
    document.addEventListener("click", closeMenus);
    return () => document.removeEventListener("click", closeMenus);
  }, []);
  useEffect(() => {
    if (filter !== "reports") return;
    openReports();
    onFilterChange("all");
    // A sidebar intent is consumed once; report selection stays local to its dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const workOptions = useMemo(() => Array.from(new Map(state.insights.map(x => [x.ownerWorkId, x.workTitle])).entries()), [state.insights]);
  const scopedInsights = useMemo(() => {
    const now = Date.now();
    return state.insights.filter(insight => {
      const finding = getVisibleFinding(state, insight);
      const validity = getInsightValidity(state, insight);
      if ((scope === "review" || filter === "review-needed") && validity !== "review") return false;
      if (scope === "starred" && !insight.starred) return false;
      if (scope === "cases" && !finding?.caseStudy) return false;
      if (["knowledge", "life", "decision"].includes(scope) && finding?.category !== scope) return false;
      if (workFilter !== "all" && insight.ownerWorkId !== workFilter) return false;
      if (validityFilter !== "all" && validity !== validityFilter) return false;
      if (period !== "all" && now - Date.parse(headOf(insight).generatedAt) > (period === "week" ? 7 : 30) * 86400000) return false;
      if (query.trim()) {
        const haystack = finding ? [finding.title, finding.summary, finding.why, insight.workTitle, ...finding.evidence.map(e => e.quote + e.title)].join(" ") : "来源暂不可用的发现";
        if (!haystack.toLowerCase().includes(query.trim().toLowerCase())) return false;
      }
      return true;
    }).sort((a, b) =>
      Number(b.starred) - Number(a.starred) ||
      Number(getInsightValidity(state, b) === "review" && !b.muted) - Number(getInsightValidity(state, a) === "review" && !a.muted) ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    );
  }, [state, filter, workFilter, validityFilter, period, query, scope]);
  const statusCounts = {
    all: scopedInsights.filter(x => x.status === "active").length,
    later: scopedInsights.filter(x => x.status === "later").length,
    done: scopedInsights.filter(x => x.status === "done").length,
    everything: scopedInsights.length,
  };
  const activeTab = ["later", "done", "everything"].includes(filter) ? filter : "all";
  const allVisible = useMemo(() => scopedInsights.filter(insight => {
    if (["everything", "history", "review-needed"].includes(filter)) return true;
    return insight.status === (filter === "later" ? "later" : filter === "done" ? "done" : "active");
  }), [scopedInsights, filter]);
  useEffect(() => {
    if (initializing) return;
    if (!allVisible.some(x => x.id === selectedId)) setSelectedId(allVisible[0]?.id || "");
  }, [allVisible, selectedId, initializing]);
  const selected = allVisible.find(x => x.id === selectedId);
  const finding = selected ? getVisibleFinding(state, selected) : null;
  const selectedValidity = selected ? getInsightValidity(state, selected) : "available";
  const currentRevision = selected ? headOf(selected) : undefined;
  const inspectedRevision = selected?.revisions.find(x => x.revision === historyRevision) || currentRevision;
  const inspectingOld = !!(selected && inspectedRevision && inspectedRevision.revision !== selected.headRevision);
  const inspectedFinding = selected && inspectedRevision ? getVisibleFinding(state, selected, inspectedRevision.revision) : null;
  const isHistory = filter === "history";
  const totalReview = state.insights.filter(x => getInsightValidity(state, x) === "review").length;
  const sourceCount = new Set(state.insights.flatMap(x => headOf(x).finding.evidence.map(e => e.sourceId))).size;
  const caseCount = state.insights.filter(x => !!getVisibleFinding(state, x)?.caseStudy).length;
  const activeFilterCount = Number(period !== "all") + Number(workFilter !== "all") + Number(validityFilter !== "all");
  const selectedIndex = selected ? allVisible.findIndex(x => x.id === selected.id) : -1;
  const targetInsight = modal?.type === "reports" && modal.targetId ? state.insights.find(x => x.id === modal.targetId) : undefined;
  const selectedReport = REPORT_FIXTURES.find(x => x.id === reportId) || REPORT_FIXTURES[0];
  const reportReadable = !selectedReport || selectedReport.findings.every(candidate => candidate.evidence.every(e => state.sources[e.sourceId]?.available));
  const availableReports = REPORT_FIXTURES.filter(report =>
    (!targetInsight || report.workId === targetInsight.ownerWorkId) &&
    (reportWork === "all" || report.workId === reportWork) &&
    (!reportQuery.trim() || report.workTitle.toLowerCase().includes(reportQuery.trim().toLowerCase())) &&
    (reportGroup === "all" || report.group === reportGroup)
  );
  const chosenFinding = selectedReport?.findings.find(x => chosenPointers.includes(x.pointer));
  const chosenReadable = !!chosenFinding && chosenFinding.evidence.every(e => state.sources[e.sourceId]?.available);
  const unresolvedFeedback = targetInsight?.feedback.filter(x => !x.resolvedInRevision && !!getVisibleFinding(state, targetInsight, x.targetRevision)) || [];
  useEffect(() => {
    const target = modal && "insightId" in modal ? modal.insightId : modal?.type === "reports" ? modal.targetId : undefined;
    if (!target) return;
    const insight = state.insights.find(x => x.id === target);
    if (insight && !getVisibleFinding(state, insight)) { setModal(null); setFeedbackText(""); setNotice("来源访问已变化，相关内容已隐藏。请先核对来源状态。"); }
  }, [state, modal]);

  function showModal(next: Modal) {
    workspaceRef.current?.querySelectorAll<HTMLDetailsElement>("details.ip-menu[open]").forEach(menu => { menu.open = false; });
    onOverlayOpen(); setNotice(""); setConflict(false); setOperationId(ledgerId()); setModal(next);
  }
  function openReports(target?: LedgerInsight) {
    const candidates = REPORT_FIXTURES.filter(x => target ? x.workId === target.ownerWorkId && x.group === "revision" : x.group === "normal");
    const report = candidates.find(x => x.findings.some(f => candidateAvailability(state, x, f).eligible)) || candidates[0] ||
      REPORT_FIXTURES.find(x => !target || x.workId === target.ownerWorkId);
    setReportId(report?.id || REPORT_FIXTURES[0]?.id);
    setReportGroup(target && candidates.length ? "revision" : "normal"); setReportWork("all");
    setChosenPointers([]); setDependenciesConfirmed(false); setAcknowledgedFeedback([]); setOriginalReport(false);
    showModal({ type: "reports", targetId: target?.id, baseRevision: target?.rowRevision });
  }
  function chooseReport(report: ReportFixture) {
    setReportId(report.id); setChosenPointers([]); setDependenciesConfirmed(false); setAcknowledgedFeedback([]); setOriginalReport(false); setNotice(""); setOperationId(ledgerId());
  }
  async function act(command: LedgerCommand, successMessage?: string) {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await executeLedger(command);
      setState(result.state);
      if (!result.ok) { setNotice(result.message); if (result.code === "conflict") setConflict(true); }
      else { setNotice(""); if (successMessage) notify(successMessage); }
      return result;
    } finally { setBusy(false); }
  }
  async function changeStatus(insight: LedgerInsight, status: LedgerInsight["status"], snoozeUntil?: string) {
    const result = await act({ type: "status", insightId: insight.id, expectedRowRevision: insight.rowRevision, status, snoozeUntil, operationId: ledgerId() });
    if (result?.ok) {
      if (result.eventId) setUndoEvent({ eventId: result.eventId, insightId: insight.id });
      notify(status === "done" ? "已处理这条发现；原任务状态保持原样" : status === "later" ? "已保存稍后时间" : "已返回待关注");
      setModal(null);
    }
  }
  function continueWork(insight: LedgerInsight, ledger = state) {
    const context = contextFor(ledger, insight);
    if (!context) { notify("来源不可用，当前发现暂不能继续讨论"); return; }
    onAssistant(context);
  }
  async function saveFeedback() {
    if (modal?.type !== "feedback" || !feedbackText.trim()) return;
    const result = await act({
      type: "feedback", insightId: modal.insightId, expectedRowRevision: modal.baseRevision,
      kind: feedbackKind, text: feedbackText.trim(), operationId,
    });
    if (result?.ok) {
      setModal(null);
      notify("反馈已保存，原结论已标为待复核");
      const updated = result.state.insights.find(x => x.id === modal.insightId);
      if (continueAfterFeedback && updated) continueWork(updated, result.state);
    }
  }
  async function saveCandidates() {
    if (!selectedReport || !chosenPointers.length || busy || !dependenciesConfirmed) return;
    if (targetInsight && modal?.type === "reports") {
      const result = await act({
        type: "update", insightId: targetInsight.id, expectedRowRevision: modal.baseRevision!,
        report: selectedReport, findingPointer: chosenPointers[0], acknowledgedFeedbackIds: acknowledgedFeedback,
        operationId,
      });
      if (result?.ok) {
        const updated = result.state.insights.find(x => x.id === targetInsight.id);
        revealAfterNavigation.current = true;
        setSelectedId(targetInsight.id); setValidityFilter("all"); setModal(null); onScopeChange?.("all"); onQueryChange?.(""); setViewMode("split"); setMobileDetail(true);
        if (updated) onFilterChange(updated.status === "done" ? "done" : updated.status === "later" ? "later" : "all");
        notify(result.duplicate ? "这份成果已保存，没有新增修订" : "新修订已保存，原处理状态与反馈已保留");
      }
      return;
    }
    setBusy(true);
    try {
      let savedId = ""; let count = 0; let duplicates = 0; let latest = state;
      for (const pointer of chosenPointers) {
        const result = await executeLedger({ type: "import", report: selectedReport, findingPointer: pointer, operationId: operationId + ":" + pointer });
        latest = result.state;
        if (!result.ok) { setNotice(result.message); setState(latest); return; }
        savedId = result.insightId || savedId; if (result.duplicate) duplicates++; else count++;
      }
      setState(latest); setModal(null); setSelectedId(savedId); setPeriod("all"); setWorkFilter("all"); setValidityFilter("all"); onScopeChange?.("all"); onQueryChange?.("");
      const saved = latest.insights.find(x => x.id === savedId);
      onFilterChange(saved?.status === "done" ? "done" : saved?.status === "later" ? "later" : "all");
      notify(count ? "已保存 " + count + " 条发现" + (duplicates ? "，已保存的候选没有重复添加" : "") : "这些发现已保存，身份与状态均已保留");
    } finally { setBusy(false); }
  }
  function openEvidence(evidence: ReportEvidence) {
    if (!state.sources[evidence.sourceId]?.available) { notify("这份来源目前不可用"); return; }
    if (evidence.sourceItemId) onOpenSource(evidence.sourceItemId);
    else notify("这项依据是当前工作中的用户补充，原话已展示在此处");
  }
  function openSavedInsight(id: string) {
    const insight = state.insights.find(x => x.id === id);
    if (!insight) return;
    revealAfterNavigation.current = true;
    onFilterChange(insight.status === "done" ? "done" : insight.status === "later" ? "later" : "all");
    onScopeChange?.("all"); onQueryChange?.("");
    setPeriod("all"); setWorkFilter("all"); setValidityFilter("all"); setSelectedId(id); setModal(null); setMobileDetail(true); setViewMode("split");
  }
  function openDetail(insight: LedgerInsight) {
    if (viewMode === "cards") returnCard.current = { id: insight.id, scroll: cardsRef.current?.scrollTop || 0 };
    const reader = detailTitleRef.current?.closest<HTMLElement>(".ip-detail-scroll");
    if (reader) reader.scrollTop = 0;
    focusDetail.current = true;
    setShownCount(count => Math.max(count, allVisible.findIndex(item => item.id === insight.id) + 1));
    setSelectedId(insight.id); setViewMode("split"); setMobileDetail(true);
  }
  function returnToCards() {
    restoreCards.current = true;
    setFocusedReading(false); setViewMode("cards"); setMobileDetail(false);
  }
  function openPublicCases() {
    clearFilters(); onScopeChange?.("cases"); onFilterChange("everything");
    setViewMode("cards"); setMobileDetail(false); setFocusedReading(false);
  }
  function openPractice(insight: LedgerInsight) {
    const item = getVisibleFinding(state, insight);
    if (!item?.caseStudy) return;
    setPracticeTitle(item.caseStudy.actionTitle + " · 实践清单");
    setPracticeBody([
      "## 应用场景", item.caseStudy.scenario,
      "## 从资料得到的发现", item.summary,
      "## 我的实践清单", ...item.caseStudy.actionSteps.map(step => "- [ ] " + step),
      "## 需要确认", item.condition,
      "## 官方依据", ...item.evidence.map(e => `${e.publisher || e.provider} · ${e.title}\n${e.externalUrl || "Hub 中的来源记录"}\n中文摘要：${e.quote}`),
      "这份清单基于公开资料整理，尚未执行；请根据自己的材料和使用环境调整。",
    ].join("\n\n"));
    showModal({ type: "practice", insightId: insight.id, baseRevision: insight.rowRevision });
  }
  async function savePractice() {
    if (modal?.type !== "practice" || busy || !practiceTitle.trim() || !practiceBody.trim()) return;
    const currentState = getLedger();
    const insight = currentState.insights.find(x => x.id === modal.insightId);
    const item = insight && getVisibleFinding(currentState, insight);
    if (!insight || !item || insight.rowRevision !== modal.baseRevision) {
      setNotice("发现或来源已经变化，请关闭清单，重新核对后再准备。"); return;
    }
    setBusy(true);
    try {
      const sourceIds = item.evidence.map(e => e.sourceId);
      const id = onCreateDraft("note", practiceTitle.trim(), practiceBody.trim(), { insightId: insight.id, workId: insight.ownerWorkId, sourceIds });
      if (!id) { setNotice("这次未能保存，清单仍保留在这里。请核对来源后重试。"); return; }
      const result = await executeLedger({ type: "receipt", insightId: insight.id, targetRevision: insight.headRevision, originSourceIds: sourceIds, kind: "note", createdItemId: id, title: practiceTitle.trim(), operationId });
      setState(result.state); setModal(null);
      notify(result.ok ? "实践清单已保存，可在工作草稿的「已保存到 Hub」中打开" : "清单已保存，处理记录暂未同步，请勿重复保存");
    } finally { setBusy(false); }
  }
  function openSnooze(insight: LedgerInsight) {
    setSnoozeDate(localInputDate(new Date(Date.now() + 86400000)));
    showModal({ type: "snooze", insightId: insight.id, baseRevision: insight.rowRevision });
  }
  function clearFilters() {
    setWorkFilter("all"); setValidityFilter("all"); setPeriod("all"); onScopeChange?.("all"); onQueryChange?.("");
  }
  function switchTab(next: string) {
    onFilterChange(next); setMobileDetail(false);
  }
  const eventsFor = (id: string) => state.events.filter(x => x.insightId === id);

  return <section ref={workspaceRef} className={"ip-workspace ip-view-" + viewMode + (mobileDetail ? " ip-mobile-detail" : "") + (focusedReading ? " ip-focused-reading" : "")} aria-label="洞察发现工作区" onKeyDown={event => {
    if (event.key !== "Escape") return;
    if (modal) { event.stopPropagation(); return; }
    const openMenu = (event.target as HTMLElement).closest<HTMLDetailsElement>("details.ip-menu[open]");
    if (openMenu) { openMenu.open = false; openMenu.querySelector("summary")?.focus(); event.preventDefault(); event.stopPropagation(); }
    else if (focusedReading) { setFocusedReading(false); event.preventDefault(); event.stopPropagation(); }
    else if (viewMode === "split") { returnToCards(); event.preventDefault(); event.stopPropagation(); }
  }}>
    <header className="ip-page-header">
      <div className="ip-page-title"><div className="ip-title-icon" aria-hidden="true"><Sparkles size={25}/></div><div><span className="ip-overline">让已有的积累，接着发挥作用</span><h1>{!navigationOpen && onOpenNavigation && <button className="ip-nav-toggle" aria-label="展开洞察侧边栏" onClick={onOpenNavigation}><PanelLeft size={21}/></button>}洞察</h1><p>看见资料里的变化与关联，找到可以继续的一步。</p></div></div>
      <div className="ip-header-actions">{scope==="decision"&&<button className="ip-button" onClick={()=>showModal({type:"decisions"})}><GitBranch size={16}/>记录与回顾决定</button>}<button className="ip-button ip-primary" onClick={() => openReports()}><Plus size={16}/>选择已有成果</button>
        <details className="ip-menu ip-page-menu"><summary aria-label="洞察更多操作" title="更多操作"><MoreHorizontal size={21}/></summary><div className="ip-menu-content">
          <button onClick={() => showModal({type:"recall"})}><BookOpen size={15}/>寻找旧知识</button>
          <button onClick={async event => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; const result = await act({ type: "check", operationId: ledgerId() }); if (result?.ok) notify(result.message || "已核对已选来源，没有启动模型分析"); }} disabled={busy || initializing}><RefreshCw size={15}/>核对已选来源</button>
          <button onClick={() => showModal({ type: "sources" })}><SlidersHorizontal size={15}/>来源与演示控制</button>
          <button onClick={() => showModal({ type: "about" })}><Info size={15}/>体验指南</button>
        </div></details>
      </div>
    </header>
    {!isHistory && <div className="ip-tab-bar"><div className="ip-status-tabs" role="tablist" aria-label="发现处理状态">
      {([{ id: "all", label: "待关注" }, { id: "later", label: "稍后" }, { id: "done", label: "已处理" }, { id: "everything", label: "全部" }] as const).map((tab, index, tabs) => <button key={tab.id} id={"ip-tab-" + tab.id} role="tab" aria-selected={activeTab === tab.id} aria-controls="ip-findings-content" tabIndex={activeTab === tab.id ? 0 : -1} className={activeTab === tab.id ? "selected" : ""} onClick={() => switchTab(tab.id)} onKeyDown={event => {
        const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : offset ? (index + offset + tabs.length) % tabs.length : -1;
        if (next >= 0) { event.preventDefault(); switchTab(tabs[next].id); document.getElementById("ip-tab-" + tabs[next].id)?.focus(); }
      }}>{tab.label}<span>{statusCounts[tab.id]}</span></button>)}
    </div><div className="ip-view-tools">
      <details className="ip-menu ip-filter-menu"><summary aria-label="筛选发现" className={activeFilterCount ? "is-filtered" : ""}><SlidersHorizontal size={15}/><span>筛选</span>{activeFilterCount > 0 && <b>{activeFilterCount}</b>}</summary>
        <div className="ip-filter-popover"><header><strong>筛选发现</strong><button onClick={clearFilters}>重置</button></header>
          <label>关联事项<select aria-label="关联事项筛选" value={workFilter} onChange={e => setWorkFilter(e.target.value)}><option value="all">全部事项 · {workOptions.length}</option>{workOptions.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
          <label>时间范围<select aria-label="发现时间范围" value={period} onChange={e => setPeriod(e.target.value)}><option value="all">全部时间</option><option value="week">最近 7 天</option><option value="month">最近 30 天</option></select></label>
          <label>结论有效性<select aria-label="结论有效性筛选" value={validityFilter} onChange={e => setValidityFilter(e.target.value)}><option value="all">全部结论</option><option value="available">可用</option><option value="review">待复核</option><option value="unavailable">不可用</option></select></label>
          <button className="ip-button ip-primary" onClick={event => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>完成</button>
        </div>
      </details><span className="ip-toolbar-divider"/><div className="ip-layout-switch" aria-label="发现布局"><button aria-label="卡片浏览" title="卡片浏览" aria-pressed={viewMode === "cards"} className={viewMode === "cards" ? "selected" : ""} onClick={returnToCards}><LayoutGrid size={16}/></button><button aria-label="列表与详情" title="列表与详情" aria-pressed={viewMode === "split"} className={viewMode === "split" ? "selected" : ""} onClick={() => { setViewMode("split"); setMobileDetail(false); }}><PanelRight size={16}/></button></div>
    </div></div>}
    {!!notice && !modal && <div className="ip-notice" role="status"><AlertCircle size={15}/><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}><X size={14}/></button></div>}
    {isHistory ? <div className="ip-history-page"><header><div><span className="ip-overline">留下事情的发展过程</span><h2>处理记录</h2><p>纠正、更新和处理分别保留；重新分析不会覆盖你的选择。</p></div><button className="ip-button" onClick={() => onFilterChange("all")}><ArrowLeft size={14}/>返回发现</button></header>
      <EventList events={state.events} state={state} onOpen={openSavedInsight} onOpenItem={onOpenSource}/>
    </div> : <div className="ip-panels" id="ip-findings-content" role="tabpanel" aria-labelledby={"ip-tab-" + activeTab}>
      <aside className="ip-discovery-list" aria-label="已保存发现">
        <div className="ip-list-heading"><div><h2>{scope !== "all" ? scopeNames[scope] : filter === "later" ? "留给稍后的发现" : filter === "done" ? "已经留下的收获" : filter === "everything" ? "全部已保存发现" : "值得留意"}<span>{allVisible.length}</span></h2>{scope !== "all" && <button className="ip-scope-reset" onClick={() => onScopeChange?.("all")} aria-label={"清除" + scopeNames[scope] + "筛选"}>查看全部<X size={12}/></button>}</div>
          <span className="ip-list-caption">{query || activeFilterCount > 0 ? <button className="ip-clear-filters" onClick={clearFilters}>清除筛选<X size={12}/></button> : viewMode === "cards" ? "每个发现，都能回到依据" : "选择一条，接着看"}</span></div>
        {(scope === "review" || filter === "review-needed") && <p className="ip-filter-explanation">已处理的发现也可能需要复核，你之前的选择会继续保留。</p>}
        <div className="ip-cards" ref={cardsRef}>
          {viewMode === "cards" && !query && scope === "all" && activeTab === "all" && caseCount > 0 && <button className="ip-case-intro" onClick={openPublicCases}><span className="ip-case-intro-icon"><Globe2 size={22}/></span><span><strong>从一个真实案例，理解洞察</strong><small>{caseCount} 个案例 · 官方资料、应用场景和可尝试的下一步</small></span><span className="ip-case-intro-link">浏览案例<ArrowUpRight size={16}/></span></button>}
          {viewMode === "cards" && scope === "cases" && <div className="ip-cases-note"><Globe2 size={19}/><div><strong>真实资料，具体的使用情境</strong><p>事实来自可核对的官方文档；应用场景和行动建议是推演，可以按你的情况调整。</p></div></div>}
          <div className="ip-card-grid">
          {initializing ? <div className="ip-empty"><RefreshCw size={25}/><h3>读取已保存的发现</h3><p>正在准备当前浏览器中的示例记录。</p></div> :
            allVisible.length ? allVisible.slice(0, shownCount).map(insight => {
              const item = getVisibleFinding(state, insight); const validity = getInsightValidity(state, insight);
              const CategoryIcon = item?.category === "life" ? CalendarDays : item?.category === "decision" ? GitBranch : BookOpen;
              return <article key={insight.id} data-category={item?.category} className={"ip-card" + (item?.caseStudy ? " ip-public-case" : "") + (selectedId === insight.id ? " selected" : "") + (insight.muted ? " muted" : "")}>
                <button id={"ip-card-open-" + insight.id} className="ip-card-main" aria-label={shownTitle(state, insight)} aria-pressed={viewMode === "split" && selectedId === insight.id} onClick={() => openDetail(insight)}>
                  <div className="ip-card-top"><span className={"ip-category ip-category-" + (item?.category || "unknown")}><CategoryIcon size={13}/>{item ? categoryNames[item.category] : "依据受限"}</span>{item?.caseStudy && <span className="ip-case-tag"><Globe2 size={11}/>真实资料</span>}{validity !== "available" && <ValidityPill value={validity}/>}<time className="ip-card-date">{dateText(insight.updatedAt)}</time></div>
                  <h3>{item?.title || "来源暂不可用的发现"}</h3><p>{item?.summary || "相关内容已隐藏。恢复来源后，需要重新核对授权与依据。"}</p>
                  {viewMode === "cards" && item && <div className="ip-card-why"><span>{item.caseStudy ? "可以用来" : "与你有关"}</span><p>{item.caseStudy?.learning || item.why}</p></div>}
                  <div className="ip-card-work">{item?.caseStudy ? <Globe2 size={13}/> : <Layers3 size={13}/>}<span>{item?.caseStudy ? Array.from(new Set(item.evidence.map(e => e.publisher || e.provider))).join(" · ") : insight.workTitle}</span></div>
                  <div className="ip-card-bottom"><span>{item ? item.evidence.length + " 处引用" : "内容已隐藏"}<i/>第 {insight.headRevision} 次修订</span><span>{dateText(insight.updatedAt)}</span></div>
                  {(insight.status !== "active" || insight.muted) && <div className="ip-card-state"><StatusPill status={insight.status}/>{insight.status === "later" && insight.snoozeUntil && <span className="ip-card-snooze-time">{dateText(insight.snoozeUntil, true)} 再看</span>}{insight.muted && <span className="ip-pill"><BellOff size={11}/>不再主动提醒</span>}</div>}
                </button>
                <button className={"ip-card-star" + (insight.starred ? " selected" : "")} aria-label={insight.starred ? "取消星标发现" : "星标发现"} onClick={() => act({ type: "star", insightId: insight.id, expectedRowRevision: insight.rowRevision, value: !insight.starred, operationId: ledgerId() })}><Star size={14} fill={insight.starred ? "currentColor" : "none"}/></button>
                {viewMode === "cards" && <footer className="ip-card-actions"><span className="ip-card-evidence-count"><Layers3 size={14}/>{item ? item.evidence.length + " 处依据" : "依据受限"}{insight.headRevision > 1 && <span> · 修订 {insight.headRevision}</span>}</span>
                  <div><details className="ip-menu ip-card-menu"><summary aria-label={"处理发现：" + shownTitle(state, insight)} title="处理发现"><MoreHorizontal size={18}/></summary><div className="ip-menu-content">
                    {insight.status === "active" ? <button disabled={busy || !item} onClick={() => openSnooze(insight)}><Clock3 size={15}/>稍后查看</button> : <button disabled={busy || !item} onClick={() => changeStatus(insight, "active")}><RotateCcw size={15}/>返回待关注</button>}
                    {insight.status !== "done" && <button disabled={busy || !item} onClick={() => changeStatus(insight, "done")}><CheckCheck size={15}/>标为已处理</button>}
                  </div></details><button className="ip-open-card" onClick={() => openDetail(insight)}>{item?.caseStudy?.actionTitle || (validity === "review" ? "核对这条发现" : "查看发现")}<ArrowUpRight size={15}/></button></div>
                </footer>}
              </article>;
            }) : <div className="ip-empty"><FileCheck2 size={29}/><h3>{query ? "没有匹配的发现" : "这里暂时没有发现"}</h3><p>{query ? "试试其他关键词，或调整事项与时间范围。" : filter === "later" ? "需要时间想一想时，可以为发现设置明确的稍后时间。" : filter === "done" ? "理解、记住经验或完成核对，都可以将发现标为已处理。" : "从已有成果选择有引用的发现，留在这里慢慢核对。"}</p><button className="ip-button" onClick={() => { if (query || workFilter !== "all" || validityFilter !== "all" || period !== "all" || scope !== "all") clearFilters(); else if (filter === "later" || filter === "done") switchTab("all"); else openReports(); }}>{query || workFilter !== "all" || validityFilter !== "all" || period !== "all" || scope !== "all" ? "清除筛选" : filter === "later" || filter === "done" ? "回到待关注" : "选择已有成果"}<ArrowRight size={13}/></button></div>}
          </div>
          {allVisible.length > shownCount && <button className="ip-show-more" onClick={() => setShownCount(c => c + 7)}>再看 {Math.min(7, allVisible.length - shownCount)} 条<ChevronDown size={14}/></button>}
        </div>
        <footer className="ip-list-footer"><FlaskConical size={12}/><span>{state.insights.length} 条发现 · {caseCount} 个真实资料案例 · 操作保存在此浏览器</span><button onClick={() => showModal({ type: "about" })}>试试这些交互<ArrowRight size={12}/></button></footer>
      </aside>
      <main className="ip-detail-pane" aria-label="发现依据与处理">
        {selected ? <div className="ip-detail-scroll" key={selected.id}>
          <div className="ip-detail-top"><button className="ip-back-to-cards ip-text-button" onClick={returnToCards}><ArrowLeft size={16}/><span>返回卡片</span></button><span>{selectedIndex + 1} / {allVisible.length}</span>
            <div className="ip-reader-tools"><button aria-label="上一条发现" title="上一条发现" disabled={selectedIndex <= 0} onClick={() => openDetail(allVisible[selectedIndex - 1])}><ChevronLeft size={17}/></button><button aria-label="下一条发现" title="下一条发现" disabled={selectedIndex < 0 || selectedIndex >= allVisible.length - 1} onClick={() => openDetail(allVisible[selectedIndex + 1])}><ChevronRight size={17}/></button><i/><button aria-label={focusedReading ? "退出专注阅读" : "专注阅读发现"} title={focusedReading ? "退出专注阅读" : "专注阅读"} aria-pressed={focusedReading} onClick={() => setFocusedReading(x => !x)}>{focusedReading ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button><button aria-label="关闭发现详情" title="关闭详情 · Esc" onClick={returnToCards}><X size={18}/></button></div>
          </div>
          {selectedValidity === "unavailable" ? <div className="ip-unavailable"><LockKeyhole size={32}/><h2 ref={detailTitleRef} tabIndex={-1}>这条发现的来源暂不可用</h2>
            <p>相关结论、引文、历史内容及依赖草稿已隐藏。你的处理状态与操作记录仍然保留。</p>
            <div className="ip-state-pair"><StatusPill status={selected.status}/><ValidityPill value="unavailable"/></div>
            <button className="ip-button" onClick={() => showModal({ type: "sources" })}>查看来源状态<ArrowRight size={14}/></button>
          </div> : inspectedFinding && inspectedRevision && <>
            <div className="ip-detail-eyebrow"><span>{categoryNames[inspectedFinding.category]}</span><i/><span>{inspectedFinding.caseStudy ? "真实资料案例" : "来自已有成果"}</span></div>
            <h2 ref={detailTitleRef} tabIndex={-1} className="ip-detail-title">{inspectedFinding.title}</h2>
            <p className="ip-detail-summary">{inspectedFinding.summary}</p>
            <div className="ip-state-pair"><div><span>{inspectingOld ? "当前处理状态" : "处理状态"}</span><StatusPill status={selected.status}/></div><div><span>{inspectingOld ? "内容视图" : "结论有效性"}</span>{inspectingOld ? <span className="ip-pill"><History size={12}/>历史快照</span> : <ValidityPill value={selectedValidity}/>}</div>
              <button className="ip-revision-link" onClick={() => { const history = document.getElementById("ip-revision-history") as HTMLDetailsElement; if (history) { history.open = true; history.scrollIntoView({ behavior: "smooth", block: "start" }); } }}><History size={13}/>修订 {inspectedRevision.revision}</button></div>
            {selected.status === "later" && <div className="ip-inline-note"><Clock3 size={14}/>稍后时间：{dateText(selected.snoozeUntil, true)}。到期后回到待关注，保留当时的有效性。</div>}
            {selectedValidity === "review" && <div className="ip-review-callout"><RefreshCw size={16}/><div><strong>{selected.status === "done" ? "已处理，但结论需要重新核对" : "这条结论需要重新核对"}</strong>
              <p>来源、访问条件或用户补充发生了变化。当前保留的是旧修订；在原工作核对后，选择新成果更新。</p></div></div>}
            {inspectingOld && <div className="ip-history-callout"><History size={15}/><span>正在查看第 {inspectedRevision.revision} 次修订的历史快照，不能将其中引文当作当前来源。</span><button onClick={() => setHistoryRevision(null)}>回到当前</button></div>}
            {!inspectingOld && selected.headRevision > 1 && <div className="ip-change-note"><span>这次新增了什么</span><p>{inspectedRevision.changeSummary || "已根据你选择的新成果更新，原处理状态与反馈继续保留。"}</p></div>}
            <section className={"ip-detail-section" + (inspectedFinding.caseStudy ? " ip-scenario" : "")}><h3>{inspectedFinding.caseStudy ? "放到一个具体情境里" : "为什么现在与你有关"}</h3><p>{inspectedFinding.caseStudy?.scenario || inspectedFinding.why}</p>{inspectedFinding.caseStudy && <div className="ip-case-connection"><Link2 size={16}/><p>{inspectedFinding.caseStudy.learning}</p></div>}</section>
            <section className="ip-detail-section ip-evidence-section"><div className="ip-section-heading"><h3>{inspectedFinding.caseStudy ? "官方资料怎么说" : "依据与原文"}</h3><span>{inspectedFinding.evidence.length} 处依据</span></div>
              {inspectedFinding.evidence.map((evidence, index) => <EvidenceCard key={evidence.sourceId + "-" + index} evidence={evidence} index={index + 1} state={state} onOpen={() => openEvidence(evidence)}/>)}
              <p className="ip-evidence-footnote">{inspectedFinding.caseStudy ? "以下为官方文档的中文摘要。打开官方原文可核对上下文；应用建议由本案例整理。" : "引用用于核对判断；重复转述与用户补充会分别标明，数量不代表可信程度。"}</p>
            </section>
            {!!selected.feedback.length && <section className="ip-feedback-section"><div className="ip-section-heading"><h3>你留下的纠正与背景</h3><span>{selected.feedback.length} 条</span></div>
              {selected.feedback.map(feedback => <div key={feedback.id} className="ip-feedback-item"><header><span>{feedbackNames[feedback.kind]}</span><time>{dateText(feedback.createdAt, true)}</time></header><p>{getVisibleFinding(state, selected, feedback.targetRevision) ? feedback.text : "对应修订的来源不可用，反馈内容已隐藏。"}</p><small>针对修订 {feedback.targetRevision} · {feedback.resolvedInRevision ? "已在修订 " + feedback.resolvedInRevision + " 中确认处理" : "已保存，等待核对"}</small></div>)}</section>}
            <section className={"ip-next-step" + (inspectedFinding.caseStudy ? " ip-case-next-step" : "")}><div><ListChecks size={19}/><h3>{inspectedFinding.caseStudy ? "可以怎样用起来" : "沿着这件事，继续"}</h3><p>{inspectedFinding.caseStudy ? "把建议整理成自己的清单，确认后再保存。" : "带上本条发现、依据和你的补充，回到同一个工作。"}</p></div>
              {inspectedFinding.caseStudy && <ol className="ip-practice-steps">{inspectedFinding.caseStudy.actionSteps.map((step, index) => <li key={index}><span>{String(index + 1).padStart(2, "0")}</span><p>{step}</p></li>)}</ol>}
              {inspectedFinding.caseStudy && <button className="ip-button ip-primary" disabled={inspectingOld} onClick={() => openPractice(selected)}><PencilLine size={15}/>准备实践清单</button>}
              <button className={"ip-button" + (!inspectedFinding.caseStudy ? " ip-primary" : "")} disabled={inspectingOld} onClick={() => continueWork(selected)}><MessageSquare size={15}/>{inspectedFinding.caseStudy ? "带着依据继续" : "在原工作中继续"}<ArrowUpRight size={14}/></button>
              {!inspectedFinding.caseStudy && <button className="ip-button" disabled={inspectingOld} onClick={() => openReports(selected)}><RefreshCw size={14}/>更新这条发现</button>}
            </section>
            <section className="ip-condition"><Info size={16}/><div><h3>使用前，还要确认</h3><p>{inspectedFinding.condition}</p></div></section>
            <div className="ip-detail-actions"><button className="ip-text-button" onClick={() => {
              setFeedbackText(""); setFeedbackKind("fact"); setContinueAfterFeedback(true);
              showModal({ type: "feedback", insightId: selected.id, baseRevision: selected.rowRevision });
            }} disabled={inspectingOld}><PencilLine size={14}/>纠正或补充</button>
              <button className="ip-text-button" disabled={busy} onClick={() => { setSnoozeDate(localInputDate(new Date(Date.now() + 86400000))); showModal({ type: "snooze", insightId: selected.id, baseRevision: selected.rowRevision }); }}><Clock3 size={14}/>现在不需要</button>
              <button className="ip-text-button" disabled={busy} onClick={() => act({ type: "mute", insightId: selected.id, expectedRowRevision: selected.rowRevision, value: !selected.muted, operationId: ledgerId() }, selected.muted ? "已恢复本条发现的提醒偏好" : "不再主动提醒此发现，历史仍然保留")}><BellOff size={14}/>{selected.muted ? "恢复关注" : "不再关注"}</button>
              <button className="ip-handle-button" disabled={busy} onClick={() => changeStatus(selected, selected.status === "done" ? "active" : "done")}><CheckCheck size={14}/>{selected.status === "done" ? "返回待关注" : "已理解，标为已处理"}</button>
            </div>
          </>}
          <details className="ip-revision-history" id="ip-revision-history"><summary><span><History size={15}/>修订与处理记录</span><span>{selected.revisions.length} 次修订<ChevronDown size={14}/></span></summary>
            {selectedValidity !== "unavailable" && <button className="ip-text-button ip-original-link" onClick={() => { setReportId(inspectedRevision!.reportId); setReportGroup("all"); setReportWork("all"); setChosenPointers([]); setDependenciesConfirmed(false); setOriginalReport(true); showModal({ type: "reports" }); }}>打开原成果快照<ArrowUpRight size={13}/></button>}
            {selectedValidity !== "unavailable" && <div className="ip-revisions">{selected.revisions.map(revision => <button key={revision.revision} className={(inspectedRevision?.revision === revision.revision ? "selected" : "")} onClick={() => setHistoryRevision(revision.revision === selected.headRevision ? null : revision.revision)}><span>修订 {revision.revision}{revision.revision === selected.headRevision ? " · 当前" : ""}</span><small>{dateText(revision.savedAt, true)}</small></button>)}</div>}
            <EventList events={eventsFor(selected.id).slice(0, 8)} state={state} onOpenItem={onOpenSource}/>
            {selectedValidity !== "unavailable" && inspectedRevision && <details className="ip-origin-details"><summary>查看出处与时间<ChevronDown size={13}/></summary><dl><div><dt>原工作</dt><dd>{selected.workTitle}</dd></div><div><dt>固定交付</dt><dd>{inspectedRevision.reportTitle}</dd></div><div><dt>来源截至</dt><dd>{dateText(inspectedRevision.coverageAsOf, true)}</dd></div><div><dt>成果生成</dt><dd>{dateText(inspectedRevision.generatedAt, true)}</dd></div><div><dt>发现保存</dt><dd>{dateText(inspectedRevision.savedAt, true)}</dd></div><div><dt>发现身份</dt><dd><code>{selected.id}</code></dd></div><div><dt>引用定位</dt><dd><code>{inspectedRevision.reportId} · {inspectedRevision.pointer}</code></dd></div></dl><p>身份在首次保存时分配。另一份成果的发现需要你显式关联，不会按标题或位置自动继承状态。</p></details>}
          </details>
          {inspectedFinding && !inspectingOld && <PrototypeRelations key={selected.id} insight={selected} state={state} disabled={busy} onSave={async supersedes => !!(await act({type:"relate",insightId:selected.id,expectedRowRevision:selected.rowRevision,supersedes,operationId:ledgerId()}))?.ok}/>}
          <footer className="ip-detail-footer"><span>{inspectedFinding?.caseStudy ? "公开资料案例 · 应用场景为推演" : "示例成果 · 保存在当前浏览器"}</span><button className="ip-text-button" onClick={() => showModal({ type: "about" })}>本版说明<ArrowUpRight size={12}/></button></footer>
        </div> : <div className="ip-detail-empty"><div className="ip-empty-glyph"><Sparkles size={29}/></div><h2>每个发现，都可以回到依据</h2><p>从左侧选择一条发现，查看它与你的关系、引用和变化。<br/>没有足够依据时，留白也是合适的结果。</p>{totalReview > 0 && <button className="ip-button" onClick={() => { clearFilters(); onScopeChange?.("review"); switchTab("everything"); }}>查看 {totalReview} 条待复核发现<ArrowRight size={14}/></button>}</div>}
      </main>
    </div>}
    {undoEvent && <div className="ip-undo" role="status"><CheckCircle2 size={14}/><span>处理状态已保存</span><button disabled={busy} onClick={async () => {
      const insight = state.insights.find(x => x.id === undoEvent.insightId); if (!insight) return;
      const result = await act({ type: "undo", insightId: insight.id, expectedRowRevision: insight.rowRevision, eventId: undoEvent.eventId, operationId: ledgerId() });
      if (result?.ok) { setUndoEvent(null); notify("已撤销处理；当前证据有效性继续保留"); }
    }}>撤销</button><button onClick={() => { openSavedInsight(undoEvent.insightId); setUndoEvent(null); }}>查看<ArrowRight size={12}/></button><button aria-label="关闭撤销提示" onClick={() => setUndoEvent(null)}><X size={13}/></button></div>}

    {modal?.type === "recall" && <Dialog title="寻找旧知识" subtitle="先定位材料，再判断是否适用" onClose={()=>setModal(null)}><InsightRecall state={state} onOpenWork={(id,question)=>{const title=REPORT_FIXTURES.find(r=>r.workId===id)?.workTitle||"原事项";setModal(null);onAssistant({id,title,workId:id,workTitle:title,excerpt:"请围绕原事项的问题核对已授权资料。关键词命中只是候选，不代表关联成立；需读取原文、核对适用条件和反例。",evidence:[]});}}/></Dialog>}
    {modal?.type === "reports" && <Dialog title={targetInsight ? "更新这条发现" : "从已有成果保存发现"} subtitle={targetInsight ? "选择同一工作的新成果，明确对应的发现，再发布一个新修订。" : "只提取已发布成果中有可读引用的发现。打开这份列表不会启动分析。"} wide onClose={() => setModal(null)}>
      <div className="ip-report-browser">
        <aside className="ip-report-nav"><div className="ip-report-filter">{!targetInsight&&<label><span>搜索事项</span><input aria-label="搜索成果事项" placeholder="按事项标题查找…" value={reportQuery} maxLength={200} onChange={e=>{setReportQuery(e.target.value);setReportWork("all");setChosenPointers([]);setDependenciesConfirmed(false);}}/></label>}<label><span>{targetInsight ? "当前工作" : "事项范围"}</span>{targetInsight ? <strong>{targetInsight.workTitle}</strong> : <select aria-label="成果事项范围" value={reportWork} onChange={e => { setReportWork(e.target.value); setChosenPointers([]); setDependenciesConfirmed(false); }}><option value="all">全部事项</option>{Array.from(new Map(REPORT_FIXTURES.map(x => [x.workId, x.workTitle]))).map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select>}</label>
          <label><span>成果类型</span><select aria-label="成果类型" value={reportGroup} onChange={e => { setReportGroup(e.target.value); setChosenPointers([]); setDependenciesConfirmed(false); }}><option value="normal">已发布成果</option><option value="revision">后续核对成果</option><option value="boundary">无发现与异常示例</option><option value="all">所有示例成果</option></select></label></div>
          <div className="ip-report-options">{availableReports.map(report => <button key={report.id} className={reportId === report.id ? "selected" : ""} onClick={() => chooseReport(report)}><FileText size={15}/><span><strong>{report.title}</strong><small>{report.workTitle}</small><small>{dateText(report.publishedAt, true)} · {report.kind === "native" ? "原生正文" : report.findings.length + " 条候选"}</small></span><ChevronRight size={12}/></button>)}
            {!availableReports.length && <p className="ip-report-nav-empty">这个范围暂时没有成果。可以切换成果类型。</p>}</div>
        </aside>
        <div className="ip-report-content">
          {selectedReport && availableReports.some(x => x.id === selectedReport.id) ? <>
            <header className="ip-report-heading"><div><span className="ip-overline">{selectedReport.kind === "native" ? "原生回答" : "固定成果快照"} · 示例</span><h3>{reportReadable ? selectedReport.title : "部分来源受限的成果"}</h3><p>{reportReadable ? selectedReport.summary : "相关摘要已隐藏。仍可选择其他依据完整、当前可读的发现。"}</p></div>
              <button className="ip-text-button" onClick={() => setOriginalReport(x => !x)}>{originalReport ? "回到候选" : "查看原成果"}<ArrowUpRight size={12}/></button></header>
            <div className="ip-report-coverage"><span><Layers3 size={12}/>{selectedReport.workTitle}</span><span><Clock3 size={12}/>资料截至 {dateText(selectedReport.coverageAsOf, true)}</span></div>
            {originalReport && <div className="ip-original-report"><h4>{selectedReport.kind === "native" ? "原回答" : "成果中的原始发现"}</h4><p>{reportReadable ? selectedReport.summary : "受限来源相关摘要已隐藏。"}</p>{selectedReport.findings.map(candidate => {
              const access = candidate.evidence.every(e => state.sources[e.sourceId]?.available);
              return <section key={candidate.pointer}><strong>{access ? candidate.title : "来源受限，相关发现已隐藏"}</strong>{access && <><p>{candidate.summary}</p>{candidate.evidence.map((e, index) => e.excerptKind === "summary" ? <div className="ip-original-summary" key={index}><small>{e.publisher || e.provider} · 官方资料 · 中文摘要</small><p>{e.quote}</p><a href={e.externalUrl} target="_blank" rel="noreferrer">{e.title}<ArrowUpRight size={12}/></a></div> : <blockquote key={index}>{e.quote}<cite>{e.title} · v{e.version}</cite></blockquote>)}</>}</section>;
            })}<p className="ip-muted">{selectedReport.emptyReason || "此处展示已发布的示例快照；不会重新生成或改写它。"}</p></div>}
            {!originalReport && (selectedReport.kind !== "structured" || selectedReport.status !== "published" || !selectedReport.findings.length) ? <div className="ip-report-empty"><FileText size={30}/><h3>这份成果暂无可提取发现</h3><p>{selectedReport.emptyReason || "没有满足要求的 findings。原回答仍可查看，不会补齐卡片。"}</p><button className="ip-button" onClick={() => setOriginalReport(true)}>查看原回答<ArrowUpRight size={13}/></button></div> : !originalReport && <div className="ip-candidate-list">
              {targetInsight && <div className="ip-update-target"><span>正在更新</span><strong>{shownTitle(state, targetInsight)}</strong><p>修订 {targetInsight.headRevision} · {statusNames[targetInsight.status]} · 原身份与处理状态将保留</p></div>}
              {selectedReport.findings.map(candidate => {
                const availability = candidateAvailability(state, selectedReport, candidate);
                const currentAccess = candidate.evidence.every(e => state.sources[e.sourceId]?.available);
                const alreadyThis = availability.existingInsightId === targetInsight?.id;
                const alreadyOther = availability.existingInsightId && !alreadyThis;
                const olderDelivery = !!targetInsight && !alreadyThis && Date.parse(selectedReport.publishedAt) < Date.parse(headOf(targetInsight).generatedAt);
                const eligible = availability.eligible && (!targetInsight || !alreadyOther) && !olderDelivery;
                const checked = chosenPointers.includes(candidate.pointer);
                return <div className={"ip-candidate" + (checked ? " selected" : "") + (!eligible ? " disabled" : "")} key={candidate.pointer}>
                  <label><input type={targetInsight ? "radio" : "checkbox"} name="report-candidate" checked={checked} disabled={!eligible || busy} onChange={() => { setChosenPointers(targetInsight ? [candidate.pointer] : checked ? chosenPointers.filter(x => x !== candidate.pointer) : [...chosenPointers, candidate.pointer]); setAcknowledgedFeedback([]); setDependenciesConfirmed(false); setNotice(""); setOperationId(ledgerId()); }}/><span><strong>{currentAccess ? candidate.title : "来源受限，候选内容已隐藏"}</strong>{currentAccess && <p>{candidate.summary}</p>}<small>{currentAccess ? candidate.evidence.length + " 处引用 · " + categoryNames[candidate.category] : "不可发布"}</small></span></label>
                  {currentAccess && <div className="ip-candidate-sources">{candidate.evidence.map((e, index) => <span key={index}>{e.title} · v{e.version}</span>)}</div>}
                  {(availability.reason || alreadyOther || olderDelivery) && <p className="ip-candidate-reason"><Info size={12}/>{olderDelivery ? "这份成果早于当前修订，请选择核对后的新成果。" : alreadyOther && targetInsight ? "这条候选已绑定另一条发现，不能重新分配。" : availability.reason}</p>}
                  {availability.existingInsightId && !targetInsight && <button className="ip-text-button" onClick={() => openSavedInsight(availability.existingInsightId!)}>查看已保存的发现<ArrowRight size={12}/></button>}
                </div>;
              })}
              {targetInsight && chosenFinding && chosenReadable && <section className="ip-update-comparison"><h4>核对这次变化</h4><div><span>当前修订</span><p>{getVisibleFinding(state, targetInsight)?.summary || "来源不可用"}</p></div><div><span>将要发布</span><p>{chosenFinding.summary}</p></div><p className="ip-muted">{chosenFinding.changeSummary || "请确认它对应原来的这条发现；相同文字或顺序并不能自动证明身份相同。"}</p></section>}
              {targetInsight && getVisibleFinding(state, targetInsight) && unresolvedFeedback.length > 0 && <section className="ip-acknowledge"><h4>这份成果处理了哪些反馈？</h4><p>仅确认已经核对并体现在新成果中的补充。未处理的反馈会继续保留。</p>{unresolvedFeedback.map(feedback => <label key={feedback.id}><input type="checkbox" checked={acknowledgedFeedback.includes(feedback.id)} disabled={!chosenFinding || !chosenReadable || !chosenFinding.resolvesFeedback} onChange={e => setAcknowledgedFeedback(ids => e.target.checked ? [...ids, feedback.id] : ids.filter(x => x !== feedback.id))}/><span>{feedback.text}</span></label>)}</section>}
            </div>}
            {!originalReport && chosenPointers.length > 0 && <section className="ip-acknowledge ip-dependency-confirmation"><h4>确认这次保存的依据</h4><p>每条发现只依赖它列出的引用。原工作中读过的其他资料不会自动成为依据；如结论还依赖共同背景，应先在成果中明确列出并核对。</p><label><input type="checkbox" checked={dependenciesConfirmed} disabled={busy} onChange={e => { setDependenciesConfirmed(e.target.checked); setOperationId(ledgerId()); }}/><span>我已核对所选发现的引用与适用背景，确认这些依据足以支持本次保存。</span></label></section>}
          </> : <div className="ip-report-empty"><FileText size={30}/><h3>选择一份成果</h3><p>左侧只显示当前工作与类型范围内的报告。</p></div>}
        </div>
      </div>
      {!!notice && <div className="ip-dialog-notice" role="alert"><AlertCircle size={14}/><span>{notice}</span>{conflict && targetInsight && <button onClick={() => { setModal({ ...modal, baseRevision: targetInsight.rowRevision }); setAcknowledgedFeedback([]); setConflict(false); setNotice("已载入当前修订，请重新核对后提交。"); setOperationId(ledgerId()); }}>重新核对当前修订</button>}</div>}
      <footer className="ip-dialog-footer"><p>{targetInsight ? "更新不会清除你的反馈或改变处理状态。" : "重复保存同一候选，不会新增卡片或重置状态。"}</p><button className="ip-button" onClick={() => setModal(null)}>取消</button><button className="ip-button ip-primary" disabled={busy || !chosenPointers.length || !dependenciesConfirmed || originalReport || !availableReports.some(x => x.id === selectedReport?.id)} onClick={saveCandidates}>{busy ? "正在保存…" : targetInsight ? "核对并发布修订" : "保存所选发现" + (chosenPointers.length ? " · " + chosenPointers.length : "")}<Check size={14}/></button></footer>
    </Dialog>}

    {modal?.type === "practice" && <Dialog title="把案例变成自己的实践清单" subtitle="内容可以先调整。保存后会成为 Hub 中的一份笔记，并保留这条发现与官方出处。" onClose={() => setModal(null)}>
      <div className="ip-form ip-practice-form"><label>清单标题<input data-autofocus value={practiceTitle} onChange={event => setPracticeTitle(event.target.value)} maxLength={180}/></label><label>清单内容<textarea value={practiceBody} onChange={event => setPracticeBody(event.target.value)} rows={12} maxLength={18000}/></label></div>
      {notice && <div className="ip-dialog-notice" role="alert">{notice}</div>}
      <footer className="ip-dialog-footer"><button className="ip-button" onClick={() => setModal(null)}>继续阅读</button><button className="ip-button ip-primary" disabled={busy || !practiceTitle.trim() || !practiceBody.trim()} onClick={savePractice}><BookmarkCheck size={15}/>{busy ? "保存中…" : "保存到 Hub"}</button></footer>
    </Dialog>}

    {modal?.type === "feedback" && <Dialog title="纠正或补充这条发现" subtitle="先保存你的原话，再回到原工作核对。保存反馈不代表结论已经修正。" onClose={() => setModal(null)}>
      <div className="ip-form"><label>反馈类型<select value={feedbackKind} onChange={e => setFeedbackKind(e.target.value as typeof feedbackKind)}><option value="fact">事实有误</option><option value="association">关联不对</option><option value="context">补充背景</option></select></label>
        <label>你想说明什么？<textarea data-autofocus rows={5} value={feedbackText} onChange={e => setFeedbackText(e.target.value)} placeholder="例如：这里的“完成”仅指纸面原型，尚未完成实机验证。"/></label>
        <button className="ip-example-fill" onClick={() => setFeedbackText(SAMPLE_U1)}>填入纸面原型的示例补充</button>
        <label className="ip-check-label"><input type="checkbox" checked={continueAfterFeedback} onChange={e => setContinueAfterFeedback(e.target.checked)}/><span>保存后，在原工作中继续核对</span></label><p className="ip-form-help">反馈归属当前发现及目标修订，不会自动成为长期记忆或个人标签。</p>
      </div>{notice && <div className="ip-dialog-notice" role="alert">{notice}</div>}
      <footer className="ip-dialog-footer"><button className="ip-button" onClick={() => setModal(null)}>取消</button><button className="ip-button ip-primary" disabled={!feedbackText.trim() || busy} onClick={saveFeedback}>{continueAfterFeedback ? "保存并继续" : "保存反馈"}<ArrowRight size={14}/></button></footer>
    </Dialog>}

    {modal?.type === "snooze" && <Dialog title="什么时候再看？" subtitle="稍后只控制这条发现出现的时间，不改变事实判断或原任务。" onClose={() => setModal(null)}>
      <div className="ip-form"><div className="ip-snooze-presets">{[{ label: "两小时后", hours: 2 }, { label: "明天此时", hours: 24 }, { label: "一周后", hours: 168 }].map(x => <button key={x.hours} className="ip-button" onClick={() => setSnoozeDate(localInputDate(new Date(Date.now() + x.hours * 3600000)))}>{x.label}</button>)}</div>
        <label>明确的稍后时间<input data-autofocus type="datetime-local" value={snoozeDate} onChange={e => setSnoozeDate(e.target.value)}/></label><p className="ip-form-help">到期后，在下一次打开面板时回到待关注。关闭期间不发送提醒。</p></div>
      {notice && <div className="ip-dialog-notice" role="alert">{notice}</div>}
      <footer className="ip-dialog-footer"><button className="ip-button" onClick={() => setModal(null)}>取消</button><button className="ip-button ip-primary" disabled={busy || !snoozeDate} onClick={async () => {
        const insight = state.insights.find(x => x.id === modal.insightId);
        const time = new Date(snoozeDate);
        if (!insight || Number.isNaN(time.getTime()) || time.getTime() <= Date.now()) { setNotice("请选择一个将来的时间。"); return; }
        const result = await act({ type: "status", insightId: insight.id, expectedRowRevision: modal.baseRevision, status: "later", snoozeUntil: time.toISOString(), operationId });
        if (result?.ok) { if (result.eventId) setUndoEvent({ eventId: result.eventId, insightId: insight.id }); setModal(null); notify("已保存稍后时间：" + dateText(time.toISOString(), true)); }
      }}>保存稍后时间<Clock3 size={14}/></button></footer>
    </Dialog>}

    {modal?.type === "decisions" && <Dialog title="决定与条件" subtitle="留下当时的理由和假设，用后来的观察逐项回顾" wide onClose={()=>setModal(null)}><InsightNotebookDemo onAssistant={id=>{setModal(null);onAssistant({id,title:"决定与条件回顾（示例）",workId:id,workTitle:"决定与条件回顾（示例）",excerpt:"请回顾刚保存的决定，区分当时理由、明确假设与后补观察。本原型仅演示交互，不声称已经分析真实资料。",evidence:[]});}}/></Dialog>}
    {modal?.type === "sources" && <Dialog title="来源与演示控制" subtitle="当前发现依赖哪些材料、引用哪个版本，都可以在这里核对。" wide onClose={() => setModal(null)}>
      <div className="ip-source-manager"><div className="ip-demo-caption"><Info size={15}/><p>这里包含公开文档摘要与合成测试资料。演示控制只改变本地快照的访问状态，不修改官方来源。</p></div>
        {SOURCE_FIXTURES.filter(source => source.kind !== "feedback").map(source => {
          const current = state.sources[source.id];
          if (!current) return null;
          const dependents = state.insights.filter(x => headOf(x).finding.evidence.some(e => e.sourceId === source.id)).length;
          return <section className="ip-source-row" key={source.id}><div className="ip-source-row-title"><FileText size={18}/><div><h3>{source.title}</h3><p>{source.provider} · 当前 v{current.version} · 影响 {dependents} 条发现</p></div><span className={"ip-pill " + (current.available ? "ip-validity-available" : "ip-validity-unavailable")}>{current.available ? "可访问" : "不可用"}</span></div>
            <div className="ip-source-controls">{source.versions.length > 1 && <button className="ip-button" disabled={busy || !current.available || current.version >= Math.max(...source.versions.map(x => x.version))} onClick={() => act({ type: "source", sourceId: source.id, version: Math.max(...source.versions.map(x => x.version)), note: "原文已有新版本，请重新核对引用及适用条件。", operationId: ledgerId() }, "来源已模拟更新，受影响发现保留旧引用并标为待复核")}><RefreshCw size={13}/>{current.version > 1 ? "已是新版本" : "模拟来源更新"}</button>}
              <button className="ip-button" disabled={busy} onClick={() => act({ type: "source", sourceId: source.id, available: !current.available, note: current.available ? "示例来源访问已撤回" : "示例来源已恢复，等待重新核对", operationId: ledgerId() }, current.available ? "已隐藏依赖该来源的内容" : "来源已恢复，请重新核对")}><LockKeyhole size={13}/>{current.available ? "模拟撤回访问" : "恢复示例访问"}</button></div>
            {current.note && <p className="ip-source-note">{current.note}</p>}</section>;
        })}
        {selected && getInsightValidity(state, selected) !== "unavailable" && <details className="ip-failure-demo"><summary>试一试更新没有成功的情况<ChevronDown size={13}/></summary><p>为当前选中的发现记录一次未成功更新；旧修订与用户反馈会保留。</p><div>{[{ value: "failed", label: "更新失败" }, { value: "stopped", label: "用户停止" }, { value: "unknown", label: "结果未知" }].map(outcome => <button className="ip-button" key={outcome.value} disabled={busy} onClick={() => act({ type: "update-outcome", insightId: selected.id, expectedRowRevision: selected.rowRevision, outcome: outcome.value as "failed" | "stopped" | "unknown", operationId: ledgerId() }, "已记录本次结果，旧修订没有被替换")}>{outcome.label}</button>)}</div></details>}
      </div>{notice && <div className="ip-dialog-notice" role="alert">{notice}</div>}<footer className="ip-dialog-footer"><p>恢复访问不等于旧结论重新有效。</p><button className="ip-button ip-primary" onClick={() => setModal(null)}>完成</button></footer>
    </Dialog>}

    {modal?.type === "about" && <Dialog title="从一条发现开始，试试看" subtitle="真实公开资料帮助理解发现，互动示例帮助体验处理过程。你的操作会保留在这个浏览器里。" onClose={() => setModal(null)}>
      <div className="ip-about"><div className="ip-demo-tour">
        <button onClick={() => { openPublicCases(); setModal(null); }}><span>01</span><div><strong>从一个真实资料案例开始</strong><p>核对官方出处，再准备自己的实践清单。</p></div><ArrowRight size={15}/></button>
        <button onClick={() => { clearFilters(); switchTab("later"); setViewMode("cards"); setModal(null); }}><span>02</span><div><strong>留到合适的时候</strong><p>查看稍后时间，或重新放回待关注。</p></div><ArrowRight size={15}/></button>
        <button onClick={() => { clearFilters(); onScopeChange?.("review"); switchTab("everything"); setViewMode("cards"); setModal(null); }}><span>03</span><div><strong>核对一条有变化的结论</strong><p>查看用户补充与新成果，追加一次修订。</p></div><ArrowRight size={15}/></button>
        <button onClick={() => { clearFilters(); switchTab("done"); setViewMode("cards"); setModal(null); }}><span>04</span><div><strong>回看已经留下的收获</strong><p>读处理记录，也可以恢复关注。</p></div><ArrowRight size={15}/></button>
      </div><h3>侧边栏管页面，顶部 Tab 管状态</h3><p>发现、阶段回顾、关注主题和工作草稿都能从侧边栏直接进入。卡片适合浏览；点开卡片，会切换到列表与依据并排的视图。</p>
        <h3>两种状态，分别保存</h3><p>“待关注 / 稍后 / 已处理”记录你的选择；“可用 / 待复核 / 不可用”记录当前依据能否支撑结论。已处理的发现也可以待复核。</p>
        <h3>真实资料与应用场景</h3><p>5 个新增案例基于 ezdxf、Notion、GitHub、Obsidian 与 Craft 官方文档整理。文档事实可以通过链接核对，应用情境与实践建议是案例推演，不代表你已发生的经历。</p>
        <h3>测试数据与保存</h3><p>首次共有 17 条发现：5 条公开资料案例与 12 条互动示例。补充数据只添加缺失案例，不重置你已有的状态、反馈与笔记。回顾、主题与草稿也有独立示例可体验。</p>
        <p>助手继续使用本地演示逻辑；已有成果提取与明确更新沿用 Issue #2 的首批流程。</p>
        <a className="ip-spec-link" href="https://github.com/VondeSong/hub-search/issues/2" target="_blank" rel="noreferrer"><BookOpen size={14}/>查看当前设计规格<ArrowUpRight size={13}/></a>
      </div><footer className="ip-dialog-footer"><button className="ip-button" onClick={() => { setModal(null); onExplore(); }}>更多发现示例<ArrowRight size={14}/></button><button className="ip-button ip-primary" onClick={() => setModal(null)}>开始体验</button></footer>
    </Dialog>}
  </section>;
}

function PrototypeRelations({insight,state,disabled,onSave}:{insight:LedgerInsight;state:LedgerState;disabled:boolean;onSave:(ids:string[])=>Promise<boolean>}) {
  const [chosen,setChosen]=useState(insight.supersedes??[]),[confirmed,setConfirmed]=useState(false);
  useEffect(()=>{setChosen(insight.supersedes??[]);setConfirmed(false);},[insight.rowRevision]);
  const choices=state.insights.filter(other=>other.id!==insight.id&&other.ownerWorkId===insight.ownerWorkId&&getVisibleFinding(state,other));
  const unchanged=JSON.stringify([...chosen].sort())===JSON.stringify([...(insight.supersedes??[])].sort());
  return <details className="ip-origin-details"><summary>关联替代发现 · {insight.supersedes?.length??0} 条<ChevronDown size={13}/></summary><div className="ip-form"><p className="ip-form-help">拆分或合并后，先将新发现单独保存，再关联它替代的原发现。原发现、处理状态和任务均会保留。</p>
    {choices.map(other=><label className="ip-check-label" key={other.id}><input type="checkbox" checked={chosen.includes(other.id)} disabled={disabled||(!chosen.includes(other.id)&&chosen.length>=12)} onChange={()=>{setChosen(old=>old.includes(other.id)?old.filter(id=>id!==other.id):[...old,other.id]);setConfirmed(false);}}/><span>{shownTitle(state,other)} · {statusNames[other.status]}</span></label>)}
    {!choices.length&&<p className="ip-form-help">这个工作还没有其他可访问的已保存发现。</p>}
    <label className="ip-check-label"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span>我已核对这些发现的对应关系；旧内容和处理状态仍保留</span></label>
    <button className="ip-button" disabled={disabled||!confirmed||unchanged} onClick={async()=>{if(await onSave(chosen))setConfirmed(false);}}>保存替代关系</button>
  </div></details>;
}

function EvidenceCard({ evidence, index, state, onOpen }: { evidence: ReportEvidence; index: number; state: LedgerState; onOpen: () => void }) {
  const source = state.sources[evidence.sourceId];
  const changed = source && source.version !== evidence.version;
  const isPublic = evidence.excerptKind === "summary" && !!evidence.externalUrl;
  return <article className={"ip-evidence-card" + (changed ? " changed" : "") + (isPublic ? " ip-public-evidence" : "")}>
    <header><span className="ip-evidence-icon">{String(index).padStart(2, "0")}</span><div><strong>{evidence.title}</strong><span>{evidence.publisher || evidence.provider}<i/>{isPublic ? "官方资料 · 中文摘要" : evidence.location}</span></div>
      {isPublic ? <a className="ip-source-external" href={evidence.externalUrl} target="_blank" rel="noreferrer" aria-label={"打开官方原文：" + evidence.title} title="打开官方原文"><ArrowUpRight size={17}/></a> : evidence.sourceItemId && <button aria-label={"打开原文：" + evidence.title} onClick={onOpen}><ArrowUpRight size={17}/></button>}</header>
    {isPublic ? <p className="ip-source-summary">{evidence.quote}</p> : <blockquote>{evidence.quote}</blockquote>}
    <footer><span>{isPublic ? "核对于 " + dateText(evidence.checkedAt) : evidence.origin === "user" ? "用户原话 · 补充依据" : evidence.relationship === "retelling" ? "重复转述 · 非独立证据" : "原始记录"}</span>{isPublic && evidence.sourceItemId ? <button className="ip-text-button" onClick={onOpen}>阅读来源摘要<ArrowRight size={12}/></button> : <span>引用 v{evidence.version}{changed ? " · 当前 v" + source.version : ""}</span>}</footer>
    {changed && <p className="ip-evidence-change"><RefreshCw size={12}/>来源已有新版本，这里保留的是生成时引用。</p>}
    {!isPublic && <details className="ip-evidence-times"><summary>记录与观察时间<ChevronDown size={11}/></summary><dl><div><dt>事件发生</dt><dd>{dateText(evidence.eventAt, true)}</dd></div><div><dt>记录写入</dt><dd>{dateText(evidence.recordedAt, true)}</dd></div><div><dt>来源修改</dt><dd>{dateText(evidence.modifiedAt, true)}</dd></div><div><dt>Hub 观察</dt><dd>{dateText(evidence.observedAt, true)}</dd></div></dl></details>}
  </article>;
}
function EventList({ events, state, onOpen, onOpenItem }: { events: LedgerEvent[]; state: LedgerState; onOpen?: (id: string) => void; onOpenItem?: (id: string) => void }) {
  if (!events.length) return <p className="ip-no-events">还没有处理记录。</p>;
  return <ol className="ip-events">{events.map(event => {
    const insight = event.insightId ? state.insights.find(x => x.id === event.insightId) : undefined;
    const available = (!insight || !!getVisibleFinding(state, insight, event.targetRevision || insight.headRevision)) && (!event.sourceId || state.sources[event.sourceId]?.available);
    return <li key={event.id}><span className="ip-event-dot"/><div><header><strong>{available ? event.text : eventNames[event.type] || "处理记录"}</strong><time>{dateText(event.createdAt, true)}</time></header>
      {available && event.detail && <p>{event.detail}</p>}{!available && <p>来源不可用，相关内容已隐藏。处理元数据保留。</p>}
      {available && event.createdItemId && onOpenItem && <button className="ip-text-button" onClick={() => onOpenItem(event.createdItemId!)}>打开保存的内容<ArrowUpRight size={12}/></button>}
      {onOpen && insight && <button className="ip-text-button" onClick={() => onOpen(insight.id)}>{shownTitle(state, insight)}<ArrowRight size={12}/></button>}
    </div></li>;
  })}</ol>;
}

