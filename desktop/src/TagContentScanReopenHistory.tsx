import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
type Snapshot = { ordinal: number; title: string; reason: string; previousState: string; previousRunStatus: string; expectedVersion: number;
  previousProposalId: string; proposalStatusAtReopen: string | null; actor: string; entitiesRead: number; charsRead: number; maxEntities: number; maxChars: number;
  previousSourceHash: string; currentSourceHashAtReopen: string };
type Page = { entries: { requestId: string; createdAt: number; snapshot: Snapshot | null }[]; nextCursor: string | null };
const stateLabels: Record<string, string> = { recorded: "已记录判断", reused: "复用旧判断", unavailable: "不可用", completed: "已结束", active: "尚未结束", pending: "待审核" };
const stateName = (s: string | null) => stateLabels[s ?? ""] ?? s ?? "未记录";
const fmt = (n: number | null) => n == null ? "未记录" : n.toLocaleString("zh-CN");
export function TagContentScanReopenHistory({ runId }: { runId: string }) {
  const [page, setPage] = useState<Page | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = useRef(false), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const load = async (reset = false) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); const n = generation.current;
    const cursor = reset ? null : page?.nextCursor;
    try {
      const result = await invoke<Page>("tag_assignment", { args: { action: "scan_reopen_history", runId, limit: 20, ...(cursor ? { cursor } : {}) } });
      if (n === generation.current) setPage(old => ({ ...result, entries: cursor && old ? [...old.entries, ...result.entries.filter(e => !old.entries.some(o => o.requestId === e.requestId))] : result.entries }));
    } catch (e) { if (n === generation.current) setError(String(e)); }
    finally { if (n === generation.current) { locked.current = false; setBusy(false); } }
  };
  return <details><summary>单项重开历史{page ? ` · 已加载 ${page.entries.length} 条` : ""}</summary>
    <p className="tag-assignment-hint">仅显示重开时的快照，不代表当前状态。查看不会重开任务、追加预算或修改标签。时间按本机时区显示。</p>
    <button type="button" disabled={busy} onClick={() => void load(true)}>{page ? "刷新重开历史" : "查看重开历史"}</button>
    {page && <ul>{page.entries.map(e => <li key={e.requestId}>
      <time dateTime={new Date(e.createdAt * 1000).toISOString()}>{new Date(e.createdAt * 1000).toLocaleString("zh-CN")}</time>
      {e.snapshot ? <><p>#{e.snapshot.ordinal} {e.snapshot.title}：{e.snapshot.reason}</p>
        <p>原状态：{stateName(e.snapshot.previousState)} → 未读；任务：{stateName(e.snapshot.previousRunStatus)} → 尚未结束。进度版本 {e.snapshot.expectedVersion} → {e.snapshot.expectedVersion + 1}。</p>
        <details><summary>查看当时的建议与预算</summary>
          <p style={{ overflowWrap: "anywhere" }}>原建议：{e.snapshot.previousProposalId || "无"}；当时审核状态：{stateName(e.snapshot.proposalStatusAtReopen)}。</p>
          <p>预算未改变：实体已用 {fmt(e.snapshot.entitiesRead)} / {fmt(e.snapshot.maxEntities)}；正文字符已用 {fmt(e.snapshot.charsRead)} / {fmt(e.snapshot.maxChars)}。</p>
          <p>操作来源：{e.snapshot.actor === "hub-user" ? "Hub 用户确认" : e.snapshot.actor || "未记录"}。</p>
          <p style={{ overflowWrap: "anywhere" }}>原证据版本：{e.snapshot.previousSourceHash || "无"}</p><p style={{ overflowWrap: "anywhere" }}>重开时证据版本：{e.snapshot.currentSourceHashAtReopen || "无"}</p>
        </details></> : <p>该条历史记录无法解析。</p>}
    </li>)}</ul>}
    {page?.nextCursor && <button type="button" disabled={busy} onClick={() => void load()}>加载更早重开记录</button>}
    {page && !page.nextCursor && <p role="status">{page.entries.length ? "本次已加载全部重开记录；新增记录请刷新。" : "当前任务尚无重开记录。"}</p>}
    {busy && <p role="status">正在加载重开历史…</p>}{error && <p role="alert">加载失败：{error}。可重试，已显示的记录保持不变。</p>}
  </details>;
}
