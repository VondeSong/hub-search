import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  CalendarCheck,
  CalendarRange,
  CheckCheck,
  ChevronDown,
  Clock3,
  Columns3,
  List,
  Loader2,
  PanelLeft,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { TaskWorkspace as SourceTasks } from "./TaskWorkspace";
import { providerName } from "./ProviderLabels";
import { runtimeCapabilities } from "./RuntimePlatform";
import { useUnifiedTasks } from "./UnifiedTaskData";
import { TaskStatusControl, TaskStatusNotice } from "./TaskStatusControl";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import type { QuickJournalItem } from "./JournalRecords";
import { QUICK_JOURNAL_UPDATED } from "./QuickJournalEvents";
import { ActionEodReview, ActionTodayPlan } from "./ActionTodayPlan";
import { ActionWeeklyReview } from "./ActionWeeklyReview";
import { MobileLocalTaskDetail, mobileTasks, MobileTaskForm, MobileTaskFilter } from "./MobileInsightTasks";
import { ActionHarvester } from "./ActionHarvester";
import { ActionDetail } from "./ActionDetail";
import { ActionTopic } from "./ActionTopic";
import type { RecallCache } from "./ActionMaterials";
import { native, shiftDay, todayKey } from "./ActionEvidence";
import {
  dueDay,
  groupsFor,
  identity,
  inTopic,
  hasBlockingWait,
  TODAY_PLAN_LIMIT,
  legacyRecords,
  metaFor,
  read,
  topicOf,
  write,
  type ActionMeta,
  type Topic,
} from "./ActionState";
import "./ActionWorkbench.css";

type Props = ComponentProps<typeof SourceTasks> & {
  mobileTarget?:string;
  onBackToInsight?:()=>void;
  initialTaskTarget?: { taskId: string; libraryId: string; insightId?: string } | null;
  onInitialTaskTargetHandled?: () => void;
  onOpenInsight?: (insightId: string) => void;
  sourceDocumentFilter?: { provider: string; libraryId: string; documentId: string; title: string } | null;
};
type QuickRequest = {
  id: string;
  title: string;
  lib: string;
  project?: string;
  topicKey?: string;
  day?: string;
  priority?: number;
};
type View = "focus" | "review" | "waiting" | "all" | "done";
export function TaskWorkspace(props: Props) {
  const [sources,setSources]=useState(false);
  if(runtimeCapabilities.mobile && sources) return <div className="bw-source-tasks"><button onClick={()=>setSources(false)}>‹ 今日聚焦</button><SourceTasks {...props}/></div>;
  if (props.sourceDocumentFilter) return <SourceTasks {...props} />;
  return <DesktopActions key={JSON.stringify(props.selectedLibraryIds ?? null)} {...props} onSources={()=>setSources(true)} />;
}
function DesktopActions({ libraries = [], selectedLibraryIds = null, onClearLibraryScope, onOpenResult, mobileTarget, onBackToInsight, initialTaskTarget, onInitialTaskTargetHandled, onOpenInsight, onSources }: Props & {onSources:()=>void}) {
  const store = useUnifiedTasks();
  const mobile=runtimeCapabilities.mobile;
  const [receiptTask,setReceiptTask]=useState<UnifiedTask | null>(null);
  const [compose,setCompose]=useState(false),[localId,setLocalId]=useState("");
  const localRows=mobile ? mobileTasks() : [];
  const localTask=localRows.find(t=>t.id===(mobileTarget || localId));
  const [view, setView] = useState<View>("focus"),
    [project, setProject] = useState<Topic | null>(null),
    [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null),
    [nav, setNav] = useState(() => window.innerWidth >= 768),
    [wide, setWide] = useState(() => window.innerWidth >= 1200),
    [board, setBoard] = useState(false),
    [revision, setRevision] = useState(0),
    [refreshKey, setRefreshKey] = useState(0),
    [day, setDay] = useState(todayKey);
  const [title, setTitle] = useState(""),
    [posting, setPosting] = useState(false),
    [destination, setDestination] = useState("");
  const [journals, setJournals] = useState<QuickJournalItem[]>([]),
    [journalError, setJournalError] = useState(""),
    [notice, setNotice] = useState("");
  const [pins, setPins] = useState<string[]>(() => read("pins", [])),
    [manage, setManage] = useState(false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const navWidth = window.matchMedia("(min-width: 768px)");
    const paperWidth = window.matchMedia("(min-width: 1200px)");
    const resizeNav = (event: MediaQueryListEvent) => setNav(event.matches);
    const resizePaper = (event: MediaQueryListEvent) => setWide(event.matches);
    navWidth.addEventListener("change", resizeNav);
    paperWidth.addEventListener("change", resizePaper);
    return () => {
      navWidth.removeEventListener("change", resizeNav);
      paperWidth.removeEventListener("change", resizePaper);
    };
  }, []);
  const scopeKey = JSON.stringify(selectedLibraryIds);
  const recallCache = useMemo<RecallCache>(() => new Map(), [scopeKey, refreshKey]);
  const [detailPercent, setDetailPercent] = useState(44);
  const [clueCount, setClueCount] = useState(0);
  const [closureTaskKey, setClosureTaskKey] = useState("");
  const bump = () => setRevision((v) => v + 1);
  useEffect(() => {
    const trigger = () => setRefreshKey((v) => v + 1),
      date = () => setDay(todayKey());
    const timer = window.setInterval(date, 30000);
    window.addEventListener(QUICK_JOURNAL_UPDATED, trigger);
    window.addEventListener("focus", trigger);
    return () => {
      clearInterval(timer);
      window.removeEventListener(QUICK_JOURNAL_UPDATED, trigger);
      window.removeEventListener("focus", trigger);
    };
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all([
      invoke<{ items: QuickJournalItem[]; error: string }>("list_quick_journal"),
      invoke<{ settings: { libraryId: string } }>("get_quick_journal_settings"),
    ])
      .then(([data, cfg]) => {
        if (!live) return;
        setJournals(
          data.items
            .map((j) => ({ ...j, libraryId: j.libraryId || cfg.settings.libraryId }))
            .filter((j) => !j.deleted && (!selectedLibraryIds || selectedLibraryIds.includes(j.libraryId))),
        );
        setJournalError(data.error);
      })
      .catch((error) => {
        if (live) setJournalError(String(error));
      });
    return () => {
      live = false;
    };
  }, [scopeKey, refreshKey]);
  const tasks = useMemo(
    () =>
      store.dashboard.tasks
        .filter(
          (t) =>
            (mobile || t.provider === "dida365") &&
            !t.isProject &&
            t.status !== "abandoned" &&
            (!selectedLibraryIds || selectedLibraryIds.includes(t.libraryId)),
        )
        .sort(
          (a, b) =>
            (a.dueAt || "9999").localeCompare(b.dueAt || "9999") || a.title.localeCompare(b.title, "zh-CN"),
        ),
    [store.dashboard.tasks, scopeKey, mobile],
  );
  const harvestTasks = useMemo(() => mobile ? tasks.filter(t => t.provider === "dida365") : tasks, [tasks, mobile]);
  const originals = useMemo(() => new Map(store.dashboard.tasks.map((t) => [t.id, t])), [store.dashboard.tasks]);
  const legacy = useMemo(legacyRecords, [revision, store.dashboard.tasks]);
  const allMeta = useMemo(
    () => new Map(tasks.map((t) => [identity(t), metaFor(t, legacy)])),
    [tasks, legacy, revision],
  );
  const meta = useCallback((t: UnifiedTask) => allMeta.get(identity(t)) || metaFor(t, legacy), [allMeta, legacy]);
  const openDida = store.dashboard.tasks.filter(
    (task) => task.provider === "dida365" && !task.isProject && task.status === "open",
  );
  const plannedCount = openDida.filter((task) => meta(task).day === day).length;
  const planFull = plannedCount >= TODAY_PLAN_LIMIT;
  const update = useCallback(
    async (t: UnifiedTask, fn: (m: ActionMeta) => ActionMeta) => {
      const before = metaFor(t, legacy);
      const next = fn(before);
      if (
        next.day === day &&
        before.day !== day &&
        openDida.filter((task) => metaFor(task, legacy).day === day).length >= TODAY_PLAN_LIMIT
      )
        throw Error(`今日计划已满 ${TODAY_PLAN_LIMIT} 项，请先移出一项。`);
      await write("task." + identity(t), next);
      bump();
    },
    [legacy, day, store.dashboard.tasks],
  );
  const topics = useMemo(() => {
    const all = new Map<string, Topic>();
    for (const t of tasks) {
      const topic = topicOf(t);
      all.set(topic.key, topic);
      for (const tag of t.tags || []) {
        const key = JSON.stringify([t.libraryId, "tag", tag]);
        all.set(key, { key, name: "#" + tag, libraryId: t.libraryId, tag });
      }
    }
    return [...all.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [tasks]);
  const topicCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      if (t.status !== "open") continue;
      const keys = new Set([
        topicOf(t).key,
        ...(t.tags || []).map((tag) => JSON.stringify([t.libraryId, "tag", tag])),
        ...(allMeta.get(identity(t))?.topics || []),
      ]);
      for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [tasks, allMeta]);
  const chosen =
    read<string[] | null>("pins", null) === null
      ? topics
          .filter((t) => !t.tag && topicCounts.has(t.key))
          .sort((a, b) => (topicCounts.get(b.key) || 0) - (topicCounts.get(a.key) || 0))
          .slice(0, 4)
      : topics.filter((t) => pins.includes(t.key));
  const [mobileList,setMobileList]=useState("");
  const [mobileSource, setMobileSource] = useState("");
  const localSource = (task: typeof localRows[number]) => task.id.startsWith("document:") ? "原文转化" : task.source;
  const localListRows = localRows.filter(t => (!mobileList || mobileList === (t.list || "本机任务")) && (!mobileSource || mobileSource === localSource(t)));
  const scoped = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query && !project && !mobileList && !mobileSource) return tasks;
    return tasks.filter((task) => {
      if (mobileSource && providerName(task.provider) !== mobileSource) return false;
      if (mobileList && topicOf(task).name !== mobileList) return false;
      if (project && !inTopic(task, project, meta(task))) return false;
      if (!query) return true;
      return [task.title, task.collectionName, ...(task.tags || []), ...meta(task).waits.flatMap((w) => [w.who, w.what])]
        .join(" ").toLowerCase().includes(query);
    });
  }, [tasks, project, meta, search, mobileList, mobileSource]);
  const counts = useMemo(() => groupsFor(tasks, meta, day), [tasks, meta, day]);
  const grouped = useMemo(() => scoped === tasks ? counts : groupsFor(scoped, meta, day), [scoped, tasks, counts, meta, day]);
  const activeWait = (t: UnifiedTask) => t.status === "open" && meta(t).waits.some((w) => !w.resolved);
  // Each section owns disjoint rows, even when a planned task is due today.
  const allDidaLibraries = libraries.filter((l) => l.provider === "dida365");
  const writable = allDidaLibraries.filter(
    (l) => !selectedLibraryIds || selectedLibraryIds.includes(l.id),
  );
  const isAsyncLoading = Boolean(store.loading) && !store.ready && !tasks.length;
  const didaScopeMissing = !mobile && libraries.length > 0 && allDidaLibraries.length === 0;
  const didaExcludedByScope = !mobile && allDidaLibraries.length > 0 && writable.length === 0;
  const didaScopeLabel = writable.length
    ? writable.map((l) => l.name).join("、")
    : allDidaLibraries.length
      ? allDidaLibraries.map((l) => l.name).join("、")
      : "滴答清单";
  useEffect(() => {
    if (!initialTaskTarget) return;
    if (isAsyncLoading) return;
    const found = tasks.find(
      (t) =>
        t.libraryId === initialTaskTarget.libraryId &&
        (t.id === initialTaskTarget.taskId || t.sourceId === initialTaskTarget.taskId),
    );
    if (found) {
      setProject(null);
      setSearch("");
      setView(found.completed ? "done" : "all");
      setSelected(identity(found));
      onInitialTaskTargetHandled?.();
    } else if (store.ready !== false && !store.loading) {
      setNotice("未在当前滴答范围内找到关联任务，可能已归档或被资料库筛选排除。");
      onInitialTaskTargetHandled?.();
    }
  }, [initialTaskTarget, tasks, isAsyncLoading, store.ready, store.loading, onInitialTaskTargetHandled]);
  const preferred = project?.libraryId || destination;
  const lib = writable.some((l) => l.id === preferred) ? preferred : !project && writable.length === 1 ? writable[0].id : "";
  const dueToday = grouped.due.filter(
    (t) => dueDay(t) === day || meta(t).waits.some((w) => !w.resolved && w.review && w.review <= day),
  );
  const dueIds = new Set(dueToday.map(identity));
  const overdue = grouped.due.filter((t) => !dueIds.has(identity(t)));
  const initialTask =
    view === "done"
      ? grouped.done[0]
      : view === "waiting"
        ? scoped.find(activeWait)
        : grouped.plan[0] || dueToday[0] || overdue[0] || scoped.find((t) => !t.completed) || scoped[0];
  const selectedTask =
    selected === null ? (wide ? initialTask : undefined) : (mobile ? tasks : scoped).find((t) => identity(t) === selected) || (mobile && receiptTask && identity(receiptTask) === selected ? receiptTask : undefined);
  const pendingRequests = read<Record<string, QuickRequest>>("quick.requests", {});
  async function clearQuickRequest(request: QuickRequest) {
    const key = JSON.stringify([request.lib, request.project || "", request.title]);
    const pending = read<Record<string, QuickRequest>>("quick.requests", {});
    if (pending[key]?.id !== request.id) return;
    delete pending[key];
    await write("quick.requests", pending);
  }
  async function finishQuickRequest(request: QuickRequest, task: UnifiedTask) {
    if (request.day || request.topicKey)
      await update(task, (m) => ({
        ...m,
        day: request.day || m.day,
        topics: request.topicKey ? [...new Set([...(m.topics || []), request.topicKey])] : m.topics,
      }));
    await clearQuickRequest(request);
    setSelected(identity(task));
  }
  async function useSyncedTask(request: QuickRequest, task: UnifiedTask) {
    setPosting(true);
    try {
      await finishQuickRequest(request, task);
      setNotice("已采用所选的滴答任务。");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setPosting(false);
    }
  }
  async function create(resume?: QuickRequest) {
    if (posting || (!resume && (!lib || !title.trim()))) return;
    setPosting(true);
    setNotice("");
    try {
      const collection = project?.collection;
      const input = resume || {
        id: crypto.randomUUID(),
        title: title.replace(/\s*!高\s*$/, "").trim(),
        priority: /!高\s*$/.test(title) ? 5 : 0,
        day: !project && view === "focus" && !planFull ? day : undefined,
        lib,
        project: collection,
        topicKey: project?.tag ? project.key : undefined,
      };
      if (!input.title) throw Error("请输入行动标题。");
      const key = JSON.stringify([input.lib, input.project || "", input.title]);
      const pending = read<Record<string, QuickRequest>>("quick.requests", {});
      const request = pending[key] || input;
      if (!writable.some((l) => l.id === request.lib)) throw Error("请重新选择当前范围内的滴答资料库。");
      await write("quick.requests", { ...pending, [key]: request });
      const result = await native<{ state: string; error?: string; task?: UnifiedTask }>("createTask", {
        requestId: request.id,
        title: request.title,
        libraryId: request.lib,
        projectId: request.project,
        priority: request.priority || 0,
      });
      if (result.state === "failed") await clearQuickRequest(request);
      if (result.state !== "confirmed" || !result.task)
        throw Error(result.error || "结果待核对，重试会沿用原请求。");
      setTitle("");
      await finishQuickRequest(request, result.task);
      setNotice(result.error || "已采纳到滴答待办");
      await store.refresh();
    } catch (e) {
      setNotice(String(e));
    } finally {
      setPosting(false);
    }
  }
  const navigate = (v: View, t: Topic | null = null, taskKey: string | null = null) => {
    setView(v);
    setProject(t);
    setSelected(taskKey);
    if (window.innerWidth < 768) setNav(false);
    setSearch("");
  };
  const views = [
    ["focus", "今日聚焦", CalendarCheck],
    ["review", "每周回顾", CalendarRange],
    ["waiting", "等待催办", Clock3],
    ["all", "全部行动", List],
    ["done", "已闭环", CheckCheck],
  ] as const;
  const longOverdueCutoff = shiftDay(day, -7);
  const weeklyDueWaitCount = tasks.filter(
    (t) => !t.completed && t.status === "open" && meta(t).waits.some((w) => !w.resolved && (!w.review || w.review <= day)),
  ).length;
  const weeklyLongOverdueCount = tasks.filter(
    (t) => !t.completed && t.status === "open" && Boolean(dueDay(t)) && dueDay(t) < longOverdueCutoff,
  ).length;
  const weeklyStalledTopicsCount = chosen.filter((topic) => {
    const openInTopic = tasks.filter((t) => !t.completed && t.status === "open" && inTopic(t, topic, meta(t)));
    const unblocked = openInTopic.filter((t) => !hasBlockingWait(meta(t)));
    return !unblocked.some((t) => meta(t).day === day || meta(t).steps.some((s) => !s.done));
  }).length;
  const weeklyReviewCount = weeklyDueWaitCount + weeklyLongOverdueCount + weeklyStalledTopicsCount;
  async function createTopicNextStep(topic: Topic, nextTitle: string) {
    const clean = nextTitle.trim();
    if (!clean) throw Error("请输入行动标题。");
    if (!writable.some((l) => l.id === topic.libraryId)) throw Error("当前专题所属滴答资料库不可写入。");
    const result = await native<{ state: string; error?: string; task?: UnifiedTask }>("createTask", {
      requestId: crypto.randomUUID(),
      title: clean,
      libraryId: topic.libraryId,
      projectId: topic.collection,
      priority: 0,
    });
    if (result.state !== "confirmed" || !result.task) {
      throw Error(result.error || "滴答写入尚未确认，请稍后核对。");
    }
    await update(result.task, (m) => ({
      ...m,
      topics: topic.tag ? [...new Set([...(m.topics || []), topic.key])] : m.topics,
      steps: m.steps.length ? m.steps : [{ id: crypto.randomUUID(), text: clean, done: false }],
    }));
    setSelected(identity(result.task));
    await store.refresh();
  }
  const [rowLimits, setRowLimits] = useState<Record<string, number>>({});
  function rows(label: string, items: UnifiedTask[], empty?: string) {
    const listKey = JSON.stringify([scopeKey, view, project?.key, label]);
    const limit = rowLimits[listKey] || 60;
    const localGroup = !mobile ? [] : localListRows.filter(task => {
      if (view === "all") return true;
      if (view === "done") return task.done;
      if (task.done) return false;
      if (view === "waiting" || label === "等待跟进") return !!task.waiting;
      return label === "今日计划" && task.plannedDay === day && !task.waiting;
    });
    return (
      <section className="aw-list" aria-label={label}>
        <h3>
          {label} <small>{items.length+localGroup.length}{mobile ? "" : " 项"}</small>
        </h3>
        <div className="aw-group">
          {localGroup.map(localRow)}
          {!items.length && !localGroup.length && <p>{mobile ? (mobileList || mobileSource ? "当前筛选下没有任务" : "暂无" + label) : empty || "当前分组暂无行动项"}</p>}
          {items.slice(0, limit).map((t) => {
            const key = identity(t),
              m = meta(t),
              wait = t.completed ? [] : m.waits.filter((w) => !w.resolved),
              original = originals.get(t.id) || t;
            return (
              <div
                className={"aw-row" + (key === (selectedTask && identity(selectedTask)) ? " is-selected" : "")}
                key={key}
              >
                <TaskStatusControl
                  task={original}
                  busy={store.taskBusyIds.has(t.id)}
                  pendingStatus={store.taskStatusTargets.get(t.id)}
                  onChange={(task, done) =>
                    void store.setTaskCompleted(task, done).then((ok) => {
                      if (!ok) setNotice("完成状态尚待滴答核对");
                      else if (done) {
                        const m = meta(task);
                        if (m.note?.trim() || m.steps.some((s) => s.done) || m.waits.some((w) => w.resolved)) {
                          setClosureTaskKey(identity(task));
                          setSelected(identity(task));
                        }
                      } else if (closureTaskKey === identity(task)) {
                        setClosureTaskKey("");
                      }
                    })
                  }
                />
                <button className="aw-pick" onClick={() => setSelected(key)}>
                  <div className="aw-row-head">
                    <strong>{t.title}</strong>
                    {t.dueAt && (
                      <time className={dueDay(t) < day ? "late" : ""}>
                        {new Date(t.dueAt).toLocaleString("zh-CN", {
                          month: "numeric",
                          day: "numeric",
                          ...(t.isAllDay ? {} : { hour: "2-digit", minute: "2-digit" }),
                        })}
                      </time>
                    )}
                  </div>
                  {wait.map((w) => (
                    <div className="aw-delivery" key={w.id}>
                      {w.blocking ? "🔴 阻塞" : "⏳ 等"} {w.who} · {w.what} · {w.review}
                    </div>
                  ))}
                  <small>
                    {!project && <span>● {t.collectionName || t.documentTitle}</span>}
                    {m.day === day && <span className="aw-chip">今日计划</span>}
                    {wait.some((w) => w.review && w.review <= day) && <span className="aw-review">今天回看</span>}

                    {m.steps.length > 0 && (
                      <span>
                        {m.steps.filter((s) => s.done).length}/{m.steps.length} 步骤
                      </span>
                    )}
                    {m.links.length > 0 && <span className="aw-chip">已备料</span>}
                  </small>
                </button>
                {!t.completed && (
                  <button
                    className="aw-row-plan"
                    disabled={planFull && m.day !== day}
                    onClick={() =>
                      void update(t, (m) => ({ ...m, day: m.day === day ? "" : day })).catch((e) =>
                        setNotice(String(e)),
                      )
                    }
                  >
                    {m.day === day ? "移出今日" : "＋今日计划"}
                  </button>
                )}
                <TaskStatusNotice
                  task={original}
                  onRetry={() =>
                    void store.setTaskCompleted(original, original.statusMutation?.targetStatus === "completed")
                  }
                />
              </div>
            );
          })}
        </div>
        {items.length > limit && (
          <button type="button" onClick={() => setRowLimits((previous) => ({ ...previous, [listKey]: limit + 60 }))}>
            显示更多（已显示 {limit} / {items.length}）
          </button>
        )}
      </section>
    );
  }
  const todayFocusCount = dueToday.length + grouped.plan.length;
  const localRow=(task:(typeof localRows)[number])=><button className="bw-reading-row" key={task.id} onClick={()=>setLocalId(task.id)}><strong>{task.title}</strong><small>{task.source} · {task.list || "本机任务"}</small></button>;
  const dueEmptyMessage = store.error ? "????????????????" : isAsyncLoading
    ? "正在读取滴答任务…"
    : didaScopeMissing
      ? "尚未接入滴答清单资料库，桌面今日聚焦仅读取滴答主档"
      : didaExcludedByScope
        ? "当前资料库筛选未包含滴答清单，未计入滴答到期承诺"
        : "已核对当前滴答范围：今日无到期承诺或到点催办（真实 0 项）";
  const planEmptyMessage = store.error ? "????????????????" : isAsyncLoading
    ? "正在读取滴答任务…"
    : didaScopeMissing
      ? "接入滴答清单后即可将任务排入今日计划"
      : didaExcludedByScope
        ? "当前资料库筛选未包含滴答清单"
        : `已核对当前滴答范围：今天已排入 ${plannedCount} 项（真实 ${plannedCount} 项），最多 ${TODAY_PLAN_LIMIT} 项。`;
  const focusCommitments = rows(mobile ? "到期承诺" : "今日到期与到点催办", dueToday, dueEmptyMessage);
  const overdueDisclosure = overdue.length > 0 && (
    <details className="aw-overdue-disclosure" aria-label="历史逾期">
      <summary>
        <span className="aw-overdue-summary-left">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>历史逾期（已折叠，优先展示今日）</span>
        </span>
        <span className="aw-overdue-summary-right">
          <small>{overdue.length} 项</small>
          <ChevronDown size={13} aria-hidden="true" />
        </span>
      </summary>
      <div className="aw-overdue-bar">
        <span>避免历史积压淹没今日安排，可逐条加入今日或转入每周回顾统一处理。</span>
        <button type="button" onClick={() => navigate("review")}>
          去每周回顾处理 →
        </button>
      </div>
      {rows("历史逾期任务", overdue)}
    </details>
  );
  const scopeStrip = !mobile && (
    <div
      className={
        "aw-scope-strip" +
        (isAsyncLoading ? " is-loading" : didaScopeMissing || didaExcludedByScope ? " is-warn" : "")
      }
      role="status"
      aria-label="滴答范围与读取状态"
    >
      <span className="aw-scope-strip-text">
        {isAsyncLoading ? (
          <>
            <Loader2 size={12} className="aw-spin" aria-hidden="true" />
            <span>正在异步读取滴答清单任务（完成前不显示 0 项）…</span>
          </>
        ) : didaScopeMissing ? (
          <span>滴答范围：尚未接入滴答清单资料库（桌面行动工作台仅读写滴答主档）</span>
        ) : didaExcludedByScope ? (
          <span>滴答范围：当前资料库筛选已排除滴答清单（{didaScopeLabel}）</span>
        ) : store.error ? (
          <span>滴答范围：{didaScopeLabel} · 读取异常，以下不代表真实 0 项</span>
        ) : (
          <span>
            滴答范围：{didaScopeLabel} · 已核对 {tasks.filter((t) => !t.completed).length} 项未完
            {overdue.length > 0 ? `（含 ${overdue.length} 项历史逾期已折叠）` : ""}
          </span>
        )}
      </span>
      {didaExcludedByScope && onClearLibraryScope && (
        <button type="button" onClick={onClearLibraryScope}>
          恢复滴答范围
        </button>
      )}
    </div>
  );
  const boardColumns = (
    <div className="aw-columns">
      {rows(
        "今日到期与计划",
        [...grouped.due, ...grouped.plan].filter((t) => !activeWait(t)),
      )}
      {rows("等待催办雷达", scoped.filter(activeWait))}
      {rows("后续待排期", grouped.next)}
    </div>
  );
  useEffect(()=>{
    if (!mobile || mobileTarget || !(selected || localId || compose)) return;
    if(!window.history.state?.hubActionDetail) window.history.pushState({...window.history.state,hubActionDetail:true},"");
    const pop=(event:PopStateEvent)=>{if(!event.state?.hubActionDetail){event.stopImmediatePropagation();setSelected("");setLocalId("");setCompose(false);}};
    window.addEventListener("popstate",pop,true);return ()=>window.removeEventListener("popstate",pop,true);
  },[mobile,selected,localId,compose,mobileTarget]);
  const closeDetail=()=>{if(mobile&&window.history.state?.hubActionDetail) window.history.back();else setSelected("");};
  if(mobile && localTask) return <MobileLocalTaskDetail key={localTask.id} task={localTask} onChange={bump} back={()=>mobileTarget?onBackToInsight?.():closeDetail()}/>;
  const quickEntry = (
    <form
      className="aw-add"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <Plus size={16} />
      {writable.length > 1 && !project && (
        <select aria-label="新建目标资料库" value={lib} onChange={(e) => setDestination(e.target.value)}>
          <option value="">选择滴答资料库</option>
          {writable.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      )}
      <input
        aria-label="新建行动"
        value={title}
        maxLength={500}
        placeholder={
          project
            ? "在「" + project.name + "」下新建行动，回车同步滴答…"
            : view === "focus" && !planFull
              ? "随手记一条行动，回车加入今日计划并同步滴答（加 !高 标记高优）…"
              : "随手记一条行动，回车同步滴答…"
        }
        onChange={(e) => setTitle(e.target.value)}
      />
      <button disabled={posting || !lib || !title.trim()} aria-label="添加待办">
        Enter
      </button>
    </form>
  );
  const mobileViews: Record<View, string> = {
    focus: "今日聚焦",
    review: "每周回顾",
    waiting: "等待跟进",
    all: "全部任务",
    done: "已完成",
  };
  const harvester = (
    <ActionHarvester
    tasks={harvestTasks}
    journals={journals}
    scope={selectedLibraryIds}
    libraries={libraries}
    day={day}
    onUpdate={update}
    onRefresh={store.refresh}
    onOpenLocalTask={mobile ? setLocalId : undefined}
    onSelect={(t) => { if (mobile) setReceiptTask(t); setSelected(identity(t)); }}
    onOpen={onOpenResult}
    onCount={setClueCount}
    planFull={planFull}
    revision={refreshKey}
  />
  );
  return (
      <main
        style={
          {
            "--aw-paper-width": detailPercent + "fr",
            "--aw-list-width": 100 - detailPercent + "fr",
          } as React.CSSProperties
        }
        className={"aw-shell" + (nav ? "" : " aw-nav-hidden") + (selectedTask ? " has-detail" : "")}
      >
      {!mobile && nav && (
        <nav className="aw-nav">
          <h3>行动聚焦（按时间）</h3>
          {views.map(([id, label, Icon]) => (
            <button key={id} aria-pressed={!project && id === view} onClick={() => navigate(id)}>
              <Icon size={14} />
              {label}
              <small className="aw-count">
                {((id === "focus" && clueCount > 0) ||
                  (id === "review" && weeklyReviewCount > 0) ||
                  (id === "waiting" &&
                    tasks.some(
                      (t) =>
                        t.status === "open" &&
                        meta(t).waits.some((w) => !w.resolved && w.review && w.review <= day),
                    ))) && <i className="aw-alert-dot" />}
                {id === "focus"
                  ? isAsyncLoading
                    ? "…"
                    : todayFocusCount
                  : id === "review"
                    ? isAsyncLoading
                      ? "…"
                      : weeklyReviewCount
                    : id === "waiting"
                      ? tasks.filter(activeWait).length
                      : tasks.filter((t) => (id === "done" ? t.completed : !t.completed)).length}
              </small>
            </button>
          ))}
          <header>
            <h3>重点专题作战室</h3>
            <button aria-label="管理重点专题" onClick={() => setManage(!manage)}>
              ＋
            </button>
          </header>
          {chosen.map((t) => (
            <button key={t.key} aria-pressed={project?.key === t.key} onClick={() => navigate("all", t)}>
              <i className="aw-topic-dot" />
              {t.name}
              <small className="aw-count">{topicCounts.get(t.key) || 0}</small>
            </button>
          ))}
          {(!chosen.length || manage) && (
            <details open={manage}>
              <summary>选择清单或标签</summary>
              {topics.map((t) => (
                <label key={t.key}>
                  <input
                    type="checkbox"
                    checked={chosen.some((topic) => topic.key === t.key)}
                    onChange={() => {
                      const prev = read<string[]>(
                        "pins",
                        chosen.map((topic) => topic.key),
                      );
                      const next = prev.includes(t.key) ? prev.filter((k) => k !== t.key) : [...prev, t.key];
                      void write("pins", next).then(
                        () => setPins(next),
                        (e) => setNotice(String(e)),
                      );
                    }}
                  />
                  {t.name}
                </label>
              ))}
            </details>
          )}
          <footer>{clueCount ? "✦ 捕手有 " + clueCount + " 条待核对线索" : "滴答主档与本地检索已就绪"}</footer>
        </nav>
      )}
      <section className="aw-center">
        {mobile && <section className="bw-task-head">
          <header><h2>{mobileViews[view]}</h2><button onClick={() => setCompose(true)}>＋ 新建任务</button></header>
          <nav className="bw-tabs" aria-label="任务视图">{views.map(([id]) =>
            <button key={id} aria-pressed={view === id} onClick={() => navigate(id)}>{mobileViews[id]}</button>)}</nav>
          <div className="bw-task-tools">
            <MobileTaskFilter source={mobileSource} list={mobileList}
              options={[...tasks.map(t => ({source: providerName(t.provider), list: topicOf(t).name})),
                ...localRows.map(t => ({source: localSource(t), list: t.list || "本机任务"}))]}
              onApply={(source, list) => {setMobileSource(source); setMobileList(list);}}
              onSources={onSources}/>
            {harvester}
          </div>
        </section>}
        {!mobile && <header className="aw-bar">
          <button aria-label="切换任务导航" onClick={() => setNav(!nav)}>
            <PanelLeft size={17} />
          </button>
          <h2>{project?.name || views.find((v) => v[0] === view)?.[1]}</h2>
          {project ? (
            <button onClick={() => navigate("focus")}>← 今日聚焦</button>
          ) : (
            <small className="aw-total">
              {isAsyncLoading
                ? "正在读取滴答任务…"
                : `今日共 ${todayFocusCount} 项 · 计划 ${plannedCount}/${TODAY_PLAN_LIMIT}${overdue.length > 0 ? ` · 历史逾期 ${overdue.length}` : ""}`}
            </small>
          )}
          <label>
            <Search size={15} />
            <input
              placeholder="搜索行动、人名或专题"
              aria-label="搜索行动"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="aw-search-clear"
                aria-label="清空搜索"
                onClick={() => setSearch("")}
              >
                ×
              </button>
            )}
          </label>
          {!project && (
            <div className="aw-switch">
              <button aria-label="列表视图" aria-pressed={!board} onClick={() => setBoard(false)}>
                <List size={14} />
              </button>
              <button aria-label="看板视图" aria-pressed={board} onClick={() => setBoard(true)}>
                <Columns3 size={14} />
              </button>
            </div>
          )}
          {project ? (
            <button className="aw-ai" onClick={() => document.getElementById("aw-report")?.click()}>
              <Sparkles size={13} /> AI 专题复盘
            </button>
          ) : (
            <>
              <ActionEodReview
                tasks={tasks}
                day={day}
                meta={meta}
                onDeferTask={(t, nextDay) => update(t, (m) => ({ ...m, day: nextDay }))}
              />
              <ActionTodayPlan
                tasks={scoped}
                day={day}
                planFull={planFull}
                meta={meta}
                onPlan={(t) => update(t, (m) => ({ ...m, day }))}
              />
            </>
          )}
        </header>}
        <div className={"aw-scroll" + (board ? " aw-board" : "")}>
          {(store.error || journalError) && (
            <p role="alert">{[store.error, journalError].filter(Boolean).join(" · ")}</p>
          )}
          {notice && (
            <p className="aw-notice" role="status">
              {notice}
            </p>
          )}
          {selectedLibraryIds && <button onClick={onClearLibraryScope}>清除资料库范围</button>}
          {store.loading && !tasks.length && (mobile || (view !== "focus" && view !== "review")) && (
            <p>正在读取滴答任务…</p>
          )}
          {mobile && compose && <MobileTaskForm initialList={mobileList} onCancel={closeDetail} onSave={task=>{setCompose(false);setLocalId(task.id);bump();}}/>}
          {!mobile && !project && view !== "done" && view !== "review" && quickEntry}
          {project ? (
            <ActionTopic
              key={project.key}
              topic={project}
              recallCache={recallCache}
              tasks={tasks.filter((t) => inTopic(t, project, meta(t)))}
              meta={meta}
              journals={journals}
              scope={selectedLibraryIds}
              day={day}
              onOpen={onOpenResult}
            >
              {quickEntry}
              {rows(
                "当前外部阻塞",
                scoped.filter((t) => !t.completed && hasBlockingWait(meta(t))),
              )}
              {rows(
                "下一步行动",
                scoped.filter((t) => !t.completed && !hasBlockingWait(meta(t))),
              )}
              {rows("已闭环节点", grouped.done)}
            </ActionTopic>
          ) : view === "focus" ? (
            <>
              {scopeStrip}
              {!mobile && harvester}
              {isAsyncLoading ? (
                <section className="aw-loading-state" role="status" aria-label="异步读取滴答任务">
                  <Loader2 size={15} className="aw-spin" aria-hidden="true" />
                  <span>正在读取滴答任务…（加载完成前不会按 0 项显示）</span>
                </section>
              ) : board ? (
                boardColumns
              ) : (
                <>
                  {rows(
                    mobile ? "今日计划" : "今日计划（额外自选）",
                    grouped.plan,
                    planEmptyMessage,
                  )}
                  {focusCommitments}
                  {overdueDisclosure}
                  {(mobile || grouped.waiting.length > 0) && rows(mobile ? "等待跟进" : "等待他人", grouped.waiting)}
                </>
              )}
            </>
          ) : view === "review" ? (
            <>
              {scopeStrip}
              {isAsyncLoading ? (
                <section className="aw-loading-state" role="status" aria-label="异步读取滴答任务">
                  <Loader2 size={15} className="aw-spin" aria-hidden="true" />
                  <span>正在读取滴答任务…（加载完成前不汇总每周回顾）</span>
                </section>
              ) : (
                <ActionWeeklyReview
                  tasks={tasks}
                  topics={chosen}
                  meta={meta}
                  day={day}
                  planFull={planFull}
                  writable={writable}
                  onSelectTask={(t) => setSelected(identity(t))}
                  onUpdateTask={update}
                  onCompleteTask={async (t) => {
                    const ok = await store.setTaskCompleted(t, true);
                    if (!ok) setNotice("完成状态尚待滴答核对");
                  }}
                  onOpenTopic={(topic) => navigate("all", topic)}
                  onCreateTopicNextStep={createTopicNextStep}
                />
              )}
            </>
          ) : board && view === "all" ? (
            boardColumns
          ) : (
            rows(
              mobile ? mobileViews[view] : view === "waiting" ? "等待催办" : view === "done" ? "已闭环" : "全部行动",
              view === "waiting"
                ? scoped.filter(activeWait).sort((a, b) => {
                    const nextReview = (task: UnifiedTask) =>
                      meta(task)
                        .waits.filter((w) => !w.resolved && w.review)
                        .map((w) => w.review)
                        .sort()[0] || "9999";
                    return nextReview(a).localeCompare(nextReview(b)) || a.title.localeCompare(b.title, "zh-CN");
                  })
                : view === "done"
                  ? grouped.done
                  : mobile ? scoped : scoped.filter((t) => !t.completed),
              "当前范围内没有行动。",
            )
          )}
          {Object.values(pendingRequests)
            .filter((r) => writable.some((l) => l.id === r.lib))
            .map((r) => (
              <div key={r.id}>
                待核对 · {r.title}{" "}
                <button disabled={posting} onClick={() => void create(r)}>
                  核对原请求
                </button>
                {tasks
                  .filter(
                    (task) =>
                      task.libraryId === r.lib &&
                      task.title === r.title &&
                      (!r.project || r.project === task.collectionId),
                  )
                  .map((task) => (
                    <button key={identity(task)} disabled={posting} onClick={() => void useSyncedTask(r, task)}>
                      采用已同步任务 · {task.collectionName || task.documentTitle} · {task.sourceId}
                    </button>
                  ))}
              </div>
            ))}
        </div>
      </section>
      {selectedTask && (
        <>
          <div
            className="aw-divider"
            role="separator"
            aria-label="调整推进台宽度"
            tabIndex={0}
            aria-valuenow={detailPercent}
            onDoubleClick={() => setDetailPercent(44)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                setDetailPercent((v) => Math.min(62, Math.max(30, v + (e.key === "ArrowLeft" ? 1 : -1))));
              }
            }}
            onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              const rect = e.currentTarget.parentElement!.getBoundingClientRect();
              const width = rect.width - (nav ? 224 : 0);
              setDetailPercent(Math.min(62, Math.max(30, ((rect.right - e.clientX) / width) * 100)));
            }}
          />
          <ActionDetail
            key={identity(selectedTask)}
            task={selectedTask}
            recallCache={recallCache}
            topicClick={() => navigate("all", topicOf(selectedTask), identity(selectedTask))}
            completion={
              <TaskStatusControl
                task={selectedTask}
                busy={store.taskBusyIds.has(selectedTask.id)}
                pendingStatus={store.taskStatusTargets.get(selectedTask.id)}
                onChange={(t, done) =>
                  void store.setTaskCompleted(t, done).then((ok) => {
                    if (!ok) setNotice("完成状态尚待滴答核对");
                    else if (done) {
                      const m = meta(t);
                      if (m.note?.trim() || m.steps.some((s) => s.done) || m.waits.some((w) => w.resolved)) {
                        setClosureTaskKey(identity(t));
                      }
                    } else if (closureTaskKey === identity(t)) {
                      setClosureTaskKey("");
                    }
                  })
                }
              />
            }
            topics={chosen}
            planFull={planFull}
            justCompleted={closureTaskKey === identity(selectedTask)}
            onDismissClosure={() => setClosureTaskKey("")}
            meta={meta(selectedTask)}
            update={(fn) => update(selectedTask, fn)}
            journals={journals}
            scope={selectedLibraryIds}
            day={day}
            onOpen={onOpenResult}
            onOpenInsight={onOpenInsight}
            onClose={closeDetail}
          />
        </>
      )}
      </main>
  );
}
