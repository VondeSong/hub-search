import { useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Sparkles, ArrowUpRight } from "lucide-react";
import { AgentPanelContext } from "./StandaloneAgentLauncher";
import { analyzeTasks, planningNames, planningEligible, planningSuggestions, planningReportSummary, savePlanningSuggestion, stopPlanningWork, taskIdentity, type PlanningRequest, type PlanningView, type TaskSuggestion } from "./TaskPlanning";
import type { UnifiedTaskDashboard } from "./UnifiedTaskData";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import "./TaskPlanning.css";

export function TaskPlanningPanel({ request, onClose, onTask, onSaved }: { request: PlanningRequest; onClose: () => void; onTask: (t: UnifiedTask) => void; onSaved: () => void }) {
  const eligible = request.tasks.filter(planningEligible);
  const [selected, setSelected] = useState(() => eligible.length <= 32 ? eligible.map(taskIdentity) : [] as string[]);
  const [phase, setPhase] = useState(-1), [refresh, setRefresh] = useState(true), [error, setError] = useState("");
  const [view, setView] = useState<PlanningView | null>(null), [suggestions, setSuggestions] = useState<TaskSuggestion[]>([]);
  const [preview, setPreview] = useState<TaskSuggestion | null>(null), [text, setText] = useState("");
  const [saved, setSaved] = useState<string[]>([]), [dismissed, setDismissed] = useState<string[]>([]), [saving, setSaving] = useState(false);
  const [refreshNote, setRefreshNote] = useState("");
  const active = useRef(true), running = useRef(false), work = useRef(""), serial = useRef(0), heading = useRef<HTMLHeadingElement>(null);
  const openAgent = useContext(AgentPanelContext);
  const busy = phase >= 0 && phase < 3;
  useEffect(() => {
    active.current = true; heading.current?.focus();
    return () => { active.current = false; serial.current++; if (running.current && work.current) void stopPlanningWork(work.current).catch(() => undefined); };
  }, []);
  async function run() {
    if (running.current || saving) return;
    const ticket = ++serial.current;
    const cancelled = () => !active.current || serial.current !== ticket;
    running.current = true; setError(""); setView(null); setSuggestions([]); setPreview(null); setPhase(0); setRefreshNote("");
    try {
      const current = await invoke<UnifiedTaskDashboard>("list_unified_tasks");
      const tasks = eligible.filter(t => selected.includes(taskIdentity(t))).map(t => {
        const latest = current.tasks.find(n => taskIdentity(n) === taskIdentity(t));
        if (!latest || !planningEligible(latest)) throw Error("选中的任务已完成、移除或发生变化，请关闭后重新选择。");
        return latest;
      });
      if (!tasks.length) throw Error("请先选择要分析的原任务。");
      if (cancelled()) return;
      setPhase(1);
      if (refresh) {
        // The host command queues discovery; its return is not a remote freshness receipt.
        for (let i = 0; i < tasks.length; i += 8) await invoke("refresh_unified_task_sources", { taskIds: tasks.slice(i, i + 8).map(t => t.id) });
        if (cancelled()) return;
        setRefreshNote("已请求刷新来源；本次仍使用当前本地资料，尚未确认来源已更新。");
      } else setRefreshNote("未请求来源刷新，本次使用已有本地快照。");
      setPhase(2);
      const result = await analyzeTasks(request.mode, tasks, id => { work.current = id; if (cancelled()) void stopPlanningWork(id).catch(() => undefined); }, cancelled);
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
      if (active.current) { setSaved(ids => [...ids, preview.id]); setPreview(null); onSaved(); }
    } catch (reason) { if (active.current) setError(`${String(reason)} 未确认保存成功，请核对后重试。`); }
    finally { if (active.current) setSaving(false); }
  }
  return <aside className="task-planning-panel" aria-label="任务分析" data-hub-keyboard-scope="task-planning" onKeyDown={e => { if (e.key === "Escape" && !e.nativeEvent.isComposing && !e.defaultPrevented && !saving) { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
    <header><div><small>围绕原任务分析</small><h2 ref={heading} tabIndex={-1}>{planningNames[request.mode]}</h2></div><button aria-label="关闭任务分析" disabled={saving} onClick={onClose}><X size={17}/></button></header>
    <div className="task-planning-content">
      <section><strong>{request.label}</strong><p>范围内 {eligible.length} 项未完成行动；已选 {selected.length} 项。项目容器与已完成任务不计入。</p>
        <details><summary>查看和选择读取范围</summary><p>每次最多 32 项；按当前项目或筛选缩小范围，不会自动扩大到资料库。</p>{eligible.map(t => <label className="task-planning-choice" key={taskIdentity(t)}><input type="checkbox" checked={selected.includes(taskIdentity(t))} disabled={busy || saving} onChange={e => setSelected(ids => e.target.checked ? ids.length < 32 ? [...ids, taskIdentity(t)] : ids : ids.filter(id => id !== taskIdentity(t)))}/><span>{t.title}<small>{t.libraryName} / {t.documentTitle}</small></span></label>)}</details>
      </section>
      <ol aria-label="读取到采纳的过程">{["读取聚合数据", "请求核对来源", "AI 分析", "选择采纳"].map((s, i) => <li key={s} aria-current={phase === i ? "step" : undefined}>{i + 1}. {s}{phase > i ? " · 已完成" : ""}</li>)}</ol>
      <label><input type="checkbox" checked={refresh} disabled={busy || saving} onChange={e => setRefresh(e.target.checked)}/>请求后台刷新来源</label>
      <p>{refreshNote || "先确认读取范围，再交给当前助手模型。不会自动启用同步或更改原任务。"}</p>
      <button className="task-planning-primary" disabled={busy || saving || !selected.length} onClick={() => void run()}><Sparkles size={14}/>{busy ? ["正在读取任务…", "正在请求核对来源…", "正在分析，可能需要一些时间…"][phase] : "读取并分析"}</button>
      {error && <p role="alert">{error}</p>}
      {view && <><p>{planningReportSummary(view)}</p>{view.validity && <p role="alert">{view.validity}</p>}{view.work.report?.limitations?.map((s, i) => <p key={i}>{s}</p>)}{view.work.report?.questions?.map((s, i) => <p key={i}>待确认：{s}</p>)}{!suggestions.length && <p>没有形成能准确对应原任务的可采纳建议。可查看完整分析，或重新分析。</p>}</>}
      {suggestions.map(s => <article key={s.id}><h3><button onClick={() => onTask(s.task)}>{s.task.title}<ArrowUpRight size={13}/></button></h3><p>{s.reason}</p><p className="task-planning-text">{s.text}</p><details><summary>查看本轮依据</summary><p>{s.task.libraryName} / {s.task.documentTitle}</p>{s.citations.map((c, i) => { const evidence = view?.evidence[Number(c.evidenceId.replace(/^e/, "")) - 1]; return <blockquote key={i}>{c.quote}<small>{evidence?.sourcePath || c.evidenceId}</small></blockquote>; })}{!s.citations.length && <p>本条未提供正文引文，请核对原任务后采纳。</p>}</details><p>{request.mode === "today" ? "只加入 Hub 今日计划，保留原任务日期、状态和清单。" : "保存为原任务的 Hub 建议笔记，不覆盖来源正文。"}</p>
        {saved.includes(s.id) ? <p role="status">已保存到原任务的{request.mode === "today" ? "今日计划" : "建议笔记"}</p> : dismissed.includes(s.id) ? <p>未采用，原任务保留。</p> : <div className="task-planning-actions"><button disabled={saving} onClick={() => { setPreview(s); setText(s.text); }}>{request.mode === "today" ? "加入今日计划" : "预览并保留建议"}</button><button disabled={saving} onClick={() => setDismissed(ids => [...ids, s.id])}>暂不采用</button></div>}
      </article>)}
      {preview && <section aria-label="建议采纳预览"><strong>目标：{preview.task.libraryName} / {preview.task.documentTitle} / {preview.task.title}</strong><p>本次只保存 Hub {request.mode === "today" ? "今日计划引用" : "建议笔记"}，不修改来源正文、日期或完成状态。</p><textarea aria-label="采纳建议内容" value={text} readOnly={request.mode === "today"} disabled={saving} onChange={e => setText(e.target.value)}/><div className="task-planning-actions"><button disabled={saving} onClick={() => void adopt()}>{saving ? "正在保存…" : "确认采纳"}</button><button disabled={saving} onClick={() => setPreview(null)}>取消采纳</button></div></section>}
      {(view?.work.id || work.current) && openAgent && <button onClick={() => openAgent({ workId: view?.work.id || work.current })}>在助手中查看完整分析</button>}
      <p>建议保存在 Hub 中。需要修改来源正文时，请打开原任务。关闭面板会请求停止本轮分析，已保存的助手记录保留。</p>
    </div>
  </aside>;
}
