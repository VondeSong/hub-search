import { useEffect, useState } from "react";
import { AccountMigrationSettings } from "./AccountMigrationSettings";
import { useDataPortability, type DataBackupSummary, type DataDependency } from "./useDataPortability";
import { formatDataPath, formatDataSize as size, isInDataDirectory } from "./DataManagementFormat";
import "./DataPortabilitySettings.css";

const date = (seconds: number) => new Date(seconds * 1000).toLocaleString("zh-CN");

function Warnings({ values }: { values: string[] }) {
  return values.length ? <ul className="data-portability-warnings">{values.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}</ul> : null;
}

function Dependencies({ values, onRelocate, disabled = false, currentRoot }: {
  values: DataDependency[];
  onRelocate?: (dependency: DataDependency) => void;
  disabled?: boolean;
  currentRoot?: string;
}) {
  return values.length ? <ul className="data-portability-dependencies">{values.map(dependency => <li key={dependency.id}>
    <div><strong>{dependency.name}</strong><small>{dependency.available ? "位置可用" : "位置不可用"}{currentRoot
      ? isInDataDirectory(dependency.sourcePath, currentRoot) ? " · 已在 Hub 数据文件夹内" : dependency.kind === "obsidian" || dependency.kind === "reading" ? " · 原库由你单独管理" : " · 需要恢复本地原件"
      : dependency.included ? " · 已纳入此备份" : ""}</small>
      <code>{formatDataPath(dependency.sourcePath)}</code>{dependency.description && dependency.description !== "来源路径可用" && <small>{dependency.description}</small>}</div>
    {onRelocate && dependency.canRelocate && <button className="maintenance-button" disabled={disabled} onClick={() => onRelocate(dependency)}>重新定位</button>}
  </li>)}</ul> : <p className="data-portability-note">没有登记在数据目录之外的文件依赖。</p>;
}

function BackupSummary({ backup }: { backup: DataBackupSummary }) {
  return <>
    <p>{date(backup.createdAt)} · Hub {backup.appVersion} · {backup.files.toLocaleString("zh-CN")} 个文件 · {size(backup.archiveBytes)}</p>
    <code className="storage-current-path">{formatDataPath(backup.path)}</code>
    {!backup.complete && <p className="data-portability-note">此备份有未包含的来源或文件；恢复可用内容后，请检查下方依赖。</p>}
    <Warnings values={backup.warnings} />
    {!!backup.dependencies.length && <details><summary>备份包含的外部文件与依赖</summary><Dependencies values={backup.dependencies} /></details>}
  </>;
}

export function DataPortabilitySettings({ blocked = false, onBusyChange }: { blocked?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [accountBusy, setAccountBusy] = useState(false);
  const state = useDataPortability({ blocked: blocked || accountBusy });
  const { status, schedule, directoryPreview, backupPreview, progress } = state;
  const locked = state.locked || !status;
  const total = progress?.totalBytes ?? progress?.total;
  const completed = progress?.completedBytes ?? progress?.completed;
  const localDependencies = status?.dependencies.filter(item => isInDataDirectory(item.sourcePath, status.root)) ?? [];
  const externalDependencies = status?.dependencies.filter(item => !isInDataDirectory(item.sourcePath, status.root)) ?? [];
  useEffect(() => { onBusyChange?.(accountBusy || Boolean(state.busy) || state.restarting || Boolean(status?.activeOperation)); }, [onBusyChange, accountBusy, state.busy, state.restarting, status?.activeOperation]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  return <section className="data-portability" aria-label="备份与迁移操作">
    <div className="storage-setting-heading"><h4>整库备份</h4>
      <button className="maintenance-button" disabled={Boolean(state.busy) || state.restarting} onClick={() => void state.reload()}>刷新</button></div>
    <div className="data-portability-actions">
      <button className="maintenance-button" disabled={locked} onClick={() => void state.createBackup()}>备份到文件…</button>
      <button className="maintenance-button" disabled={locked} onClick={() => void state.chooseBackup()}>从备份恢复…</button>
      <button className="maintenance-button" disabled={locked} onClick={() => void state.chooseExistingDirectory()}>打开已有数据目录…</button>
    </div>
    <p className="data-portability-note">包含 Hub 数据、Craft 原件和附件。Obsidian 原始库不打包；账号授权可在下方按需准备。</p>

    {state.busy && <div className="data-portability-progress" role="status" aria-live="polite">
      <span>{state.cancelling ? "正在停止，请等待当前文件处理结束…" : state.busy}</span>
      {progress?.message && <small>{progress.message}</small>}
      {typeof total === "number" && total > 0 && typeof completed === "number" && <progress aria-label="数据操作进度" value={Math.min(completed, total)} max={total} />}
      {progress?.completedFiles !== undefined && <small>已处理 {progress.completedFiles.toLocaleString("zh-CN")}{progress.totalFiles != null ? ` / ${progress.totalFiles.toLocaleString("zh-CN")}` : ""} 个文件</small>}
      {state.cancellable && <button className="maintenance-button" disabled={state.cancelling} onClick={() => void state.cancel()}>停止操作</button>}
    </div>}
    {status?.activeOperation && !state.busy && <p role="status">已有数据操作正在进行，请等待完成后刷新。</p>}
    {state.error && <p role="alert" className="data-portability-error">{state.error}</p>}
    {state.notice && <p role="status" className="data-portability-notice">{state.notice}</p>}
    {!!status?.warnings.length && <details><summary>备份与迁移提示（{status.warnings.length} 项）</summary><Warnings values={status.warnings} /></details>}

    {directoryPreview && <div className="data-portability-preview" aria-label="已有数据目录检查结果">
      <strong>数据目录已检查</strong>
      <code className="storage-current-path">{formatDataPath(directoryPreview.path)}</code>
      <p>{directoryPreview.libraries} 个资料库 · {directoryPreview.documents.toLocaleString("zh-CN")} 篇内容 · {directoryPreview.profileValues} 项个人设置</p>
      <p>确认后 Hub 会重启并使用此目录。当前目录会保留。</p>
      <Warnings values={directoryPreview.warnings} />
      {!!directoryPreview.dependencies.length && <details><summary>换机后需检查的外部目录</summary><Dependencies values={directoryPreview.dependencies} /></details>}
      <div className="data-portability-actions"><button className="maintenance-button" disabled={locked} onClick={state.clearPreview}>取消</button>
        <button className="maintenance-button primary" disabled={locked} onClick={() => void state.openExistingDirectory()}>打开此目录并重启</button></div>
    </div>}

    {backupPreview && <div className="data-portability-preview" aria-label="备份文件检查结果">
      <strong>备份文件已检查</strong><BackupSummary backup={backupPreview} />
      <div className="data-portability-field"><span>恢复位置</span><div className="data-portability-path-field"><code>{state.restoreDestination ? formatDataPath(state.restoreDestination) : "请选择一个空文件夹"}</code>
        <button className="maintenance-button" disabled={locked} onClick={() => void state.chooseRestoreDestination()}>选择空文件夹…</button></div></div>
      <p>恢复会创建独立的数据目录。目标必须为空，当前使用的数据会保留。</p>
      <label className="data-portability-checkbox"><input type="checkbox" checked={state.openAfterRestore} disabled={locked} onChange={event => state.setOpenAfterRestore(event.target.checked)} />恢复后打开此目录并重启 Hub</label>
      <div className="data-portability-actions"><button className="maintenance-button" disabled={locked} onClick={state.clearPreview}>取消恢复</button>
        <button className="maintenance-button primary" disabled={locked || !state.restoreDestination} onClick={() => void state.restoreBackup()}>{state.openAfterRestore ? "恢复并重启" : "恢复到所选文件夹"}</button></div>
    </div>}
    {state.createdBackup && <details className="data-portability-result" open><summary>本次备份结果</summary><BackupSummary backup={state.createdBackup} /></details>}
    {state.restoreResult && <details className="data-portability-result" open><summary>本次恢复结果</summary>
      <code className="storage-current-path">{formatDataPath(state.restoreResult.destination)}</code><Warnings values={state.restoreResult.warnings} />
      {!!state.restoreResult.pathMappings.length && <ul>{state.restoreResult.pathMappings.map(mapping => <li key={`${mapping.kind}:${mapping.id}`}><code>{formatDataPath(mapping.sourcePath)}</code><span> → </span><code>{formatDataPath(mapping.restoredPath)}</code></li>)}</ul>}
      <button className="maintenance-button" onClick={() => void state.reveal(state.restoreResult!.destination)}>打开恢复目录</button>
    </details>}

    <details><summary>自动备份{schedule.enabled ? ` · 每 ${schedule.intervalHours} 小时` : " · 未开启"}</summary>
      <div className="data-portability-options">
        <label className="data-portability-checkbox"><input type="checkbox" checked={schedule.enabled} disabled={locked} onChange={event => state.changeSchedule({ enabled: event.target.checked })} />启用自动备份</label>
        <div className="data-portability-field"><span>保存位置</span><div className="data-portability-path-field"><code>{schedule.destination ? formatDataPath(schedule.destination) : "尚未选择"}</code><button className="maintenance-button" disabled={locked} onClick={() => void state.chooseScheduleDestination()}>选择…</button></div></div>
        <div className="data-portability-number-fields">
          <label>备份间隔（小时）<input type="number" min={1} max={720} step={1} value={schedule.intervalHours} disabled={locked} onChange={event => state.changeSchedule({ intervalHours: Number(event.target.value) })} /></label>
          <label>保留最近（份）<input type="number" min={1} max={100} step={1} value={schedule.keepCount} disabled={locked} onChange={event => state.changeSchedule({ keepCount: Number(event.target.value) })} /></label>
        </div>
        <p className="data-portability-note">Hub 运行时执行，保存到独立位置。保留份数只用于此计划。</p>
        {schedule.lastSuccessAt && <small>最近成功：{date(schedule.lastSuccessAt)}</small>}
        {schedule.lastError && <p role="alert" className="data-portability-error">上次自动备份：{schedule.lastError}</p>}
        <button className="maintenance-button" disabled={locked} onClick={() => void state.saveSchedule()}>保存自动备份设置</button>
      </div>
    </details>
    <details><summary>复制数据文件夹到新电脑{status?.hasAccountCopy ? " · 含加密授权副本" : ""}</summary>
      <AccountMigrationSettings blocked={Boolean(blocked || state.busy || state.restarting || status?.activeOperation || !status)} hasAccountCopy={status?.hasAccountCopy} onBusyChange={setAccountBusy} onPrepared={() => void state.reload()} />
    </details>
    {localDependencies.length > 0 && <details><summary>已在 Hub 数据文件夹内的原件（{localDependencies.length} 项）</summary>
      <p className="data-portability-note">这些原件会随整个数据文件夹复制，无需单独迁移。</p>
      <Dependencies values={localDependencies} currentRoot={status?.root} disabled={locked} onRelocate={dependency => void state.relocateDependency(dependency)} />
    </details>}
    <details><summary>独立管理的库与外部文件{status ? `（${externalDependencies.length} 项）` : ""}</summary>
      <p className="data-portability-note">Obsidian 原库由你自行移动并重新加载。Craft、滴答的原件与附件由 Hub 自动保存到数据目录。</p>
      {status && <Dependencies values={externalDependencies} currentRoot={status.root} disabled={locked} onRelocate={dependency => void state.relocateDependency(dependency)} />}
    </details>
  </section>;
}
