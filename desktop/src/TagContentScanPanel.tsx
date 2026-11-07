import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { CodexContentScan } from "./CodexContentScan";
import { TagContentScanNewRound } from "./TagContentScanNewRound";
import { TagContentScanBudgetHistory, type BudgetEntry } from "./TagContentScanBudgetHistory";
import { TagContentScanReopen } from "./TagContentScanReopen";
import { TagContentScanReopenHistory } from "./TagContentScanReopenHistory";
import { TagContentScanJoint, type JointTag } from "./TagContentScanJoint";

type Run = { runId: string; tag: string; version: number; status: string; stale: boolean; blockers: string[]; manifestMode?: string; manifestScope?: string[]; incremental?: { baseRunId: string } | null;
  totalEntities: number; entitiesRead: number; charsRead: number; maxEntities: number; maxChars: number;
  remainingEntities: number; remainingChars: number; counts: Record<string, number>; decisionCounts: Record<string, number>; jointSelection?: JointTag[] | null; jointCounts?: Record<string, number> };
type Change = { runId: string; expectedVersion: number; addEntities: number; addChars: number;
  before: { maxEntities: number; maxChars: number }; after: { maxEntities: number; maxChars: number } };
type Snapshot = { run: Run | null; budgetHistory: BudgetEntry[] };
type Preview = { change: Change; confirmationToken: string };
type History = { runs: { runId: string; createdAt: number; status: string; entitiesRead: number; charsRead: number }[]; nextCursor: string | null };
const call = <T,>(args: Record<string, unknown>) => invoke<T>("tag_assignment", { args });
const fmt = (n: number) => n.toLocaleString("zh-CN");

export function TagContentScanPanel({ tagId }: { tagId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Snapshot | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selectedRun, setSelectedRun] = useState("");
  const [history, setHistory] = useState<History | null>(null);
  const [entities, setEntities] = useState("30"), [chars, setChars] = useState("15000");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const serial = useRef(0), locked = useRef(false);
  const load = useCallback(async () => {
    if (locked.current) return;
    locked.current = true; const request = ++serial.current;
    setBusy(true); setError(""); setPreview(null); setNotice("");
    try {
      const result = await call<Snapshot>({ action: "scan_status", tag: tagId, ...(selectedRun ? { runId: selectedRun } : {}) });
      if (request === serial.current) setData(result);
    } catch (e) { if (request === serial.current) { setData(null); setError(String(e)); } }
    finally { if (request === serial.current) { setBusy(false); locked.current = false; } }
  }, [tagId, selectedRun]);
  useEffect(() => () => { serial.current++; locked.current = false; }, [tagId]);
  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => { const refresh = () => { if (open) void load(); }; window.addEventListener("hub-tag-scan-updated", refresh); return () => window.removeEventListener("hub-tag-scan-updated", refresh); }, [open, load]);
  const run = data?.run;
  const loadHistory = async (cursor?: string) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setPreview(null);
    const request = ++serial.current;
    try {
      const result = await call<History>({ action: "scan_history", tag: tagId, limit: 20, ...(cursor ? { cursor } : {}) });
      if (request === serial.current) setHistory(old => ({ ...result, runs: cursor && old ? [...old.runs, ...result.runs.filter(r => !old.runs.some(v => v.runId === r.runId))] : result.runs }));
    } catch (e) { if (request === serial.current) setError(String(e)); }
    finally { if (request === serial.current) { locked.current = false; setBusy(false); } }
  };
  const selectRun = (id: string) => {
    if (id === selectedRun) { void load(); return; }
    serial.current++; setPreview(null); setData(null); setNotice(""); setError(""); setSelectedRun(id);
  };
  const addEntities = Number(entities), addChars = Number(chars);
  const valid = entities.trim() !== "" && chars.trim() !== "" && Number.isSafeInteger(addEntities) && Number.isSafeInteger(addChars)
    && addEntities >= 0 && addChars >= 0 && addEntities + addChars > 0
    && (run?.maxEntities ?? 0) + addEntities <= 5000 && (run?.maxChars ?? 0) + addChars <= 5000000;
  const canExtend = run && run.status === "active" && !run.stale && run.counts.unread + run.counts.read > 0;
  const inspect = async () => {
    if (!run || !valid || locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice(""); const request = ++serial.current;
    try {
      const result = await call<Preview>({ action: "scan_preview_budget", runId: run.runId, expectedVersion: run.version, addEntities, addChars });
      if (request === serial.current) setPreview(result);
    } catch (e) { if (request === serial.current) { setPreview(null); setData(null); setError(`${String(e)}；请刷新进度后重试。`); } }
    finally { if (request === serial.current) { locked.current = false; setBusy(false); } }
  };
  const apply = async () => {
    if (!preview || locked.current) return;
    locked.current = true; setBusy(true); setError(""); const request = ++serial.current; const p = preview;
    try {
      const result = await call<Snapshot>({ action: "scan_apply_budget", runId: p.change.runId, expectedVersion: p.change.expectedVersion,
        addEntities: p.change.addEntities, addChars: p.change.addChars, confirmationToken: p.confirmationToken, requestId: `budget-${p.confirmationToken}` });
      if (request === serial.current) { setData(result); setPreview(null); setNotice("预算已追加，原任务和已用额度保持不变。点击“用 Codex 继续逐篇检查”即可续跑。"); }
    } catch (e) { if (request === serial.current) { setPreview(null); setData(null); setError(`未确认预算操作结果：${String(e)}。请刷新核对额度和追加记录，勿重复追加。`); } }
    finally { if (request === serial.current) { locked.current = false; setBusy(false); } }
  };
  return <details className="tag-scan-panel" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>逐篇检查进度与预算</summary>
    {open && !busy && !preview && <TagContentScanNewRound key={`${tagId}:${selectedRun}`} tagId={tagId} onCreated={id => {
      setHistory(null); selectRun(id);
    }} />}
    <div className="tag-scan-toolbar"><button type="button" disabled={busy} onClick={() => void loadHistory()}>查看历史任务</button>
      {selectedRun && <button type="button" disabled={busy} onClick={() => selectRun("")}>返回最近任务</button>}</div>
    {history && <div className="tag-scan-history" aria-label="历史检查任务">
      {!history.runs.length && <p>尚无历史任务。</p>}
      {history.runs.map(h => <button type="button" key={h.runId} disabled={busy || h.runId === run?.runId} onClick={() => selectRun(h.runId)}>
        {h.runId} · {h.status === "completed" ? "清单已结束" : "尚未结束"} · 已读 {h.entitiesRead} 个实体 / {fmt(h.charsRead)} 字符
      </button>)}
      {history.nextCursor && <button type="button" disabled={busy} onClick={() => void loadHistory(history.nextCursor!)}>加载更多历史任务</button>}
      <p className="tag-assignment-hint">历史状态不代表当前证据有效；选择后重新校验定义和范围。不会开始新的分析。</p>
    </div>}
    <div className="tag-scan-toolbar"><button type="button" disabled={busy} onClick={() => void load()}>刷新进度</button>
      </div>
    {open && data && <CodexContentScan key={run?.runId ?? tagId} tagId={tagId} runId={run?.runId} disabled={busy || !!preview} onRunningChange={setBusy} onCompleted={() => void load()} />}
    {busy && <p role="status">正在处理…</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {data && !run && <p>尚无逐篇检查任务。保存补标定义后，点击上方按钮开始。</p>}
    {run && <>
      <p>{run.stale ? "定义或范围已过期，仅可查看" : run.status === "completed" ? "清单已结束（不代表语义分析全部完成）" : "任务尚未结束"}</p>
      <p className="tag-assignment-hint">任务 {run.runId} · 进度版本 {run.version}</p>
      {run.incremental && <p>新增内容任务 · 基准 {run.incremental.baseRunId}；不包含基准链中的旧内容或其后续变化。</p>}
      {!run.stale && !busy && !preview && <TagContentScanNewRound key={`incremental:${run.runId}:${run.version}`} tagId={tagId} incrementalFromRunId={run.runId} onCreated={id => { setHistory(null); selectRun(id); }} />}
      {run.blockers.length > 0 && <ul>{run.blockers.map(b => <li key={b}>{b}</li>)}</ul>}
      <dl className="tag-scan-counts">
        <div><dt>清单实体</dt><dd>{fmt(run.totalEntities)}</dd></div>
        <div><dt>未读 / 已读未记录</dt><dd>{fmt(run.counts.unread)} / {fmt(run.counts.read)}</dd></div>
        <div><dt>已保存判断</dt><dd>{fmt(run.counts.recorded)}</dd></div>
        <div><dt>复用旧判断（非本轮新分析）</dt><dd>{fmt(run.counts.reused ?? 0)}</dd></div>
        <div><dt>已有标签 / 不可用</dt><dd>{fmt(run.counts.already_tagged)} / {fmt(run.counts.unavailable)}</dd></div>
        <div><dt>排除跳过（未分析）</dt><dd>{fmt(run.counts.excluded ?? 0)}</dd></div>
        {run.manifestMode === "union" && <div><dt>主标签不需判断（仍检查其他标签）</dt><dd>{fmt(run.counts.joint_only ?? 0)}</dd></div>}
        <div><dt>实体额度已用 / 总额</dt><dd>{fmt(run.entitiesRead)} / {fmt(run.maxEntities)}</dd></div>
        <div><dt>正文字符已用 / 总额</dt><dd>{fmt(run.charsRead)} / {fmt(run.maxChars)}</dd></div>
      </dl>
      <p>剩余：{fmt(run.remainingEntities)} 个新实体，{fmt(run.remainingChars)} 正文字符。</p>
      <TagContentScanJoint key={`joint:${tagId}:${run.runId}:${run.version}`} tagId={tagId} runId={run.runId} selection={run.jointSelection} counts={run.jointCounts} union={run.manifestMode === "union"} onCreated={id => { setHistory(null); selectRun(id); }} editable={run.status === "active" && !run.stale && !busy && !preview} />
      {(run.remainingChars === 0 || run.remainingEntities === 0) && <p>部分额度已用尽。实体额度只限制新实体；已读实体补读仍需剩余字符额度。</p>}
      <p className="tag-assignment-hint">建议补标 {run.decisionCounts.recommend_add} · 仅相关 {run.decisionCounts.related_only} · 不适用 {run.decisionCounts.out_of_scope} · 证据不足 {run.decisionCounts.insufficient_evidence}。这些是历史判断，不是批准数量。</p>
      {canExtend && <fieldset disabled={busy} className="tag-scan-budget"><legend>追加本任务预算</legend>
        {!preview ? <>
          <label>增加新实体额度<input type="number" min={0} max={5000 - run.maxEntities} step={1} value={entities} onChange={e => setEntities(e.target.value)} /></label>
          <label>增加正文字符额度<input type="number" min={0} max={5000000 - run.maxChars} step={1} value={chars} onChange={e => setChars(e.target.value)} /></label>
          <button type="button" disabled={!valid} onClick={() => void inspect()}>预览预算追加</button>
        </> : <div className="tag-scan-confirm" role="group" aria-label="确认预算追加">
          <p>实体总额：{fmt(preview.change.before.maxEntities)} → {fmt(preview.change.after.maxEntities)}；正文字符总额：{fmt(preview.change.before.maxChars)} → {fmt(preview.change.after.maxChars)}。</p>
          <p>仅为当前任务增加可读额度，不清零已用额度、不扩大资料库范围，也不自动执行分析。</p>
          <button type="button" onClick={() => void apply()}>确认追加预算</button><button type="button" onClick={() => setPreview(null)}>取消</button>
        </div>}
      </fieldset>}
      <p className="tag-assignment-hint">预算按正文字符计，不是 token 或金额。刷新仅查看进度，不启动 Codex；批准标签仍在待审核区进行。</p>
      {data && <TagContentScanBudgetHistory key={`${run.runId}:${run.version}`} runId={run.runId} recent={data.budgetHistory} />}
      <TagContentScanReopen key={`reopen:${run.runId}:${run.version}`} runId={run.runId} onReopened={() => void load()} />
      <TagContentScanReopenHistory key={`reopen-history:${run.runId}:${run.version}`} runId={run.runId} />
    </>}
  </details>;
}
