import { useState } from "react";
import { native, todayKey } from "./ActionEvidence";
import { dueDay } from "./ActionState";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import { sourceNoteStatus, type TaskNoteAction } from "./TaskPlanningSource";

function formDate(task: UnifiedTask) {
  if (!task.dueAt) return "";
  if (task.isAllDay) return dueDay(task);
  const date = new Date(task.dueAt);
  if (!Number.isFinite(date.getTime())) return "";
  return (
    todayKey(date) + "T" + [date.getHours(), date.getMinutes()].map((v) => String(v).padStart(2, "0")).join(":")
  );
}
// Resolve the calendar day in the source's timezone, including DST transitions.
function dueInstant(value: string, task: UnifiedTask) {
  if (!value) return null;
  if (!task.isAllDay || !task.timeZone) return new Date(task.isAllDay ? value + "T00:00:00" : value).toISOString();
  const target = Date.parse(value + "T00:00:00Z");
  let at = target;
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: task.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const display = fmt.format(new Date(at)).replace(" ", "T");
    const diff = target - Date.parse(display + "Z");
    if (!diff) break;
    at += diff;
  }
  return new Date(at).toISOString();
}
export function ActionSourceFields({ task }: { task: UnifiedTask }) {
  const [title, setTitle] = useState(task.title),
    [due, setDue] = useState(() => formDate(task));
  const [prepared, setPrepared] = useState<TaskNoteAction | null>(null),
    [busy, setBusy] = useState(false),
    [msg, setMsg] = useState("");
  async function resume() {
    try {
      const history = await native<(TaskNoteAction & { changes?: { title?: string; dueDate?: string | null } })[]>(
        "listFields",
        { taskIds: [task.id] },
      );
      const last = history.find((row) => ["prepared", "retryable", "writing", "unknown"].includes(row.state));
      if (!last) return;
      setPrepared(last);
      setTitle(last.changes?.title ?? task.title);
      setDue(
        formDate({
          ...task,
          dueAt: last.changes && "dueDate" in last.changes ? last.changes.dueDate || undefined : task.dueAt,
        }),
      );
    } catch (e) {
      setMsg(String(e));
    }
  }
  async function run(action: "prepareFields" | "submitNote" | "inspectNote") {
    setMsg("");
    setBusy(true);
    try {
      const changes: Record<string, string | null> = {};
      if (title.trim() !== task.title) changes.title = title.trim();
      if (due !== formDate(task)) changes.dueDate = dueInstant(due, task);
      const result = await native<TaskNoteAction>(
        action,
        action === "prepareFields"
          ? { taskId: task.id, contentRevision: task.contentRevision, workId: crypto.randomUUID(), changes }
          : { id: prepared?.id },
      );
      setPrepared(result);
      setMsg(sourceNoteStatus(result));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (task.completed) return null;
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !prepared) void resume();
      }}
    >
      <summary>编辑滴答标题与截止时间</summary>
      <div className="aw-form">
        <label>
          标题
          <input
            value={title}
            disabled={!!prepared || busy}
            maxLength={500}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          截止
          <input
            type={task.isAllDay ? "date" : "datetime-local"}
            value={due}
            disabled={!!prepared || busy}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
        {!prepared ? (
          <button
            disabled={busy || !title.trim() || (title.trim() === task.title && due === formDate(task))}
            onClick={() => void run("prepareFields")}
          >
            核对滴答原任务
          </button>
        ) : ["prepared", "retryable"].includes(prepared.state) ? (
          <>
            <p>
              {task.title} → {title} · 截止 {due || "无"}
            </p>
            <button disabled={busy} onClick={() => void run("submitNote")}>
              确认修改滴答
            </button>
            <button disabled={busy} onClick={() => setPrepared(null)}>
              取消
            </button>
          </>
        ) : ["unknown", "writing"].includes(prepared.state) ? (
          <button disabled={busy} onClick={() => void run("inspectNote")}>
            核对原操作
          </button>
        ) : (
          <button
            disabled={busy}
            onClick={() => {
              setPrepared(null);
              setTitle(task.title);
              setDue(formDate(task));
            }}
          >
            继续编辑
          </button>
        )}
        {msg && <span role="status">{msg}</span>}
      </div>
    </details>
  );
}
