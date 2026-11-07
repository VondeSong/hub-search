import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Paperclip, RefreshCw, Send, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { localJournalDate, type JournalViewConfig } from "./JournalViews";
import type { LibrarySummary } from "./SearchTypes";
import "./QuickJournal.css";

type Attachment = { hash: string; name: string; size: number; image: boolean };
type Record = { version: 1; id: string; date: string; text: string; attachments: Attachment[] };
type Item = { record: Record; body: string; uploaded: boolean; applied: boolean; libraryId: string; path: string; namespace: string; sourceError?: string };
type Settings = { libraryId: string; folder: string; sync: boolean };
const blank = (): Record => ({ version: 1, id: crypto.randomUUID().replace(/-/g, ""), date: localJournalDate(), text: "", attachments: [] });
const message = (e: unknown) => String(e);
function Image({ hash, name }: { hash: string; name: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => { let live = true; void invoke<string>("quick_journal_image", { hash }).then(v => { if (live) setUrl(v); }).catch(() => {}); return () => { live = false; }; }, [hash]);
  return url ? <img src={url} alt={name} loading="lazy" /> : <span>{name} · 图片暂不可用</span>;
}
function Card({ item, mobile }: { item: Item; mobile: boolean }) {
  const [expanded, setExpanded] = useState(false), [error, setError] = useState("");
  const collapsible = item.body.length > 350 || item.body.split("\n").length > 8 || item.record.attachments.length > 1;
  async function exportAttachment(a: Attachment) {
    try {
      const destination = mobile ? "" : await saveDialog({ defaultPath: a.name });
      if (destination === null) return;
      await invoke("export_quick_journal_attachment", { id: item.record.id, hash: a.hash, destination });
    } catch (e) { setError(message(e)); }
  }
  return <article className="quick-journal-card" data-journal-day={item.record.date}>
    <header><span>{item.record.date}</span><span>{item.applied ? "已写入 OS" : item.uploaded ? "已上传，等待电脑写入" : "已保存到本机"}</span>
      {item.applied && !mobile && <button aria-label={`打开 ${item.record.date} 的 OS 日记`} onClick={() => { void invoke("open_quick_journal", { id: item.record.id }).catch(e => setError(message(e))); }}><ExternalLink size={16} /></button>}
    </header>
    <div className={`quick-journal-prose ${collapsible && !expanded ? "is-collapsed" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
        img: ({ src, alt }) => { const hash = src?.match(/(?:^|\/)\_hub-assets\/([a-f0-9]{64})(?:\.[a-z0-9]{1,12})?$/)?.[1]; return hash ? <Image hash={hash} name={alt || "照片"} /> : <span>{alt || "图片"}</span>; },
        a: ({ href, children }) => /^https?:\/\//i.test(href || "") ? <a href={href} onClick={e => { e.preventDefault(); void openUrl(href!).catch(e => setError(message(e))); }}>{children}</a> : <span>{children}</span>,
      }}>{item.body}</ReactMarkdown>
      {(!item.path || item.sourceError) && item.record.attachments.map(a => a.image ? <Image key={a.hash} hash={a.hash} name={a.name} /> : <p key={a.hash}><Paperclip size={14} /> {a.name}</p>)}
    </div>
    {!!item.record.attachments.length && <div className="quick-journal-attachments">{item.record.attachments.map((a, i) => <button key={`${a.hash}-${i}`} onClick={() => { void exportAttachment(a); }}><Paperclip size={14} />保存 {a.name}</button>)}</div>}
    {collapsible && <button className="quick-journal-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开全文"}</button>}
    {error && <p role="alert">{error}</p>}
    {item.sourceError && <p role="status">{item.sourceError}</p>}
  </article>;
}
export function QuickJournal({ libraries, scope, view, dataVersion }: { libraries: LibrarySummary[]; scope: string[] | null; view: JournalViewConfig; dataVersion: string }) {
  const [draft, setDraft] = useState<Record>(blank), [ready, setReady] = useState(false), [saving, setSaving] = useState(false), [uploading, setUploading] = useState(false);
  const [items, setItems] = useState<Item[]>([]), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [mobile, setMobile] = useState(false), [settings, setSettings] = useState<Settings>({ libraryId: "", folder: "Journals", sync: false }), [settingsReady, setSettingsReady] = useState(false);
  const [limit, setLimit] = useState(50), [tag, setTag] = useState("");
  const draftWrites = useRef(Promise.resolve()), draftLatest = useRef(draft), fileInput = useRef<HTMLInputElement>(null), mounted = useRef(true);
  const persist = (value: Record) => {
    draftLatest.current = value; setDraft(value);
    draftWrites.current = draftWrites.current.catch(() => {}).then(() => invoke<void>("save_quick_journal_draft", { draft: JSON.stringify(value) }));
    void draftWrites.current.catch(e => { if (mounted.current) setError(`草稿保存失败：${message(e)}`); });
  };
  async function refresh() {
    const result = await invoke<{ items: Item[]; error: string }>("list_quick_journal");
    if (mounted.current) { setItems(result.items); if (result.error) setError(result.error); }
  }
  useEffect(() => {
    mounted.current = true;
    void invoke<string>("get_quick_journal_draft").then(raw => { if (!mounted.current) return; if (raw) { const saved = JSON.parse(raw) as Record; if (saved.version !== 1 || !Array.isArray(saved.attachments)) throw new Error("草稿格式无法识别"); setDraft(saved); draftLatest.current = saved; } setReady(true); }).catch(e => setError(message(e)));
    void invoke<{ settings: Settings; mobile: boolean; error: string }>("get_quick_journal_settings").then(v => { if (mounted.current) { setSettings(v.settings); setMobile(v.mobile); setSettingsReady(true); } }).catch(e => setError(message(e)));
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { void refresh().catch(e => setError(message(e))); const timer = setInterval(() => { void refresh().catch(e => setError(message(e))); }, 15000); return () => clearInterval(timer); }, [dataVersion]);
  useEffect(() => { setLimit(50); }, [view.query, view.period, view.day, view.month, tag, scope, view.libraries]);
  async function sync() {
    setBusy(true); setError("");
    try { await invoke("sync_quick_journal"); await refresh(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function save() {
    if (saving || uploading || !ready) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await draftWrites.current;
      const result = await invoke<{ warning: string | null }>("capture_quick_journal", { record: draftLatest.current });
      persist(blank());
      setNotice(result.warning || `已保存到本机，可以锁屏。${settings.sync ? "" : "云同步尚未开启。"}`);
      await refresh();
      // Persisted WorkManager handles Android; this also makes desktop captures immediately visible in OS.
      void sync();
    } catch (e) { setError(message(e)); } finally { setSaving(false); }
  }
  async function attach(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setError("");
    try {
      if (files.length + draftLatest.current.attachments.length > 9) throw new Error("每条最多 9 个附件");
      for (const file of Array.from(files)) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MB`);
        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
          reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
          reader.readAsDataURL(file);
        });
        const a = await invoke<Attachment>("stage_quick_journal_attachment", { name: file.name, content });
        persist({ ...draftLatest.current, attachments: [...draftLatest.current.attachments, a] });
      }
    } catch (e) { setError(message(e)); } finally { setUploading(false); if (fileInput.current) fileInput.current.value = ""; }
  }
  const filtered = useMemo(() => items.filter(i => {
    const date = i.record.date;
    if (view.period === "month" && !date.startsWith(view.month)) return false;
    if (view.period === "day" && date !== view.day) return false;
    const library = i.libraryId || settings.libraryId;
    if (scope !== null && !scope.includes(library)) return false;
    if (view.libraries !== null && !view.libraries.includes(library)) return false;
    const text = `${i.body}\n${i.record.attachments.map(a => a.name).join(" ")}`;
    return text.toLocaleLowerCase().includes(view.query.toLocaleLowerCase()) && (!tag || tagsFor(i.body).includes(tag));
  }).sort((a, b) => view.ascending ? a.record.date.localeCompare(b.record.date) : b.record.date.localeCompare(a.record.date)), [items, view, scope, settings.libraryId, tag]);
  const tags = [...new Set(items.flatMap(i => tagsFor(i.body)))].sort();
  return <section className="quick-journal" aria-label="速记卡片流">
    <details className="quick-journal-settings"><summary>速记保存与同步设置</summary>
      <p>记录按所选日期写入日记。电脑作为唯一写入端；手机保留本机副本。云同步复用设置中的 OSS 连接及总开关。</p>
      {!mobile && <label>OS 资料库<select aria-label="速记 OS 资料库" value={settings.libraryId} disabled={!settingsReady} onChange={e => setSettings({ ...settings, libraryId: e.target.value })}><option value="">请选择</option>{libraries.filter(l => l.provider === "obsidian").map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
      {!mobile && <label>库内日记目录<input value={settings.folder} onChange={e => setSettings({ ...settings, folder: e.target.value })} placeholder="Journals" /></label>}
      <label><input type="checkbox" checked={settings.sync} onChange={e => setSettings({ ...settings, sync: e.target.checked })} />开启本设备速记云同步</label>
      <button disabled={!settingsReady || busy} onClick={async () => { setBusy(true); setError(""); try { await invoke("save_quick_journal_settings", { value: settings }); setNotice("设置已保存"); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>保存设置</button>
    </details>
    <form className="quick-journal-compose" onSubmit={e => { e.preventDefault(); void save(); }}>
      <label className="sr-only" htmlFor="quick-journal-text">此刻的想法</label>
      <textarea id="quick-journal-text" placeholder="此刻的想法… 支持 #标签" value={draft.text} disabled={!ready || saving} maxLength={100000} onChange={e => persist({ ...draftLatest.current, text: e.target.value })} />
      {!!draft.attachments.length && <ul>{draft.attachments.map((a, i) => <li key={`${a.hash}-${i}`}><Paperclip size={14} /><span>{a.name}</span><button type="button" aria-label={`移除附件 ${a.name}`} disabled={saving || uploading} onClick={() => persist({ ...draftLatest.current, attachments: draft.attachments.filter((_, n) => i !== n) })}><X size={14} /></button></li>)}</ul>}
      <footer><label>日期<input type="date" value={draft.date} disabled={!ready || saving} onChange={e => persist({ ...draftLatest.current, date: e.target.value })} /></label>
        <input ref={fileInput} className="sr-only" type="file" multiple tabIndex={-1} onChange={e => { void attach(e.target.files); }} />
        <button type="button" disabled={!ready || saving || uploading} onClick={() => fileInput.current?.click()}><Paperclip size={16} />{uploading ? "保存附件…" : "照片 / 附件"}</button>
        <button type="submit" disabled={!ready || saving || uploading || (!draft.text.trim() && !draft.attachments.length)}><Send size={16} />{saving ? "保存中…" : "记下"}</button>
      </footer>
    </form>
    {notice && <p className="quick-journal-notice" role="status">{notice}</p>}
    {error && <div className="quick-journal-error" role="alert">{error}<button onClick={() => { setError(""); void refresh().catch(e => setError(message(e))); }}>重新读取</button></div>}
    <div className="quick-journal-controls"><span>{filtered.length} 条记录</span><button disabled={busy} onClick={() => { void sync(); }}><RefreshCw size={15} />{busy ? "同步中…" : "同步 / 重试"}</button>{!!tags.length && <label>标签<select aria-label="速记标签" value={tag} onChange={e => setTag(e.target.value)}><option value="">全部</option>{tags.map(t => <option key={t} value={t}>#{t}</option>)}</select></label>}</div>
    {filtered.slice(0, limit).map(i => <Card key={i.record.id} item={i} mobile={mobile} />)}
    {!filtered.length && <p className="quick-journal-empty">还没有符合筛选的记录。写下一个想法，或调整日期和资料库。</p>}
    {filtered.length > limit && <button onClick={() => setLimit(limit + 50)}>加载更多记录</button>}
  </section>;
}
export function tagsFor(text: string) { return [...text.matchAll(/(?:^|\s)#([^\s#.,，。!?！？\[\]<>]+)/gu)].map(m => m[1]); }
