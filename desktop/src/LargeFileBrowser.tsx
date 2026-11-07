import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatDataPath, formatDataSize } from "./DataManagementFormat";

type Entry = { relativePath: string; name: string; bytes: number; categoryLabel: string; kind: string; titles: string[]; referenceCount: number };
type Result = { entries: Entry[]; totalFiles: number; totalBytes: number; page: number; pageSize: number; warnings: string[]; readOnly: boolean };
const kinds: Record<string, string> = { video: "视频", pdf: "PDF", image: "图片", other: "其他文件" };
export function LargeFileBrowser({ category, categoryLabel = "大文件", rootPath, onClose }: { category: string; categoryLabel?: string; rootPath: string; onClose: () => void }) {
  const [minimum, setMinimum] = useState(50), [kind, setKind] = useState("all"), [page, setPage] = useState(0);
  const [draft, setDraft] = useState(""), [query, setQuery] = useState(""), [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Result | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [notice, setNotice] = useState(""), [revealing, setRevealing] = useState("");
  const section = useRef<HTMLElement>(null);
  useEffect(() => { section.current?.scrollIntoView?.({ block: "start", behavior: "auto" }); section.current?.focus(); }, []);
  useEffect(() => {
    let alive = true; setLoading(true); setError(""); setResult(null);
    void invoke<Result>("data_portability", { args: { action: "list_large_files", category, minimumBytes: minimum * 1024 * 1024, kind, query, page, operationId: crypto.randomUUID() } })
      .then(value => { if (alive) setResult(value); }).catch(reason => { if (alive) setError(String(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [category, minimum, kind, query, page, revision]);
  const fullPath = (relative: string) => { const root = formatDataPath(rootPath); const separator = root.includes("\\") ? "\\" : "/"; return root.replace(/[\\/]+$/, "") + separator + relative.split("/").join(separator); };
  const reveal = async (entry: Entry) => {
    if (revealing) return; setRevealing(entry.relativePath); setError("");
    try { await invoke("data_portability", { args: { action: "reveal_large_file", relativePath: entry.relativePath, operationId: crypto.randomUUID() } }); }
    catch (reason) { setError(`无法定位文件：${String(reason)}。请刷新后重试。`); }
    finally { setRevealing(""); }
  };
  const copy = async (entry: Entry) => {
    try { await navigator.clipboard.writeText(fullPath(entry.relativePath)); setNotice("已复制完整文件路径。"); }
    catch { setError("无法复制路径，请展开文件位置后手动复制。"); }
  };
  return <section className="large-file-browser data-management-operation" aria-label="大文件列表" ref={section} tabIndex={-1}>
    <div className="data-management-row"><div><h4>{categoryLabel} · 大文件</h4><p className="data-management-note">按文件大小从大到小排列，显示关联的内容。此处只查看和定位。</p></div><button className="maintenance-button" onClick={onClose}>关闭列表</button></div>
    <form className="large-file-filters" onSubmit={event => { event.preventDefault(); setPage(0); setQuery(draft.trim()); setRevision(v => v + 1); }}>
      <label>文件大小<select aria-label="大文件最小大小" value={minimum} disabled={loading} onChange={event => { setPage(0); setMinimum(Number(event.target.value)); }}>
        <option value={0}>全部大小</option><option value={10}>至少 10 MB</option><option value={50}>至少 50 MB</option><option value={100}>至少 100 MB</option><option value={500}>至少 500 MB</option><option value={1024}>至少 1 GB</option></select></label>
      <label>类型<select aria-label="大文件类型" value={kind} disabled={loading} onChange={event => { setPage(0); setKind(event.target.value); }}><option value="all">全部类型</option>{Object.entries(kinds).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <label className="large-file-search">查找内容或文件<input aria-label="查找大文件" value={draft} onChange={event => setDraft(event.target.value)} placeholder="标题、文件名或路径" /></label>
      <button className="maintenance-button" disabled={loading}>查找</button>
    </form>
    <p role="status" className="data-management-note">{loading ? "正在扫描文件大小并匹配内容…" : result ? `${result.totalFiles.toLocaleString("zh-CN")} 个文件 · ${formatDataSize(result.totalBytes)}，按大小降序` : ""}</p>
    {error && <p role="alert" className="data-management-error">{error} <button className="maintenance-button" disabled={loading} onClick={() => setRevision(v => v + 1)}>刷新列表</button></p>}
    {result?.entries.length === 0 && <p>没有符合条件的文件。可降低大小门槛或更换类型。</p>}
    <ol className="large-file-list" start={page * 50 + 1}>{result?.entries.map(entry => <li key={entry.relativePath}>
      <div className="large-file-description"><strong>{entry.titles[0] || entry.name}</strong><span className="data-management-note">{kinds[entry.kind]} · {entry.categoryLabel}{entry.referenceCount > 0 ? ` · 关联 ${entry.referenceCount} 条内容` : " · 未匹配到内容引用"}</span>
        {entry.titles.length > 1 && <details><summary>其他关联内容（{entry.titles.length - 1} 条）</summary><ul>{entry.titles.slice(1).map(title => <li key={title}>{title}</li>)}</ul></details>}
        <details><summary>文件名与完整位置</summary><code className="data-management-path">{fullPath(entry.relativePath)}</code><button className="maintenance-button" type="button" onClick={() => void copy(entry)}>复制文件路径</button></details>
      </div>
      <div className="large-file-actions"><strong>{formatDataSize(entry.bytes)}</strong><button className="maintenance-button" disabled={Boolean(revealing)} onClick={() => void reveal(entry)}>{revealing === entry.relativePath ? "正在定位…" : "定位文件"}</button></div>
    </li>)}</ol>
    {result && result.totalFiles > 50 && <div className="data-management-actions"><button className="maintenance-button" disabled={loading || page === 0} onClick={() => setPage(v => v - 1)}>上一页</button><span>第 {page + 1} / {Math.ceil(result.totalFiles / 50)} 页</span><button className="maintenance-button" disabled={loading || (page + 1) * 50 >= result.totalFiles} onClick={() => setPage(v => v + 1)}>下一页</button></div>}
    {!!result?.warnings.length && <details><summary>扫描提示（{result.warnings.length} 项）</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    <p role="status" className="data-management-note">{notice}</p><p className="data-management-note">显示文件内容大小，不等同于实际释放空间。Obsidian 原库不参与扫描。</p>
  </section>;
}
