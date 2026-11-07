import { Activity, AlertCircle, AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Clock3, Cloud, Copy, FileImage, FileText, LoaderCircle, RotateCcw, Settings, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type ReactNode, type SetStateAction } from "react";
import type { FailedIndexItem, IndexStatus } from "./IndexStatusTypes";
import type { LibrarySummary } from "./SearchTypes";
import { librarySyncState, summarizeSyncHealth } from "./SyncHealthPresentation";
import { CodexSuiteFooter } from "./CodexSuiteFooter";
import { SkippedJobsPanel } from "./SkippedJobsPanel";
import { DownloadFailuresPanel } from "./DownloadFailuresPanel";
import { downloadFailureMessage } from "./DownloadFailureTypes";

type OperationStatus = { text: string; tone: "working" | "success" | "warning" | "error" } | null;

type FooterStatusProps = {
  dismissFailedJobs: (options?: { excludeDownloads?: boolean }) => void | Promise<void>;
  dismissingFailedJobs: boolean;
  indexDetailsOpen: boolean;
  indexJobTypeLabel: (jobType: string) => string;
  indexStatus: IndexStatus | null;
  operationStatus: OperationStatus;
  refreshIndex: () => void | Promise<void>;
  retryFailedJobs: (options?: { excludeDownloads?: boolean }) => void | Promise<void>;
  retryingFailedJobs: boolean;
  spaces: LibrarySummary[];
  setIndexDetailsOpen: Dispatch<SetStateAction<boolean>>;
  setShowConnection: Dispatch<SetStateAction<boolean>>;
  startWindowDrag: (event: ReactMouseEvent<HTMLElement>) => void;
  syncing: boolean;
  versionLabel: string;
  statusSpaceId?: string | null;
  refreshStatus?: () => Promise<unknown> | unknown;
  flashcardsActive?: boolean;
  mobileNavigation?: ReactNode;
};

const PROVIDER_NAMES: Record<string, string> = {
  craft: "Craft",
  obsidian: "Obsidian",
  dida365: "滴答清单",
  feishu: "飞书",
};

function formatSyncTime(value?: string | number) {
  if (value === undefined || value === null || value === "") return "尚未同步";
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const elapsed = Date.now() - date.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return "刚刚";
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`;
  if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatRetryTime(value?: number) {
  if (!value) return "稍后自动重试";
  const seconds = value - Math.floor(Date.now() / 1_000);
  if (seconds <= 10) return "即将自动重试";
  if (seconds < 60) return `约 ${seconds} 秒后重试`;
  if (seconds < 3_600) return `约 ${Math.ceil(seconds / 60)} 分钟后重试`;
  return `${new Date(value * 1_000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 重试`;
}

function failedItemKind(item: FailedIndexItem) {
  if (item.mimeType === "application/pdf") return item.pageNumber !== undefined ? `PDF · 第 ${item.pageNumber} 页` : "PDF";
  if (item.mimeType?.startsWith("image/")) return item.mimeType.slice(6).toUpperCase() || "图片";
  return item.sourceType.includes("attachment") ? "附件" : item.sourceType;
}

function failedItemAdvice(item: FailedIndexItem) {
  const message = item.error.toLocaleLowerCase();
  if (message.includes("无法解码图片") || message.includes("0x88982f61")) {
    return "请先打开原图确认文件未损坏；能打开时另存为 PNG/JPEG 后替换原文件，打不开时请重新下载或重新导出。";
  }
  if (item.mimeType === "application/pdf" || message.includes("pdf")) {
    return "请用 PDF 阅读器确认文件可打开且未加密；异常时重新导出或“打印为 PDF”，替换原文件后再重试。";
  }
  if (message.includes("下载") || message.includes("http")) {
    return "请确认来源仍可访问及网络正常，然后重试；若链接已失效，请在原文档中重新上传附件。";
  }
  return "请按下方来源信息检查原文件，修复或替换后点击“重试失败任务”。";
}

export function FooterStatus({
  dismissFailedJobs,
  dismissingFailedJobs,
  indexDetailsOpen,
  indexJobTypeLabel,
  indexStatus,
  operationStatus,
  refreshIndex,
  retryFailedJobs,
  retryingFailedJobs,
  spaces,
  setIndexDetailsOpen,
  setShowConnection,
  startWindowDrag,
  syncing,
  versionLabel,
  statusSpaceId = null,
  refreshStatus,
  flashcardsActive = false,
  mobileNavigation,
}: FooterStatusProps) {
  const [copied, setCopied] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [skippedOpen, setSkippedOpen] = useState(false);
  const detailOpen = downloadsOpen || skippedOpen;
  const indexButtonRef = useRef<HTMLButtonElement>(null);
  const indexPopoverRef = useRef<HTMLElement>(null);
  const downloadsButtonRef = useRef<HTMLButtonElement>(null);
  const returningToHealth = useRef(false);
  const connectedById = useMemo(() => new Map(spaces.map((space) => [space.id, space.connected])), [spaces]);
  const { actionRequired, awaitingRetry, tone: healthTone } = summarizeSyncHealth(indexStatus, syncing);
  const indexLabel = syncing
    ? "正在同步资料库…"
    : indexStatus
      ? `本地索引 ${indexStatus.documentCount} 篇${indexStatus.pendingJobs ? ` · ${indexStatus.jobDetails.some(job => job.status === "running" && job.count > 0) ? "处理中" : "等待处理"} ${indexStatus.pendingJobs}` : ""}${indexStatus.failedJobs ? ` · 失败 ${indexStatus.failedJobs}` : actionRequired.length ? ` · 需处理 ${actionRequired.length}` : awaitingRetry.length ? " · 等待重试" : ""} · ${versionLabel}`
      : `尚未建立索引 · ${versionLabel}`;
  const otherFailedJobs = indexStatus?.jobDetails.filter((job) => job.jobType !== "download_source" && job.status === "failed")
    .reduce((total,job) => total+job.count,0) ?? 0;

  const returnToHealth = () => {
    returningToHealth.current=true;
    setDownloadsOpen(false); setSkippedOpen(false);
  };

  useEffect(() => { if (!indexDetailsOpen) {setDownloadsOpen(false);setSkippedOpen(false);} }, [indexDetailsOpen]);
  useEffect(() => {
    if (!detailOpen && indexDetailsOpen && returningToHealth.current) {
      returningToHealth.current=false;downloadsButtonRef.current?.focus();
    }
  },[detailOpen,indexDetailsOpen]);

  useEffect(() => {
    if (!indexDetailsOpen) return;
    const dismissWhenOutside = (event: PointerEvent | FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (indexButtonRef.current?.contains(target) || indexPopoverRef.current?.contains(target)) return;
      setIndexDetailsOpen(false);
    };
    const dismissWhenWindowBlurs = () => setIndexDetailsOpen(false);
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (detailOpen) returnToHealth(); else setIndexDetailsOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismissWhenOutside, true);
    document.addEventListener("focusin", dismissWhenOutside, true);
    window.addEventListener("blur", dismissWhenWindowBlurs);
    window.addEventListener("keydown", dismissWithEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissWhenOutside, true);
      document.removeEventListener("focusin", dismissWhenOutside, true);
      window.removeEventListener("blur", dismissWhenWindowBlurs);
      window.removeEventListener("keydown", dismissWithEscape);
    };
  }, [detailOpen, indexDetailsOpen, setIndexDetailsOpen]);

  const copyErrors = async () => {
    if (!indexStatus) return;
    const detailedItems = indexStatus.libraryHealth.flatMap((library) =>
      (library.failedItems ?? []).filter(item => item.jobType !== "download_source").map((item) => ({ library, item })),
    );
    const detailedErrors = new Set(detailedItems.map(({ item }) => item.error));
    const lines = [
      ...actionRequired.filter((item) => !item.failedItems?.length).map((item) => `${item.name}（${PROVIDER_NAMES[item.provider] ?? item.provider}）：${item.lastError ?? `${item.failedJobs} 个任务失败`}`),
      ...detailedItems.map(({ library, item }) => [
        `${library.name} / ${item.title}`,
        item.parentTitle ? `所在文档：${item.parentTitle}` : "",
        item.documentPath ? `所在路径：${item.documentPath}` : "",
        `类型：${failedItemKind(item)}；阶段：${indexJobTypeLabel(item.jobType)}；已尝试：${item.attempts} 次`,
        `来源：${item.sourceReference ?? item.sourceId}`,
        `错误：${item.error}`,
        `建议：${failedItemAdvice(item)}`,
      ].filter(Boolean).join("\n")),
      ...indexStatus.jobDetails.filter((item) => item.jobType !== "download_source" && item.status !== "not_applicable" && item.lastError && !detailedErrors.has(item.lastError)).map((item) => `${indexJobTypeLabel(item.jobType)}：${item.lastError}`),
      ...indexStatus.obsidianWatchers.filter((item) => item.lastError).map((item) => `Obsidian 文件监听：${item.lastError}`),
    ];
    await navigator.clipboard.writeText(downloadFailureMessage(lines.join("\n")));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  };

  return (
    <footer className={`footer-bar${mobileNavigation ? " mobile-navigation-footer" : ""}`} onMouseDown={startWindowDrag}>
      {mobileNavigation}
      {!mobileNavigation && <CodexSuiteFooter />}
      <div className={`footer-operation${operationStatus ? ` ${operationStatus.tone}` : ""}`} aria-live="polite" aria-atomic="true">
        {operationStatus && <>
          {operationStatus.tone === "working"
            ? <LoaderCircle className="spin" size={14} aria-hidden="true" />
            : operationStatus.tone === "success"
              ? <CheckCircle2 size={14} aria-hidden="true" />
              : operationStatus.tone === "warning"
                ? <AlertTriangle size={14} aria-hidden="true" />
                : <AlertCircle size={14} aria-hidden="true" />}
          <span title={operationStatus.text}>{operationStatus.text}</span>
        </>}
      </div>
      <div className="footer-status">
        <button ref={indexButtonRef} className={`index-state ${healthTone}`} onClick={() => setIndexDetailsOpen((open) => !open)} aria-expanded={indexDetailsOpen} aria-controls="sync-health-center">
          {healthTone === "failed" ? <AlertTriangle size={16} /> : healthTone === "working" ? <Activity size={16} /> : healthTone === "waiting" ? <Clock3 size={16} /> : <CheckCircle2 size={16} />}
          <span className="footer-index-label">{indexLabel}</span>
          <span className="mobile-footer-label">索引</span>
        </button>
        {indexDetailsOpen && <section ref={indexPopoverRef} id="sync-health-center" className="index-details-popover" aria-label={skippedOpen ? "已跳过记录" : downloadsOpen ? "附件下载失败" : "同步健康中心"}>
          <header>
            {detailOpen && <button type="button" onClick={returnToHealth} aria-label="返回同步健康中心"><ArrowLeft size={16} /></button>}
            <span className={`health-heading ${healthTone}`}>
              {healthTone === "failed" ? <AlertTriangle size={16} /> : healthTone === "working" ? <Activity size={16} /> : healthTone === "waiting" ? <Clock3 size={16} /> : <CheckCircle2 size={16} />}
              <span><strong>{skippedOpen ? "已跳过记录" : downloadsOpen ? "附件下载失败" : "同步健康中心"}</strong><small>{skippedOpen ? "保留下载、文字识别及索引任务的跳过记录" : downloadsOpen ? "查看原因、跳过或再次重试" : healthTone === "failed" ? `${actionRequired.length || 1} 个资料库需要处理` : healthTone === "working" ? "后台任务正在运行" : healthTone === "waiting" ? (awaitingRetry.length ? `${awaitingRetry.length} 个资料库等待自动恢复` : "后台任务等待处理") : "所有资料库运行正常"}</small></span>
            </span>
            <button onClick={() => setIndexDetailsOpen(false)} aria-label="关闭同步健康中心"><X size={14} /></button>
          </header>
          {skippedOpen ? <SkippedJobsPanel key={statusSpaceId ?? "all"} spaceId={statusSpaceId} onChanged={refreshStatus} /> : downloadsOpen ? <DownloadFailuresPanel key={statusSpaceId ?? "all"} spaceId={statusSpaceId} onChanged={refreshStatus} /> : indexStatus ? <>
            <div className="index-summary-grid">
              <span><b>{indexStatus.documentCount}</b>文档</span>
              <span><b>{indexStatus.pendingDownloads}</b>待下载 / 下载中</span>
              <span><b>{indexStatus.pendingOcrPages}</b>OCR</span>
              <span><b>{indexStatus.pendingOtherJobs}</b>索引任务</span>
              <span><b>{indexStatus.deferredOcrSources}</b>待发现</span>
              <span className={indexStatus.failedJobs ? "has-failure" : ""}><b>{indexStatus.failedJobs}</b>失败</span>
            </div>

            <button ref={downloadsButtonRef} type="button" className="download-failures-entry" onClick={() => setDownloadsOpen(true)}>
              <span><strong>附件下载失败</strong><small>查看失败和已跳过的附件</small></span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>

            <button type="button" className="download-failures-entry" onClick={() => setSkippedOpen(true)}>
              <span><strong>已跳过记录</strong><small>下载、文字识别与索引任务的存档</small></span><ChevronRight size={16} aria-hidden="true" />
            </button>

            {!!indexStatus.policyPausedDownloads && <p className="index-detail-empty">{indexStatus.policyPausedDownloads} 个附件按资料库内容设置暂停自动下载，开启相应下载选项后会继续。</p>}
            {awaitingRetry.length > 0 && <div className="sync-retry-note">
              <Clock3 size={13} />
              <span><strong>自动恢复中</strong><small>{formatRetryTime(indexStatus.nextAutoSyncAt)}；期间继续使用现有本地索引。</small></span>
            </div>}

            <div className="health-section-heading"><strong>资料库</strong><small>最后同步与任务状态</small></div>
            <div className="library-health-list">
              {indexStatus.libraryHealth.map((health) => {
                const state = librarySyncState(health, connectedById.get(health.libraryId) ?? true);
                return <article className={`library-health-row ${state.tone}`} key={health.libraryId}>
                  <i aria-hidden="true" />
                  <div className="library-health-main">
                    <span><strong>{health.name}</strong><em>{PROVIDER_NAMES[health.provider] ?? health.provider}</em></span>
                    <small>{health.documentCount} 篇 · {formatSyncTime(health.lastSync)}</small>
                    {health.lastError && (!health.failedItems?.length || state.tone === "waiting") && <p className={state.tone === "waiting" ? "quiet-error" : ""} title={downloadFailureMessage(health.lastError)}>{state.tone === "waiting" ? "上次同步未完成，后台将自动重试" : downloadFailureMessage(health.lastError)}</p>}
                    {(health.failedItems ?? []).filter((item) => item.jobType !== "download_source").map((item) => <section className="failed-source-detail" key={item.jobId}>
                      <div className="failed-source-title">
                        {item.mimeType === "application/pdf" ? <FileText size={13} /> : <FileImage size={13} />}
                        <strong title={item.title}>{item.title}</strong>
                        <small>{failedItemKind(item)}</small>
                      </div>
                      {item.parentTitle && item.parentTitle !== item.title && <div className="failed-source-line"><b>所在文档</b><span title={item.parentTitle}>{item.parentTitle}</span></div>}
                      {item.documentPath && <div className="failed-source-line"><b>所在路径</b><span title={item.documentPath}>{item.documentPath}</span></div>}
                      <div className="failed-source-line"><b>来源</b><span title={downloadFailureMessage(item.sourceReference ?? item.sourceId)}>{downloadFailureMessage(item.sourceReference ?? item.sourceId)}</span></div>
                      <div className="failed-source-line"><b>失败阶段</b><span>{indexJobTypeLabel(item.jobType)} · 已尝试 {item.attempts} 次</span></div>
                      <div className="failed-source-error" title={downloadFailureMessage(item.error)}>{downloadFailureMessage(item.error)}</div>
                      <div className="failed-source-advice"><b>如何处理</b><span>{failedItemAdvice(item)}</span></div>
                    </section>)}
                  </div>
                  <b>{state.label}</b>
                </article>;
              })}
            </div>

            {indexStatus.jobDetails.length > 0 && <>
              <div className="health-section-heading"><strong>后台任务</strong><small>按处理阶段汇总</small></div>
              <div className="index-detail-list">
                {indexStatus.jobDetails.filter(detail => !(detail.jobType === "download_source" && detail.status === "failed")).map((detail) => <div className={`index-detail-row ${detail.status}`} key={`${detail.jobType}:${detail.status}`}>
                  <span><strong>{indexJobTypeLabel(detail.jobType)}</strong><small>{detail.status === "not_applicable" ? "不适用文字识别" : detail.status === "failed" ? "失败" : detail.status === "running" ? "正在处理" : detail.status === "policy_paused" ? "按设置暂停下载" : "等待处理"} · {detail.count}</small></span>
                  {detail.lastError && detail.jobType !== "download_source" && <p title={downloadFailureMessage(detail.lastError)}>{downloadFailureMessage(detail.lastError)}</p>}
                </div>)}
              </div>
            </>}

            {(indexStatus.failedJobs > 0 || actionRequired.length > 0 || awaitingRetry.length > 0) && <div className="index-detail-actions">
              {actionRequired.length > 0 && <button className="quiet" onClick={() => void copyErrors()}><Copy size={12} />{copied ? "已复制" : "复制错误"}</button>}
              {otherFailedJobs > 0
                ? <button disabled={retryingFailedJobs || dismissingFailedJobs} onClick={() => void retryFailedJobs({excludeDownloads:true})}><RotateCcw size={12} />{retryingFailedJobs ? "正在重试…" : "重试其他失败任务"}</button>
                : indexStatus.failedJobs === 0 && <button disabled={syncing} onClick={() => void refreshIndex()}><RotateCcw size={12} />{syncing ? "正在同步…" : "立即同步"}</button>}
              {otherFailedJobs > 0 && <button className="quiet" disabled={retryingFailedJobs || dismissingFailedJobs} onClick={() => void dismissFailedJobs({excludeDownloads:true})}>{dismissingFailedJobs ? "处理中…" : "跳过并存档"}</button>}
            </div>}
          </> : <p className="index-detail-empty">正在读取索引状态…</p>}
        </section>}
        {flashcardsActive && <button className="footer-flashcard-sync" onClick={() => window.dispatchEvent(new Event("hub:flashcards-sync"))} title="同步闪卡" aria-label="同步闪卡"><Cloud size={15} /></button>}
        <button className="settings-button" onClick={() => setShowConnection(true)} title="资料库设置"><Settings size={15} /><span className="mobile-footer-label">设置</span></button>
      </div>
    </footer>
  );
}
