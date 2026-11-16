import { openJournalVoice } from "./JournalVoice";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Mic, Bold, CalendarDays, ExternalLink, Hash, ImagePlus, List, ListOrdered, Quote, SquareCheck, Pin, Copy, MoreHorizontal, Paperclip, Plus, RefreshCw, Send, X } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { localJournalDate, type JournalViewConfig } from "./JournalViews";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import "./QuickJournal.css";
import { runtimeCapabilities } from "./RuntimePlatform";
import { insertJournalTask, splitJournalCapture } from "./JournalCapture";
import { journalRecordMatches,useJournalRecords,type QuickJournalItem } from "./JournalRecords";
import { QUICK_JOURNAL_UPDATED, openQuickJournalCapture } from "./QuickJournalEvents";
import { openCloudSyncSettings } from "./CloudSyncEvents";
import { JournalRichEditor, type JournalRichEditorHandle } from "./JournalRichEditor";
import "./MobileJournal.css";

type Attachment = { hash: string; name: string; size: number; image: boolean };
type Record = { version: 1; id: string; date: string; text: string; attachments: Attachment[] };
type Item = QuickJournalItem;
type Settings = { libraryId: string; folder: string; sync: boolean; dateFolders: boolean };
type SyncReport = { pendingUpload: number; awaitingOs: number; written: number };
type SettingsResult = { settings: Settings; mobile: boolean; error: string; cloudEnabled?: boolean; autoSync?: boolean };
const blank = (): Record => ({ version: 1, id: crypto.randomUUID().replace(/-/g, ""), date: localJournalDate(), text: "", attachments: [] });
const message = (e: unknown) => String(e);
// Survive sheet unmounts so a reopened composer waits for earlier native writes.
let draftWrites: Promise<void> = Promise.resolve();
let attachmentWrites: Promise<void> = Promise.resolve();
export function Image({ hash, name }: { hash: string; name: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => { let live = true; void invoke<string>("quick_journal_image", { hash }).then(v => { if (live) setUrl(v); }).catch(() => {}); return () => { live = false; }; }, [hash]);
  return url ? <img src={url} alt={name} loading="lazy" /> : <span>{name} · 图片暂不可用</span>;
}
export function QuickJournalCard({ item, mobile, onTag, onPreview }: { item: Item; mobile: boolean; onTag?: (tag: string) => void;onPreview?:(entry:SearchResult)=>void }) {
  const records=useJournalRecords();
  const normalized=(value:string)=>value.replace(/\\/g,"/").toLowerCase();
  const preview=records.index.find(meta=>meta.preview&&meta.libraryId===item.libraryId&&meta.path&&item.path&&normalized(item.path).endsWith("/"+normalized(meta.path)))?.preview;
  const [expanded, setExpanded] = useState(false), [error, setError] = useState("");
  // Refreshes must preserve the renderer identities and loaded image state.
  const markdownComponents = useMemo<Components>(() => ({
    img: ({ src, alt }) => { const hash = src?.match(/(?:^|\/)\_hub-assets\/([a-f0-9]{64})(?:\.[a-z0-9]{1,12})?$/)?.[1]; return hash ? <Image hash={hash} name={alt || "照片"} /> : <span>{alt || "图片"}</span>; },
    a: ({ href, children }) => /^https?:\/\//i.test(href || "") ? <a href={href} onClick={e => { e.preventDefault(); void openUrl(href!).catch(e => setError(message(e))); }}>{children}</a> : <span>{children}</span>,
  }), []);
  const collapsible = item.body.length > 350 || item.body.split("\n").length > 8 || item.record.attachments.length > 1;
  async function exportAttachment(a: Attachment) {
    try {
      const destination = mobile ? "" : await saveDialog({ defaultPath: a.name });
      if (destination === null) return;
      await invoke("export_quick_journal_attachment", { id: item.record.id, hash: a.hash, destination });
    } catch (e) { setError(message(e)); }
  }
  return <article className="quick-journal-card memo-card" data-journal-day={item.record.date}>
    <header><span>{records.pins.has(item.record.id)&&<Pin size={12}/>} {item.record.date}</span><span>{item.applied ? "已写入 OS" : item.uploaded ? "已上传，等待电脑写入" : "已保存到本机"}</span>
      {item.applied && !mobile && <button aria-label={`打开 ${item.record.date} 的 OS 日记`} onClick={() => { void invoke("open_quick_journal", { id: item.record.id }).catch(e => setError(message(e))); }}><ExternalLink size={16} /></button>}
    </header>
    {!mobile&&<details className="journal-record-menu"><summary aria-label={`记录操作 ${item.record.date}`}><MoreHorizontal size={18}/></summary><div><button onClick={()=>records.togglePin(item.record.id)}><Pin size={14}/>{records.pins.has(item.record.id)?"取消置顶":"置顶"}</button><button onClick={()=>void navigator.clipboard.writeText(item.body).then(()=>{},e=>setError(`复制失败：${String(e)}`))}><Copy size={14}/>复制正文</button>{preview&&onPreview&&<button onClick={()=>onPreview(preview)}>在阅读面板打开</button>}{item.applied&&!mobile&&<button onClick={()=>void invoke("open_quick_journal",{id:item.record.id}).catch(e=>setError(String(e)))}><ExternalLink size={14}/>在 OS 中打开 / 编辑</button>}</div></details>}
    <div className={`quick-journal-prose ${collapsible && !expanded ? "is-collapsed" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>{item.body}</ReactMarkdown>
      {(!item.path || item.sourceError) && item.record.attachments.map(a => a.image ? <Image key={a.hash} hash={a.hash} name={a.name} /> : <p key={a.hash}><Paperclip size={14} /> {a.name}</p>)}
    </div>
    {!!item.record.attachments.length && <div className="quick-journal-attachments">{item.record.attachments.map((a, i) => <button key={`${a.hash}-${i}`} onClick={() => { void exportAttachment(a); }}><Paperclip size={14} />保存 {a.name}</button>)}</div>}
    {collapsible && <button className="quick-journal-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开全文"}</button>}
    {error && <p role="alert">{error}</p>}
    {item.sourceError && <p role="status">{item.sourceError}</p>}
    {!!onTag && !!tagsFor(item.body).length && <footer className="quick-journal-card-tags">{[...new Set(tagsFor(item.body))].map(t => <button key={t} onClick={() => onTag?.(t)}>#{t}</button>)}</footer>}
  </article>;
}
export type QuickJournalSaved = { id: string; date: string; notice: string };
export function QuickJournal({ libraries, scope, view, dataVersion, mode = "all", captureDate, onSaved, onSyncSettings, onViewChange }: {
  libraries: LibrarySummary[]; scope: string[] | null; view: JournalViewConfig; dataVersion: string;
  mode?: "all" | "compose" | "feed" | "settings" | "calendar";
  captureDate?:string;
  onSaved?: (record: QuickJournalSaved) => void;
  onSyncSettings?: () => void;
  onViewChange?: (change: Partial<JournalViewConfig>) => void;
}) {
  const records=useJournalRecords();
  const slot=mode==="calendar"?captureDate:undefined;
  const [draft, setDraft] = useState<Record>(blank), [ready, setReady] = useState(false), [saving, setSaving] = useState(false), [uploading, setUploading] = useState(false);
  const [items, setItems] = useState<Item[]>([]), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [listError, setListError] = useState("");
  const [mobile, setMobile] = useState(mode === "compose" || runtimeCapabilities.mobile), [settings, setSettings] = useState<Settings>({ libraryId: "", folder: "Journals", sync: false, dateFolders: true }), [settingsReady, setSettingsReady] = useState(false);
  const [savedSettings, setSavedSettings] = useState<Settings | null>(null), [settingsOpen, setSettingsOpen] = useState(false);
  const [cloud, setCloud] = useState<{ enabled?: boolean; auto?: boolean }>({});
  const settingsDirty = savedSettings !== null && (settings.libraryId !== savedSettings.libraryId || settings.folder !== savedSettings.folder || settings.sync !== savedSettings.sync || settings.dateFolders !== savedSettings.dateFolders);
  const [taskLibrary,setTaskLibrary]=useState(""),[taskProject,setTaskProject]=useState(""),[projects,setProjects]=useState<Array<{id:string;name:string}>>([]);
  const capture=splitJournalCapture(draft.text);
  useEffect(()=>{if(!taskLibrary)return;let live=true;void invoke<{projects:Array<{id:string;name:string}>}>("journal_task_destinations",{libraryId:taskLibrary}).then(value=>{if(live)setProjects(value.projects);}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[taskLibrary]);
  const [limit, setLimit] = useState(50), [tag, setTag] = useState("");
  const [moreOpen, setMoreOpen] = useState(false), [pendingOnly, setPendingOnly] = useState(false), [draftStatus, setDraftStatus] = useState(""), [loadRevision, setLoadRevision] = useState(0);
  const textInput = useRef<HTMLTextAreaElement>(null), photoInput = useRef<HTMLInputElement>(null), draftSequence = useRef(0), savePending=useRef(false);
  const richInput=useRef<JournalRichEditorHandle>(null);
  const openSyncSettings = onSyncSettings || openCloudSyncSettings;
  const draftLatest = useRef(draft), fileInput = useRef<HTMLInputElement>(null), mounted = useRef(true);
  const persist = (value: Record) => {
    draftLatest.current = value; setDraft(value);
    const sequence = ++draftSequence.current; setDraftStatus("正在保存草稿…");
    draftWrites = draftWrites.catch(() => {}).then(() => invoke<void>("save_quick_journal_draft", { draft: JSON.stringify(value), ...(slot?{slot}:{}) }));
    void draftWrites.then(() => { if (mounted.current && sequence === draftSequence.current) setDraftStatus("草稿已保存"); }).catch(e => { if (mounted.current) setError(`草稿保存失败：${message(e)}`); });
  };
  async function refresh() {
    const result = await invoke<{ items: Item[]; error: string }>("list_quick_journal");
    if (mounted.current) { setItems(result.items); setListError(result.error || ""); }
  }
  useEffect(() => {
    mounted.current = true;
    if (mode === "all" || mode === "compose" || mode === "calendar") void attachmentWrites.catch(() => {}).then(() => draftWrites.catch(() => {})).then(() => invoke<string>("get_quick_journal_draft",slot?{slot}:undefined)).then(raw => { if (!mounted.current) return; if (raw) { const saved = JSON.parse(raw) as Record; if (saved.version !== 1 || !Array.isArray(saved.attachments)) throw new Error("草稿格式无法识别"); if (!saved.text.trim() && !saved.attachments.length) saved.date = captureDate || localJournalDate(); setDraft(saved); draftLatest.current = saved; } if(!raw&&captureDate){const value={...blank(),date:captureDate};setDraft(value);draftLatest.current=value;} setReady(true); }).catch(e => { if (mounted.current) setError(message(e)); });
    void invoke<SettingsResult>("get_quick_journal_settings").then(v => { if (mounted.current) {
      const value = { ...v.settings, dateFolders: v.settings.dateFolders ?? false };
      setSettings(value); setSavedSettings(value); setMobile(v.mobile); setSettingsReady(true);
      setCloud({ enabled: v.cloudEnabled, auto: v.autoSync });
      if ((mode!=="calendar"&&(!value.sync||(!v.mobile&&!value.libraryId)))||(mode==="calendar"&&!value.libraryId)) setSettingsOpen(true);
    } }).catch(e => setError(message(e)));
    return () => { mounted.current = false; };
  }, [loadRevision, mode]);
  useEffect(() => {
    if (!ready || (mode !== "compose" && mode !== "calendar")) return;
    const focus = () => { textInput.current?.focus({ preventScroll: true }); if (mode === "compose") { richInput.current?.focus(); if (mobile) void invoke("focus_quick_journal_editor").catch(() => {}); } };
    focus();
    if (mode !== "compose") return;
    window.addEventListener("hub:journal-capture-focus", focus);
    return () => window.removeEventListener("hub:journal-capture-focus", focus);
  }, [mode, ready, mobile]);
  useEffect(() => {
    if (mode === "compose" || mode === "calendar") return;
    const reload = () => { void refresh().catch(e => setListError(message(e))); };
    reload(); const timer = setInterval(reload, 15000);
    window.addEventListener(QUICK_JOURNAL_UPDATED, reload);
    return () => { clearInterval(timer); window.removeEventListener(QUICK_JOURNAL_UPDATED, reload); };
  }, [dataVersion, mode]);
  useEffect(() => { setLimit(50); }, [view.query, view.period, view.day, view.month, tag, scope, view.libraries]);
  async function sync(manual = true) {
    if (busy || !settingsReady) return;
    if (!manual && (!savedSettings?.sync || settingsDirty)) return;
    if (settingsDirty) { setError("速记设置有未保存的修改，请先点击“保存设置”"); setSettingsOpen(true); return; }
    setBusy(true); setError("");
    if (manual) setNotice("");
    try {
      const report = await invoke<SyncReport | null>("sync_quick_journal");
      if (manual) setNotice(report ? `本轮同步已结束。本机队列：待上传 ${report.pendingUpload} 条，等待电脑写入 ${report.awaitingOs} 条，已确认写入 OS ${report.written} 条。` : "同步请求已结束，请查看卡片状态。");
    } catch (e) { setError(message(e)); setSettingsOpen(true); }
    finally {
      await refresh().catch(e => setListError(message(e)));
      await invoke<SettingsResult>("get_quick_journal_settings").then(v => setCloud({ enabled: v.cloudEnabled, auto: v.autoSync })).catch(() => {});
      setBusy(false);
    }
  }
  async function saveSettings() {
    setBusy(true); setError(""); setNotice("");
    const value = { ...settings };
    try {
      const result = await invoke<{ warning?: string } | null>("save_quick_journal_settings", { value });
      setSavedSettings(value); setNotice(result?.warning ? `设置已保存，后台任务安排失败：${result.warning}。可先手动同步。` : "设置已保存。可以点击“同步 / 重试”检查结果。");
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function save() {
    if (savePending.current || saving || uploading || !ready) return;
    if(mode==="calendar"&&!capture.text.trim()&&!capture.tasks.length&&!draft.attachments.length){setError("请填写日志正文或任务内容");return;}
    if(mode==="calendar"&&capture.tasks.length&&(!taskLibrary||!taskProject)){setError("请选择任务保存到的滴答资料库和清单");return;}
    savePending.current=true;setSaving(true); setError(""); setNotice("");
    try {
      draftWrites = draftWrites.catch(() => invoke<void>("save_quick_journal_draft", { draft: JSON.stringify(draftLatest.current), ...(slot?{slot}:{}) }));
      await draftWrites;
      const captured = draftLatest.current;
      const result = await invoke<{ warning: string | null;tasks?:number }>(mode==="calendar"?"capture_calendar_journal":"capture_quick_journal", { record: captured, ...(mode==="calendar"?{libraryId:taskLibrary,projectId:taskProject}:{}) });
      persist({...blank(),date:captureDate||localJournalDate()});
      // A clear failure must not turn an already durable record into a failed save.
      const clearWarning = await draftWrites.then(() => "", () => "草稿清理失败；重新打开时可能仍显示刚保存的内容。");
      const savedNotice = [result.warning || (mode==="calendar"?`创建完成。${captured.attachments.length||capture.text.trim()?"日志已保存在本机，并进入 OS 保存队列。":""}${result.tasks?`${result.tasks} 条任务已核对保存。`:""}`:`已保存到本机，可以锁屏。${!settingsReady ? "请检查同步设置。" : !settings.sync ? "速记云同步尚未开启。" : cloud.enabled === false ? "云同步总开关尚未开启。" : cloud.auto === false ? "自动同步已暂停，可在日志页手动重试。" : ""}`), clearWarning].filter(Boolean).join(" ");
      setNotice(savedNotice);
      window.dispatchEvent(new CustomEvent(QUICK_JOURNAL_UPDATED));
      if (mode !== "compose" && mode !== "calendar") await refresh();
      onSaved?.({ id: captured.id, date: captured.date, notice: savedNotice });
      // Persisted WorkManager handles Android; this also makes desktop captures immediately visible in OS.
      if (!mobile) void sync(false);
    } catch (e) { setError(message(e));if(mode==="calendar")window.dispatchEvent(new CustomEvent(QUICK_JOURNAL_UPDATED)); } finally { savePending.current=false;setSaving(false); }
  }
  async function attach(files: FileList | null) {
    if (!files?.length) return;
    const selectedFiles = Array.from(files);
    setUploading(true); setError("");
    attachmentWrites = attachmentWrites.catch(() => {}).then(async () => {
    try {
      if (selectedFiles.length + draftLatest.current.attachments.length > 9) throw new Error("每条最多 9 个附件");
      for (const file of selectedFiles) if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MB`);
      for (const file of selectedFiles) {
        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
          reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
          reader.readAsDataURL(file);
        });
        const a = await invoke<Attachment>("stage_quick_journal_attachment", { name: file.name, content });
        persist({ ...draftLatest.current, attachments: [...draftLatest.current.attachments, a] });
      }
    } catch (e) { setError(message(e)); } finally { setUploading(false); if (fileInput.current) fileInput.current.value = ""; if (photoInput.current) photoInput.current.value = ""; }
    });
    await attachmentWrites;
  }
  const filtered = useMemo(() => items.filter(i => {
    if (i.deleted || pendingOnly && i.applied) return false;
    const indexed={id:i.record.id,hasAttachments:i.record.attachments.length>0,hasTags:tagsFor(i.body).length>0};
    if(!journalRecordMatches(indexed,view.recordFilter||"all",records.pins))return false;
    const date = i.record.date;
    if (view.period === "month" && !date.startsWith(view.month)) return false;
    if (view.period === "day" && date !== view.day) return false;
    const library = i.libraryId || settings.libraryId;
    if (!(mobile && !library)) {
      if (scope !== null && !scope.includes(library)) return false;
      if (view.libraries !== null && !view.libraries.includes(library)) return false;
    }
    const text = `${date}\n${i.body}\n${i.record.attachments.map(a => a.name).join(" ")}`;
    return text.toLocaleLowerCase().includes(view.query.toLocaleLowerCase()) && (!tag || tagsFor(i.body).includes(tag));
  }).sort((a, b) => view.ascending ? a.record.date.localeCompare(b.record.date) : b.record.date.localeCompare(a.record.date)), [items, view, scope, settings.libraryId, tag, pendingOnly, mobile, records.pins]);
  const tags = [...new Set(items.flatMap(i => tagsFor(i.body)))].sort();
  const queue = { pending: items.filter(i => !i.uploaded).length, awaiting: items.filter(i => i.uploaded && !i.applied).length, written: items.filter(i => i.applied).length };
  function insert(kind: "tag" | "bold" | "list" | "task" | "number" | "quote") {
    const input = textInput.current; if (!input || saving || uploading) return;
    const start = input.selectionStart, end = input.selectionEnd, selected = draftLatest.current.text.slice(start, end);
    if(kind==="task"){const next=insertJournalTask(draftLatest.current.text,start,end);persist({...draftLatest.current,text:next.text});requestAnimationFrame(()=>{input.focus();input.setSelectionRange(next.caret,next.caret);});return;}
    const value = kind==="number"?"\n1. ":kind==="quote"?"\n> ":kind === "bold" ? `**${selected || "文字"}**` : kind === "list" ? `${start && draftLatest.current.text[start - 1] !== "\n" ? "\n" : ""}- ${selected}` : `${start && !/\s/.test(draftLatest.current.text[start - 1]) ? " " : ""}#`;
    persist({ ...draftLatest.current, text: draftLatest.current.text.slice(0, start) + value + draftLatest.current.text.slice(end) });
    requestAnimationFrame(() => { input.focus({ preventScroll: true }); input.setSelectionRange(start + (kind === "bold" ? 2 : value.length), start + value.length - (kind === "bold" ? 2 : 0)); });
  }
  const compose = <form className={`quick-journal-compose ${mobile ? "is-mobile" : ""}`} onSubmit={e => { e.preventDefault(); void save(); }}>
    {mode==="compose"&&mobile?<JournalRichEditor ref={richInput} value={draft.text} onChange={text=>persist({...draftLatest.current,text})} disabled={!ready||saving||uploading} onPhotos={()=>photoInput.current?.click()} onMore={()=>setMoreOpen(!moreOpen)} moreOpen={moreOpen} onSubmit={()=>void save()} actions={<><button type="button" aria-label="进入录音模式" disabled={!ready||saving||uploading} onClick={()=>void draftWrites.then(()=>openJournalVoice({record:draftLatest.current,sourceDraft:true})).catch(e=>setError(message(e)))}><Mic size={21}/></button><button type="submit" className="journal-rich-send" aria-label="保存记录" disabled={!ready||saving||uploading||(!draft.text.trim()&&!draft.attachments.length)}><Send size={20}/></button></>}/>:<>
    <label className="sr-only" htmlFor="quick-journal-text">此刻的想法</label>
    <textarea ref={textInput} id="quick-journal-text" placeholder="现在的想法是…" value={draft.text} disabled={!ready || saving} maxLength={100000} onChange={e => persist({ ...draftLatest.current, text: e.target.value })} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); } }} />
    </>}
    {!!draft.attachments.length && <ul className="quick-journal-draft-files">{draft.attachments.map((a, i) => <li key={`${a.hash}-${i}`}>{a.image ? <Image hash={a.hash} name={a.name} /> : <Paperclip size={24} />}<span>{a.name}</span><button type="button" aria-label={`移除附件 ${a.name}`} disabled={saving || uploading} onClick={() => persist({ ...draftLatest.current, attachments: draftLatest.current.attachments.filter((_, n) => i !== n) })}><X size={14} /></button></li>)}</ul>}
    <footer>
      {mode==="calendar"?<div className="quick-journal-compose-tools">{([["tag",Hash,"插入标签"],["attach",ImagePlus,"照片 / 附件"],["list",List,"插入项目符号"],["number",ListOrdered,"插入编号列表"],["quote",Quote,"插入引用"],["task",SquareCheck,"插入任务"]] as const).map(([kind,Icon,label])=><button key={kind} type="button" aria-label={label} disabled={!ready||saving||uploading} onClick={()=>kind==="attach"?fileInput.current?.click():insert(kind)}><Icon size={18}/></button>)}</div>:mobile ? <div className="quick-journal-compose-tools"><button type="button" aria-label="插入标签" disabled={!ready || saving} onClick={() => insert("tag")}><Hash size={22} /></button><button type="button" aria-label="添加照片" disabled={!ready || saving || uploading} onClick={() => photoInput.current?.click()}><ImagePlus size={22} /></button><button type="button" aria-label="更多记录选项" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}><MoreHorizontal size={22} /></button></div> : <label>日期<input type="date" value={draft.date} disabled={!ready || saving} onChange={e => persist({ ...draftLatest.current, date: e.target.value })} /></label>}
      <input ref={fileInput} className="sr-only" type="file" multiple tabIndex={-1} onChange={e => { void attach(e.target.files); }} />
      <input ref={photoInput} className="sr-only" type="file" accept="image/*" multiple tabIndex={-1} onChange={e => { void attach(e.target.files); }} />
      {!mobile && mode!=="calendar" && <button type="button" disabled={!ready || saving || uploading} onClick={() => fileInput.current?.click()}><Paperclip size={16} />{uploading ? "保存附件…" : "照片 / 附件"}</button>}
      <button type="submit" disabled={!ready || saving || uploading || (!draft.text.trim() && !draft.attachments.length) || (mode==="calendar"&&!capture.text.trim()&&!capture.tasks.length&&!draft.attachments.length)}><Send size={17} />{saving ? "保存中…" : mode==="calendar"?"创建":"记下"}</button>
    </footer>
    {mobile && moreOpen && <div className="quick-journal-more"><label>记录日期<input type="date" aria-label="记录日期" value={draft.date} disabled={!ready || saving} onChange={e => persist({ ...draftLatest.current, date: e.target.value })} /></label><div><button type="button" disabled={!ready || saving || uploading} onClick={() => fileInput.current?.click()}><Paperclip size={17} />添加文件</button>{mode!=="compose"&&<><button type="button" disabled={!ready || saving} onClick={() => insert("bold")}><Bold size={17} />加粗</button><button type="button" disabled={!ready || saving} onClick={() => insert("list")}><List size={17} />列表</button></>}</div><small>每条最多 9 个附件，单个 20 MB。</small></div>}
    {mobile && <div className="quick-journal-draft-status"><span role="status">{uploading ? "正在保存附件…" : draftStatus}</span><button type="button" onClick={() => setMoreOpen(!moreOpen)}><CalendarDays size={13} />{draft.date === localJournalDate() ? "今天" : draft.date}</button></div>}
  </form>;
  return <section className={`quick-journal quick-journal-${mode}`} aria-label={mode === "compose" ? "速记录入" : mode === "settings" ? "速记同步" : "速记卡片流"}>
    {mobile && mode !== "compose" && mode !== "settings" && <header className="quick-journal-mobile-heading"><h1>日志</h1><p>按天留下想法，随时回来接着看。</p><button onClick={openSyncSettings}>{queue.pending + queue.awaiting ? `${queue.pending + queue.awaiting} 条记录等待同步或写入` : "查看同步状态"}<RefreshCw size={15} /></button></header>}
    {mode === "settings" && <div className="quick-journal-queue"><span><strong>{queue.pending}</strong>待上传</span><span><strong>{queue.awaiting}</strong>等待电脑</span><span><strong>{queue.written}</strong>已写入 OS</span></div>}
    {(mode === "settings" || (!mobile && mode === "all") || (mode==="calendar"&&settingsOpen)) &&
    <details className="quick-journal-settings" open={settingsOpen} onToggle={e => setSettingsOpen(e.currentTarget.open)}><summary>速记保存与同步设置</summary>
      <p>记录按所选日期写入日记。电脑作为唯一写入端；手机保留本机副本。云同步复用设置中的 OSS 连接及总开关。</p>
      <p role="status">已保存的速记同步：{savedSettings?.sync ? "开启" : "关闭"}；云同步总开关：{cloud.enabled === undefined ? "待检查" : cloud.enabled ? "开启" : "关闭"}；自动同步：{cloud.auto === undefined ? "待检查" : cloud.auto ? "开启" : "关闭"}</p>
      <button onClick={openSyncSettings}>打开云同步设置</button>
      {!mobile && <label>OS 资料库<select aria-label="速记 OS 资料库" value={settings.libraryId} disabled={!settingsReady || busy} onChange={e => setSettings({ ...settings, libraryId: e.target.value })}><option value="">请选择</option>{libraries.filter(l => l.provider === "obsidian").map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
      {!mobile && <><label>{settings.dateFolders ? "日记根目录" : "日记固定目录"}<input aria-label="速记日记目录" disabled={!settingsReady || busy} value={settings.folder} onChange={e => setSettings({ ...settings, folder: e.target.value })} placeholder="Journals" /></label>
        <label><input type="checkbox" disabled={!settingsReady || busy} checked={settings.dateFolders} onChange={e => setSettings({ ...settings, dateFolders: e.target.checked })} />按记录日期分年/月目录</label>
        <p>{settings.dateFolders ? "填写根目录，例如 Journals，年月会按每条记录的日期自动补齐。" : "当前使用固定目录，跨月时不会自动切换。可改填 Journals 并开启年/月目录。"}</p>
        <p>保存后，{draft.date || "所选日期"}的目标：{settings.folder}/{settings.dateFolders && draft.date ? `${draft.date.slice(0, 4)}/${draft.date.slice(5, 7)}/` : ""}{draft.date || "日期"}.md</p>
      </>}
      <label><input type="checkbox" disabled={!settingsReady || busy} checked={settings.sync} onChange={e => setSettings({ ...settings, sync: e.target.checked })} />开启本设备速记云同步</label>
      {settingsDirty && <p role="status">设置尚未保存，当前同步仍使用已保存的配置。</p>}
      <button disabled={!settingsReady || busy} onClick={() => { void saveSettings(); }}>保存设置</button>
    </details>}
    {mode !== "settings" && mode !== "feed" && compose}
    {mode==="calendar"&&<p className="journal-capture-destinations">日志 → {libraries.find(l=>l.id===settings.libraryId)?.name||"请先配置 OS 保存位置"}<button type="button" onClick={()=>setSettingsOpen(!settingsOpen)}>保存设置</button></p>}
    {mode==="calendar"&&capture.tasks.length>0&&<div className="journal-capture-target"><p>{capture.text.trim()||draft.attachments.length?"日志 → OS；":""}{capture.tasks.length} 条任务 → 滴答清单</p><label>任务保存到<select aria-label="任务资料库" value={taskLibrary} disabled={saving} onChange={e=>{setTaskLibrary(e.target.value);setTaskProject("");}}><option value="">选择滴答资料库</option>{libraries.filter(l=>l.provider==="dida365"&&l.connected).map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>{taskLibrary&&<label>清单<select aria-label="任务清单" value={taskProject} disabled={saving} onChange={e=>setTaskProject(e.target.value)}><option value="">选择清单</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}<p>点击创建后，任务与日志分别保存。</p></div>}
    {notice && <p className="quick-journal-notice" role="status">{notice}</p>}
    {(error || listError) && <div className="quick-journal-error" role="alert">{error || listError}<button onClick={() => { setError(""); setListError(""); if (!ready || !settingsReady) setLoadRevision(v => v + 1); if (mode !== "compose") void refresh().catch(e => setListError(message(e))); }}>重新读取</button></div>}
    {mode === "compose" && <p className="quick-journal-capture-help">保存到本机后可锁屏。{!settingsReady ? "正在读取同步设置。" : !settings.sync ? "速记云同步尚未开启。" : cloud.enabled === false ? "云同步总开关尚未开启。" : cloud.auto === false ? "自动同步已暂停，可在日志页手动重试。" : "后台会继续上传。"}<button onClick={openSyncSettings}>同步设置</button></p>}
    {mode !== "compose" && mode !== "calendar" && <>
    {mobile && mode === "feed" && <div className="quick-journal-mobile-filters"><div className="quick-journal-search-row"><label><span className="sr-only">搜索记录或附件</span><input type="search" aria-label="搜索记录或附件" placeholder="搜索记录或附件" value={view.query} onChange={e => onViewChange?.({ query: e.target.value })} /></label>{!!tags.length && <label className="quick-journal-tag-filter"><span className="sr-only">标签</span><select aria-label="速记标签" value={tag} onChange={e => setTag(e.target.value)}><option value="">全部标签</option>{tags.map(t => <option key={t} value={t}>#{t}</option>)}</select></label>}</div><div><button aria-pressed={!pendingOnly && view.period === "all"} onClick={() => { setPendingOnly(false); onViewChange?.({ period: "all" }); }}>全部</button><button aria-pressed={!pendingOnly && view.period === "day" && view.day === localJournalDate()} onClick={() => { setPendingOnly(false); onViewChange?.({ period: "day", day: localJournalDate() }); }}>今天</button><button aria-pressed={pendingOnly} onClick={() => { setPendingOnly(true); onViewChange?.({ period: "all" }); }}>待同步</button><button onClick={openQuickJournalCapture}><Plus size={16} />记一条</button></div></div>}
    <div className={`quick-journal-controls${mobile && mode === "feed" ? " quick-journal-mobile-count" : ""}`}>{mode !== "settings" && <span>{filtered.length} 条记录</span>}<button disabled={busy || !settingsReady} onClick={() => { void sync(); }}><RefreshCw size={15} />{busy ? "处理中…" : "同步 / 重试"}</button>{mode !== "settings" && !(mobile && mode === "feed") && !!tags.length && <label>标签<select aria-label="速记标签" value={tag} onChange={e => setTag(e.target.value)}><option value="">全部</option>{tags.map(t => <option key={t} value={t}>#{t}</option>)}</select></label>}</div>
    {mode !== "settings" && filtered.slice(0, limit).map(i => <QuickJournalCard key={i.record.id} item={i} mobile={mobile} onTag={setTag} />)}
    {mode !== "settings" && !filtered.length && <p className="quick-journal-empty">还没有符合筛选的记录。写下一个想法，或调整日期和资料库。{mobile && <button onClick={() => { setTag(""); setPendingOnly(false); onViewChange?.({ period: "all", query: "" }); }}>清除筛选</button>}</p>}
    {mode !== "settings" && filtered.length > limit && <button onClick={() => setLimit(limit + 50)}>加载更多记录</button>}
    </>}
  </section>;
}
export function tagsFor(text: string) { return [...text.matchAll(/(?:^|\s)#([^\s#.,，。!?！？\[\]<>]+)/gu)].map(m => m[1]); }
