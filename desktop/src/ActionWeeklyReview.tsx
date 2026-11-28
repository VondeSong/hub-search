import { useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, Clock3, FolderOpen, Plus, Target } from "lucide-react";
import { nextMonday, shiftDay } from "./ActionEvidence";
import {
  dueDay,
  hasBlockingWait,
  identity,
  inTopic,
  readTopicReviews,
  saveTopicReview,
  type ActionMeta,
  type Topic,
} from "./ActionState";
import type { LibrarySummary } from "./SearchTypes";
import type { UnifiedTask } from "./TaskWorkspacePresentation";

function overdueDaysBetween(due: string, day: string): number {
  if (!due || due >= day) return 0;
  const a = Date.parse(day + "T12:00:00");
  const b = Date.parse(due + "T12:00:00");
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(1, Math.round((a - b) / 86_400_000)) : 1;
}

export function ActionWeeklyReview({
  tasks,
  topics,
  meta,
  day,
  planFull,
  writable,
  onSelectTask,
  onUpdateTask,
  onCompleteTask,
  onOpenTopic,
  onCreateTopicNextStep,
}: {
  tasks: UnifiedTask[];
  topics: Topic[];
  meta: (t: UnifiedTask) => ActionMeta;
  day: string;
  planFull: boolean;
  writable: LibrarySummary[];
  onSelectTask: (t: UnifiedTask) => void;
  onUpdateTask: (t: UnifiedTask, fn: (m: ActionMeta) => ActionMeta) => Promise<void>;
  onCompleteTask: (t: UnifiedTask) => Promise<void>;
  onOpenTopic: (topic: Topic) => void;
  onCreateTopicNextStep: (topic: Topic, title: string) => Promise<void>;
}) {
  const [includeShortOverdue, setIncludeShortOverdue] = useState(false);
  const [topicReviews, setTopicReviews] = useState<Record<string, string>>(readTopicReviews);
  const [quickTitles, setQuickTitles] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const longOverdueCutoff = useMemo(() => shiftDay(day, -7), [day]);

  const dueWaits = useMemo(() => {
    const rows: Array<{ task: UnifiedTask; wait: ActionMeta["waits"][number] }> = [];
    for (const task of tasks) {
      if (task.completed || task.status !== "open") continue;
      for (const wait of meta(task).waits) {
        if (wait.resolved) continue;
        if (!wait.review || wait.review <= day) {
          rows.push({ task, wait });
        }
      }
    }
    return rows.sort((a, b) => (a.wait.review || "0000").localeCompare(b.wait.review || "0000"));
  }, [tasks, meta, day]);

  const allOverdueTasks = useMemo(
    () =>
      tasks
        .filter((t) => !t.completed && t.status === "open" && Boolean(dueDay(t)) && dueDay(t) < day)
        .sort((a, b) => dueDay(a).localeCompare(dueDay(b))),
    [tasks, day],
  );

  const longOverdueTasks = useMemo(
    () => allOverdueTasks.filter((t) => includeShortOverdue || dueDay(t) < longOverdueCutoff),
    [allOverdueTasks, includeShortOverdue, longOverdueCutoff],
  );

  const longOverdueCoreCount = useMemo(
    () => allOverdueTasks.filter((t) => dueDay(t) < longOverdueCutoff).length,
    [allOverdueTasks, longOverdueCutoff],
  );

  const topicsWithoutNext = useMemo(() => {
    return topics
      .map((topic) => {
        const openTasks = tasks.filter((t) => !t.completed && t.status === "open" && inTopic(t, topic, meta(t)));
        const unblocked = openTasks.filter((t) => !hasBlockingWait(meta(t)));
        const hasNextStep = unblocked.some((t) => meta(t).day === day || meta(t).steps.some((s) => !s.done));
        let reason = "";
        if (openTasks.length === 0) reason = "暂无未完成行动";
        else if (unblocked.length === 0) reason = "全部行动处于外部阻塞，无非阻塞下一步";
        else if (!hasNextStep) reason = `有 ${unblocked.length} 项待办，但尚未拆解步骤或排入今日`;
        return {
          topic,
          openCount: openTasks.length,
          reason,
          reviewDate: topicReviews[topic.key] || "",
          canWrite: writable.some((l) => l.id === topic.libraryId),
        };
      })
      .filter((entry) => Boolean(entry.reason));
  }, [topics, tasks, meta, day, topicReviews, writable]);

  async function runAction(key: string, fn: () => Promise<void>, okMessage: string) {
    if (busyKey) return;
    setBusyKey(key);
    setError("");
    setStatus("");
    try {
      await fn();
      if (okMessage) setStatus(okMessage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey("");
    }
  }

  return (
    <div className="aw-weekly" aria-label="每周回顾">
      <header className="aw-weekly-head">
        <div>
          <h3>每周回顾 · {day}</h3>
          <p>集中核查到期等待、长期逾期与缺少下一步的重点专题；支持直接处理或设本地回看日，不擅自修改滴答原排期。</p>
        </div>
        <div className="aw-weekly-metrics">
          <span>
            到期等待 <strong>{dueWaits.length}</strong>
          </span>
          <span>
            长期逾期 <strong>{longOverdueCoreCount}</strong>
          </span>
          <span>
            无下一步专题 <strong>{topicsWithoutNext.length}</strong>
          </span>
        </div>
      </header>

      {error && <p role="alert">{error}</p>}
      {status && (
        <p className="aw-notice" role="status">
          {status}
        </p>
      )}

      <section className="aw-list aw-weekly-section" aria-label="到期等待">
        <h3>
          <Clock3 size={14} aria-hidden="true" /> 到期等待
          <small>{dueWaits.length} 项</small>
        </h3>
        <div className="aw-group">
          {!dueWaits.length && <p>当前没有到期或未定回看日的等待项。</p>}
          {dueWaits.map(({ task, wait }) => {
            const key = `${identity(task)}:${wait.id}`;
            return (
              <div className="aw-weekly-row" key={key}>
                <div className="aw-weekly-main">
                  <button type="button" className="aw-weekly-title" onClick={() => onSelectTask(task)}>
                    <strong>{task.title}</strong>
                    {wait.blocking && <span className="aw-weekly-tag is-danger">阻塞</span>}
                  </button>
                  <small>
                    等 {wait.who} · {wait.what} · {wait.review ? `回看 ${wait.review}` : "未设回看日"}
                  </small>
                </div>
                <div className="aw-weekly-actions">
                  <button
                    type="button"
                    className="aw-primary"
                    disabled={!!busyKey}
                    onClick={() =>
                      void runAction(
                        key + ":done",
                        () =>
                          onUpdateTask(task, (m) => ({
                            ...m,
                            waits: m.waits.map((row) => (row.id === wait.id ? { ...row, resolved: day } : row)),
                          })),
                        `已将「${wait.who} · ${wait.what}」标为已收到`,
                      )
                    }
                  >
                    <CheckCircle2 size={12} aria-hidden="true" /> 标记已收到
                  </button>
                  <button
                    type="button"
                    disabled={!!busyKey}
                    onClick={() =>
                      void runAction(
                        key + ":tomorrow",
                        () =>
                          onUpdateTask(task, (m) => ({
                            ...m,
                            waits: m.waits.map((row) =>
                              row.id === wait.id ? { ...row, review: shiftDay(day, 1) } : row,
                            ),
                          })),
                        `已将回看日设为明天（${shiftDay(day, 1)}）`,
                      )
                    }
                  >
                    明天
                  </button>
                  <button
                    type="button"
                    disabled={!!busyKey}
                    onClick={() =>
                      void runAction(
                        key + ":3d",
                        () =>
                          onUpdateTask(task, (m) => ({
                            ...m,
                            waits: m.waits.map((row) =>
                              row.id === wait.id ? { ...row, review: shiftDay(day, 3) } : row,
                            ),
                          })),
                        `已将回看日设为 ${shiftDay(day, 3)}`,
                      )
                    }
                  >
                    +3天
                  </button>
                  <button
                    type="button"
                    disabled={!!busyKey}
                    onClick={() =>
                      void runAction(
                        key + ":mon",
                        () =>
                          onUpdateTask(task, (m) => ({
                            ...m,
                            waits: m.waits.map((row) =>
                              row.id === wait.id ? { ...row, review: nextMonday(day) } : row,
                            ),
                          })),
                        `已将回看日设为下周一（${nextMonday(day)}）`,
                      )
                    }
                  >
                    下周一
                  </button>
                  <input
                    type="date"
                    aria-label={`设置等待项 ${wait.what} 回看日`}
                    value={wait.review || ""}
                    disabled={!!busyKey}
                    onChange={(e) => {
                      const nextDate = e.target.value;
                      void runAction(
                        key + ":date",
                        () =>
                          onUpdateTask(task, (m) => ({
                            ...m,
                            waits: m.waits.map((row) =>
                              row.id === wait.id ? { ...row, review: nextDate } : row,
                            ),
                          })),
                        nextDate ? `已将回看日设为 ${nextDate}` : "已清除等待回看日",
                      );
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="aw-list aw-weekly-section" aria-label="长期逾期">
        <h3>
          <CalendarClock size={14} aria-hidden="true" /> 长期逾期（{includeShortOverdue ? "全部历史逾期" : "超过 7 天"}）
          <small>{longOverdueTasks.length} 项</small>
          {allOverdueTasks.length > longOverdueCoreCount && (
            <button
              type="button"
              className="aw-weekly-toggle"
              onClick={() => setIncludeShortOverdue((v) => !v)}
            >
              {includeShortOverdue ? "仅看超过 7 天" : `含 1–7 天逾期 (${allOverdueTasks.length})`}
            </button>
          )}
        </h3>
        <div className="aw-group">
          {!longOverdueTasks.length && <p>当前范围内没有超过 7 天的长期逾期任务。</p>}
          {longOverdueTasks.map((task) => {
            const key = identity(task);
            const m = meta(task);
            const isToday = m.day === day;
            const due = dueDay(task);
            const daysLate = overdueDaysBetween(due, day);
            return (
              <div className="aw-weekly-row" key={key}>
                <div className="aw-weekly-main">
                  <button type="button" className="aw-weekly-title" onClick={() => onSelectTask(task)}>
                    <strong>{task.title}</strong>
                    <span className="aw-weekly-tag is-danger">逾期 {daysLate} 天</span>
                    {m.reviewDate && <span className="aw-weekly-tag is-info">回看 {m.reviewDate}</span>}
                  </button>
                  <small>
                    {task.collectionName || task.documentTitle || "收件箱"} · 原截止 {due}
                  </small>
                </div>
                <div className="aw-weekly-actions">
                  <button
                    type="button"
                    disabled={!!busyKey || (planFull && !isToday)}
                    onClick={() =>
                      void runAction(
                        key + ":today",
                        () => onUpdateTask(task, (prev) => ({ ...prev, day: prev.day === day ? "" : day })),
                        isToday ? `已移出今日计划：${task.title}` : `已加入今日计划：${task.title}`,
                      )
                    }
                  >
                    <Target size={12} aria-hidden="true" /> {isToday ? "移出今日" : "加入今日"}
                  </button>
                  <button
                    type="button"
                    disabled={!!busyKey}
                    onClick={() =>
                      void runAction(
                        key + ":complete",
                        () => onCompleteTask(task),
                        `已请求标记完成：${task.title}`,
                      )
                    }
                  >
                    标记完成
                  </button>
                  <button
                    type="button"
                    disabled={!!busyKey}
                    onClick={() =>
                      void runAction(
                        key + ":review-mon",
                        () => onUpdateTask(task, (prev) => ({ ...prev, reviewDate: nextMonday(day) })),
                        `已设为下周一（${nextMonday(day)}）回看：${task.title}`,
                      )
                    }
                  >
                    下周一
                  </button>
                  <input
                    type="date"
                    aria-label={`设置 ${task.title} 复盘回看日`}
                    value={m.reviewDate || ""}
                    disabled={!!busyKey}
                    onChange={(e) => {
                      const nextDate = e.target.value;
                      void runAction(
                        key + ":review-date",
                        () => onUpdateTask(task, (prev) => ({ ...prev, reviewDate: nextDate || undefined })),
                        nextDate ? `已将「${task.title}」回看日设为 ${nextDate}` : `已清除「${task.title}」回看日`,
                      );
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="aw-list aw-weekly-section" aria-label="无下一步的重点专题">
        <h3>
          <FolderOpen size={14} aria-hidden="true" /> 无下一步的重点专题
          <small>{topicsWithoutNext.length} 项</small>
        </h3>
        <div className="aw-group">
          {!topicsWithoutNext.length && (
            <p>{topics.length ? "当前重点专题均已有明确可推进的下一步。" : "尚未固定重点专题，可在左侧点击「＋」选择。"}</p>
          )}
          {topicsWithoutNext.map(({ topic, openCount, reason, reviewDate, canWrite }) => {
            const draft = quickTitles[topic.key] || "";
            return (
              <div className="aw-weekly-row is-topic" key={topic.key}>
                <div className="aw-weekly-main">
                  <div className="aw-weekly-topic-head">
                    <strong>{topic.name}</strong>
                    <span className="aw-weekly-tag">{openCount} 项未完</span>
                    {reviewDate && <span className="aw-weekly-tag is-info">回看 {reviewDate}</span>}
                  </div>
                  <small>{reason}</small>
                  <form
                    className="aw-weekly-next-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const clean = draft.trim();
                      if (!clean || !canWrite) return;
                      void runAction(
                        topic.key + ":next",
                        async () => {
                          await onCreateTopicNextStep(topic, clean);
                          setQuickTitles((prev) => ({ ...prev, [topic.key]: "" }));
                        },
                        `已为专题「${topic.name}」新增下一步「${clean}」并同步滴答`,
                      );
                    }}
                  >
                    <input
                      aria-label={`为重点专题 ${topic.name} 新增下一步`}
                      placeholder={
                        canWrite
                          ? `为「${topic.name}」补一条明确下一步，回车同步滴答…`
                          : "当前专题所属滴答资料库不可写入"
                      }
                      value={draft}
                      disabled={!!busyKey || !canWrite}
                      onChange={(e) => setQuickTitles((prev) => ({ ...prev, [topic.key]: e.target.value }))}
                    />
                    <button type="submit" className="aw-primary" disabled={!!busyKey || !canWrite || !draft.trim()}>
                      <Plus size={12} aria-hidden="true" /> 补下一步
                    </button>
                  </form>
                </div>
                <div className="aw-weekly-actions">
                  <button type="button" onClick={() => onOpenTopic(topic)}>
                    进入专题
                  </button>
                  <button
                    type="button"
                    disabled={!!busyKey}
                    onClick={() =>
                      void runAction(
                        topic.key + ":review-mon",
                        async () => {
                          const next = await saveTopicReview(topic.key, nextMonday(day));
                          setTopicReviews(next);
                        },
                        `已为专题「${topic.name}」设置下周一（${nextMonday(day)}）回看`,
                      )
                    }
                  >
                    下周一
                  </button>
                  <input
                    type="date"
                    aria-label={`设置重点专题 ${topic.name} 回看日`}
                    value={reviewDate}
                    disabled={!!busyKey}
                    onChange={(e) => {
                      const nextDate = e.target.value;
                      void runAction(
                        topic.key + ":review-date",
                        async () => {
                          const next = await saveTopicReview(topic.key, nextDate);
                          setTopicReviews(next);
                        },
                        nextDate
                          ? `已将专题「${topic.name}」回看日设为 ${nextDate}`
                          : `已清除专题「${topic.name}」回看日`,
                      );
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
