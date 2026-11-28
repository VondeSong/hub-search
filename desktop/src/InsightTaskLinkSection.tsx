import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, Link2, ListTodo, Loader2 } from "lucide-react";
import {
  createLinkedInsightTask,
  listInsightTaskLinks,
  saveInsightTaskLink,
  type InsightTaskLink,
} from "./InsightActionLinks";
import { useUnifiedTasks } from "./UnifiedTaskData";
import type { Insight } from "./InsightTypes";
import type { LibrarySummary } from "./SearchTypes";

export const INSIGHT_TASK_LINKS_CHANGED = "hub:insight-task-links-changed";

function safeListLinks(): InsightTaskLink[] {
  try {
    return listInsightTaskLinks();
  } catch {
    return [];
  }
}

export function InsightTaskLinkSection({
  insight,
  insightTitle,
  libraries,
  onOpenTask,
  disabled = false,
}: {
  insight: Insight;
  insightTitle: string;
  libraries?: LibrarySummary[];
  onOpenTask?: (target: { taskId: string; libraryId: string; insightId: string }) => void;
  disabled?: boolean;
}) {
  const [links, setLinks] = useState<InsightTaskLink[]>(() =>
    safeListLinks().filter((l) => l.insightId === insight.id),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState<"create" | "link">("create");
  const [titleDraft, setTitleDraft] = useState(() => insightTitle.slice(0, 180));
  const [libraryId, setLibraryId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState<0 | 5>(0);
  const [search, setSearch] = useState("");
  const [chosenTaskId, setChosenTaskId] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const sync = () => setLinks(safeListLinks().filter((l) => l.insightId === insight.id));
    sync();
    window.addEventListener(INSIGHT_TASK_LINKS_CHANGED, sync);
    return () => window.removeEventListener(INSIGHT_TASK_LINKS_CHANGED, sync);
  }, [insight.id]);

  useEffect(() => {
    setTitleDraft(insightTitle.slice(0, 180));
    setDrawerOpen(false);
    setFeedback("");
    setError("");
    setChosenTaskId("");
    setSearch("");
  }, [insight.id, insightTitle]);

  const tasksEnabled = Boolean((libraries && libraries.length > 0) || onOpenTask || drawerOpen || links.length > 0);
  const taskStore = useUnifiedTasks({ enabled: tasksEnabled });

  const didaTasks = useMemo(
    () =>
      taskStore.dashboard.tasks.filter(
        (t) => t.provider === "dida365" && !t.isProject && t.status !== "abandoned",
      ),
    [taskStore.dashboard.tasks],
  );

  const didaLibraries = useMemo(() => {
    const fromProps = (libraries || []).filter((l) => l.provider === "dida365");
    if (fromProps.length > 0) {
      return fromProps.map((l) => ({ id: l.id, name: l.name }));
    }
    const inferred = new Map<string, string>();
    for (const task of didaTasks) {
      if (!inferred.has(task.libraryId)) {
        inferred.set(task.libraryId, task.libraryName || "滴答清单");
      }
    }
    return [...inferred.entries()].map(([id, name]) => ({ id, name }));
  }, [libraries, didaTasks]);

  const effectiveLibraryId = didaLibraries.some((l) => l.id === libraryId)
    ? libraryId
    : didaLibraries.length === 1
      ? didaLibraries[0].id
      : "";

  const effectiveLibraryName =
    didaLibraries.find((l) => l.id === effectiveLibraryId)?.name || "滴答清单";

  const projectOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of didaTasks) {
      if (effectiveLibraryId && task.libraryId !== effectiveLibraryId) continue;
      if (task.collectionId && !map.has(task.collectionId)) {
        map.set(task.collectionId, task.collectionName || task.documentTitle || task.collectionId);
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"));
  }, [didaTasks, effectiveLibraryId]);

  const filteredExistingTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return didaTasks
      .filter((t) => {
        if (!q) return true;
        return `${t.title} ${t.collectionName || ""} ${t.documentTitle || ""} ${t.libraryName || ""}`
          .toLowerCase()
          .includes(q);
      })
      .slice(0, 60);
  }, [didaTasks, search]);

  const citationCount = insight.snapshot?.sourceCitations.length ?? 0;
  const revisionNumber = insight.contentRevision ?? insight.headRevision;
  const targetListLabel =
    (projectId && projectOptions.find(([id]) => id === projectId)?.[1]) || "收件箱";

  async function handleCreateAndLink() {
    const cleanTitle = titleDraft.trim();
    if (!cleanTitle) {
      setError("请先确认任务标题。");
      return;
    }
    if (!effectiveLibraryId) {
      setError("请选择要写入的滴答清单资料库。");
      return;
    }
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      const receipt = await createLinkedInsightTask({
        insightId: insight.id,
        title: cleanTitle,
        priority,
        libraryId: effectiveLibraryId,
        projectId: projectId || undefined,
      });
      if (receipt.state === "failed") {
        throw new Error(receipt.error || "滴答任务创建失败，未建立关联。");
      }
      if (receipt.state !== "confirmed") {
        throw new Error(receipt.error || "滴答创建结果待核对，可再次点击核对回执（不会重复建任务）。");
      }
      window.dispatchEvent(new Event(INSIGHT_TASK_LINKS_CHANGED));
      setLinks(safeListLinks().filter((l) => l.insightId === insight.id));
      setDrawerOpen(false);
      await taskStore.refresh();
      setFeedback(
        `已创建滴答任务「${cleanTitle}」至「${effectiveLibraryName} · ${receipt.projectName || targetListLabel}」，并建立双向关联。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleLinkExisting() {
    const picked = didaTasks.find((t) => `${t.libraryId}::${t.id}` === chosenTaskId);
    if (!picked) {
      setError("请先选择一项要关联的滴答任务。");
      return;
    }
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      await saveInsightTaskLink({
        insightId: insight.id,
        taskId: picked.id,
        libraryId: picked.libraryId,
      });
      window.dispatchEvent(new Event(INSIGHT_TASK_LINKS_CHANGED));
      setLinks(safeListLinks().filter((l) => l.insightId === insight.id));
      setDrawerOpen(false);
      setChosenTaskId("");
      setFeedback(
        `已关联滴答任务「${picked.title}」（${picked.collectionName || picked.documentTitle || "收件箱"} · ${picked.completed ? "已完成" : "待办"}）。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="insights-task-links" aria-label="关联滴答任务">
      <div className="insights-task-links-head">
        <div>
          <h4>
            <ListTodo size={15} aria-hidden="true" /> 关联滴答任务
            <small>{links.length} 项</small>
          </h4>
          <p className="insights-muted">创建或关联真实滴答任务，保留来源并支持双向跳转与状态同步。</p>
        </div>
        <button
          type="button"
          disabled={disabled || busy}
          aria-expanded={drawerOpen}
          onClick={() => {
            setError("");
            setDrawerOpen((v) => !v);
          }}
        >
          <ListTodo size={14} aria-hidden="true" />
          {drawerOpen ? "收起" : "创建 / 关联滴答任务"}
        </button>
      </div>

      {links.length > 0 && (
        <div className="insights-task-link-list">
          {links.map((link) => {
            const live = didaTasks.find(
              (t) => t.libraryId === link.libraryId && (t.id === link.taskId || t.sourceId === link.taskId),
            );
            const libName =
              live?.libraryName || didaLibraries.find((l) => l.id === link.libraryId)?.name || "滴答清单";
            const statusText = !live
              ? taskStore.loading
                ? "同步状态中…"
                : "未在当前滴答缓存中"
              : live.statusMutation?.state === "pending"
                ? "状态同步中"
                : live.completed
                  ? "已完成"
                  : "待办";
            const statusClass = !live
              ? "is-muted"
              : live.completed
                ? "is-done"
                : "is-open";
            return (
              <div className="insights-task-link-card" key={`${link.libraryId}:${link.taskId}`}>
                <div className="insights-task-link-info">
                  <div className="insights-task-link-title">
                    <span className={`insights-task-status-pill ${statusClass}`}>{statusText}</span>
                    <strong>{live?.title || `滴答任务 ${link.taskId}`}</strong>
                  </div>
                  <small>
                    {libName} · {live?.collectionName || live?.documentTitle || "收件箱"}
                    {live?.dueAt ? ` · 截止 ${live.dueAt.slice(0, 10)}` : ""}
                  </small>
                </div>
                {onOpenTask && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenTask({
                        taskId: live?.id || link.taskId,
                        libraryId: link.libraryId,
                        insightId: insight.id,
                      })
                    }
                  >
                    前往任务 <ArrowUpRight size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {feedback && (
        <p className="insights-task-feedback" role="status">
          {feedback}
        </p>
      )}
      {error && (
        <p className="insights-error" role="alert">
          {error}
        </p>
      )}

      {drawerOpen && !disabled && (
        <div className="insights-task-drawer" role="region" aria-label="创建或关联滴答任务确认">
          <div className="insights-task-drawer-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "create"}
              onClick={() => {
                setTab("create");
                setError("");
              }}
            >
              新建滴答任务
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "link"}
              onClick={() => {
                setTab("link");
                setError("");
              }}
            >
              关联已有任务
            </button>
          </div>

          {tab === "create" ? (
            <div className="insights-task-form">
              <label>
                <span>任务标题</span>
                <input
                  aria-label="滴答任务标题"
                  value={titleDraft}
                  maxLength={500}
                  onChange={(e) => {
                    setTitleDraft(e.target.value);
                  }}
                  placeholder="确认要写入滴答的任务标题"
                />
              </label>

              <div className="insights-task-form-grid">
                {didaLibraries.length > 1 ? (
                  <label>
                    <span>滴答资料库</span>
                    <select
                      aria-label="目标滴答资料库"
                      value={effectiveLibraryId}
                      onChange={(e) => {
                        setLibraryId(e.target.value);
                        setProjectId("");
                      }}
                    >
                      <option value="">选择滴答资料库</option>
                      {didaLibraries.map((lib) => (
                        <option key={lib.id} value={lib.id}>
                          {lib.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="insights-task-readonly-field">
                    <span>滴答资料库</span>
                    <strong>{didaLibraries[0]?.name || "尚未接入滴答清单资料库"}</strong>
                  </div>
                )}

                <label>
                  <span>目标清单</span>
                  <select
                    aria-label="目标滴答清单"
                    value={projectId}
                    disabled={!effectiveLibraryId}
                    onChange={(e) => {
                      setProjectId(e.target.value);
                    }}
                  >
                    <option value="">收件箱（默认）</option>
                    {projectOptions.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>优先级</span>
                  <select
                    aria-label="滴答任务优先级"
                    value={String(priority)}
                    onChange={(e) => {
                      setPriority(e.target.value === "5" ? 5 : 0);
                    }}
                  >
                    <option value="0">普通</option>
                    <option value="5">高优（!高）</option>
                  </select>
                </label>
              </div>

              <div className="insights-task-source-confirm">
                <span>来源确认</span>
                <p>
                  来源洞察：<strong>{insightTitle || insight.id}</strong> · 原事项：
                  {insight.workTitle || insight.workId} · 版本 v{revisionNumber} · {citationCount} 处依据。
                  将写入 {effectiveLibraryName} · {targetListLabel}，并在本机建立双向关联。
                </p>
              </div>

              <div className="insights-task-drawer-actions">
                <button type="button" disabled={busy} onClick={() => setDrawerOpen(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="insights-primary"
                  disabled={busy || !titleDraft.trim() || !effectiveLibraryId}
                  onClick={() => void handleCreateAndLink()}
                >
                  {busy ? (
                    <Loader2 size={14} className="aw-spin" aria-hidden="true" />
                  ) : (
                    <Check size={14} aria-hidden="true" />
                  )}
                  {busy ? "正在写入滴答…" : "确认创建并关联"}
                </button>
              </div>
            </div>
          ) : (
            <div className="insights-task-form">
              <label>
                <span>搜索已有滴答任务</span>
                <input
                  aria-label="筛选已有滴答任务"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="按标题或清单名称查找…"
                />
              </label>

              <label>
                <span>选择滴答任务</span>
                <select
                  aria-label="选择已有滴答任务"
                  value={chosenTaskId}
                  disabled={taskStore.loading && !didaTasks.length}
                  onChange={(e) => setChosenTaskId(e.target.value)}
                >
                  <option value="">
                    {taskStore.loading && !didaTasks.length
                      ? "正在读取滴答任务…"
                      : didaTasks.length
                        ? "选择要关联的滴答任务"
                        : "当前没有可关联的滴答任务"}
                  </option>
                  {filteredExistingTasks.map((t) => (
                    <option key={`${t.libraryId}::${t.id}`} value={`${t.libraryId}::${t.id}`}>
                      {t.title} · {t.collectionName || t.documentTitle || "收件箱"} ·{" "}
                      {t.completed ? "已完成" : "待办"}
                    </option>
                  ))}
                </select>
              </label>

              <div className="insights-task-source-confirm">
                <span>来源确认</span>
                <p>
                  确认将洞察「{insightTitle || insight.id}」（版本 v{revisionNumber}）与所选滴答任务双向关联，不修改滴答原任务内容。
                </p>
              </div>

              <div className="insights-task-drawer-actions">
                <button type="button" disabled={busy} onClick={() => setDrawerOpen(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="insights-primary"
                  disabled={busy || !chosenTaskId}
                  onClick={() => void handleLinkExisting()}
                >
                  <Link2 size={14} aria-hidden="true" />
                  确认关联
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
