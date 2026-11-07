import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, FileDown, LoaderCircle, RotateCcw, SkipForward } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadFailureMessage, downloadFailureTarget, type DownloadFailureItem, type DownloadFailurePage, type DownloadFailureView } from "./DownloadFailureTypes";
import { useVisiblePolling } from "./useVisiblePolling";
import { ViewRequest } from "./ViewRequest";
import "./DownloadFailuresPanel.css";

const PAGE_SIZE = 25;
const STATES: Record<DownloadFailureItem["issueState"], string> = {
  failed: "下载失败", scheduled: "已安排重试", retrying: "正在下载", unavailable: "来源不可用", rejected: "文件未能读取", dismissed: "已跳过",
};

export function DownloadFailuresPanel({ spaceId = null, onChanged }: {
  spaceId?: string | null;
  onChanged?: () => Promise<unknown> | unknown;
}) {
  const [libraryId,setLibraryId] = useState(spaceId ?? "");
  const [view,setView] = useState<DownloadFailureView>("failed");
  const [offset,setOffset] = useState(0);
  const [page,setPage] = useState<DownloadFailurePage>();
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const requests = useRef(new ViewRequest());
  const actionInFlight = useRef(false);
  const mounted = useRef(false);
  const adoptedPageKey = useRef<string|undefined>(undefined);
  const headingRef = useRef<HTMLParagraphElement>(null);
  const activeLibraryId = spaceId || libraryId;
  const key = JSON.stringify([spaceId,activeLibraryId,view,offset]);
  requests.current.select(key);
  const query = useCallback(() => ({ libraryId: activeLibraryId || null, status: view, offset, limit: PAGE_SIZE }),[activeLibraryId,view,offset]);
  const acceptPage = useCallback((value:DownloadFailurePage) => {
    if (value.offset!==offset) {
      // The backend returns the clamped offset and its rows in one snapshot.
      // Adopt them together instead of rereading or briefly showing an empty page.
      adoptedPageKey.current=JSON.stringify([spaceId,activeLibraryId,view,value.offset]);
      setOffset(value.offset);
    }
    setPage(value);
  },[activeLibraryId,offset,spaceId,view]);

  const load = useCallback((fresh = false) => requests.current.run(key,async current => {
    try {
      if (current()) setLoading(true);
      const value = await invoke<DownloadFailurePage>("attachment_download_failures", { args: { action: "list", ...query() } });
      if (current()) { setError("");setLoading(false); }
      return value;
    } catch (reason) {
      if (current()) { setError(downloadFailureMessage(reason) || "下载记录暂时无法读取");setLoading(false); }
      throw reason;
    }
  },acceptPage,fresh).catch(() => undefined),[acceptPage,key,query]);

  useEffect(() => {
    mounted.current=true;
    headingRef.current?.focus({ preventScroll: true });
    return () => { mounted.current=false;requests.current.invalidate(); };
  },[]);
  useEffect(() => { setLibraryId(spaceId ?? "");setOffset(0); },[spaceId]);
  useEffect(() => {
    const adopted=adoptedPageKey.current===key;
    adoptedPageKey.current=undefined;
    if (adopted) { setLoading(false);return () => { requests.current.invalidate(); }; }
    setPage(undefined);setLoading(true);setError("");setBusy(actionInFlight.current);
    void load(true);
    return () => { requests.current.invalidate(); };
  },[key,load]);
  useVisiblePolling(() => load(false),Boolean(page) && !busy && !error,5000,{ refreshKey:key,initialDelayMs:5000 });

  const act = async (action: "skip" | "retry", selected: DownloadFailureItem[]) => {
    if (actionInFlight.current) return;
    const items = selected.filter(item => item.status!=="running" && (action === "skip" ? item.canSkip : item.canRetry)).map(downloadFailureTarget);
    if (!items.length) return;
    actionInFlight.current=true;setBusy(true);setError("");setNotice("");
    requests.current.invalidate();
    const current=requests.current.guard(key);
    try {
      const result=await invoke<DownloadFailurePage>("attachment_download_failures",{ args: { action,...query(),items } });
      if (!current()) return;
      acceptPage(result);
      setNotice(result.changed
        ? action === "skip" ? `已跳过 ${result.changed} 个附件；可在“已跳过”中再次重试。` : `已重新排队 ${result.changed} 个附件，下载结果将随后更新。`
        : "项目状态已变化，请查看最新记录。");
      await onChanged?.();
    } catch (reason) {
      if (current()) setError(downloadFailureMessage(reason) || "操作未能完成，请重试");
    } finally {
      actionInFlight.current=false;
      if (mounted.current) setBusy(false);
    }
  };

  const retryable = page?.items.filter(item => item.status!=="running" && item.canRetry) ?? [];
  const skippable = page?.items.filter(item => item.status!=="running" && item.canSkip) ?? [];
  const resetOffset = () => {setOffset(0);setNotice("");};
  return <div className="download-failures-panel">
    <p ref={headingRef} tabIndex={-1} className="download-failures-intro">失败附件集中在此处理。跳过后暂停该附件的自动下载，原文档和已有缓存保留。</p>
    <div className="download-failures-toolbar">
      <label>资料库<select aria-label="筛选下载失败的资料库" value={activeLibraryId} disabled={busy || Boolean(spaceId)} onChange={event => {setLibraryId(event.target.value);resetOffset();}}>
        {!spaceId && <option value="">全部资料库</option>}
        {spaceId && !page?.libraries.some(library => library.id===spaceId) && <option value={spaceId}>当前资料库</option>}
        {page?.libraries.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}
      </select></label>
      <button type="button" disabled={busy || loading} onClick={() => void load(true)} aria-label="刷新下载记录"><RotateCcw size={14} /></button>
    </div>
    <div className="download-failures-views" role="group" aria-label="下载记录状态">
      <button type="button" aria-pressed={view==="failed"} onClick={() => {setView("failed");resetOffset();}}>待处理{page ? ` ${page.failedCount}` : ""}</button>
      <button type="button" aria-pressed={view==="dismissed"} onClick={() => {setView("dismissed");resetOffset();}}>已跳过{page ? ` ${page.skippedCount}` : ""}</button>
    </div>
    {error && <p className="download-failures-error" role="alert">{error}<button type="button" disabled={busy || loading} onClick={() => void load(true)}>重新读取</button></p>}
    {notice && <p className="download-failures-notice" role="status">{notice}</p>}
    {loading && <p className="download-failures-empty" role="status"><LoaderCircle className="spin" size={16} />正在读取下载记录…</p>}
    {!loading && page && !page.items.length && <p className="download-failures-empty"><CheckCircle2 size={18} />{view==="dismissed" ? "当前没有已跳过的附件" : "当前没有需要处理的下载失败"}</p>}
    {page && page.items.length>0 && <>
      <div className="download-failures-batch">
        <span>本页 {page.items.length} 项</span>
        <div><button type="button" disabled={busy || !skippable.length} onClick={() => void act("skip",page.items)}><SkipForward size={13} />跳过本页</button>
        <button type="button" disabled={busy || !retryable.length} onClick={() => void act("retry",page.items)}><RotateCcw size={13} />重试本页</button></div>
      </div>
      <div className="download-failures-list">{page.items.map(item => <article className="download-failure-item" key={item.jobId}>
        <div className="download-failure-title"><FileDown size={15} aria-hidden="true" /><strong>{item.title}</strong><small>{STATES[item.issueState]}</small></div>
        <div className="download-failure-context"><span>{item.libraryName}</span>{item.parentTitle && <span>所在文档：{item.parentTitle}</span>}</div>
        {item.documentPath && <p className="download-failure-path">{item.documentPath}</p>}
        <p className="download-failure-reason">{downloadFailureMessage(item.error)}</p>
        <div className="download-failure-actions"><small>已尝试 {item.attempts} 次{item.hasCache ? " · 已有缓存保留" : ""}</small><div>
          {item.canSkip && <button type="button" disabled={busy || item.status==="running"} aria-label={`跳过 ${item.title}`} onClick={() => void act("skip",[item])}><SkipForward size={13} />跳过</button>}
          {item.canRetry && <button type="button" disabled={busy || item.status==="running"} aria-label={`再次重试 ${item.title}`} onClick={() => void act("retry",[item])}><RotateCcw size={13} />再次重试</button>}
        </div></div>
      </article>)}</div>
      <div className="download-failures-pagination"><span>{offset+1}–{offset+page.items.length} / {page.total}</span><div>
        <button type="button" disabled={busy || !offset} onClick={() => setOffset(Math.max(0,offset-PAGE_SIZE))}>上一页</button>
        <button type="button" disabled={busy || offset+PAGE_SIZE>=page.total} onClick={() => setOffset(offset+PAGE_SIZE)}>下一页</button>
      </div></div>
    </>}
  </div>;
}
