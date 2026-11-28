import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, CalendarClock, Clock3, Layers3, Plus, Sparkles, Target, X } from "lucide-react";
import { AgentPanelContext, AgentTextMaterialContext } from "./StandaloneAgentLauncher";
import { resolveTaskResult } from "./TaskWorkspaceResult";
import { TaskPlanningPanel } from "./TaskPlanningPanel";
import { ActionSourceFields } from "./ActionSourceFields";
import { archiveAction } from "./ActionJournal";
import { dueDay, identity } from "./ActionState";
import { listInsightTaskLinks, type InsightTaskLink } from "./InsightActionLinks";
import { INSIGHT_TASK_LINKS_CHANGED } from "./InsightTaskLinkSection";
import type { Insight } from "./InsightTypes";
import { findingSections } from "./InsightFindingText";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import type { QuickJournalItem } from "./JournalRecords";
import type { SearchResult } from "./SearchTypes";
import type { ActionMeta, Draft, Topic } from "./ActionState";
import {
  detectMeasurementConflicts,
  generate,
  native,
  nextMonday,
  shiftDay,
  type Material,
  type ModelMode,
} from "./ActionEvidence";
import { Materials, assembleMaterials, useRecall, type RecallCache } from "./ActionMaterials";
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
        const citations =
          claim.citations && claim.citations.length
            ? claim.citations
            : [{ source: claim.source, quote: claim.quote }];
        return (
          <li key={i}>
            {claim.verify && <strong className="aw-review">⚠ 待核实 · </strong>}
            {claim.text}
            {citations.map((cite, j) => {
              const source = draft.sources.find((m) => m.id === cite.source);
              return (
                source && (
                  <details key={j}>
                    <summary>依据 · {source.title}</summary>
                    <blockquote>{cite.quote}</blockquote>
                    <Materials items={[source]} journals={journals} onOpen={onOpen} />
                  </details>
                )
              );
            })}
          </li>
        );
      })}
    </ol>
  );
}
export function ActionDetail({
  task,
  recallCache,
  meta,
  update,
  journals,
  scope,
  day,
  onOpen,
  onOpenInsight,
  topicClick,
  completion,
  waitInitially = false,
  planFull = false,
  justCompleted = false,
  onDismissClosure,
  onClose,
  topics = [],
}: {
  task: UnifiedTask;
  topics?: Topic[];
  recallCache?: RecallCache;
  meta: ActionMeta;
  update: UpdateMeta;
  journals: QuickJournalItem[];
  scope: string[] | null;
  day: string;
  onOpen?: (r: SearchResult) => void;
  onOpenInsight?: (insightId: string) => void;
  topicClick?: () => void;
  completion?: React.ReactNode;
  waitInitially?: boolean;
  planFull?: boolean;
  justCompleted?: boolean;
  onDismissClosure?: () => void;
  onClose: () => void;
}) {
  const agent = useContext(AgentPanelContext);
  const materialContext = useContext(AgentTextMaterialContext);
  const recall = useRecall(task.title, scope, [], recallCache);
  const [planning, setPlanning] = useState("");
  const [insightLinks, setInsightLinks] = useState<InsightTaskLink[]>(() => {
    try {
      return listInsightTaskLinks().filter(
        (link) => link.libraryId === task.libraryId && (link.taskId === task.id || link.taskId === task.sourceId),
      );
    } catch {
      return [];
    }
  });
  const [linkedInsightMeta, setLinkedInsightMeta] = useState<
    Record<string, { title: string; status: string; validity: string }>
  >({});
  useEffect(() => {
    const refreshLinks = () => {
      try {
        setInsightLinks(
          listInsightTaskLinks().filter(
            (link) =>
              link.libraryId === task.libraryId && (link.taskId === task.id || link.taskId === task.sourceId),
          ),
        );
      } catch {
        setInsightLinks([]);
      }
    };
    refreshLinks();
    window.addEventListener(INSIGHT_TASK_LINKS_CHANGED, refreshLinks);
    return () => window.removeEventListener(INSIGHT_TASK_LINKS_CHANGED, refreshLinks);
  }, [task.id, task.sourceId, task.libraryId]);
  useEffect(() => {
    if (!insightLinks.length) {
      setLinkedInsightMeta({});
      return;
    }
    let active = true;
    const stateLabel: Record<string, string> = { attention: "待关注", later: "稍后", done: "已处理" };
    const validityLabel: Record<string, string> = {
      available: "依据已核对",
      review: "待复核",
      unavailable: "来源不可用",
    };
    void Promise.all(
      insightLinks.map(async (link) => {
        try {
          const detail = await invoke<Insight>("agent_investigation", {
            args: { action: "insightDetail", insightId: link.insightId },
          });
          const body = detail?.snapshot?.text ? findingSections(detail.snapshot.text).body : "";
          const firstLine = body.split(/\n/)[0]?.replace(/\*\*/g, "").trim() || "";
          const title = firstLine
            ? firstLine.length <= 68
              ? firstLine
              : firstLine.slice(0, 60) + "…"
            : detail?.workTitle || `洞察 ${link.insightId}`;
          return [
            link.insightId,
            {
              title,
              status: stateLabel[detail?.processingState || ""] || "已保存",
              validity: validityLabel[detail?.validity || ""] || "",
            },
          ] as const;
        } catch {
          return [link.insightId, { title: `洞察 ${link.insightId}`, status: "已关联", validity: "" }] as const;
        }
      }),
    ).then((entries) => {
      if (active) setLinkedInsightMeta(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [insightLinks]);
  const pack = useMemo(
    () => assembleMaterials(task.title, journals, recall.items, meta.links, day),
    [task.title, journals, recall.items, meta.links, day],
  );
  const conflicts = useMemo(
    () => detectMeasurementConflicts(pack.recent, pack.long),
    [pack.recent, pack.long],
  );
  const [waitOpen, setWaitOpen] = useState(waitInitially),
    [editingWaitId, setEditingWaitId] = useState<string | null>(null),
    [who, setWho] = useState(""),
    [what, setWhat] = useState(""),
    [review, setReview] = useState(""),
    [blocking, setBlocking] = useState(true);
  const [step, setStep] = useState(""),
    [note, setNote] = useState(meta.note || ""),
    [busy, setBusy] = useState(""),
    [status, setStatus] = useState(""),
    [statusError, setStatusError] = useState(false);
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
    setStatusError(false);
    try {
      await fn();
    } catch (e) {
      if (live.current) {
        setStatus(e instanceof Error ? e.message : String(e));
        setStatusError(true);
      }
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
    await update((m) => ({ ...m, draft: { mode, claims, sources, revision: task.contentRevision, waitId } }));
  }
  const staleDraft = !!meta.draft?.revision && meta.draft.revision !== task.contentRevision;
  const unboundFollowup = meta.draft?.mode === "followup" && !meta.draft.waitId;
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
  function resolveWait(id: string, resolved?: string) {
    change((m) => ({
      ...m,
      waits: m.waits.map((row) => (row.id === id ? { ...row, resolved } : row)),
      draft:
        resolved && m.draft?.mode === "followup" && (!m.draft.waitId || m.draft.waitId === id)
          ? undefined
          : m.draft,
    }));
  }
  const due = dueDay(task);
  const hasMaterials = pack.all.length > 0;
  const dueTime =
    due &&
    !task.isAllDay &&
    new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(task.dueAt!));
  return (
    <aside className="aw-detail" aria-label="任务推进台">
      <header>
        <button className="aw-origin" onClick={topicClick}>
          <i className="aw-topic-dot" />
          <span>{task.collectionName || task.documentTitle || "收件箱"}</span>
        </button>
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
        <button
          className="aw-ask"
          onClick={() => {
            if (!agent || !materialContext) {
              setPlanning(crypto.randomUUID());
              return;
            }
            materialContext.setPending({
              kind: "text",
              title: task.title,
              text: [
                task.title,
                meta.note,
                ...meta.waits.map((w) => [w.who, w.what, w.resolved ? "已收到" : w.review].join(" · ")),
                ...pack.all.map((m) => m.title + " · " + m.text),
              ]
                .filter(Boolean)
                .join("\n")
                .slice(0, 2450),
            });
            agent(null);
          }}
        >
          <Sparkles size={14} aria-hidden="true" /> 问助手
        </button>
        <button aria-label="关闭详情" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="aw-detail-scroll">
        {justCompleted && task.completed && (
          <div className="aw-closure-banner" role="status">
            <span>任务已闭环 · 是否将推进结论沉淀至今日日志？</span>
            <div className="aw-wait-actions">
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
                    onDismissClosure?.();
                  })
                }
              >
                一键归档至今日日志
              </button>
              <button onClick={() => onDismissClosure?.()}>跳过</button>
            </div>
          </div>
        )}
        <div className="aw-detail-content">
          <div className="aw-detail-title">
            {completion}
            <h2>{task.title}</h2>
          </div>
          <div className="aw-detail-controls">
            <button
              disabled={!!busy || task.completed || (planFull && meta.day !== day)}
              title={planFull && meta.day !== day ? "今日计划已满" : undefined}
              aria-pressed={meta.day === day}
              onClick={() => change((m) => ({ ...m, day: m.day === day ? "" : day }))}
            >
              <Target size={12} aria-hidden="true" />
              {meta.day === day ? "已在今日计划" : "＋ 加入今日计划"}
            </button>
            <button
              disabled={task.completed}
              onClick={() => {
                if (editingWaitId) {
                  setEditingWaitId(null);
                  setWho("");
                  setWhat("");
                  setReview("");
                  setBlocking(true);
                  setWaitOpen(true);
                } else {
                  setWaitOpen((v) => !v);
                }
              }}
            >
              <Clock3 size={12} aria-hidden="true" /> ＋ 新增等待项
            </button>
            <small>
              截止：{due === day ? "今天" : due || "未排期"}
              {dueTime && " " + dueTime}
            </small>
            {meta.reviewDate && (
              <span className="aw-review-pill">
                <CalendarClock size={11} aria-hidden="true" />
                回看：{meta.reviewDate}
                <button
                  type="button"
                  aria-label="清除本地回看日"
                  disabled={!!busy}
                  onClick={() => change((m) => ({ ...m, reviewDate: undefined }))}
                >
                  ×
                </button>
              </span>
            )}
          </div>
          {insightLinks.length > 0 && (
            <section className="aw-linked-insights" aria-label="关联洞察">
              <h3>
                <Layers3 size={13} aria-hidden="true" /> 关联洞察（{insightLinks.length}）
              </h3>
              <div className="aw-linked-insight-list">
                {insightLinks.map((link) => {
                  const info = linkedInsightMeta[link.insightId];
                  return (
                    <div className="aw-linked-insight-card" key={`${link.insightId}:${link.taskId}`}>
                      <div className="aw-linked-insight-copy">
                        <strong>{info?.title || `洞察 ${link.insightId}`}</strong>
                        <small>
                          {info?.status || "已关联"}
                          {info?.validity ? ` · ${info.validity}` : ""}
                        </small>
                      </div>
                      {onOpenInsight && (
                        <button type="button" onClick={() => onOpenInsight(link.insightId)}>
                          回到洞察详情 <ArrowUpRight size={12} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          {!!meta.waits.length && (
            <section>
              <h3>等待交付</h3>
              {meta.waits.map((w) => (
                <div
                  className={"aw-wait " + (w.resolved ? "received" : w.blocking ? "blocking" : "parallel")}
                  key={w.id}
                >
                  <div className="aw-wait-top">
                    <span className="aw-wait-badge">
                      {w.resolved ? "✓ 已收到" : w.blocking ? "阻塞下一步" : "并行等回复"}
                    </span>
                    <strong>{w.who}</strong>
                    <time>{w.resolved || (w.review && w.review + " 回看")}</time>
                  </div>
                  <div className="aw-wait-deliverable">交付物：{w.what}</div>
                  {!task.completed && (
                    <div className="aw-wait-actions">
                      {!w.resolved ? (
                        <>
                          <button
                            disabled={!!busy}
                            onClick={() =>
                              void act("复制催办", async () => {
                                await navigator.clipboard.writeText(
                                  meta.draft?.mode === "followup" && meta.draft.waitId === w.id && !staleDraft
                                    ? draftText
                                    : "想跟进一下「" + w.what + "」，方便说一下目前进度和预计交付时间吗？",
                                );
                                setStatus("已复制催办");
                              })
                            }
                          >
                            复制催办
                          </button>
                          <button className="aw-wait-received" disabled={!!busy} onClick={() => resolveWait(w.id, day)}>
                            标记已收到
                          </button>
                          <button disabled={!!busy} onClick={() => void act("起草催办", () => draft("followup", w.id))}>
                            起草催办
                          </button>
                          <button
                            className="aw-snooze"
                            disabled={!!busy}
                            onClick={() =>
                              change((m) => ({
                                ...m,
                                waits: m.waits.map((row) =>
                                  row.id === w.id ? { ...row, review: shiftDay(row.review || day, 1) } : row,
                                ),
                                draft: m.draft?.mode === "followup" && m.draft.waitId === w.id ? undefined : m.draft,
                              }))
                            }
                          >
                            +1天
                          </button>
                          <button
                            className="aw-snooze"
                            disabled={!!busy}
                            onClick={() =>
                              change((m) => ({
                                ...m,
                                waits: m.waits.map((row) =>
                                  row.id === w.id ? { ...row, review: shiftDay(row.review || day, 3) } : row,
                                ),
                                draft: m.draft?.mode === "followup" && m.draft.waitId === w.id ? undefined : m.draft,
                              }))
                            }
                          >
                            +3天
                          </button>
                          <button
                            className="aw-snooze"
                            disabled={!!busy}
                            onClick={() =>
                              change((m) => ({
                                ...m,
                                waits: m.waits.map((row) =>
                                  row.id === w.id ? { ...row, review: nextMonday(day) } : row,
                                ),
                                draft: m.draft?.mode === "followup" && m.draft.waitId === w.id ? undefined : m.draft,
                              }))
                            }
                          >
                            下周一
                          </button>
                        </>
                      ) : (
                        <button disabled={!!busy} onClick={() => resolveWait(w.id)}>
                          恢复等待
                        </button>
                      )}
                      <button
                        disabled={!!busy}
                        onClick={() => {
                          setEditingWaitId(w.id);
                          setWho(w.who);
                          setWhat(w.what);
                          setReview(w.review);
                          setBlocking(Boolean(w.blocking));
                          setWaitOpen(true);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        disabled={!!busy}
                        onClick={() => {
                          if (editingWaitId === w.id) {
                            setEditingWaitId(null);
                            setWaitOpen(false);
                          }
                          change((m) => ({
                            ...m,
                            waits: m.waits.filter((row) => row.id !== w.id),
                            draft:
                              m.draft?.mode === "followup" && (!m.draft.waitId || m.draft.waitId === w.id)
                                ? undefined
                                : m.draft,
                          }));
                        }}
                      >
                        删除
                      </button>
                    </div>
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
                  const targetId = editingWaitId;
                  await update((m) => ({
                    ...m,
                    waits: targetId
                      ? m.waits.map((row) =>
                          row.id === targetId
                            ? { ...row, who: who.trim(), what: what.trim(), review, blocking }
                            : row,
                        )
                      : [
                          ...m.waits,
                          { id: crypto.randomUUID(), who: who.trim(), what: what.trim(), review, blocking },
                        ],
                    draft:
                      targetId && m.draft?.mode === "followup" && m.draft.waitId === targetId
                        ? undefined
                        : m.draft,
                  }));
                  setEditingWaitId(null);
                  setWaitOpen(false);
                  setWho("");
                  setWhat("");
                  setReview("");
                  setBlocking(true);
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
                <input type="date" value={review} onChange={(e) => setReview(e.target.value)} />
              </label>
              <label>
                <input type="checkbox" checked={blocking} onChange={(e) => setBlocking(e.target.checked)} /> 阻塞下一步
              </label>
              <div className="aw-wait-actions">
                <button disabled={!!busy}>{editingWaitId ? "更新等待项" : "保存等待项"}</button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => {
                    setEditingWaitId(null);
                    setWaitOpen(false);
                    setWho("");
                    setWhat("");
                    setReview("");
                    setBlocking(true);
                  }}
                >
                  取消
                </button>
              </div>
            </form>
          )}
          <section className="aw-detail-steps">
            <h3>
              <span>
                执行步骤清单 ({meta.steps.filter((s) => s.done).length}/{meta.steps.length})
              </span>
              <button
                disabled={!!busy || task.completed}
                onClick={() => void act("拆解步骤", () => draft("steps"))}
              >
                <Sparkles size={12} aria-hidden="true" /> AI 补充拆解步骤
              </button>
            </h3>
            <div className="aw-checklist">
              {meta.steps.map((s) => (
                <div className="aw-step-row" key={s.id}>
                  <label className="aw-step">
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
                    <span className={s.done ? "is-done" : ""}>{s.text}</span>
                  </label>
                  {!task.completed && (
                    <button
                      type="button"
                      className="aw-step-remove"
                      aria-label={"删除步骤：" + s.text}
                      disabled={!!busy}
                      onClick={() =>
                        change((m) => ({
                          ...m,
                          steps: m.steps.filter((row) => row.id !== s.id),
                        }))
                      }
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {!meta.steps.length && <p>暂无子步骤，回车添加或点右上角拆解</p>}
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
                  <Plus size={14} aria-hidden="true" />
                  <input
                    aria-label="新步骤"
                    placeholder="添加具体步骤，回车保存…"
                    value={step}
                    onChange={(e) => setStep(e.target.value)}
                  />
                </form>
              )}
            </div>
          </section>
          {recall.error && <p role="alert">资料检索失败 · {recall.error}</p>}
          {(hasMaterials || meta.draft) && (
            <section className="aw-detail-brief">
              {hasMaterials && (
                <div className="aw-brief-heading">
                  <h3>
                    <Layers3 size={14} aria-hidden="true" /> 关联现场与规范备料包
                  </h3>
                  <small>备料宽松召回 · 草稿结论逐条核对来源</small>
                </div>
              )}
              <div className={hasMaterials ? "aw-brief-box" : undefined}>
                {conflicts.length > 0 && (
                  <div className="aw-conflict-card" role="status">
                    <strong>⚡ 工程参数差异提示（{conflicts.length} 处）</strong>
                    {conflicts.map((conflict, idx) => (
                      <p key={idx}>
                        {conflict.spec.title}（{conflict.specValue}）与 {conflict.field.title}（{conflict.fieldValue}）数值不同，请先核对是否指同一项参数。
                      </p>
                    ))}
                  </div>
                )}
                <Materials
                  items={pack.recent}
                  journals={journals}
                  onOpen={onOpen}
                  onPin={pin}
                  caption={
                    <>
                      <span>近期现场记录（14 天加权）</span>
                      <small>可能相关 · 14 天加权</small>
                    </>
                  }
                />
                <Materials
                  items={pack.long}
                  journals={journals}
                  onOpen={onOpen}
                  onPin={pin}
                  caption={
                    <>
                      <span>长期规范与图纸（跨时间窗）</span>
                      <small>不受 14 天时间窗限制</small>
                    </>
                  }
                />
                <Materials
                  items={pack.related}
                  journals={journals}
                  onOpen={onOpen}
                  onPin={pin}
                  caption="已关联的其他来源"
                />
                {hasMaterials && (
                  <button disabled={!!busy} onClick={() => void act("起草评审", () => draft("draft"))}>
                    起草评审要点
                  </button>
                )}
                {meta.draft && (
                  <div className="aw-detail-draft">
                    <details open>
                      <summary className="aw-draft-summary">
                        <Sparkles size={14} aria-hidden="true" />
                        {meta.draft.mode === "steps"
                          ? "建议步骤"
                          : meta.draft.mode === "followup"
                            ? "催办消息"
                            : "评审草稿"}
                      </summary>
                      <div className="aw-draft-body">
                        {staleDraft && <p role="status">滴答原任务已更新，请按当前材料重新起草。</p>}
                        {unboundFollowup && (
                          <p role="status">旧草稿未关联到具体交付，请在对应的等待卡重新起草。</p>
                        )}
                        <DraftView draft={meta.draft} journals={journals} onOpen={onOpen} />
                        <button
                          disabled={unboundFollowup}
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
                        {!staleDraft && !unboundFollowup && (
                          <SourceAppend
                            key={draftText}
                            task={task}
                            text={draftText}
                            workId={"workbench-" + task.sourceId}
                          />
                        )}
                      </div>
                    </details>
                  </div>
                )}
              </div>
            </section>
          )}
          <section className="aw-detail-note">
            <h3>任务备注与进展记录</h3>
            <textarea
              placeholder="记录推进备注、沟通结论或关键参数…"
              aria-label="推进备注"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              disabled={!!busy || note === (meta.note || "")}
              onClick={() => change((m) => ({ ...m, note }))}
            >
              保存备注
            </button>
            {note.trim() && (
              <SourceAppend key={note} task={task} text={note} workId={"workbench-note-" + task.sourceId} />
            )}
          </section>
          <details className="aw-detail-source">
            <summary>原任务与来源操作</summary>
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
            <button onClick={() => setPlanning((v) => (v ? "" : crypto.randomUUID()))}>
              分析与来源操作记录
            </button>
          </details>
          {planning && (
            <TaskPlanningPanel
              request={{
                id: planning,
                mode: "task",
                label: task.title,
                tasks: [task],
                historyOnly: task.completed,
              }}
              onClose={() => setPlanning("")}
              onTask={() => {}}
              onSaved={() => void update((m) => m)}
            />
          )}
        </div>
      </div>
      <p role={statusError ? "alert" : "status"}>{busy ? busy + "中…" : status}</p>
    </aside>
  );
}
