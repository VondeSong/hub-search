import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { downloadFailureMessage } from "./DownloadFailureTypes";
import "./DownloadFailuresPanel.css";

type Item = { id: number; title: string; parentTitle?: string; documentPath?: string; libraryName: string; jobType: string; error: string; attempts: number; archivedAt: number; status?: string; updatedAt?: number; canRetry: boolean };
type Page = { items: Item[]; total: number; offset: number; changed: boolean };
const kinds: Record<string, string> = { download_source: "附件下载", import_local_source: "导入附件", ocr_page: "文字识别", extract_pdf: "PDF 提取", upsert_lexical: "更新索引", delete_lexical: "清理索引" };
export function SkippedJobsPanel({ spaceId = null, onChanged }: { spaceId?: string | null; onChanged?: () => unknown }) {
  const [page, setPage] = useState<Page>();
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const read = async () => {
    const token = ++generation.current;
    setBusy(true);
    try {
      const result = await invoke<Page>("skipped_index_jobs", { args: { action: "list", libraryId: spaceId, offset } });
      if (token === generation.current) { setPage(result); setError(""); }
    } catch (reason) { if (token === generation.current) setError(downloadFailureMessage(reason)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  useEffect(() => { setPage(undefined); void read(); return () => { ++generation.current; }; }, [spaceId, offset]);
  const retry = async (item: Item) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    const token = generation.current;
    try {
      const result = await invoke<Page>("skipped_index_jobs", { args: { action: "retry", libraryId: spaceId, offset, archiveId: item.id, updatedAt: item.updatedAt } });
      if (token !== generation.current) return;
      setPage(result); setNotice(result.changed ? "已重新排队，跳过记录继续保留。" : "项目状态已变化，记录已刷新。");
      await onChanged?.();
    } catch (reason) { if (token === generation.current) setError(downloadFailureMessage(reason)); }
    finally { inFlight.current = false; if (token === generation.current) setBusy(false); }
  };
  return <div className="download-failures-panel">
    <p className="download-failures-intro">手动跳过的下载、文字识别和索引任务在此存档。后续同步、重试或来源移除后，记录仍会保留。</p>
    <div className="download-failures-batch"><span>已跳过 {page?.total ?? "…"} 项</span><button disabled={busy} onClick={() => void read()}>刷新记录</button></div>
    {error && <p role="alert" className="download-failures-error">{error}</p>}
    {notice && <p role="status" className="download-failures-notice">{notice}</p>}
    {!page && busy && <p role="status">正在读取跳过记录…</p>}
    {page?.total === 0 && <p>当前没有已跳过的任务</p>}
    <div className="download-failures-list">{page?.items.map(item => <article key={item.id} className="download-failure-item">
      <div className="download-failure-title"><strong>{item.title}</strong><small>{kinds[item.jobType] ?? "后台任务"} · 已跳过</small></div>
      <div className="download-failure-context"><span>{item.libraryName}</span>{item.parentTitle && <span>所在文档：{item.parentTitle}</span>}</div>
      {item.documentPath && <p className="download-failure-path">{item.documentPath}</p>}
      <p className="download-failure-reason">{downloadFailureMessage(item.error) || "用户选择跳过"}</p>
      <div className="download-failure-actions"><small>{new Date(item.archivedAt * 1000).toLocaleString("zh-CN")} · 当时已尝试 {item.attempts} 次</small>
        {item.canRetry ? <button disabled={busy} aria-label={`重试已跳过的任务 ${item.title}`} onClick={() => void retry(item)}>再次重试</button> : <small>{item.status === "pending" || item.status === "running" ? "已重新安排" : item.status === "completed" ? "当前任务已结束" : "原记录存档"}</small>}
      </div>
    </article>)}</div>
    {!!page?.total && <div className="download-failures-pagination"><span>{page.offset + 1}–{page.offset + page.items.length} / {page.total}</span><div>
      <button disabled={busy || !page.offset} onClick={() => setOffset(Math.max(0, page.offset - 25))}>上一页</button>
      <button disabled={busy || page.offset + 25 >= page.total} onClick={() => setOffset(page.offset + 25)}>下一页</button>
    </div></div>}
  </div>;
}
