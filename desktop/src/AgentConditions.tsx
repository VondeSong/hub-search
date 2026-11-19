import { useEffect, useRef, useState } from "react";

export type AgentCondition = { enabled: boolean; onChange?: boolean; dueAt?: number | null; repeatDays?: number | null; scanLibraries?: boolean; expiresAt?: number; remaining?: number; notify?: boolean; running?: string | null; message: string };
export function AgentConditions({ value, disabled, active, libraryCount = 0, onAction }: { value?: AgentCondition | null; disabled: boolean; active: boolean; libraryCount?: number; onAction: (args: Record<string, unknown>) => Promise<void> }) {
  const [onChange, setOnChange] = useState(false);
  const [reviewAt, setReviewAt] = useState("");
  const [frequency, setFrequency] = useState("once");
  const [editing, setEditing] = useState(false);
  const [notify, setNotify] = useState(false);
  const [error, setError] = useState("");
  const status = useRef<HTMLParagraphElement>(null);
  const changes = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setOnChange(!!value?.onChange);
    setNotify(!!value?.notify);
    setFrequency(value?.repeatDays?.toString() ?? "once");
  }, [value?.onChange, value?.notify, value?.repeatDays]);
  const recurring = frequency !== "once";
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError("");
    const dueAt = reviewAt ? new Date(reviewAt).getTime() : null;
    if (recurring && dueAt === null) { setError("请选择首次运行时间。"); return; }
    if (!onChange && dueAt === null) { setError("请选择来源变化或约定复查时间。"); changes.current?.focus(); return; }
    if (dueAt !== null && (!Number.isFinite(dueAt) || dueAt < Date.now() + 10_000 || dueAt > Date.now() + 7 * 86_400_000)) { setError("复查时间需在未来 10 秒至 7 天内。"); return; }
    try {
      await onAction({ action: "configureWatch", confirmed: true, onChange: !recurring && onChange, dueAt, notify,
        ...(recurring ? { repeatDays: Number(frequency), scanLibraries: libraryCount > 0 } : {}) });
      setEditing(false);
      status.current?.focus();
    }
    catch (reason) { setError(String(reason)); }
  };
  return <section className="agent-conditions" aria-label="自动复查条件">
    <h3>按约定继续调查</h3>
    <p ref={status} tabIndex={-1} role="status">{value?.message || "自动复查未启用。"}</p>
    {value?.enabled && !editing ? <>
      {value.repeatDays && <p>{value.repeatDays === 7 ? "每周" : "每天"} · Windows 上的 Hub 运行时执行{value.scanLibraries ? ` · ${libraryCount} 个已授权资料库` : " · 已知来源"}</p>}
      <p className="agent-note">还可自动复查 {value.remaining ?? 0} 轮；{value.expiresAt ? new Date(value.expiresAt).toLocaleString() : "7 天后"}到期。{value.dueAt ? `约定复查：${new Date(value.dueAt).toLocaleString()}。` : ""}</p>
      <button type="button" disabled={disabled} onClick={async () => { setError(""); try { await onAction({ action: "pauseWatch" }); status.current?.focus(); } catch (reason) { setError(String(reason)); } }}>暂停自动复查</button>
      <button type="button" disabled={disabled || active} onClick={() => { setReviewAt(""); setEditing(true); }}>更改复查时间</button>
    </> : <form onSubmit={submit}>
      <label>复查频率<select name="agentReviewFrequency" value={frequency} disabled={disabled || active} onChange={event => setFrequency(event.target.value)}><option value="once">一次或来源变化</option><option value="1">每天</option><option value="7">每周</option></select></label>
      {!recurring && <label className="agent-grant"><input ref={changes} name="agentWatchChanges" type="checkbox" checked={onChange} disabled={disabled || active} onChange={event => setOnChange(event.target.checked)} />已知来源或业务回执变化时复查</label>}
      <label>{recurring ? "首次运行时间" : "约定复查时间（可选）"}<input name="agentReviewAt" type="datetime-local" value={reviewAt} disabled={disabled || active} onChange={event => setReviewAt(event.target.value)} /></label>
      <label className="agent-grant"><input name="agentWatchNotice" type="checkbox" checked={notify} disabled={disabled || active} onChange={event => setNotify(event.target.checked)} />复查结束时在 Hub 内提醒我</label>
      <p className="agent-note">{recurring ? `${libraryCount ? `检查这 ${libraryCount} 个已授权资料库的本机索引，并复查已读来源。` : "复查本事项的已知来源。"}Windows 上的 Hub 运行时自动生成只读报告，最多 3 轮。重开后补做一轮到期复查，再按原日程继续。` : "7 天内最多自动复查 3 轮。每轮使用本事项的已知来源，生成只读报告。"}</p>
      <button type="submit" disabled={disabled || active}>{editing ? "保存新日程" : recurring ? "启用定时复查" : "启用有限自动复查"}</button>
      {editing && <button type="button" onClick={() => { setEditing(false); setError(""); }}>取消更改</button>}
    </form>}
    <p role="alert">{error}</p>
  </section>;
}
