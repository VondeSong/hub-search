import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { didaRetentionExplanation, type DidaRetentionKind } from "./DidaReadingStatus";
import "./DidaReadingResolutions.css";

type Item = { key: string; title: string; sourceUrl?: string; snapshot: string; error: string; reasonKind?: DidaRetentionKind; state: string; updatedAt: number };
type Props = { busy: boolean; onRetry: () => void; onOpenUrl?: (url: string) => void; pendingCount?: number; preservedCount?: number };

// Keep linked titles concise without modifying the original source receipt.
const displayTitle = (title: string) => title.trim().replace(
  /\[((?:[^\[\]]|\[[^\]]*\])*)\]\((?:[^()\s]|\([^()]*\))+(?:\s+"[^"]*")?\)/g,
  "$1",
).split(/\r?\n/).find(Boolean) || "滴答稍后读";

export function DidaReadingResolutions({ busy, onRetry, onOpenUrl, pendingCount, preservedCount }: Props) {
  const [open, setOpen] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]), [working, setWorking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const mounted = useRef(true), request = useRef(0), deciding = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current += 1; }; }, []);
  const load = async () => {
    const current = ++request.current;
    setWorking(true); setError("");
    try {
      const records = await invoke<Item[]>("list_dida_reading_resolutions");
      if (mounted.current && current === request.current) { setItems(records); setLoaded(true); }
    } catch (e) {
      if (mounted.current && current === request.current) setError(String(e));
    } finally {
      if (mounted.current && current === request.current) setWorking(false);
    }
  };
  // Refresh when a sync ends; completed decisions remain in closed history.
  useEffect(() => { if (open && !busy && !deciding.current) void load(); }, [open, busy, pendingCount, preservedCount]);
  const resolve = async (item: Item, preserve: boolean) => {
    const current = ++request.current;
    deciding.current = true;
    setWorking(true); setError(""); setNotice("");
    try {
      await invoke("resolve_dida_reading", { key: item.key, snapshot: item.snapshot, error: item.error, updatedAt: item.updatedAt, preserve });
      if (!mounted.current || current !== request.current) return;
      // Successful decisions disappear from the actionable list immediately,
      // even if loading the updated list later fails.
      setItems(records => records.map(record => record.key === item.key ? {
        ...record, state: preserve ? "preserved" : "pending",
        error: preserve ? "用户选择保留两边内容，已结束自动清理" : "用户要求重新读取检查",
      } : record));
      setNotice(preserve ? "这条已结束处理。Hub 与滴答的内容都保留，记录已移到“已结束处理”。" : "已恢复检查，将重新读取这条内容。");
      if (preserve) setHistoryOpen(false);
      if (!preserve) onRetry();
      const records = await invoke<Item[]>("list_dida_reading_resolutions");
      if (mounted.current && current === request.current) setItems(records);
    } catch (e) {
      if (mounted.current && current === request.current) setError(String(e));
    } finally {
      deciding.current = false;
      if (mounted.current && current === request.current) setWorking(false);
    }
  };
  const pending = items.filter(item => item.state !== "preserved");
  const history = items.filter(item => item.state === "preserved");
  const pendingLabelCount = open && loaded ? pending.length : pendingCount;
  const renderItem = (item: Item, completed: boolean) => <article key={item.key} className={`collection-dida-resolution-item${completed ? " is-history" : ""}`}>
    <div className="collection-dida-resolution-heading"><strong title={displayTitle(item.title)}>{displayTitle(item.title)}</strong><span>{completed ? "已结束" : "待处理"}</span></div>
    <p>{completed ? "已选择保留 Hub 与滴答内容，不再自动删除滴答原项。" : didaRetentionExplanation({ message: item.error, kind: item.reasonKind, count: 1 })}</p>
    <div className="collection-dida-resolution-actions">
      {item.sourceUrl && onOpenUrl && <button onClick={() => onOpenUrl(item.sourceUrl!)}>查看滴答原内容</button>}
      <button disabled={working || busy} onClick={() => void resolve(item, false)}>{completed ? "恢复自动检查" : "重新读取并检查"}</button>
      {!completed && <button disabled={working || busy} onClick={() => void resolve(item, true)}>保留两边，结束此项处理</button>}
    </div>
  </article>;
  return <section className="collection-dida-resolutions" aria-label="滴答原内容处理方案">
    <button aria-expanded={open} onClick={() => setOpen(!open)}>处理保留的原内容{pendingLabelCount !== undefined && pendingLabelCount > 0 ? ` · ${pendingLabelCount} 项待处理` : ""}</button>
    {open && <>
      <p className="collection-dida-resolution-intro">每条内容可重新检查，也可保留两边并结束自动清理。结束后会移到历史记录，不再作为待处理问题。</p>
      {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
      <button disabled={working || busy} onClick={() => void load()}>刷新处理记录</button>
      {busy && <p>滴答正在同步，本轮结束后即可选择处理方式。</p>}
      <section className="collection-dida-resolution-pending" aria-label="待处理原内容">
        <div className="collection-dida-resolution-section-heading"><strong>待处理</strong><span>{pending.length} 项</span></div>
        {pending.map(item => renderItem(item, false))}
        {!working && !pending.length && <p>没有待处理的原内容。</p>}
      </section>
      {!!history.length && <details className="collection-dida-resolution-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
        <summary>已结束处理 · {history.length} 项</summary>
        <p>这些记录已处理完，不影响后续同步。需要时可恢复检查。</p>
        {historyOpen && history.map(item => renderItem(item, true))}
      </details>}
    </>}
  </section>;
}
