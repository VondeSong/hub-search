import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { DataPortabilitySettings } from "./DataPortabilitySettings";
import { CurrentDataManagement } from "./CurrentDataManagement";
import { useCurrentDataManagement } from "./useCurrentDataManagement";
import { formatDataPath, formatDataSize } from "./DataManagementFormat";
import type { RuntimeCapabilities } from "./RuntimePlatform";
import "./DataManagement.css";

type StorageMode = "default" | "custom" | "portable";
type StorageInfo = { mode: StorageMode; path: string; defaultPath: string; portablePath: string; sizeBytes: number; fileCount: number };
type StorageSyncSettingsSectionProps = {
  runtimeCapabilities: RuntimeCapabilities;
  storageInfo: StorageInfo | null;
  storageMode: StorageMode;
  storageCustomPath: string;
  changingStorage: boolean;
  autoSyncMinutes: number;
  formatFileSize: (size?: number) => string;
  revealStorageLocation: () => void | Promise<void>;
  chooseStorageFolder: () => void | Promise<void>;
  applyStorageLocation: () => void | Promise<void>;
  changeAutoSync: (minutes: number) => void | Promise<void>;
  setStorageMode: (mode: StorageMode) => void;
  setStorageCustomPath: (path: string) => void;
  advancedSettings?: ReactNode;
};

export function StorageSyncSettingsSection(props: StorageSyncSettingsSectionProps) {
  const { runtimeCapabilities, storageInfo, storageMode, storageCustomPath, changingStorage, autoSyncMinutes,
    revealStorageLocation, chooseStorageFolder, applyStorageLocation, changeAutoSync, setStorageMode, setStorageCustomPath, advancedSettings } = props;
  const [portabilityBusy, setPortabilityBusy] = useState(false);
  const [editingLocation, setEditingLocation] = useState(false);
  const [spaceOpen, setSpaceOpen] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [folderError, setFolderError] = useState("");
  const [visited, setVisited] = useState({ space: false, backup: false, advanced: false });
  const management = useCurrentDataManagement({ blocked: changingStorage || portabilityBusy, enabled: runtimeCapabilities.customStorageLocation });
  const storageLocked = changingStorage || portabilityBusy || Boolean(management.busy) || Boolean(management.status?.activeOperation);
  const bytes = management.status?.usage.logicalBytes ?? storageInfo?.sizeBytes;
  const path = management.status?.root ?? storageInfo?.path;
  const visit = (key: keyof typeof visited, open: boolean) => { if (open) setVisited(value => value[key] ? value : { ...value, [key]: true }); };
  const openDataFolder = async () => {
    if (openingFolder) return;
    setOpeningFolder(true); setFolderError("");
    try { await revealStorageLocation(); }
    catch (reason) { setFolderError(`无法打开数据文件夹：${reason instanceof Error ? reason.message : String(reason)}。可复制下方路径，在文件资源管理器中打开。`); }
    finally { setOpeningFolder(false); }
  };
  return <section className="data-management settings-category index" aria-label="数据管理">
    {runtimeCapabilities.customStorageLocation && <>
      <header className="data-management-overview">
        <div className="data-management-row"><div><h3>Hub 数据</h3><p className="data-management-total">{bytes == null ? "正在读取…" : formatDataSize(bytes)}</p></div>
          <button className="maintenance-button" disabled={!path || openingFolder} onClick={() => void openDataFolder()}>{openingFolder ? "正在打开…" : "打开数据文件夹"}</button></div>
        {folderError && <p role="alert" className="data-management-error">{folderError}</p>}
        <code className="data-management-path">{path ? formatDataPath(path) : "正在读取数据位置…"}</code>
        <p className="data-management-note">正文、任务、个人设置和 Hub 管理的附件。Obsidian 原始库单独管理。</p>
        <p className="data-management-note">换电脑：完全退出 Hub，直接复制整个文件夹；新电脑选择“打开已有数据目录”。</p>
        {management.error && !spaceOpen && <div role="alert" className="data-management-error">{management.error}<button className="maintenance-button" disabled={Boolean(management.busy)} onClick={() => void management.reload()}>刷新空间占用</button></div>}
      </header>

      <details className="data-management-group" onToggle={event => { setSpaceOpen(event.currentTarget.open); visit("space", event.currentTarget.open); }}>
        <summary><span><strong>管理空间</strong><small>{management.busy || (management.status?.cleanup.status?.phase === "requested" ? "已安排下次启动清理，可查看或取消" : management.status?.compaction.preview.reclaimableBytes ? "查看分类与清理 · 数据库内可回收 " + formatDataSize(management.status.compaction.preview.reclaimableBytes) : "查看分类占用、检查可清理项目")}</small></span><ChevronRight aria-hidden="true" size={18} /></summary>
        {visited.space && <div className="data-management-group-content"><CurrentDataManagement state={management} /></div>}
      </details>

      <details className="data-management-group" onToggle={event => visit("backup", event.currentTarget.open)}>
        <summary><span><strong>备份与迁移</strong><small>{portabilityBusy || changingStorage ? "数据操作正在进行…" : "保存备份、换电脑或更改数据位置"}</small></span><ChevronRight aria-hidden="true" size={18} /></summary>
        {visited.backup && <div className="data-management-group-content">
          <DataPortabilitySettings blocked={changingStorage || Boolean(management.busy) || Boolean(management.status?.activeOperation)} onBusyChange={setPortabilityBusy} />
          <section className="data-management-operation" aria-label="更改数据位置">
            <div className="data-management-row"><div><h4>数据位置</h4><p className="data-management-note">迁移到另一个空文件夹，保留原目录。</p></div>
              <button className="maintenance-button" disabled={storageLocked || !storageInfo} aria-expanded={editingLocation} onClick={() => setEditingLocation(value => !value)}>{editingLocation ? "收起位置设置" : "更改数据位置…"}</button></div>
            {editingLocation && <div className="data-management-location-editor">
              <label className="data-portability-field">存储方式<select value={storageMode} disabled={storageLocked} aria-label="数据存储模式" onChange={event => setStorageMode(event.target.value as StorageMode)}>
                <option value="default">Windows 默认位置</option><option value="custom">自定义文件夹</option><option value="portable">便携模式（程序旁边）</option>
              </select></label>
              {storageMode === "custom" && <div className="data-portability-field"><label htmlFor="data-management-custom-path">目标文件夹</label><div className="data-portability-path-field"><input id="data-management-custom-path" value={storageCustomPath} disabled={storageLocked} aria-label="自定义数据文件夹" onChange={event => setStorageCustomPath(event.target.value)} placeholder="选择一个空文件夹" spellCheck={false} /><button className="maintenance-button" disabled={storageLocked} onClick={() => void chooseStorageFolder()}>选择文件夹…</button></div></div>}
              <p className="data-management-note">{storageMode === "portable" ? "目标：" + formatDataPath(storageInfo?.portablePath ?? "免安装程序旁边") : storageMode === "custom" ? "选择空文件夹。重启时复制、校验数据后切换到新位置。" : "目标：" + formatDataPath(storageInfo?.defaultPath ?? "%APPDATA%\\com.craftsearch.desktop")}</p>
              <button className="maintenance-button" disabled={storageLocked || !storageInfo} onClick={() => void applyStorageLocation()}>{changingStorage ? "准备迁移…" : "更改并迁移"}</button>
            </div>}
          </section>
        </div>}
      </details>
    </>}

    <details className="data-management-group" onToggle={event => visit("advanced", event.currentTarget.open)}>
      <summary><span><strong>索引与高级设置</strong><small>自动同步、下载与识别、后台诊断</small></span><ChevronRight aria-hidden="true" size={18} /></summary>
      {visited.advanced && <div className="data-management-group-content data-management-advanced">
        <label className="data-management-row"><span><strong>自动同步</strong><small className="data-management-note">{runtimeCapabilities.mobile ? "应用运行时按间隔同步" : "在后台增量同步资料库"}</small></span>
          <select aria-label="自动同步间隔" value={autoSyncMinutes} onChange={event => void changeAutoSync(Number(event.target.value))}>
            <option value={0}>关闭</option><option value={5}>每 5 分钟</option><option value={15}>每 15 分钟</option><option value={30}>每 30 分钟</option><option value={60}>每小时</option><option value={180}>每 3 小时</option><option value={360}>每 6 小时</option>
          </select></label>
        {advancedSettings}
      </div>}
    </details>
  </section>;
}
