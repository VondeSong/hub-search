import { useState } from "react";
import { generate, type Claim } from "./ActionEvidence";
import { identity, type ActionMeta } from "./ActionState";
import type { UnifiedTask } from "./TaskWorkspacePresentation";

export function ActionTodayPlan({
  tasks,
  day,
  meta,
  onPlan,
}: {
  tasks: UnifiedTask[];
  day: string;
  meta: (t: UnifiedTask) => ActionMeta;
  onPlan: (t: UnifiedTask) => Promise<void>;
}) {
  const [items, setItems] = useState<Claim[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const count = tasks.filter((t) => t.status === "open" && meta(t).day === day).length;
  async function suggest() {
    setBusy(true);
    setError("");
    setItems([]);
    try {
      const open = tasks
        .filter((t) => t.status === "open" && !meta(t).waits.some((w) => !w.resolved) && meta(t).day !== day)
        .slice(0, 32);
      if (!open.length) throw Error("范围内没有可排入今天的行动。");
      const sources = open.map((t) => ({
        id: identity(t),
        title: t.title,
        text: [t.title, t.dueAt && "截止 " + t.dueAt, t.priority && "优先级 " + t.priority]
          .filter(Boolean)
          .join("\n"),
      }));
      setItems((await generate("plan", sources)).slice(0, 5));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="aw-today-plan">
      <small>今日计划 {count} / 5</small>
      <button disabled={busy} onClick={() => void suggest()}>
        {busy ? "正在安排…" : "AI 安排今天"}
      </button>
      {items.map((item, i) => {
        const t = tasks.find((t) => identity(t) === item.source);
        return (
          t &&
          t.status === "open" && (
            <div key={i}>
              <strong>{t.title}</strong>
              <p>{item.text}</p>
              <button
                disabled={meta(t).day === day}
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
  );
}
