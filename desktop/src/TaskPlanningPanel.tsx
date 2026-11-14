import { useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Sparkles, ArrowUpRight } from "lucide-react";
import { AgentPanelContext } from "./StandaloneAgentLauncher";
import { analyzeTasks, planningNames, planningEligible, planningSuggestions, planningReportSummary, savePlanningSuggestion, stopPlanningWork, taskIdentity, type PlanningRequest, type PlanningView, type TaskSuggestion } from "./TaskPlanning";
import type { UnifiedTaskDashboard } from "./UnifiedTaskData";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import "./TaskPlanning.css";
import { refreshPlanningSources, prepareSourceNote, taskSourceCall, sourceNoteStatus, type TaskReadReceipt, type TaskNoteAction } from "./TaskPlanningSource";

export function TaskPlanningPanel({ request, onClose, onTask, onSaved }: { request: PlanningRequest; onClose: () => void; onTask: (t: UnifiedTask) => void; onSaved: () => void }) {
  const eligible = request.tasks.filter(planningEligible);
  const [selected, setSelected] = useState(() => eligible.length <= 32 ? eligible.map(taskIdentity) : [] as string[]);
  const [phase, setPhase] = useState(-1), [refresh, setRefresh] = useState(true), [error, setError] = useState("");
  const [view, setView] = useState<PlanningView | null>(null), [suggestions, setSuggestions] = useState<TaskSuggestion[]>([]);
  const [preview, setPreview] = useState<TaskSuggestion | null>(null), [text, setText] = useState("");
  const [saved, setSaved] = useState<string[]>([]), [dismissed, setDismissed] = useState<string[]>([]), [saving, setSaving] = useState(false);
  const [refreshNote, setRefreshNote] = useState("");
  const [receipts, setReceipts] = useState<TaskReadReceipt[]>([]), [noteActions, setNoteActions] = useState<TaskNoteAction[]>([]);
  const [destination, setDestination] = useState("hub"), [sourcePreview, setSourcePreview] = useState<TaskNoteAction | null>(null);
  const [historyReady, setHistoryReady] = useState(false);
  const previewSection = useRef<HTMLElement>(null);
  const active = useRef(true), running = useRef(false), work = useRef(""), serial = useRef(0), heading = useRef<HTMLHeadingElement>(null);
  const openAgent = useContext(AgentPanelContext);
  const busy = phase >= 0 && phase < 3;
  useEffect(() => {
    active.current = true; heading.current?.focus();
    return () => { active.current = false; serial.current++; if (running.current && work.current) void stopPlanningWork(work.current).catch(() => undefined); };
  }, []);
  useEffect(() => {
    let current = true;
    const history = request.historyOnly ? request.tasks : eligible.filter(t => selected.includes(taskIdentity(t)));
    if (history.length && history.length <= 32) {
      setHistoryReady(false);
      void taskSourceCall<TaskNoteAction[]>({ action: "listNotes", taskIds: history.map(t => t.id) }).then(rows => { if (current && Array.isArray(rows)) { setNoteActions(rows); setHistoryReady(true); } }).catch(reason => { if (current) { setError(`来源操作记录暂时无法读取：${String(reason)}`); setHistoryReady(true); } });
    }
    return () => { current = false; };
  }, [request.id, view?.work.id]);
  useEffect(() => { previewSection.current?.focus(); previewSection.current?.scrollIntoView?.({ block: "nearest" }); }, [preview?.id, sourcePreview?.id]);
  async function run() {
    if (running.current || saving) return;
    const ticket = ++serial.current;
    const cancelled = () => !active.current || serial.current !== ticket;
    running.current = true; setError(""); setView(null); setSuggestions([]); setPreview(null); setSourcePreview(null); setPhase(0); setRefreshNote(""); setReceipts([]);
    try {
      const current = await invoke<UnifiedTaskDashboard>("list_unified_tasks");
      let tasks = eligible.filter(t => selected.includes(taskIdentity(t))).map(t => {
        const latest = current.tasks.find(n => taskIdentity(n) === taskIdentity(t));
        if (!latest || !planningEligible(latest)) throw Error("选中的任务已完成、移除或发生变化，请关闭后重新选择。");
        return latest;
      });
      if (!tasks.length) throw Error("请先选择要分析的原任务。");
      if (cancelled()) return;
      setPhase(1);
      let reads: TaskReadReceipt[];
      if (refresh) {
        const checked = await refreshPlanningSources(tasks.map(t => t.id));
        if (cancelled()) return;
        reads = checked.receipts;
        if (!Array.isArray(reads) || reads.length !== tasks.length || tasks.some(t => reads.filter(r => r.taskId === t.id).length !== 1)) throw Error("来源核对回执不完整，未开始模型分析。");
        const latest = await invoke<UnifiedTaskDashboard>("list_unified_tasks");
        tasks = tasks.map(t => { const fresh = latest.tasks.find(n => taskIdentity(n) === taskIdentity(t)); if (!fresh || !planningEligible(fresh)) throw Error("来源核对后任务已完成或移除，请重新选择。"); return fresh; });
        setRefreshNote("已完成本轮选中任务的主要来源核对；失败项和只读索引仍使用缓存。未扫描远端新增任务或全部历史。");
      } else {
        reads = tasks.map(t => ({ taskId: t.id, provider: t.provider, libraryName: t.libraryName, state: "cached", checkedAt: Date.now() / 1000, indexedAt: t.indexedAt }));
        setRefreshNote("未请求来源核对，本次使用已有本地快照。");
      }
      if (cancelled()) return;
      setReceipts(reads);
      setPhase(2);
      const result = await analyzeTasks(request.mode, tasks, id => { work.current = id; if (cancelled()) void stopPlanningWork(id).catch(() => undefined); }, cancelled, reads);
      if (cancelled()) return;
      setView(result); setSuggestions(planningSuggestions(result, tasks)); setPhase(3);
      if (result.run?.error) setError(result.run.error);
      else if (!result.work.report) setError("本轮没有形成报告，可在助手历史中查看原因后重试。");
    } catch (reason) { if (!cancelled()) { setError(String(reason)); setPhase(-1); } }
    finally { running.current = false; }
  }
  async function adopt() {
    if (!preview || saving) return;
    setSaving(true); setError("");
    try {
      const current = await invoke<UnifiedTaskDashboard>("list_unified_tasks");
      if (!active.current) return;
      const day = new Date().toLocaleDateString("sv-SE");
      await savePlanningSuggestion(preview, current.tasks.find(t => taskIdentity(t) === taskIdentity(preview.task)), request.mode, text, day);
      if (active.current) { setSaved(ids => [...ids, preview.id]); setPreview(null); heading.current?.focus(); onSaved(); }
    } catch (reason) { if (active.current) setError(`${String(reason)} 未确认保存成功，请核对后重试。`); }
    finally { if (active.current) setSaving(false); }
  }
  async function prepareNote() {
    if (!preview || saving) return;
    setSaving(true); setError("");
    try { const action = await prepareSourceNote(preview, text); if (active.current) { setSourcePreview(action); setNoteActions(rows => [action, ...rows.filter(r => r.id !== action.id)]); } }
    catch (reason) { if (active.current) setError(String(reason)); }
    finally { if (active.current) setSaving(false); }
  }
  async function submitNote(action: TaskNoteAction, inspect = false) {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const result = await taskSourceCall<TaskNoteAction>({ action: inspect ? "inspectNote" : "submitNote", id: action.id });
      if (active.current) { setSourcePreview(result); setNoteActions(rows => [result, ...rows.filter(r => r.id !== result.id)]); heading.current?.focus(); if (result.state === "confirmed") onSaved(); }
    } catch (reason) { if (active.current) setError(`${String(reason)} 请核对原操作，不要重复追加。`); }
    finally { if (active.current) setSaving(false); }
  }
  function adoptionPreview(s: TaskSuggestion) {
    if (preview?.id !== s.id) return null;
    const writable = Boolean(s.task.contentRevision) && !s.task.statusWriteBlockedReason && s.task.syncState !== "conflict"
      && (s.task.provider === "dida365" || s.task.sourceRefs?.some(r => r.provider === "dida365"));
    return <section ref={previewSection} tabIndex={-1} aria-label="建议采纳预览"><strong>目标：{s.task.libraryName} / {s.task.documentTitle} / {s.task.title}</strong>
      {request.mode !== "today" && <label>保存位置 <select aria-label="建议保存位置" disabled={saving || !!sourcePreview} value={destination} onChange={e => setDestination(e.target.value)}><option value="hub">Hub 建议笔记</option><option value="dida" disabled={!writable}>追加到滴答普通文字任务正文</option></select></label>}
      <p>{request.mode === "today" ? "只保存 Hub 今日计划引用，不修改来源日期或状态。" : destination === "hub" ? "只保存 Hub 建议笔记，保留来源正文。" : "将先读取滴答原文并预览追加内容；日期、状态和清单保留，既有同步规则继续独立运行。"}</p>
      <textarea aria-label="采纳建议内容" value={text} readOnly={request.mode === "today" || !!sourcePreview} disabled={saving} onChange={e => setText(e.target.value)}/>
      {destination === "dida" && sourcePreview ? <><strong title={sourcePreview.sourceId}>滴答：{sourcePreview.libraryName} / {sourcePreview.title || s.task.title}</strong><details><summary>查看来源原文</summary><pre>{sourcePreview.before || "原正文为空"}</pre></details><label>提交后的正文<textarea aria-label="来源变更预览" readOnly value={sourcePreview.after}/></label><p role="status">{sourceNoteStatus(sourcePreview)}</p>{sourcePreview.error && <p role="alert">{sourcePreview.error}</p>}
        <div className="task-planning-actions">{["prepared", "retryable"].includes(sourcePreview.state) ? <button disabled={saving} onClick={() => void submitNote(sourcePreview)}>{saving ? "正在核对并提交…" : sourcePreview.state === "retryable" ? "再次确认同一变更" : "确认写入滴答"}</button> : sourcePreview.state !== "conflict" && <button disabled={saving} onClick={() => void submitNote(sourcePreview, true)}>只核对来源结果</button>}</div></> : <div className="task-planning-actions"><button disabled={saving} onClick={() => void (destination === "dida" && request.mode !== "today" ? prepareNote() : adopt())}>{saving ? "正在准备…" : destination === "dida" && request.mode !== "today" ? "准备来源变更预览" : "确认采纳"}</button></div>}
      <button disabled={saving} onClick={() => { setPreview(null); setSourcePreview(null); heading.current?.focus(); }}>取消采纳</button>
    </section>;
  }
  return <aside className="task-planning-panel" aria-label="任务分析" data-hub-keyboard-scope="task-planning" onKeyDown={e => { if (e.key === "Escape" && !e.nativeEvent.isComposing && !e.defaultPrevented && !saving) { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
    <header><div><small>围绕原任务分析</small><h2 ref={heading} tabIndex={-1}>{request.historyOnly ? "来源操作记录" : planningNames[request.mode]}</h2></div><button aria-label="关闭任务分析" disabled={saving} onClick={onClose}><X size={17}/></button></header>
    <div className="task-planning-content">
      {!request.historyOnly && <>
      <section><strong>{request.label}</strong><p>范围内 {eligible.length} 项未完成行动；已选 {selected.length} 项。项目容器与已完成任务不计入。</p>
        <details><summary>查看和选择读取范围</summary><p>每次最多 32 项；按当前项目或筛选缩小范围，不会自动扩大到资料库。</p>{eligible.map(t => <label className="task-planning-choice" key={taskIdentity(t)}><input type="checkbox" checked={selected.includes(taskIdentity(t))} disabled={busy || saving} onChange={e => setSelected(ids => e.target.checked ? ids.length < 32 ? [...ids, taskIdentity(t)] : ids : ids.filter(id => id !== taskIdentity(t)))}/><span>{t.title}<small>{t.libraryName} / {t.documentTitle}</small></span></label>)}</details>
      </section>
      <ol aria-label="读取到采纳的过程">{["读取聚合数据", "核对选中来源", "AI 分析", "选择采纳"].map((s, i) => <li key={s} aria-current={phase === i ? "step" : undefined}>{i + 1}. {s}{phase > i ? " · 已完成" : ""}</li>)}</ol>
      <label><input type="checkbox" checked={refresh} disabled={busy || saving} onChange={e => setRefresh(e.target.checked)}/>分析前核对选中来源</label>
      <p>{refreshNote || "先确认读取范围，再交给当前助手模型。不会自动启用同步或更改原任务。"}</p>
      {!!receipts.length && <details><summary>本次来源、读取时间与缺口</summary><ul>{receipts.map(r => <li key={r.taskId}>{r.libraryName} · {r.state === "confirmed" ? "本轮已核对" : r.state === "cached" ? "本地缓存" : "核对失败，使用缓存"} · {new Date(r.checkedAt * 1000).toLocaleString("zh-CN")}{r.indexedAt ? ` · 本地索引 ${new Date(r.indexedAt * 1000).toLocaleString("zh-CN")}` : " · 本地索引时间未知"}{r.error && <p>{r.error}</p>}</li>)}</ul><p>范围仅含明确选择的任务，不代表远端清单和新增任务已完整扫描，也未核对日历空闲时间。</p></details>}
      <button className="task-planning-primary" disabled={busy || saving || !selected.length} onClick={() => void run()}><Sparkles size={14}/>{busy ? ["正在读取任务…", "正在请求核对来源…", "正在分析，可能需要一些时间…"][phase] : "读取并分析"}</button>
      {error && <p role="alert">{error}</p>}
      {view && <><p>{planningReportSummary(view)}</p>{view.validity && <p role="alert">{view.validity}</p>}{view.work.report?.limitations?.map((s, i) => <p key={i}>{s}</p>)}{view.work.report?.questions?.map((s, i) => <p key={i}>待确认：{s}</p>)}{!suggestions.length && <p>没有形成能准确对应原任务的可采纳建议。可查看完整分析，或重新分析。</p>}</>}
      {suggestions.map(s => <article key={s.id}><h3><button onClick={() => onTask(s.task)}>{s.task.title}<ArrowUpRight size={13}/></button></h3><p>{s.reason}</p><p className="task-planning-text">{s.text}</p><details><summary>查看本轮依据</summary><p>{s.task.libraryName} / {s.task.documentTitle}</p>{s.citations.map((c, i) => { const evidence = view?.evidence[Number(c.evidenceId.replace(/^e/, "")) - 1]; return <blockquote key={i}>{c.quote}<small>{evidence?.sourcePath || c.evidenceId}</small></blockquote>; })}{!s.citations.length && <p>本条未提供正文引文，请核对原任务后采纳。</p>}</details><p>{request.mode === "today" ? "只加入 Hub 今日计划，保留原任务日期、状态和清单。" : "保存为原任务的 Hub 建议笔记，不覆盖来源正文。"}</p>
        {saved.includes(s.id) ? <p role="status">已保存到原任务的{request.mode === "today" ? "今日计划" : "建议笔记"}</p> : dismissed.includes(s.id) ? <p>未采用，原任务保留。</p> : <div className="task-planning-actions"><button disabled={saving} onClick={() => { setPreview(s); setSourcePreview(null); setDestination("hub"); setText(s.text); }}>{request.mode === "today" ? "加入今日计划" : "预览并保留建议"}</button><button disabled={saving} onClick={() => setDismissed(ids => [...ids, s.id])}>暂不采用</button></div>}
        {adoptionPreview(s)}
      </article>)}
      </>}
      {!!noteActions.length && <section aria-label="来源操作记录"><strong>来源操作记录</strong>{noteActions.map(action => <div key={action.id}><p>{action.title || "原任务"} · {action.libraryName} · {sourceNoteStatus(action)} · {new Date(action.updatedAt * 1000).toLocaleString("zh-CN")}</p>{action.error && <p>{action.error}</p>}{(["writing", "unknown"].includes(action.state) || action.state === "confirmed" && !!action.error) && <button disabled={saving} onClick={() => void submitNote(action, true)}>核对这次写入</button>}{["prepared", "retryable"].includes(action.state) && <details><summary>查看并确认同一变更</summary><p>目标：{action.libraryName} / {action.title || "原任务"}</p><details><summary>查看来源原文</summary><pre>{action.before}</pre></details><textarea aria-label="历史来源变更预览" readOnly value={action.after}/><button disabled={saving} onClick={() => void submitNote(action)}>再次确认同一变更</button></details>}</div>)}</section>}
      {(view?.work.id || work.current) && openAgent && <button onClick={() => openAgent({ workId: view?.work.id || work.current })}>在助手中查看完整分析</button>}
      {request.historyOnly && !historyReady && <p>正在读取来源操作记录…</p>}
      {request.historyOnly && historyReady && !noteActions.length && !error && <p>这条原任务还没有来源写入记录。</p>}
      {request.historyOnly && error && <p role="alert">{error}</p>}
      <p>默认保存在 Hub。已核实的滴答原任务可预览后追加建议；其他来源请回到原任务修改。关闭面板会请求停止本轮分析，已有分析与来源操作记录保留。</p>
    </div>
  </aside>;
}
