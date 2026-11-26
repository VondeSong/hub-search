import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CalendarCheck,
  CheckCheck,
  Clock3,
  Columns3,
  List,
  PanelLeft,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { TaskWorkspace as SourceTasks } from "./TaskWorkspace";
import { runtimeCapabilities } from "./RuntimePlatform";
import { useUnifiedTasks } from "./UnifiedTaskData";
import { TaskStatusControl, TaskStatusNotice } from "./TaskStatusControl";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import type { QuickJournalItem } from "./JournalRecords";
import { QUICK_JOURNAL_UPDATED } from "./QuickJournalEvents";
import { ActionTodayPlan } from "./ActionTodayPlan";
import { ActionHarvester } from "./ActionHarvester";
import { ActionDetail } from "./ActionDetail";
import { ActionTopic } from "./ActionTopic";
import { native, todayKey } from "./ActionEvidence";
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
type View = "focus" | "waiting" | "all" | "done";
export function TaskWorkspace(props: Props) {
  if (runtimeCapabilities.mobile || props.sourceDocumentFilter) return <SourceTasks {...props} />;
  return <DesktopActions key={JSON.stringify(props.selectedLibraryIds ?? null)} {...props} />;
}
function DesktopActions({ libraries = [], selectedLibraryIds = null, onClearLibraryScope, onOpenResult }: Props) {
  const store = useUnifiedTasks();
  const [view, setView] = useState<View>("focus"),
    [project, setProject] = useState<Topic | null>(null),
    [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null),
    [nav, setNav] = useState(() => window.innerWidth >= 768),
    [wide, setWide] = useState(() => window.innerWidth >= 1024),
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
    const paperWidth = window.matchMedia("(min-width: 1024px)");
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
  const [detailPercent, setDetailPercent] = useState(44);
  const [clueCount, setClueCount] = useState(0);
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
            t.provider === "dida365" &&
            !t.isProject &&
            t.status !== "abandoned" &&
            (!selectedLibraryIds || selectedLibraryIds.includes(t.libraryId)),
        )
        .sort(
          (a, b) =>
            (a.dueAt || "9999").localeCompare(b.dueAt || "9999") || a.title.localeCompare(b.title, "zh-CN"),
        ),
    [store.dashboard.tasks, scopeKey],
  );
  const originals = useMemo(() => new Map(store.dashboard.tasks.map((t) => [t.id, t])), [store.dashboard.tasks]);
  const legacy = useMemo(legacyRecords, [revision, store.dashboard.tasks]);
  const allMeta = useMemo(
    () => new Map(tasks.map((t) => [identity(t), metaFor(t, legacy)])),
    [tasks, legacy, revision],
  );
  const meta = (t: UnifiedTask) => allMeta.get(identity(t)) || metaFor(t, legacy);
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
  const matches = (t: UnifiedTask) =>
    [t.title, t.collectionName, ...(t.tags || []), ...meta(t).waits.flatMap((w) => [w.who, w.what])]
      .join(" ")
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  const scoped = tasks.filter((t) => (!project || inTopic(t, project, meta(t))) && matches(t));
  const grouped = groupsFor(scoped, meta, day);
  const activeWait = (t: UnifiedTask) => t.status === "open" && meta(t).waits.some((w) => !w.resolved);
  // Each section owns disjoint rows, even when a planned task is due today.
  const writable = libraries.filter(
    (l) => l.provider === "dida365" && (!selectedLibraryIds || selectedLibraryIds.includes(l.id)),
  );
  const lib = project?.libraryId || destination || (writable.length === 1 ? writable[0].id : "");
  const initialTask =
    view === "done"
      ? grouped.done[0]
      : view === "waiting"
        ? scoped.find(activeWait)
        : grouped.due[0] || grouped.plan[0] || scoped.find((t) => !t.completed) || scoped[0];
  const selectedTask =
    selected === null ? (wide ? initialTask : undefined) : scoped.find((t) => identity(t) === selected);
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
    ["waiting", "等待催办", Clock3],
    ["all", "全部行动", List],
    ["done", "已闭环", CheckCheck],
  ] as const;
  function rows(label: string, items: UnifiedTask[], empty?: string) {
    return (
      <section className="aw-list" aria-label={label}>
        <h3>
          {label} <small>{items.length} 项</small>
        </h3>
        <div className="aw-group">
          {!items.length && <p>{empty || "当前分组暂无行动项"}</p>}
          {items.map((t) => {
            const key = identity(t),
              m = meta(t),
              wait = m.waits.filter((w) => !w.resolved),
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
      </section>
    );
  }
  const dueToday = grouped.due.filter(
    (t) => dueDay(t) === day || meta(t).waits.some((w) => !w.resolved && w.review && w.review <= day),
  );
  const dueIds = new Set(dueToday.map(identity));
  const overdue = grouped.due.filter((t) => !dueIds.has(identity(t)));
  const counts = groupsFor(tasks, meta, day);
  const focusCount = counts.due.length + counts.plan.length + counts.waiting.length;
  const focus = rows("今日到期与到点催办", [...dueToday, ...overdue], "今日无到期承诺或到点催办项");
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
      {nav && (
        <nav className="aw-nav">
          <h3>行动聚焦（按时间）</h3>
          {views.map(([id, label, Icon]) => (
            <button key={id} aria-pressed={!project && id === view} onClick={() => navigate(id)}>
              <Icon size={14} />
              {label}
              <small className="aw-count">
                {((id === "focus" && clueCount > 0) ||
                  (id === "waiting" &&
                    tasks.some((t) => meta(t).waits.some((w) => !w.resolved && w.review && w.review <= day)))) && (
                  <i className="aw-alert-dot" />
                )}
                {id === "focus"
                  ? focusCount
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
        <header className="aw-bar">
          <button aria-label="切换任务导航" onClick={() => setNav(!nav)}>
            <PanelLeft size={17} />
          </button>
          <h2>{project?.name || views.find((v) => v[0] === view)?.[1]}</h2>
          {project ? (
            <button onClick={() => navigate("focus")}>← 今日聚焦</button>
          ) : (
            <small className="aw-total">
              今日共 {focusCount} 项 · 计划 {plannedCount}/{TODAY_PLAN_LIMIT}
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
            <ActionTodayPlan
              tasks={scoped}
              day={day}
              planFull={planFull}
              meta={meta}
              onPlan={(t) => update(t, (m) => ({ ...m, day }))}
            />
          )}
        </header>
        <div className={"aw-scroll" + (board ? " aw-board" : "")}>
          {(store.error || journalError) && (
            <p role="alert">{[store.error, journalError].filter(Boolean).join(" · ")}</p>
          )}
          {selectedLibraryIds && <button onClick={onClearLibraryScope}>清除资料库范围</button>}
          {store.loading && !tasks.length && <p>正在读取滴答任务…</p>}
          {!project && view !== "done" && quickEntry}
          {project ? (
            <ActionTopic
              key={project.key}
              topic={project}
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
              <ActionHarvester
                tasks={tasks}
                journals={journals}
                scope={selectedLibraryIds}
                libraries={libraries}
                day={day}
                onUpdate={update}
                onRefresh={store.refresh}
                onSelect={(t) => setSelected(identity(t))}
                onOpen={onOpenResult}
                onCount={setClueCount}
                planFull={planFull}
                revision={refreshKey}
              />
              {board ? (
                boardColumns
              ) : (
                <>
                  {focus}
                  {rows(
                    "今日计划（额外自选）",
                    grouped.plan,
                    `今天已排入 ${plannedCount} 项，最多 ${TODAY_PLAN_LIMIT} 项。`,
                  )}
                  {grouped.waiting.length > 0 && rows("等待他人", grouped.waiting)}
                </>
              )}
            </>
          ) : board && view === "all" ? (
            boardColumns
          ) : (
            rows(
              view === "waiting" ? "等待催办" : view === "done" ? "已闭环" : "全部行动",
              view === "waiting"
                ? scoped.filter(activeWait)
                : view === "done"
                  ? grouped.done
                  : scoped.filter((t) => !t.completed),
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
          {notice && <p role="status">{notice}</p>}
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
            topicClick={() => navigate("all", topicOf(selectedTask), identity(selectedTask))}
            completion={
              <TaskStatusControl
                task={selectedTask}
                busy={store.taskBusyIds.has(selectedTask.id)}
                onChange={(t, done) => void store.setTaskCompleted(t, done)}
              />
            }
            topics={chosen}
            planFull={planFull}
            meta={meta(selectedTask)}
            update={(fn) => update(selectedTask, fn)}
            journals={journals}
            scope={selectedLibraryIds}
            day={day}
            onOpen={onOpenResult}
            onClose={() => setSelected("")}
          />
        </>
      )}
    </main>
  );
}
