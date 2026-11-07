import { formatDataSize } from "./DataManagementFormat";
import type { CurrentDataManagementState } from "./useCurrentDataManagement";
import { useState } from "react";
import { LargeFileBrowser } from "./LargeFileBrowser";

const categoryNames: Record<string, string> = {
  attachments: "文档附件", database: "正文与设置", indexes: "搜索索引", reading: "阅读附件",
  sources: "来源文件", recovery: "备份与恢复", settings: "功能设置", logs: "日志", webview: "界面缓存", other: "其他文件",
};

export function CurrentDataManagement({ state }: { state: CurrentDataManagementState }) {
  const [fileCategory, setFileCategory] = useState<string | null>(null);
  const { status, preview, busy, locked } = state;
  const compaction = status?.compaction;
  const compactPending = compaction?.status?.phase === "requested";
  const compactTerminal = !compaction?.status || ["complete", "failed", "cancelled"].includes(compaction.status.phase);
  const supported = compaction?.preview.availableFreeBytes != null;
  const enoughSpace = supported && compaction!.preview.availableFreeBytes! >= compaction!.preview.requiredFreeBytes;
  const cleanup = status?.cleanup.status;
  const categories = status?.usage.categories ?? [];
  const classifiedBytes = categories.reduce((total, category) => total + category.logicalBytes, 0);
  return <div className="current-data-management">
    <section className="data-space-overview" aria-label="空间分布">
      <div className="data-management-row"><div><h4>此设备</h4><p className="data-management-note">仅统计 Hub 数据，Obsidian 原始库单独管理。</p></div>
        <button className="maintenance-button" aria-label="刷新空间占用" disabled={Boolean(busy)} onClick={() => void state.reload()}>刷新</button></div>
      {status && <>
        <div className="data-space-bar" aria-hidden="true">{categories.filter(category => category.logicalBytes > 0).map(category => <span key={category.id} data-category={category.id} style={{ width: `${category.logicalBytes / classifiedBytes * 100}%` }} />)}</div>
        <ul className="data-space-legend" aria-label="分类空间占用">{categories.map(category => <li key={category.id}>
          <button type="button" data-category={category.id} aria-label={`查看${category.label}的大文件`} aria-description={`${formatDataSize(category.logicalBytes)} · ${category.files.toLocaleString("zh-CN")} 个文件${category.rebuildable ? " · 可重建" : ""}`} disabled={Boolean(busy)} title={`${category.label} · ${category.files.toLocaleString("zh-CN")} 个文件${category.rebuildable ? " · 可重建" : ""}`} onClick={() => setFileCategory(category.id)}>
            <span className="data-space-category"><i aria-hidden="true" />{categoryNames[category.id] ?? category.label}</span><span className="data-space-size">{formatDataSize(category.logicalBytes)}</span>
          </button>
        </li>)}</ul>
        <p className="data-management-note data-space-hint">点击分类查看大文件，按大小定位占用。</p>
      </>}
    </section>
    <section className="data-management-card data-management-row" aria-label="查看大文件">
      <div><h4>大文件</h4><p className="data-management-note">查看附件和来源文件，按大小排列并定位关联内容。</p></div>
      <button className="maintenance-button" aria-label="查看全部分类的大文件" disabled={Boolean(busy) || !status} onClick={() => setFileCategory("all")}>查看</button>
    </section>
    {status && fileCategory && <LargeFileBrowser key={fileCategory} category={fileCategory} categoryLabel={status.usage.categories.find(v => v.id === fileCategory)?.label ?? "全部分类"} rootPath={status.root} onClose={() => setFileCategory(null)} />}
    {!!status?.usage.warnings.length && <details className="data-management-subdetails"><summary>空间统计提示（{status.usage.warnings.length} 项）</summary><ul className="data-management-warnings">{status.usage.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}

    <section className="data-management-operation data-management-card" aria-label="恢复副本清理">
      <div className="data-management-row"><div><h4>恢复与临时副本</h4><p className="data-management-note">先检查可清理范围，保留仍被引用或无法确认的文件。</p></div>
        <button className="maintenance-button" disabled={locked || !status || cleanup?.phase === "requested" || cleanup?.phase === "running"} onClick={() => void state.inspectCleanup()}>检查可清理项目</button></div>
      {cleanup?.phase === "requested" && <div className="data-management-row"><p>已安排下次启动清理 {cleanup.plannedFiles.toLocaleString("zh-CN")} 个文件（{formatDataSize(cleanup.plannedLogicalBytes)}）。</p><button className="maintenance-button" disabled={locked} onClick={() => void state.cancelCleanup()}>取消清理安排</button></div>}
      {cleanup?.phase === "running" && <p className="data-management-note">上次清理尚未完成，请重新打开 Hub 后检查结果。</p>}
      {cleanup && ["complete", "partial"].includes(cleanup.phase) && <p className="data-management-note">上次清理了 {cleanup.deletedFiles.toLocaleString("zh-CN")} 个文件，保留 {cleanup.retainedFiles.toLocaleString("zh-CN")} 个文件。</p>}
      {cleanup?.error && <p role="alert" className="data-management-error">{cleanup.error}。请重新检查可清理项目。</p>}
      {preview && <div className="data-management-confirmation" aria-label="清理范围预览">
        <h4>{preview.files ? `可清理 ${preview.files.toLocaleString("zh-CN")} 个文件 · ${formatDataSize(preview.logicalBytes)}` : "没有可安全清理的项目"}</h4>
        {!!preview.candidates.length && <ul>{preview.candidates.map(item => <li key={item.id}><span>{item.label}</span><span>{formatDataSize(item.logicalBytes)} · {item.files.toLocaleString("zh-CN")} 个文件</span></li>)}</ul>}
        {!!preview.retained.length && <details><summary>保留的项目（{preview.retained.length} 项）</summary><ul>{preview.retained.map(item => <li key={item.id}><span>{item.label}<small>{item.reason}</small></span><span>{formatDataSize(item.logicalBytes)}</span></li>)}</ul></details>}
        {!!preview.warnings.length && <ul className="data-management-warnings">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        {preview.files > 0 && <p className="data-management-note">下次启动时删除以上副本；正文、业务附件和原始库保留。请先退出使用同一目录的其他 Hub 或 MCP。清理量是文件内容大小，实际释放空间可能不同。</p>}
        <div className="data-management-actions"><button className="maintenance-button" disabled={locked} onClick={state.clearPreview}>{preview.files ? "取消" : "关闭检查结果"}</button>
          {preview.files > 0 && <button className="maintenance-button data-management-caution" disabled={locked} onClick={() => void state.scheduleCleanup()}>安排下次启动清理</button>}</div>
      </div>}
    </section>

    <section className="data-management-operation data-management-card" aria-label="数据库压实">
      <div className="data-management-row"><div><h4>压实数据库</h4><p className="data-management-note">{compaction ? `数据库内可回收 ${formatDataSize(compaction.preview.reclaimableBytes)}。` : "正在检查数据库…"}下次启动时整理，并保留完整恢复副本。</p></div>
        {compactPending ? <button className="maintenance-button" disabled={locked} onClick={() => void state.compact(true)}>取消压实安排</button>
          : <button className="maintenance-button" disabled={locked || !compaction || !compactTerminal || !enoughSpace || !compaction.preview.reclaimableBytes} onClick={() => void state.compact(false)}>安排下次启动压实</button>}</div>
      {compactPending && <p>已安排，下次启动时压实数据库。</p>}
      {compaction?.status?.phase === "complete" && <p className="data-management-note">上次数据库缩小 {formatDataSize(Math.max(0, compaction.status.beforeBytes - compaction.status.afterBytes))}。</p>}
      {compaction && !supported && <p className="data-management-note">当前设备暂不支持数据库压实。</p>}
      {compaction && supported && !enoughSpace && <p className="data-management-note">可用空间不足，至少需要 {formatDataSize(compaction.preview.requiredFreeBytes)} 保存恢复副本。</p>}
      {compaction && compaction.retainedBytes > 0 && <p className="data-management-note">已保留的数据库恢复副本：{formatDataSize(compaction.retainedBytes)}。</p>}
      {compaction?.note && <p className="data-management-note">{compaction.note}</p>}
      {compaction?.status?.error && <p role="alert" className="data-management-error">{compaction.status.error}。请刷新状态后重试。</p>}
    </section>
    <p role="status" className="data-management-status">{busy || state.notice}</p>
    {state.error && <p role="alert" className="data-management-error">{state.error}</p>}
  </div>;
}
