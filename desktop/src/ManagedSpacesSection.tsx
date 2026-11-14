import {
  BookOpen,
  Check,
  Filter,
  FolderOpen,
  FolderOutput,
  ImagePlus,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Pencil,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CraftBackupHistory } from "./CraftBackupHistory";
import type { ReactNode } from "react";
import type { IndexStatus, ObsidianWatchStatus } from "./IndexStatusTypes";
import type { Provider } from "./ProviderLabels";
import type { LibrarySummary } from "./SearchTypes";
import { LibrarySyncSchedule } from "./LibrarySyncSchedule";
import { LibraryContentPolicyEditor } from "./LibraryContentPolicyEditor";
import { libraryPhaseLabel, libraryRuntimeLabel, type LibraryRuntime } from "./LibraryManagement";
import { publishCodexNotice } from "./CodexSuite";
import "./LibraryManagement.css";

type CraftVaultExportProgress = {
  libraryId: string;
  phase: "capture" | "preparing" | "documents" | "attachments" | "completed";
  completed: number;
  total: number;
  current: string;
};

export type CraftVaultExportRequest = {
  destination: string;
  vaultName: string;
  includeImages: boolean;
  includeVideos: boolean;
  includeOtherAttachments: boolean;
  exportDailyNotes: boolean;
  openAfterExport: boolean;
  backupIntervalMinutes: number;
  replicaDestination: string;
};

type ManagedSpacesSectionProps = {
  allowVaultExport?: boolean;
  spaces: LibrarySummary[];
  renderLibraryIcon: (space: LibrarySummary) => ReactNode;
  indexStatus: IndexStatus | null;
  libraryRuntime?: Record<string, LibraryRuntime>;
  acceptingLibrary?: Record<string, boolean>;
  controlLibrary?: (space: LibrarySummary, action: "pause" | "resume" | "cancel" | "sync") => void | Promise<unknown>;
  renamingLibraryId: string;
  libraryNameDraft: string;
  exportingLibraryId: string;
  exportProgress: CraftVaultExportProgress | null;
  lastExportPath: string;
  exportError: string;
  maintenanceMessage: string;
  editingExclusions: string;
  exclusionDraft: string;
  savingExclusions: boolean;
  restartingWatcher: string;
  relocatingLibraryId?: string;
  relocateObsidian?: (space: LibrarySummary) => void | Promise<void>;
  providerName: (provider: Provider) => string;
  providerUnavailableLabel: (provider: Provider) => string;
  obsidianWatchLabel: (status?: ObsidianWatchStatus) => string;
  beginRenameLibrary: (space: LibrarySummary) => void;
  saveLibraryName: () => void | Promise<void>;
  updateLibraryIcon: (space: LibrarySummary, file?: File) => void | Promise<void>;
  resetLibraryIcon: (space: LibrarySummary) => void | Promise<void>;
  chooseExportDirectory: () => Promise<string | undefined>;
  exportCraftVault: (space: LibrarySummary, request: CraftVaultExportRequest) => Promise<boolean>;
  editExclusions: (space: LibrarySummary) => void;
  restartWatcher: (space: LibrarySummary) => void | Promise<void>;
  removeSpace: (space: LibrarySummary) => void | Promise<void>;
  saveExclusions: () => void | Promise<void>;
  openExportPath: () => void | Promise<void>;
  openExportInObsidian: () => void | Promise<void>;
  setRenamingLibraryId: (value: string) => void;
  setLibraryNameDraft: (value: string) => void;
  setEditingExclusions: (value: string) => void;
  setExclusionDraft: (value: string) => void;
};

export function ManagedSpacesSection({
  allowVaultExport = true,
  spaces,
  renderLibraryIcon,
  indexStatus,
  libraryRuntime = {},
  acceptingLibrary = {},
  controlLibrary,
  renamingLibraryId,
  libraryNameDraft,
  exportingLibraryId,
  exportProgress,
  lastExportPath,
  exportError,
  maintenanceMessage,
  editingExclusions,
  exclusionDraft,
  savingExclusions,
  restartingWatcher,
  relocatingLibraryId = "",
  relocateObsidian,
  providerName,
  providerUnavailableLabel,
  obsidianWatchLabel,
  beginRenameLibrary,
  saveLibraryName,
  updateLibraryIcon,
  resetLibraryIcon,
  chooseExportDirectory,
  exportCraftVault,
  editExclusions,
  restartWatcher,
  removeSpace,
  saveExclusions,
  openExportPath,
  openExportInObsidian,
  setRenamingLibraryId,
  setLibraryNameDraft,
  setEditingExclusions,
  setExclusionDraft,
}: ManagedSpacesSectionProps) {
  const [exportSpaceId, setExportSpaceId] = useState("");
  const [moreSpaceId, setMoreSpaceId] = useState("");
  // Keep the chooser mounted when native file-picker focus closes the settings panel.
  const iconInput = useRef<HTMLInputElement>(null);
  const iconSpace = useRef<LibrarySummary | null>(null);
  const [vaultName, setVaultName] = useState("");
  const [destination, setDestination] = useState("");
  const [includeImages, setIncludeImages] = useState(true);
  const [includeVideos, setIncludeVideos] = useState(true);
  const [includeOtherAttachments, setIncludeOtherAttachments] = useState(true);
  const [exportDailyNotes, setExportDailyNotes] = useState(true);
  const [openAfterExport, setOpenAfterExport] = useState(true);
  const [backupIntervalMinutes, setBackupIntervalMinutes] = useState(1440);
  const [replicaDestination, setReplicaDestination] = useState("");
  const [backupConfigured, setBackupConfigured] = useState(false);
  const [loadingBackup, setLoadingBackup] = useState(false);
  const [backupLoadError, setBackupLoadError] = useState("");
  const [backupRevision, setBackupRevision] = useState(0);
  useEffect(() => { if (exportError) publishCodexNotice(exportError, "error", 10000); }, [exportError]);
  useEffect(() => {
    if (!moreSpaceId) return;
    const dismiss = (event: Event) => { const target = event.target; if (!(target instanceof Element) || target.closest("[data-library-manager]")?.getAttribute("data-library-manager") !== moreSpaceId) setMoreSpaceId(""); };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("focusin", dismiss);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("focusin", dismiss); };
  }, [moreSpaceId]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ libraryId: string }>("craft-backup-updated", event => {
      if (!disposed && event.payload.libraryId === exportSpaceId) setBackupRevision(old => old + 1);
    }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [exportSpaceId]);

  useEffect(() => {
    if (!exportSpaceId) return;
    let disposed = false;
    setLoadingBackup(true); setBackupLoadError(""); setBackupConfigured(false);
    void invoke<{ config: { destination: string; vaultName: string; intervalMinutes: number; replicaDestination: string | null } | null }>("craft_backup_history", { libraryId: exportSpaceId, root: null }).then(async ({ config }) => {
      const parent = config?.destination ?? await invoke<string>("get_craft_backup_destination", { libraryId: exportSpaceId });
      if (disposed) return;
      setBackupConfigured(Boolean(config)); setDestination(parent);
      if (config) { setVaultName(config.vaultName); setBackupIntervalMinutes(config.intervalMinutes); setReplicaDestination(config.replicaDestination || ""); }
    }).catch(reason => { if (!disposed) { setBackupLoadError(String(reason)); publishCodexNotice(String(reason), "error", 10000); } }).finally(() => { if (!disposed) setLoadingBackup(false); });
    return () => { disposed = true; };
  }, [exportSpaceId, backupRevision]);

  const beginVaultExport = (space: LibrarySummary) => {
    if (exportSpaceId === space.id) return;
    setLoadingBackup(true);
    setBackupLoadError("");
    setBackupConfigured(false);
    setExportSpaceId(space.id);
    setVaultName(`${space.name} - Craft`);
    setDestination("");
    setReplicaDestination("");
    setBackupIntervalMinutes(1440);
    setIncludeImages(true);
    setIncludeVideos(true);
    setIncludeOtherAttachments(true);
    setExportDailyNotes(true);
    setOpenAfterExport(true);
  };

  const dismissVaultExport = () => {
    if (exportingLibraryId) return;
    setExportSpaceId("");
  };

  const progressLabel = exportProgress?.phase === "attachments"
    ? "正在整理附件"
    : exportProgress?.phase === "documents"
      ? "正在生成 Markdown"
      : exportProgress?.phase === "capture" ? "正在采集并核验原始备份" : "正在准备 Vault";

  return (
    <>
      <input
        ref={iconInput}
        type="file"
        hidden
        aria-label="选择资料库图标文件"
        accept=".svg,.png,.jpg,.jpeg,.webp,.gif,image/svg+xml,image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          const space = iconSpace.current;
          event.currentTarget.value = "";
          iconSpace.current = null;
          if (space && file) void Promise.resolve(updateLibraryIcon(space, file)).catch(reason => publishCodexNotice(String(reason), "error", 10000));
        }}
      />
      {spaces.length > 0 && <div className="managed-spaces settings-category libraries">{spaces.map((space) => {
        const watchStatus = indexStatus?.obsidianWatchers.find((status) => status.libraryId === space.id);
        const exportPanelOpen = exportSpaceId === space.id;
        const runtime = libraryRuntime[space.id];
        const paused = runtime?.state === "paused" || runtime?.state === "cancelled";
        const removing = runtime?.state === "removing" || runtime?.state === "removed";
        const retryRemove = runtime?.state === "removing" && Boolean(runtime.lastError);
        const busy = Boolean(acceptingLibrary[space.id]) || removing;
        const moreOpen = moreSpaceId === space.id;
        return <Fragment key={space.id}><div data-library-manager={space.id} className={`managed-space ${exportPanelOpen ? "export-active" : ""}`}>
          {renderLibraryIcon(space)}
          <span>
            {renamingLibraryId === space.id
              ? <span className="library-name-editor">
                  <input
                    autoFocus
                    value={libraryNameDraft}
                    maxLength={80}
                    onChange={(event) => setLibraryNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveLibraryName();
                      if (event.key === "Escape") { setRenamingLibraryId(""); setLibraryNameDraft(""); }
                    }}
                  />
                  <button title="保存名称" disabled={!libraryNameDraft.trim()} onClick={() => void saveLibraryName()}><Check size={14} /></button>
                  <button title="取消" onClick={() => { setRenamingLibraryId(""); setLibraryNameDraft(""); }}><X size={14} /></button>
                </span>
              : <strong>{space.name}</strong>}
            <small>{providerName(space.provider)} · {space.documentCount === 0 && !space.lastSync ? "尚未同步" : `本地 ${space.documentCount} ${space.provider === "dida365" ? "项" : "篇"}`} · {space.connected ? "连接可用" : providerUnavailableLabel(space.provider)}</small>
            <small className={`library-runtime ${runtime?.state || ""}`} title={runtime?.lastError}>{acceptingLibrary[space.id] ? "正在提交请求…" : libraryRuntimeLabel(runtime)}</small>
            {space.provider === "obsidian" && <small className={`watch-status ${!paused && !removing && runtime?.state !== "pausing" && watchStatus && !watchStatus.watching ? "error" : ""}`} title={!paused && !removing ? watchStatus?.lastError : undefined}>{paused || runtime?.state === "pausing" ? "文件监控已暂停" : removing ? "正在关闭文件监控" : obsidianWatchLabel(watchStatus)}</small>}
            {space.provider === "obsidian" && space.location && <small className="library-location" title={space.location}>{space.location}</small>}
            {space.provider === "obsidian" && !space.connected && relocateObsidian && <button className="maintenance-button library-relocate-action" disabled={relocatingLibraryId === space.id || removing || runtime?.state === "pausing"} onClick={() => void relocateObsidian(space)}><FolderOpen size={14} /><span>{relocatingLibraryId === space.id ? "正在更新位置…" : "重新定位文件夹"}</span></button>}
          </span>
          <span className="managed-space-actions">
            <LibrarySyncSchedule libraryId={space.id} name={space.name} disabled={removing} />
            {controlLibrary && <><button className="library-main-action" title={paused ? "继续资料库后台处理" : "暂停资料库后台处理"} disabled={busy || runtime?.state === "pausing"} onClick={() => void Promise.resolve(controlLibrary(space, paused ? "resume" : "pause")).catch(() => undefined)}>{paused ? <Play size={14} /> : <Pause size={14} />}<span>{paused ? "继续" : runtime?.state === "pausing" ? "暂停中" : "暂停"}</span></button><button className="library-main-action" title={paused ? "此资料库已暂停，请先继续" : space.connected ? "提交一次后台同步" : "尝试恢复已保存的授权并更新资料"} disabled={busy || paused || runtime?.state === "pausing"} onClick={() => void Promise.resolve(controlLibrary(space, "sync")).catch(() => undefined)}><RotateCcw size={14} /><span>同步一次</span></button></>}
            <button className="library-main-action" title="更多资料库设置" aria-label={`更多资料库设置 · ${space.name}`} aria-expanded={moreOpen} disabled={removing && !retryRemove} onClick={() => setMoreSpaceId(moreOpen ? "" : space.id)}><MoreHorizontal size={18} /></button>
          </span>
        </div>
        {moreOpen && <section data-library-manager={space.id} className="library-management-panel" aria-label={`资料库管理 · ${space.name}`}>
          <div className="library-management-panel-actions">
            {renamingLibraryId !== space.id && <button className="maintenance-button" title="修改资料库显示名称" disabled={removing} onClick={() => beginRenameLibrary(space)}><Pencil size={15} /> 修改名称</button>}
            <button type="button" className="icon-upload" title="选择并裁剪资料库图标（SVG、PNG、JPG、WebP、GIF）" disabled={removing} onClick={() => {
              iconSpace.current = space;
              iconInput.current?.click();
            }}>
              <ImagePlus size={16} /><span>选择并裁剪图标</span>
            </button>
            {space.iconSvg && <button className="maintenance-button" title="恢复默认资料库图标" disabled={removing} onClick={() => void resetLibraryIcon(space)}><RotateCcw size={16} /> 恢复图标</button>}
            {allowVaultExport && space.provider === "craft" && <button className="maintenance-button export-vault-button" title="完整备份并生成 Obsidian Vault" disabled={removing || Boolean(exportingLibraryId) && exportingLibraryId !== space.id} onClick={() => beginVaultExport(space)}><FolderOutput size={16} /><span>备份与恢复</span></button>}
            {space.provider === "obsidian" && <button className="maintenance-button" title="设置排除路径" disabled={removing} onClick={() => editExclusions(space)}><Filter size={16} /> 读取范围</button>}
            {space.provider === "obsidian" && relocateObsidian && <button className="maintenance-button" title="选择改名或移动后的同一个库，保留已有索引和关联" disabled={relocatingLibraryId === space.id || removing || runtime?.state === "pausing"} onClick={() => void relocateObsidian(space)}><FolderOpen size={16} /> 更换文件夹</button>}
            {space.provider === "obsidian" && <button className="maintenance-button" title="重新建立文件监听" disabled={restartingWatcher === space.id || paused || removing} onClick={() => void restartWatcher(space)}><RotateCcw className={restartingWatcher === space.id ? "spin" : ""} size={16} /> 重建监听</button>}
          </div>
          {space.provider !== "obsidian" && <p>读取范围由当前授权连接决定。{space.provider === "craft" ? "如需调整范围，请在 Craft 修改此连接的页面权限，再同步一次。" : space.provider === "feishu" ? "仅读取已选择且有权限的文档来源，不提供附件写入。" : "读取当前账号可访问的清单与任务。"}</p>}
          {!removing && <LibraryContentPolicyEditor key={space.id} libraryId={space.id} />}
          <div className="library-management-status"><strong>当前处理状态</strong><span>{libraryRuntimeLabel(runtime)}</span>{runtime?.phase && <small>阶段：{libraryPhaseLabel(runtime.phase)}</small>}{runtime && <small>已受理操作 {runtime.activeOperations} 项，其中排队 {runtime.pending} 项</small>}{runtime?.lastError && <small>最近错误：{runtime.lastError}</small>}{controlLibrary && runtime?.state === "running" && <button className="maintenance-button" onClick={() => void Promise.resolve(controlLibrary(space, "cancel")).catch(() => undefined)}>取消当前处理并保持暂停</button>}</div>
          <div className="library-management-panel-actions"><button className="maintenance-button" title="移除本地资料库索引" disabled={Boolean(acceptingLibrary[space.id]) || (removing && !retryRemove)} onClick={() => void Promise.resolve(removeSpace(space)).catch(() => undefined)}><Trash2 size={16} /> {retryRemove ? "重试移除" : "移除资料库…"}</button><small>确认后移除 Hub 中的资料库登记与本地索引；原文件和云端内容保留。</small></div>
        </section>}
        {allowVaultExport && exportPanelOpen && <section data-library-manager={space.id} className="vault-export-panel" aria-labelledby={`vault-export-title-${space.id}`}>
          <header>
            <span><BookOpen size={18} /><span><strong id={`vault-export-title-${space.id}`}>备份与恢复 · {space.name}</strong><small>立即备份与自动备份使用同一位置。全部原始数据和附件核验通过后，更新同一个 Obsidian 库。历史版本和权限不包含。</small></span></span>
            <button className="vault-export-close" aria-label="关闭导出设置" disabled={Boolean(exportingLibraryId)} onClick={dismissVaultExport}><X size={16} /></button>
          </header>
          {loadingBackup && <p role="status">正在读取备份设置…</p>}
          {backupConfigured ? <div className="vault-export-fields">
            <label><span>保存位置（手动与自动共用）</span><code>{destination}</code></label>
            <label><span>Obsidian 库名称</span><code>{vaultName}</code></label>
            <label><span>第二份备份</span><code>{replicaDestination || "尚未设置"}</code></label>
          </div> : <><div className="vault-export-fields">
            <label><span>Vault 名称</span><input value={vaultName} maxLength={100} disabled={Boolean(exportingLibraryId)} onChange={(event) => setVaultName(event.target.value)} /></label>
            <label><span>保存位置（Hub 自动管理）</span><span className="vault-export-location"><code title={destination}>{destination || "正在读取数据目录…"}</code></span></label>
          </div>
          <div className="vault-export-fields">
            <label><span>自动备份</span><select disabled={Boolean(exportingLibraryId)} value={backupIntervalMinutes} onChange={e => setBackupIntervalMinutes(Number(e.target.value))}><option value={0}>仅手动</option><option value={60}>每小时</option><option value={360}>每 6 小时</option><option value={1440}>每天</option></select></label>
            <label><span>第二份备份（可选）</span><span className="vault-export-location"><code title={replicaDestination}>{replicaDestination || "建议选择另一块磁盘"}</code><button disabled={Boolean(exportingLibraryId)} onClick={async () => { const selected = await chooseExportDirectory(); if (selected) setReplicaDestination(selected); }}>选择…</button>{replicaDestination && <button onClick={() => setReplicaDestination("")}>清除</button>}</span></label>
          </div></>}
          <div className="vault-export-summary" aria-label="导出内容">
            <span><strong>{space.documentCount}</strong><small>篇 Markdown</small></span>
            <span><strong>attachments/</strong><small>统一附件目录</small></span>
            <span><strong>.obsidian/</strong><small>Vault 配置</small></span>
          </div>
          {!backupConfigured && <details className="vault-export-options">
            <summary>Vault 阅读选项（原始备份始终保存全部附件）</summary>
            <div>
              <label><input type="checkbox" checked={includeImages} disabled={Boolean(exportingLibraryId)} onChange={(event) => setIncludeImages(event.target.checked)} /><span>图片</span></label>
              <label><input type="checkbox" checked={includeVideos} disabled={Boolean(exportingLibraryId)} onChange={(event) => setIncludeVideos(event.target.checked)} /><span>视频</span></label>
              <label><input type="checkbox" checked={includeOtherAttachments} disabled={Boolean(exportingLibraryId)} onChange={(event) => setIncludeOtherAttachments(event.target.checked)} /><span>其他附件</span></label>
              <label><input type="checkbox" checked={exportDailyNotes} disabled={Boolean(exportingLibraryId)} onChange={(event) => setExportDailyNotes(event.target.checked)} /><span>识别日期页面并配置日记</span></label>
              <label><input type="checkbox" checked={openAfterExport} disabled={Boolean(exportingLibraryId)} onChange={(event) => setOpenAfterExport(event.target.checked)} /><span>完成后在 Obsidian 中打开</span></label>
            </div>
          </details>}
          {exportingLibraryId === space.id && exportProgress && <div className="vault-export-progress" role="status">
            <LoaderCircle className="spin" size={16} />
            <span><strong>{progressLabel}</strong><small>{exportProgress.current}</small></span>
            <progress max={Math.max(exportProgress.total, 1)} value={exportProgress.completed} />
          </div>}
          <footer>
            <span>原始备份与 Vault 分别保存。自动备份需 Hub 运行且 Craft 连接可用；旧恢复点永久保留，云端删除不会删除它们。</span>
            <div><button className="maintenance-button" disabled={Boolean(exportingLibraryId)} onClick={dismissVaultExport}>取消</button><button className="maintenance-button primary" disabled={Boolean(exportingLibraryId) || loadingBackup || Boolean(backupLoadError) || !destination || !vaultName.trim()} onClick={async () => {
              const completed = await exportCraftVault(space, { destination, vaultName: vaultName.trim(), includeImages, includeVideos, includeOtherAttachments, exportDailyNotes, openAfterExport, backupIntervalMinutes, replicaDestination });
              if (completed) setExportSpaceId("");
            }}>{exportingLibraryId === space.id ? "正在备份…" : backupConfigured ? "立即备份" : "设置并开始首次备份"}</button></div>
          </footer>
          <CraftBackupHistory libraryId={space.id} disabled={Boolean(exportingLibraryId)} />
        </section>}
        </Fragment>;
      })}</div>}
      {allowVaultExport && <CraftBackupHistory />}
      {lastExportPath && maintenanceMessage && <div className="vault-export-result settings-category libraries"><Check size={16} /><span>{maintenanceMessage}</span><div><button className="maintenance-button primary" onClick={() => void openExportInObsidian()}>在 Obsidian 中打开</button><button className="maintenance-button" onClick={() => void openExportPath()}>显示文件夹</button></div></div>}
      {editingExclusions && <div data-library-manager={editingExclusions} className="exclusion-editor settings-category libraries">
        <strong>排除路径 · {spaces.find((space) => space.id === editingExclusions)?.name}</strong>
        <small>每行一条相对路径或通配符，例如 <code>Archive</code>、<code>Templates/**</code>、<code>*.canvas</code>。保存后会移除对应的本地搜索记录，不修改 Vault 原文件。</small>
        <textarea value={exclusionDraft} onChange={(event) => setExclusionDraft(event.target.value)} rows={6} spellCheck={false} placeholder={"Archive\nTemplates/**"} />
        <span>
          <button className="maintenance-button" onClick={() => { setEditingExclusions(""); setExclusionDraft(""); }} disabled={savingExclusions}>取消</button>
          <button className="maintenance-button primary" onClick={() => void saveExclusions()} disabled={savingExclusions}>{savingExclusions ? "保存并更新中…" : "保存并更新索引"}</button>
        </span>
      </div>}
    </>
  );
}
