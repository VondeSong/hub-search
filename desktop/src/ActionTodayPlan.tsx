import { useState } from "react";
import { generate, shiftDay, type Claim } from "./ActionEvidence";
import { archiveAction } from "./ActionJournal";
import { hasBlockingWait, identity, type ActionMeta } from "./ActionState";
import type { UnifiedTask } from "./TaskWorkspacePresentation";

export function ActionTodayPlan({
  tasks,
  day,
  planFull = false,
  meta,
  onPlan,
}: {
  tasks: UnifiedTask[];
  day: string;
  planFull?: boolean;
  meta: (t: UnifiedTask) => ActionMeta;
  onPlan: (t: UnifiedTask) => Promise<void>;
}) {
  const [items, setItems] = useState<Claim[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [show, setShow] = useState(false);
  async function suggest() {
    setBusy(true);
    setError("");
    setItems([]);
    try {
      const open = tasks
        .filter((t) => t.status === "open" && !hasBlockingWait(meta(t)) && meta(t).day !== day)
        .slice(0, 32);
      if (!open.length) throw Error("范围内没有可排入今天的非阻塞行动。");
      const sources = open.map((t) => {
        const m = meta(t);
        const parallelWaits = m.waits.filter((w) => !w.resolved && !w.blocking);
        return {
          id: identity(t),
          title: t.title,
          text: [
            t.title,
            t.collectionName && "专题 " + t.collectionName,
            t.dueAt && "截止 " + t.dueAt,
            t.priority && "优先级 " + t.priority,
            m.steps.length && `步骤 ${m.steps.filter((s) => s.done).length}/${m.steps.length}`,
            parallelWaits.length &&
              "并行等待（不阻塞主线）" + parallelWaits.map((w) => `${w.who}·${w.what}`).join("、"),
          ]
            .filter(Boolean)
            .join("\n"),
        };
      });
      setItems((await generate("plan", sources)).slice(0, 5));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="aw-today-plan">
      <button
        className="aw-ai"
        disabled={busy || planFull}
        title={planFull ? "今日计划已满" : undefined}
        onClick={() => {
          setShow(true);
          void suggest();
        }}
      >
        ✦{busy ? "正在安排…" : "AI 安排今天"}
      </button>
      {show && (items.length > 0 || error) && (
        <div className="aw-suggestions">
          <button onClick={() => setShow(false)}>关闭</button>
          {items.map((item, i) => {
            const t = tasks.find((t) => identity(t) === item.source);
            return (
              t &&
              t.status === "open" && (
                <div key={i}>
                  <strong>{t.title}</strong>
                  <p>{item.text}</p>
                  <button
                    disabled={planFull || meta(t).day === day}
                    onClick={() => void onPlan(t).catch((e) => setError(String(e)))}
                  >
                    {meta(t).day === day ? "已排入今天" : "排入今天"}
                  </button>
                </div>
              )
            );
          })}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function ActionEodReview({
  tasks,
  day,
  meta,
  onDeferTask,
}: {
  tasks: UnifiedTask[];
  day: string;
  meta: (t: UnifiedTask) => ActionMeta;
  onDeferTask: (t: UnifiedTask, nextDay: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const doneToday = tasks.filter(
    (t) => t.completed && (!t.completedAt || t.completedAt.slice(0, 10) === day),
  );
  const unfinishedPlan = tasks.filter((t) => t.status === "open" && meta(t).day === day);
  const resolvedWaits = tasks.flatMap((t) =>
    meta(t)
      .waits.filter((w) => w.resolved === day)
      .map((w) => ({ taskTitle: t.title, who: w.who, what: w.what })),
  );
  const tomorrow = shiftDay(day, 1);
  async function deferAll() {
    setBusy(true);
    setStatus("");
    setIsError(false);
    try {
      for (const task of unfinishedPlan) {
        await onDeferTask(task, tomorrow);
      }
      setStatus(`已将 ${unfinishedPlan.length} 项未完计划顺延至 ${tomorrow}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }
  async function archiveEod() {
    setBusy(true);
    setStatus("");
    setIsError(false);
    try {
      const lines = [
        `今日收工复盘（${day}）`,
        `已闭环（${doneToday.length}）：${doneToday.map((t) => t.title).join("、") || "无"}`,
        `今日新收件（${resolvedWaits.length}）：${resolvedWaits.map((w) => `${w.who}·${w.what}`).join("、") || "无"}`,
        `未完今日计划（${unfinishedPlan.length}）：${unfinishedPlan.map((t) => t.title).join("、") || "无"}`,
      ].join("\n");
      setStatus(await archiveAction("eod." + day, lines, day));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="aw-today-plan">
      <button className="aw-eod-btn" onClick={() => setOpen((v) => !v)}>
        ✦ 日终复盘
      </button>
      {open && (
        <div className="aw-suggestions aw-eod-panel" role="dialog" aria-label="今日收工复盘">
          <div className="aw-eod-head">
            <strong>今日收工复盘 · {day}</strong>
            <button onClick={() => setOpen(false)}>关闭</button>
          </div>
          <p>
            已闭环 {doneToday.length} 项 · 新收件 {resolvedWaits.length} 项 · 未完计划 {unfinishedPlan.length} 项
          </p>
          {unfinishedPlan.length > 0 && (
            <ul>
              {unfinishedPlan.map((t) => (
                <li key={identity(t)}>{t.title}</li>
              ))}
            </ul>
          )}
          <div className="aw-tools">
            {unfinishedPlan.length > 0 && (
              <button disabled={busy} onClick={() => void deferAll()}>
                一键顺延未完计划至明天
              </button>
            )}
            <button disabled={busy} onClick={() => void archiveEod()}>
              归档今日小结至日志
            </button>
          </div>
          {status && <p role={isError ? "alert" : "status"}>{status}</p>}
        </div>
      )}
    </div>
  );
}
