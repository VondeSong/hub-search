import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

export type BudgetEntry = { requestId?: string; createdAt?: number; change: { expectedVersion: number; addEntities: number; addChars: number;
  before: { maxEntities: number; maxChars: number }; after: { maxEntities: number; maxChars: number } } };
type Page = { entries: BudgetEntry[]; nextCursor: string | null };
const fmt = (n: number) => n.toLocaleString("zh-CN");
export function TagContentScanBudgetHistory({ runId, recent }: { runId: string; recent: BudgetEntry[] }) {
  const [page, setPage] = useState<Page | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = useRef(false), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const load = async (reset = false) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); const n = generation.current;
    const cursor = reset ? null : page?.nextCursor;
    try {
      const result = await invoke<Page>("tag_assignment", { args: { action: "scan_budget_history", runId, limit: 20, ...(cursor ? { cursor } : {}) } });
      if (n === generation.current) setPage(old => ({ ...result, entries: cursor && old
        ? [...old.entries, ...result.entries.filter(e => !old.entries.some(v => v.requestId === e.requestId))] : result.entries }));
    } catch (e) { if (n === generation.current) setError(String(e)); }
    finally { if (n === generation.current) { locked.current = false; setBusy(false); } }
  };
  const entries = page?.entries ?? recent;
  return <details><summary>{page ? `预算追加历史 · 已加载 ${entries.length} 条` : `最近 ${recent.length} 次预算追加`}</summary>
    <p className="tag-assignment-hint">仅查看当前任务的追加记录，不改变额度。时间按本机时区显示。</p>
    <ul>{entries.map((h, i) => <li key={h.requestId ?? h.change?.expectedVersion ?? i}>
      {h.createdAt != null && <time dateTime={new Date(h.createdAt * 1000).toISOString()}>{new Date(h.createdAt * 1000).toLocaleString("zh-CN")} · </time>}
      {h.change ? <>进度版本 {h.change.expectedVersion}：增加 {fmt(h.change.addEntities)} 个实体、{fmt(h.change.addChars)} 正文字符。
        实体总额 {fmt(h.change.before.maxEntities)} → {fmt(h.change.after.maxEntities)}；字符总额 {fmt(h.change.before.maxChars)} → {fmt(h.change.after.maxChars)}。</> : "该条记录无法解析"}
    </li>)}</ul>
    {!page && <button type="button" disabled={busy} onClick={() => void load()}>查看完整预算历史</button>}
    {page?.nextCursor && <button type="button" disabled={busy} onClick={() => void load()}>加载更早预算记录</button>}
    {page && <button type="button" disabled={busy} onClick={() => void load(true)}>刷新预算历史</button>}
    {page && !page.nextCursor && <p role="status">已显示全部预算追加记录。</p>}
    {busy && <p role="status">正在加载预算历史…</p>}{error && <p role="alert">预算历史加载失败：{error}。可重试，已显示的记录不会丢失。</p>}
  </details>;
}
