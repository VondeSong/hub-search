import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import "./TagSourceWriteback.css";

type Candidate = { id: string; title: string; path: string; libraryName: string; provider: string; pageId: string; addTag: string; removeTag: string };
type Page = { items: Candidate[]; total: number; nextOffset: number | null };
type Preview = { id: string; token: string; candidate: Candidate; noop: boolean; changes: { id?: string; before: string; after: string }[]; append: string; expiresAt: number };
type Outcome = { id: string; status: string; changed: boolean; warning?: string };
type HistoryItem = { id: string; status: string; updatedAt: number; result: { error?: string; warning?: string } };
type RecordDetail = { plan: { candidate: Candidate; before: string; after: string; changes: { id: string; before: string; after: string }[]; append: string }; status: string };
const call = <T,>(args: Record<string, unknown>) => invoke<T>("tag_assignment", { args });

export function TagSourceWriteback({ proposalId, kind, disabled = false, allowWrite = true, onWritten }: { proposalId: string; kind: "assignment" | "governance"; disabled?: boolean; allowWrite?: boolean; onWritten?: () => void }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const generation = useRef(0);
  const lock = useRef(false);
  useEffect(() => { generation.current++; setOpen(false); setPage(null); setPreview(null); setOutcomes({}); setHistory(null); setRecord(null); setError(""); setBusy(""); lock.current = false; return () => { generation.current++; }; }, [proposalId, kind]);

  async function run<T>(key: string, request: () => Promise<T>, done: (value: T) => void) {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(key); setError(""); const current = generation.current;
    try { const value = await request(); if (current === generation.current) done(value); }
    catch (reason) { if (current === generation.current) setError(String(reason)); }
    finally { if (current === generation.current) { lock.current = false; setBusy(""); } }
  }
  function load(offset = 0) {
    setPreview(null);
    void run("list", () => call<Page>({ action: "source_writeback_list", proposalId, kind, offset }), (value) => {
      setPage(previous => offset && previous ? { ...value, items: [...previous.items, ...value.items.filter(item => !previous.items.some(old => old.id === item.id))] } : value);
      setOpen(true);
    });
  }
  function inspect(item: Candidate) {
    setPreview(null);
    void run(item.id, () => call<Preview>({ action: "source_writeback_preview", proposalId, kind, candidateId: item.id }), setPreview);
  }
  function apply() {
    if (!preview || preview.noop || lock.current || disabled || !allowWrite) return;
    const current = preview;
    // Consume the confirmation immediately; uncertain results require a fresh source read.
    setPreview(null);
    void run(current.candidate.id, () => call<Outcome>({ action: "source_writeback_apply", id: current.id, token: current.token }), value => { setOutcomes(old => ({ ...old, [current.candidate.id]: value })); if (value.changed) onWritten?.(); });
  }
  return <section className="tag-source-writeback" aria-label="标签写回来源">
    {allowWrite && <button type="button" disabled={disabled || !!busy} aria-expanded={open} onClick={() => open ? setOpen(false) : load()}>{busy === "list" ? "正在读取写回范围…" : "写回来源"}</button>}
    {" "}<button type="button" disabled={!!busy} onClick={() => { setRecord(null); void run("history", () => call<{ items: HistoryItem[] }>({ action: "source_writeback_history", proposalId, kind }), value => setHistory(value.items)); }}>写回记录与备份</button>
    {open && allowWrite && <div className="tag-source-writeback-body">
      <header><strong>将标签优化写入原笔记</strong><p>{kind === "assignment" ? "把已批准的 Hub 标签添加到原笔记。" : "将原标签替换为已批准的规范标签；父子关系和待拆分建议不修改来源。"}选择笔记预览，确认后写入。</p></header>
      <button type="button" disabled={disabled || !!busy} onClick={() => load()}>刷新范围</button>
      <p className="tag-source-writeback-note">Obsidian 更新标签属性与正文标签；Craft 更新对应页面中的标签。撤销 Hub 内部建议不会撤销已经完成的来源修改。</p>
      {page && <p>本建议涉及 {page.total} 个写回项 · 已显示 {page.items.length} 个</p>}
      {page?.items.length === 0 && <p>暂无可写回项。来源可能已更新，或此建议只包含内部关系。</p>}
      <ul>{page?.items.map(item => <li key={item.id}>
        <div className="tag-source-writeback-item"><span><strong>{item.title || "未命名笔记"}</strong><small>{item.provider === "craft" ? "Craft" : item.provider === "obsidian" ? "Obsidian" : item.provider} · {item.libraryName} · {item.path}</small><span className="tag-source-writeback-tags">{item.removeTag ? <>#{item.removeTag} → </> : "新增 "}#{item.addTag}</span></span>
          <button type="button" disabled={disabled || !!busy} onClick={() => inspect(item)}>{busy === item.id ? "处理中…" : outcomes[item.id] ? "重新核对" : "预览变更"}</button>
        </div>
        {outcomes[item.id] && <p role="status">{outcomes[item.id].changed ? "已写入来源并读回验证。" : "来源无需修改。"}{outcomes[item.id].warning}</p>}
        {preview?.candidate.id === item.id && <div className="tag-source-writeback-preview">
          {preview.noop ? <p>此项无需修改：来源已包含目标标签，或原标签已不存在。</p> : <>
            <p>将修改：{item.libraryName} / {item.title}{item.provider === "craft" && <small> · 页面 {item.pageId}</small>}</p>
            {preview.append && <div><strong>在页面末尾新增标签块</strong><pre>{preview.append}</pre></div>}
            {preview.changes.map((change, index) => <details key={change.id ?? index} open><summary>查看原文与修改后内容{preview.changes.length > 1 ? ` · ${index + 1}` : ""}</summary><div className="tag-source-writeback-diff"><div><strong>原文</strong><pre>{change.before}</pre></div><div><strong>修改后</strong><pre>{change.after}</pre></div></div></details>)}
            <p className="tag-source-writeback-note">原文快照保存在 Hub；来源变化或预览超过 30 分钟时，需要重新预览。</p>
            <div className="tag-source-writeback-actions"><button type="button" disabled={disabled || !!busy} onClick={() => setPreview(null)}>取消</button><button type="button" className="primary" disabled={disabled || !!busy} onClick={apply}>确认写入{item.provider === "craft" ? " Craft" : " Obsidian"}</button></div>
          </>}
        </div>}
      </li>)}</ul>
      {page?.nextOffset != null && <button type="button" disabled={disabled || !!busy} onClick={() => load(page.nextOffset!)}>加载更多笔记</button>}
    </div>}
    {error && <p className="tag-source-writeback-error" role="alert">{error}</p>}
    {history && <div className="tag-source-writeback-body"><strong>最近 30 次写回记录</strong>{history.length === 0 && <p>暂无已执行的写回。</p>}<ul>{history.map(item => <li key={item.id}><span>{new Date(item.updatedAt * 1000).toLocaleString("zh-CN")} · {({ written: "已写入并验证", unchanged: "无需修改", writing: "写入中或结果待核对", needs_review: "失败或部分完成，需核对" } as Record<string, string>)[item.status] ?? item.status}</span>{item.result.error && <p>{item.result.error}</p>}<button type="button" disabled={!!busy} onClick={() => void run(item.id, () => call<RecordDetail>({ action: "source_writeback_record", id: item.id }), setRecord)}>查看原文备份</button></li>)}</ul>
      {record && <div><strong>{record.plan.candidate.libraryName} / {record.plan.candidate.title} · 写回前原文</strong><p className="tag-source-writeback-note">这是写回前的快照。手动恢复前请与当前来源核对，以免覆盖后续编辑。</p><pre>{record.plan.candidate.provider === "obsidian" ? record.plan.before : record.plan.changes.length ? record.plan.changes.map(change => `${change.id}\n${change.before}`).join("\n\n") : record.plan.before}</pre></div>}
    </div>}
  </section>;
}
