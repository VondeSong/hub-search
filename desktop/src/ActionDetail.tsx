import { useEffect, useRef, useState } from "react";
import { resolveTaskResult } from "./TaskWorkspaceResult";
import { TaskPlanningPanel } from "./TaskPlanningPanel";
import { ActionSourceFields } from "./ActionSourceFields";
import { archiveAction } from "./ActionJournal";
import { identity } from "./ActionState";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import type { QuickJournalItem } from "./JournalRecords";
import type { SearchResult } from "./SearchTypes";
import type { ActionMeta, Draft, Topic } from "./ActionState";
import { generate, native, todayKey, type Material, type ModelMode } from "./ActionEvidence";
import { Materials, assembleMaterials, useRecall } from "./ActionMaterials";
import { sourceNoteStatus, type TaskNoteAction } from "./TaskPlanningSource";

export type UpdateMeta = (change: (m: ActionMeta) => ActionMeta) => Promise<void>;
export function SourceAppend({
  task,
  text,
  workId,
  onDone,
}: {
  task: UnifiedTask;
  text: string;
  workId: string;
  onDone?: (state: string) => void;
}) {
  const [action, setAction] = useState<TaskNoteAction | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(kind: "prepareNote" | "submitNote" | "inspectNote") {
    setBusy(true);
    setError("");
    try {
      const next = await native<TaskNoteAction>(
        kind,
        kind === "prepareNote"
          ? { taskId: task.id, contentRevision: task.contentRevision, workId, text }
          : { id: action?.id },
      );
      setAction(next);
      onDone?.(next.state);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {!action ? (
        <button disabled={busy || task.completed || !text.trim()} onClick={() => void run("prepareNote")}>
          预览追加到滴答备注
        </button>
      ) : (
        <>
          <span role="status">{sourceNoteStatus(action)}</span>
          {["prepared", "retryable"].includes(action.state) && (
            <details open>
              <summary>核对追加后的正文</summary>
              <pre>{action.after}</pre>
              <button disabled={busy} onClick={() => void run("submitNote")}>
                确认追加至滴答
              </button>
            </details>
          )}
          {["unknown", "writing"].includes(action.state) && (
            <button disabled={busy} onClick={() => void run("inspectNote")}>
              核对写入结果
            </button>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function DraftView({
  draft,
  journals,
  onOpen,
}: {
  draft: Draft;
  journals: QuickJournalItem[];
  onOpen?: (r: SearchResult) => void;
}) {
  return (
    <ol className="aw-claims">
      {draft.claims.map((claim, i) => {
        const source = draft.sources.find((m) => m.id === claim.source);
        return (
          <li key={i}>
            {claim.verify && <strong className="aw-review">⚠ 待核实 · </strong>}
            {claim.text}
            {source && (
              <details>
                <summary>依据 · {source.title}</summary>
                <blockquote>{claim.quote}</blockquote>
                <Materials items={[source]} journals={journals} onOpen={onOpen} />
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}
export function ActionDetail({
  task,
  meta,
  update,
  journals,
  scope,
  day,
  onOpen,
  waitInitially = false,
  onClose,
  topics = [],
}: {
  task: UnifiedTask;
  topics?: Topic[];
  meta: ActionMeta;
  update: UpdateMeta;
  journals: QuickJournalItem[];
  scope: string[] | null;
  day: string;
  onOpen?: (r: SearchResult) => void;
  waitInitially?: boolean;
  onClose: () => void;
}) {
  const recall = useRecall(task.title, scope);
  const [planning, setPlanning] = useState("");
  const pack = assembleMaterials(task.title, journals, recall.items, meta.links, day);
  const [waitOpen, setWaitOpen] = useState(waitInitially),
    [who, setWho] = useState(""),
    [what, setWhat] = useState(""),
    [review, setReview] = useState(day),
    [blocking, setBlocking] = useState(true);
  const [step, setStep] = useState(""),
    [note, setNote] = useState(meta.note || ""),
    [busy, setBusy] = useState(""),
    [status, setStatus] = useState("");
  const live = useRef(true),
    lock = useRef(false),
    lastSavedNote = useRef(meta.note || "");
  useEffect(() => {
    const previous = lastSavedNote.current;
    lastSavedNote.current = meta.note || "";
    setNote((current) => (current === previous ? meta.note || "" : current));
  }, [meta.note]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function act(label: string, fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setStatus("");
    try {
      await fn();
    } catch (e) {
      if (live.current) setStatus(String(e));
    } finally {
      lock.current = false;
      if (live.current) setBusy("");
    }
  }
  const change = (fn: (m: ActionMeta) => ActionMeta) => void act("保存", () => update(fn));
  async function draft(mode: ModelMode, waitId?: string) {
    const w = meta.waits.find((w) => w.id === waitId);
    const base: Material = {
      id: "task",
      title: task.title,
      text: [task.title, meta.note, ...meta.steps.map((s) => s.text), w && `${w.who} · ${w.what} · ${w.review}`]
        .filter(Boolean)
        .join("\n"),
    };
    const sources = [base, ...pack.all].slice(0, 32);
    const claims = await generate(mode, sources);
    if (!claims.length) throw Error("材料不足，尚无可核对的建议。");
    await update((m) => ({ ...m, draft: { mode, claims, sources, revision: task.contentRevision } }));
  }
  const staleDraft = !!meta.draft?.revision && meta.draft.revision !== task.contentRevision;
  const draftText =
    meta.draft?.claims
      .map(
        (c) =>
          (c.verify ? "待核实 · " : "") +
          c.text +
          "\n依据：" +
          (meta.draft?.sources.find((s) => s.id === c.source)?.title || "") +
          " · " +
          c.quote,
      )
      .join("\n\n") || "";
  function pin(material: Material) {
    change((m) => ({ ...m, links: [...m.links.filter((l) => l.id !== material.id), material] }));
  }
  return (
    <aside className="aw-detail" aria-label="任务推进台">
      <header>
        <small>{task.collectionName || task.documentTitle}</small>
        <button aria-label="关闭详情" onClick={onClose}>
          ×
        </button>
      </header>
      <h2>{task.title}</h2>
      <ActionSourceFields key={task.contentRevision} task={task} />
      {onOpen && (
        <button onClick={() => void act("打开原任务", async () => onOpen(await resolveTaskResult(task)))}>
          查看滴答原任务
        </button>
      )}
      {!!topics.length && (
        <details>
          <summary>关联重点专题</summary>
          {topics.map((topic) => (
            <label className="aw-step" key={topic.key}>
              <input
                type="checkbox"
                checked={meta.topics?.includes(topic.key) || false}
                onChange={() =>
                  change((m) => ({
                    ...m,
                    topics: m.topics?.includes(topic.key)
                      ? m.topics.filter((k) => k !== topic.key)
                      : [...(m.topics || []), topic.key],
                  }))
                }
              />
              {topic.name}
            </label>
          ))}
        </details>
      )}
      <div className="aw-tools">
        <button
          disabled={!!busy || task.completed}
          aria-pressed={meta.day === day}
          onClick={() => change((m) => ({ ...m, day: m.day === day ? "" : day }))}
        >
          {meta.day === day ? "移出今日计划" : "排入今天"}
        </button>
        <button disabled={task.completed} onClick={() => setWaitOpen((v) => !v)}>
          添加等待项
        </button>
        {task.dueAt && <small>截止 {new Date(task.dueAt).toLocaleString("zh-CN")}</small>}
      </div>
      {!!meta.waits.length && (
        <section>
          <h3>等待交付</h3>
          {meta.waits.map((w) => (
            <div className="aw-wait" key={w.id}>
              <strong>
                {w.who} · {w.what}
              </strong>
              <small>
                {w.resolved ? "已收到 · " + w.resolved : w.blocking ? "阻塞下一步" : "并行等回复"}
                {!w.resolved && w.review && " · " + w.review + " 回看"}
              </small>
              {!w.resolved && !task.completed && (
                <>
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      change((m) => ({
                        ...m,
                        waits: m.waits.map((row) => (row.id === w.id ? { ...row, resolved: todayKey() } : row)),
                      }))
                    }
                  >
                    标记已收到
                  </button>
                  <button disabled={!!busy} onClick={() => void act("起草催办", () => draft("followup", w.id))}>
                    起草催办
                  </button>
                </>
              )}
            </div>
          ))}
        </section>
      )}
      {waitOpen && (
        <form
          className="aw-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!who.trim() || !what.trim()) return;
            void act("保存", async () => {
              await update((m) => ({
                ...m,
                waits: [
                  ...m.waits,
                  { id: crypto.randomUUID(), who: who.trim(), what: what.trim(), review, blocking },
                ],
              }));
              setWaitOpen(false);
              setWho("");
              setWhat("");
            });
          }}
        >
          <label>
            等谁
            <input required value={who} onChange={(e) => setWho(e.target.value)} />
          </label>
          <label>
            等什么交付
            <input required value={what} onChange={(e) => setWhat(e.target.value)} />
          </label>
          <label>
            回看日
            <input required type="date" value={review} onChange={(e) => setReview(e.target.value)} />
          </label>
          <label>
            <input type="checkbox" checked={blocking} onChange={(e) => setBlocking(e.target.checked)} /> 阻塞下一步
          </label>
          <button disabled={!!busy}>保存等待项</button>
        </form>
      )}
      <section>
        <h3>
          执行步骤{" "}
          <small>
            {meta.steps.filter((s) => s.done).length}/{meta.steps.length}
          </small>
        </h3>
        {meta.steps.map((s) => (
          <label className="aw-step" key={s.id}>
            <input
              type="checkbox"
              disabled={!!busy || task.completed}
              checked={s.done}
              onChange={() =>
                change((m) => ({
                  ...m,
                  steps: m.steps.map((row) => (row.id === s.id ? { ...row, done: !row.done } : row)),
                }))
              }
            />
            {s.text}
          </label>
        ))}
        {!task.completed && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!step.trim()) return;
              const text = step.trim();
              void act("保存", async () => {
                await update((m) => ({
                  ...m,
                  steps: [...m.steps, { id: crypto.randomUUID(), text, done: false }],
                }));
                setStep("");
              });
            }}
          >
            <input
              aria-label="新步骤"
              placeholder="添加执行步骤，回车保存"
              value={step}
              onChange={(e) => setStep(e.target.value)}
            />
          </form>
        )}
        <button disabled={!!busy || task.completed} onClick={() => void act("拆解步骤", () => draft("steps"))}>
          AI 拆解步骤
        </button>
      </section>
      {recall.error && <p role="alert">资料检索失败 · {recall.error}</p>}
      {!!pack.all.length && (
        <section>
          <h3>任务备料</h3>
          <Materials
            items={pack.recent}
            journals={journals}
            onOpen={onOpen}
            onPin={pin}
            caption="近期现场记录（14 天加权）"
          />
          <Materials
            items={pack.long}
            journals={journals}
            onOpen={onOpen}
            onPin={pin}
            caption="长期规范与已确认图纸（跨时间窗）"
          />
          <button disabled={!!busy} onClick={() => void act("起草评审", () => draft("draft"))}>
            起草评审要点
          </button>
        </section>
      )}
      {meta.draft && (
        <section>
          <h3>
            {meta.draft.mode === "steps" ? "建议步骤" : meta.draft.mode === "followup" ? "催办消息" : "评审草稿"}
          </h3>
          {staleDraft && <p role="status">滴答原任务已更新，请按当前材料重新起草。</p>}
          <DraftView draft={meta.draft} journals={journals} onOpen={onOpen} />
          <button
            onClick={() =>
              void act("复制", async () => {
                await navigator.clipboard.writeText(draftText);
                setStatus("已复制草稿");
              })
            }
          >
            复制草稿
          </button>
          {meta.draft.mode === "steps" && !staleDraft && (
            <button
              disabled={!!busy || task.completed}
              onClick={() =>
                change((m) => ({
                  ...m,
                  steps: [
                    ...m.steps,
                    ...m
                      .draft!.claims.filter((c) => !m.steps.some((s) => s.text === c.text))
                      .map((c) => ({ id: crypto.randomUUID(), text: c.text, done: false })),
                  ],
                }))
              }
            >
              采纳为执行步骤
            </button>
          )}
          {!staleDraft && (
            <SourceAppend key={draftText} task={task} text={draftText} workId={"workbench-" + task.sourceId} />
          )}
        </section>
      )}
      <section>
        <h3>推进备注</h3>
        <textarea aria-label="推进备注" value={note} onChange={(e) => setNote(e.target.value)} />
        <button disabled={!!busy || note === (meta.note || "")} onClick={() => change((m) => ({ ...m, note }))}>
          保存备注
        </button>
        {note.trim() && (
          <SourceAppend key={note} task={task} text={note} workId={"workbench-note-" + task.sourceId} />
        )}
      </section>
      <button
        disabled={!!busy}
        onClick={() =>
          void act("记入日志", async () => {
            setStatus(
              await archiveAction(
                identity(task),
                [task.title, meta.note, ...meta.steps.filter((s) => s.done).map((s) => "✓ " + s.text)]
                  .filter(Boolean)
                  .join("\n"),
              ),
            );
          })
        }
      >
        记入今日日志
      </button>
      <button onClick={() => setPlanning((v) => (v ? "" : crypto.randomUUID()))}>分析与来源操作记录</button>
      {planning && (
        <TaskPlanningPanel
          request={{ id: planning, mode: "task", label: task.title, tasks: [task], historyOnly: task.completed }}
          onClose={() => setPlanning("")}
          onTask={() => {}}
          onSaved={() => void update((m) => m)}
        />
      )}
      <p role="status">{busy ? busy + "中…" : status}</p>
    </aside>
  );
}
