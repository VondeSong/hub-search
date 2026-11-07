import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { TagContentScanCheckHistory } from "./TagContentScanCheckHistory";
type Page = { items: { ordinal: number; title: string; state: string; checkedAt?: number; assessment?: { code: string; reason: string; canReopen: boolean } }[]; version: number; nextAfterOrdinal: number | null; checked?: boolean; nextCursor?: string | null; blockers?: string[]; saved?: boolean; checkpointId?: number; checkpointStale?: boolean; checkpointSuperseded?: boolean };
type Preview = { confirmationToken: string; change: { ordinal: number; expectedVersion: number; reason: string; beforeRunStatus: string;
  before: { title: string; proposalId: string }; entitiesRead: number; charsRead: number; maxEntities: number; maxChars: number } };
export function TagContentScanReopen({ runId, onReopened }: { runId: string; onReopened: () => void }) {
  const [page, setPage] = useState<Page | null>(null), [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); const n = generation.current;
    try {
      const result = await invoke<Page & Preview>("tag_assignment", { args: { action, runId, ...extra } });
      if (n !== generation.current) return;
      if (["scan_reopen_items", "scan_check_items", "scan_check_save", "scan_check_saved"].includes(action)) { setPreview(null); setPage(old => ({ ...result, items: (extra.afterOrdinal || extra.cursor) && old ? [...old.items, ...result.items.filter(i => !old.items.some(o => o.ordinal === i.ordinal))] : result.items })); }
      else if (action === "scan_preview_reopen") setPreview(result);
      else { setPreview(null); setPage(null); onReopened(); }
    } catch (e) { if (n === generation.current) { setPreview(null); setError(`${String(e)}${action === "scan_apply_reopen" ? "；请先刷新任务进度核对结果，勿重复确认。" : ""}`); } }
    finally { if (n === generation.current) { lock.current = false; setBusy(false); } }
  };
  return <details><summary>检查已处理项 / 单项重开</summary>
    <p className="tag-assignment-hint">只重开正文或标签上下文已变化、恢复可用、或已撤销排除的项，不重跑整轮。缺少历史上下文时不推断变化；已审核决定保留，定义变化请新建一轮。</p>
    <fieldset disabled={busy} className="tag-scan-budget">
      <button type="button" onClick={() => void act("scan_reopen_items")}>刷新可检查项</button>
      <button type="button" onClick={() => void act("scan_check_save", { limit: 10, requestId: crypto.randomUUID() })}>分批检查失效项</button>
      <button type="button" onClick={() => void act("scan_check_saved")}>恢复上次检查</button>
      <p>检查后保存批次断点；恢复只显示上次一批历史结果，不重新读取正文。重新点击“分批检查失效项”会从头检查，不自动重开任何内容。</p>
      {page && !preview && <>
        {page.saved === false && <p>尚无已保存的检查断点。</p>}
        {page.checkpointSuperseded && <p>此批次已被后续检查替代，请恢复最新检查后继续。</p>}
        {page.checkpointStale && <p>任务或定义已变化，历史检查仅供参考；请从头重新检查。</p>}
        {page.checked && <p>本次已核对 {page.items.length} 项，其中 {page.items.filter(i => i.assessment?.canReopen).length} 项可预览重开。仅检查已记录、复用、排除跳过或不可用项，不代表全库语义分析。</p>}
        {page.blockers?.map(b => <p key={b}>{b}</p>)}
        <ul>{page.items.map(i => <li key={i.ordinal}>{i.title} · #{i.ordinal}
          {i.assessment && <p>{i.assessment.reason}{i.checkedAt != null && `（检查于 ${new Date(i.checkedAt * 1000).toLocaleString("zh-CN")}）`}</p>}
          {!page.checkpointStale && (!page.checked || i.assessment?.canReopen) && <button type="button" aria-label={`检查重开第 ${i.ordinal} 项`} onClick={() => void act("scan_preview_reopen", { ordinal: i.ordinal, expectedVersion: page.version })}>检查是否可重开</button>}
        </li>)}</ul>
        {!page.items.length && <p>没有可检查的已处理项。</p>}
        {page.nextAfterOrdinal != null && <button type="button" onClick={() => void act("scan_reopen_items", { afterOrdinal: page.nextAfterOrdinal })}>加载更多可检查项</button>}
        {page.checked && !page.checkpointStale && !page.checkpointSuperseded && page.nextCursor && <button type="button" onClick={() => void act("scan_check_save", { cursor: page.nextCursor, checkpointId: page.checkpointId, limit: 10, requestId: crypto.randomUUID() })}>检查下一批</button>}
        {page.checked ? <p>{page.checkpointStale || page.checkpointSuperseded ? "旧断点已失效。" : !page.nextCursor ? "已检查至清单末尾。" : "仍有未检查项。"}每批仅反映检查时点，不是全库同一时刻的快照；结果可能变化，重开前仍需单独预览确认。</p> : <p>列表不是失效判断；点击单项后才读取当前证据核对。</p>}</>}
      {preview && <div role="group" aria-label="确认单项重开">
        <p>{preview.change.before.title} · #{preview.change.ordinal}：{preview.change.reason}</p>
        <p>仅此项回到未读，强制重新取证；原建议与审计记录保留。{preview.change.beforeRunStatus === "completed" ? "原任务将恢复为尚未结束。" : ""}</p>
        <p>已用额度保持 {preview.change.entitiesRead} / {preview.change.maxEntities} 个实体、{preview.change.charsRead} / {preview.change.maxChars} 正文字符。不会退还或追加预算，也不自动启动 Codex。</p>
        <button type="button" onClick={() => void act("scan_apply_reopen", { ordinal: preview.change.ordinal, expectedVersion: preview.change.expectedVersion, confirmationToken: preview.confirmationToken, requestId: `reopen-${preview.confirmationToken}` })}>确认只重开此项</button>
        <button type="button" onClick={() => setPreview(null)}>取消重开</button>
      </div>}
    </fieldset>
    <TagContentScanCheckHistory key={runId} runId={runId} />
    {busy && <p role="status">正在检查…</p>}{error && <p role="alert">{error}</p>}
  </details>;
}
