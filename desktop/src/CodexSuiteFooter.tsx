import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, LoaderCircle, Settings2, X } from "lucide-react";
import { cancelModelJob, codexSelectionLabel, openCodexSuiteSettings, publishCodexNotice, useCodexSuite, type CodexJob } from "./CodexSuite";
import "./CodexSuiteFooter.css";
import { ModelJobActivity } from "./ModelJobActivity";

const labels: Record<CodexJob["state"], string> = { queued: "等待运行", running: "正在生成", succeeded: "生成完成", failed: "生成失败", cancelled: "已停止，可继续" };
export function CodexSuiteFooter() {
  const suite = useCodexSuite();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLElement>(null);
  const running = suite.jobs.filter(job => job.state === "running");
  const queued = suite.jobs.filter(job => job.state === "queued");
  const failed = suite.jobs.filter(job => job.state === "failed");
  const last = suite.jobs.filter(job => job.state === "succeeded" || job.state === "failed" || job.state === "cancelled").sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  const summary = suite.error ? "模型状态读取失败" : !suite.loaded ? "Hub 正在读取设置…" : running.length || queued.length ? `Hub · 运行 ${running.length}${queued.length ? ` · 等待 ${queued.length}` : ""}${failed.length ? ` · 历史失败 ${failed.length}` : ""}` : last ? `Hub · ${last.label} · ${labels[last.state]}` : "Hub · 就绪";
  const activeJobs = [...running, ...queued];
  const selectionJob = activeJobs.length === 1 ? activeJobs[0] : activeJobs.length === 0 ? last : undefined;
  const selectionLabel = selectionJob ? `${selectionJob.label} · ${codexSelectionLabel({ ...suite.settings, provider: selectionJob.provider, model: selectionJob.model, reasoningEffort: selectionJob.reasoningEffort, fast: selectionJob.fast })}` : activeJobs.length > 1 ? "多个任务使用各自设置，见下方记录" : `默认设置：${codexSelectionLabel(suite.settings)}`;
  const hasError = !!suite.error || (!running.length && !queued.length && last?.state === "failed");
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => { const node = event.target; if (node instanceof Node && !trigger.current?.contains(node) && !popup.current?.contains(node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    const blur = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true); document.addEventListener("focusin", outside, true); window.addEventListener("keydown", escape); window.addEventListener("blur", blur);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside, true); window.removeEventListener("keydown", escape); window.removeEventListener("blur", blur); };
  }, [open]);
  return <div className="codex-suite-footer" onMouseDown={event => event.stopPropagation()}>
    <button ref={trigger} type="button" className={`codex-suite-status${hasError ? " has-error" : ""}`} aria-label="模型运行状态" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)} title={`${summary} · ${selectionLabel}`}>
      {hasError ? <AlertCircle size={13} /> : running.length ? <LoaderCircle size={13} className="spin" /> : queued.length ? <Clock3 size={13} /> : <CheckCircle2 size={13} />}<span>{summary}</span>
    </button>
    {open && <section ref={popup} className="codex-suite-popover" role="dialog" aria-label="模型请求与设置">
      <header><strong>模型运行</strong><button type="button" aria-label="关闭模型状态" onClick={() => setOpen(false)}><X size={15} /></button></header>
      <p>{selectionLabel}</p>
      <p className="agent-note">默认设置：{codexSelectionLabel(suite.settings)} · 最多同时运行 {suite.settings.maxConcurrent} 个请求</p>
      <button type="button" className="codex-suite-open-settings" onClick={() => { setOpen(false); openCodexSuiteSettings(); }}><Settings2 size={14} />模型与速度设置</button>
      {suite.error && <p role="alert" className="codex-suite-job-error">{suite.error}</p>}
      <small>以下记录表示模型生成结果。资料库的写入与附件处理结果另行核验。</small>
      {!suite.jobs.length && <p>尚无 Hub 发起的模型请求。</p>}
      <div className="codex-suite-jobs">{[...suite.jobs].reverse().map(job => <article key={job.id} className={`codex-suite-job ${job.state}`}>
        <div><strong>{job.label}</strong><span>{labels[job.state]}</span></div>
        <small>{codexSelectionLabel({ provider: job.provider, model: job.model, reasoningEffort: job.reasoningEffort, fast: job.fast, maxConcurrent: suite.settings.maxConcurrent })}</small>
        {!!job.usage?.calls && <small>{job.usage.calls} 次调用 · {job.usage.callsWithTokens ? `${job.usage.totalTokens.toLocaleString()} tokens${job.usage.callsWithTokens < job.usage.calls ? `（${job.usage.callsWithTokens} 次已返回用量）` : ""}` : "提供方未返回用量"}</small>}
        {(job.state === "running" || job.state === "queued") && <button type="button" onClick={() => void cancelModelJob(job.id).catch(reason => publishCodexNotice(String(reason), "error"))}>停止此请求</button>}
        <ModelJobActivity job={job}/>
        {job.error && <p className="codex-suite-job-error">{job.error}</p>}
      </article>)}</div>
    </section>}
  </div>;
}
