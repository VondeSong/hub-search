import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CalendarCheck, CheckCheck, Clock3, Layers, List, PanelLeft, Search } from "lucide-react";
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
type QuickRequest = { id: string; title: string; lib: string; project?: string; topicKey?: string };
type View = "focus" | "waiting" | "all" | "done";
export function TaskWorkspace(props: Props) {
  if (runtimeCapabilities.mobile || props.sourceDocumentFilter) return <SourceTasks {...props} />;
  return <DesktopActions key={JSON.stringify(props.selectedLibraryIds ?? null)} {...props} />;
}
function DesktopActions({
  libraries = [],
  selectedLibraryIds = null,
  onClearLibraryScope,
  onToggleDesktopSidebar,
  onOpenResult,
}: Props) {
  const store = useUnifiedTasks();
  const [view, setView] = useState<View>("focus"),
    [project, setProject] = useState<Topic | null>(null),
    [search, setSearch] = useState("");
  const [selected, setSelected] = useState(""),
    [nav, setNav] = useState(true),
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
  const scopeKey = JSON.stringify(selectedLibraryIds);
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
    ]).then(
      ([data, cfg]) => {
        if (!live) return;
        setJournals(
          data.items
            .map((j) => ({ ...j, libraryId: j.libraryId || cfg.settings.libraryId }))
            .filter((j) => !j.deleted && (!selectedLibraryIds || selectedLibraryIds.includes(j.libraryId))),
        );
        setJournalError(data.error);
      },
      (e) => {
        if (live) setJournalError(String(e));
      },
    );
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
  const update = useCallback(
    async (t: UnifiedTask, fn: (m: ActionMeta) => ActionMeta) => {
      await write("task." + identity(t), fn(metaFor(t, legacy)));
      bump();
    },
    [legacy],
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
  const chosen = topics.filter((t) => pins.includes(t.key));
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
  const selectedTask = tasks.find((t) => identity(t) === selected);
  const pendingRequests = read<Record<string, QuickRequest>>("quick.requests", {});
  async function useSyncedTask(request: QuickRequest, task: UnifiedTask) {
    setPosting(true);
    try {
      if (request.topicKey)
        await update(task, (m) => ({ ...m, topics: [...new Set([...(m.topics || []), request.topicKey!])] }));
      const key = JSON.stringify([request.lib, request.project || "", request.title]);
      const pending = read<Record<string, QuickRequest>>("quick.requests", {});
      if (pending[key]?.id === request.id) {
        delete pending[key];
        await write("quick.requests", pending);
      }
      setSelected(identity(task));
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
        title: title.trim(),
        lib,
        project: collection,
        topicKey: project?.tag ? project.key : undefined,
      };
      const key = JSON.stringify([input.lib, input.project || "", input.title]);
      const pending = read<Record<string, QuickRequest>>("quick.requests", {});
      const request = pending[key] || input;
      await write("quick.requests", { ...pending, [key]: request });
      const result = await native<{ state: string; error?: string; task?: UnifiedTask }>("createTask", {
        requestId: request.id,
        title: request.title,
        libraryId: request.lib,
        projectId: request.project,
        priority: 0,
      });
      if (["failed", "confirmed"].includes(result.state)) {
        const latest = read<Record<string, QuickRequest>>("quick.requests", {});
        delete latest[key];
        await write("quick.requests", latest);
      }
      if (result.state !== "confirmed") throw Error(result.error || "结果待核对，重试会沿用原请求。");
      setTitle("");
      setNotice(result.error || "已采纳到滴答待办");
      await store.refresh();
      if (result.task) {
        if (request.topicKey)
          await update(result.task, (m) => ({
            ...m,
            topics: [...new Set([...(m.topics || []), request.topicKey!])],
          }));
        setSelected(identity(result.task));
      }
    } catch (e) {
      setNotice(String(e));
    } finally {
      setPosting(false);
    }
  }
  const navigate = (v: View, t: Topic | null = null) => {
    setView(v);
    setProject(t);
    setSelected("");
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
          {label} <small>{items.length}</small>
        </h3>
        {!items.length && empty && <p>{empty}</p>}
        {items.map((t) => {
          const key = identity(t),
            m = meta(t),
            wait = m.waits.filter((w) => !w.resolved),
            original = originals.get(t.id) || t;
          return (
            <div className={"aw-row" + (key === selected ? " is-selected" : "")} key={key}>
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
                <strong>{t.title}</strong>
                <small>
                  {t.dueAt && (
                    <span>
                      {new Date(t.dueAt).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        ...(t.isAllDay ? {} : { hour: "2-digit", minute: "2-digit" }),
                      })}
                    </span>
                  )}
                  {m.day === day && <span>今日计划</span>}
                  {wait.some((w) => w.review && w.review <= day) && <span className="aw-review">今天回看</span>}
                  {wait.length > 0 && <span>等 {wait.map((w) => w.who).join("、")}</span>}
                  {m.steps.length > 0 && (
                    <span>
                      {m.steps.filter((s) => s.done).length}/{m.steps.length} 步骤
                    </span>
                  )}
                  {m.links.length > 0 && <span>已关联材料</span>}
                </small>
              </button>
              <TaskStatusNotice
                task={original}
                onRetry={() =>
                  void store.setTaskCompleted(original, original.statusMutation?.targetStatus === "completed")
                }
              />
            </div>
          );
        })}
      </section>
    );
  }
  const dueToday = grouped.due.filter(
    (t) => dueDay(t) === day || meta(t).waits.some((w) => !w.resolved && w.review && w.review <= day),
  );
  const dueIds = new Set(dueToday.map(identity));
  const overdue = grouped.due.filter((t) => !dueIds.has(identity(t)));
  const focus = (
    <>
      {rows("今日到期与到点催办", dueToday, "今天没有到期或到点催办。")}
      {overdue.length > 0 && (
        <details className="aw-overdue">
          <summary>逾期未完成 · {overdue.length}</summary>
          {rows("逾期行动", overdue)}
        </details>
      )}
    </>
  );
  return (
    <main className={"aw-shell" + (nav ? "" : " aw-nav-hidden") + (selectedTask ? " has-detail" : "")}>
      {nav && (
        <nav className="aw-nav">
          <h3>行动聚焦</h3>
          {views.map(([id, label, Icon]) => (
            <button key={id} aria-pressed={!project && id === view} onClick={() => navigate(id)}>
              <Icon size={16} />
              {label}
            </button>
          ))}
          <header>
            <h3>重点专题</h3>
            <button aria-label="管理重点专题" onClick={() => setManage(!manage)}>
              ＋
            </button>
          </header>
          {chosen.map((t) => (
            <button key={t.key} aria-pressed={project?.key === t.key} onClick={() => navigate("all", t)}>
              <Layers size={15} />
              {t.name}
            </button>
          ))}
          {(!chosen.length || manage) && (
            <details open={manage}>
              <summary>选择清单或标签</summary>
              {topics.map((t) => (
                <label key={t.key}>
                  <input
                    type="checkbox"
                    checked={pins.includes(t.key)}
                    onChange={() => {
                      const prev = read<string[]>("pins", []);
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
        </nav>
      )}
      <section className="aw-center">
        <header className="aw-bar">
          <button aria-label="切换任务导航" onClick={() => setNav(!nav)}>
            <PanelLeft size={17} />
          </button>
          <h2>{project?.name || views.find((v) => v[0] === view)?.[1]}</h2>
          {onToggleDesktopSidebar && (
            <button onClick={onToggleDesktopSidebar} title="切换主导航">
              主导航
            </button>
          )}
          <button aria-pressed={board} onClick={() => setBoard(!board)}>
            {board ? "返回列表" : "看板视图"}
          </button>
          <label>
            <Search size={15} />
            <input
              placeholder="搜索行动、人名或专题"
              aria-label="搜索行动"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </header>
        <div className={"aw-scroll" + (board ? " aw-board" : "")}>
          {(store.error || journalError) && (
            <p role="alert">{[store.error, journalError].filter(Boolean).join(" · ")}</p>
          )}
          {selectedLibraryIds && <button onClick={onClearLibraryScope}>清除资料库范围</button>}
          {store.loading && !tasks.length && <p>正在读取滴答任务…</p>}
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
              {rows("外部等待", scoped.filter(activeWait))}
              {rows(
                "下一步行动",
                scoped.filter((t) => !t.completed && !activeWait(t)),
              )}
              {rows("已闭环节点", grouped.done)}
            </ActionTopic>
          ) : view === "focus" ? (
            <>
              {focus}
              <ActionTodayPlan
                tasks={scoped}
                day={day}
                meta={meta}
                onPlan={(t) => update(t, (m) => ({ ...m, day }))}
              />
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
                revision={refreshKey}
              />
              {rows(
                "今日计划",
                grouped.plan,
                `今天已排入 ${tasks.filter((t) => !t.completed && meta(t).day === day).length} 项，建议最多 5 项。`,
              )}
              {grouped.waiting.length > 0 && rows("等待他人", grouped.waiting)}
            </>
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
          {view !== "done" && (
            <form
              className="aw-add"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
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
                placeholder="记一条滴答待办"
                onChange={(e) => setTitle(e.target.value)}
              />
              <button disabled={posting || !lib || !title.trim()}>添加待办</button>
            </form>
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
        <ActionDetail
          key={identity(selectedTask)}
          task={selectedTask}
          topics={chosen}
          meta={meta(selectedTask)}
          update={(fn) => update(selectedTask, fn)}
          journals={journals}
          scope={selectedLibraryIds}
          day={day}
          onOpen={onOpenResult}
          onClose={() => setSelected("")}
        />
      )}
    </main>
  );
}
