import { useEffect, useRef, useState } from "react";

export type AgentCondition = { enabled: boolean; onChange?: boolean; dueAt?: number | null; expiresAt?: number; remaining?: number; notify?: boolean; running?: string | null; message: string };
export function AgentConditions({ value, disabled, active, onAction }: { value?: AgentCondition | null; disabled: boolean; active: boolean; onAction: (args: Record<string, unknown>) => Promise<void> }) {
  const [onChange, setOnChange] = useState(false);
  const [reviewAt, setReviewAt] = useState("");
  const [notify, setNotify] = useState(false);
  const [error, setError] = useState("");
  const status = useRef<HTMLParagraphElement>(null);
  const changes = useRef<HTMLInputElement>(null);
  useEffect(() => { setOnChange(!!value?.onChange); setNotify(!!value?.notify); }, [value?.onChange, value?.notify]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError("");
    const dueAt = reviewAt ? new Date(reviewAt).getTime() : null;
    if (!onChange && dueAt === null) { setError("请选择来源变化或约定复查时间。"); changes.current?.focus(); return; }
    if (dueAt !== null && (!Number.isFinite(dueAt) || dueAt < Date.now() + 10_000 || dueAt > Date.now() + 7 * 86_400_000)) { setError("复查时间需在未来 10 秒至 7 天内。"); return; }
    try { await onAction({ action: "configureWatch", confirmed: true, onChange, dueAt, notify }); status.current?.focus(); }
    catch (reason) { setError(String(reason)); }
  };
  return <section className="agent-conditions" aria-label="自动复查条件">
    <h3>按约定继续调查</h3>
    <p ref={status} tabIndex={-1} role="status">{value?.message || "自动复查未启用。"}</p>
    {value?.enabled ? <>
      <p className="agent-note">还可自动复查 {value.remaining ?? 0} 轮；{value.expiresAt ? new Date(value.expiresAt).toLocaleString() : "7 天后"}到期。{value.dueAt ? `约定复查：${new Date(value.dueAt).toLocaleString()}。` : ""}</p>
      <button type="button" disabled={disabled} onClick={async () => { setError(""); try { await onAction({ action: "pauseWatch" }); status.current?.focus(); } catch (reason) { setError(String(reason)); } }}>暂停自动复查</button>
    </> : <form onSubmit={submit}>
      <label className="agent-grant"><input ref={changes} name="agentWatchChanges" type="checkbox" checked={onChange} disabled={disabled || active} onChange={event => setOnChange(event.target.checked)} />已知来源或业务回执变化时复查</label>
      <label>约定复查时间（可选）<input name="agentReviewAt" type="datetime-local" value={reviewAt} disabled={disabled || active} onChange={event => setReviewAt(event.target.value)} /></label>
      <label className="agent-grant"><input name="agentWatchNotice" type="checkbox" checked={notify} disabled={disabled || active} onChange={event => setNotify(event.target.checked)} />复查结束时在 Hub 内提醒我</label>
      <p className="agent-note">明确启用后，7 天内最多自动复查 3 轮，每轮最多 2 分钟、3 次调查调用，另有最多 1 次结果纠错，仍计入总时限。仅核对本事项已知的笔记、阅读、任务和有版本依据的附件片段；附件重新提取期间等待，任务对应关系或行号身份改变时暂停。不自动执行标签、归档或闪卡动作。应用退出期间不运行，重新打开后检查遗漏变化。需要你决定、手工继续或发生错误时暂停。</p>
      <button type="submit" disabled={disabled || active}>启用有限自动复查</button>
    </form>}
    <p role="alert">{error}</p>
  </section>;
}
