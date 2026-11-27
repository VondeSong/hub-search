import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Archive, ArrowLeft, ArrowUp, Camera, ChevronRight, Clock3, Cloud, Download, FileText, Image, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeft, Plus, Search, Settings2, Sparkles, Square, Video, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CloudMarkdownTable } from "./CloudMarkdownTable";
import { loadComposerDrafts, saveComposerDraft, type ComposerDraft } from "./CloudAgentDrafts";
import { imageUpload, outbox, uploadSize, videoUploads, type CloudSkillPayload, type DraftTurn, type Upload, type MaterialSnapshot } from "./CloudAgentMedia";
import "./CloudAgents.css";
import { CloudAgentSheet, CloudAnswerNote, CloudMaterialPicker } from "./CloudAgentMaterials";
import { AgentAnswerActions } from "./AgentAnswerActions";
import { runtimeCapabilities } from "./RuntimePlatform";
import { CloudModelPanel, CloudSkillSheet, modelLabel, effortLabel, type CloudAccount, type ModelCatalog, type ModelSelection, type SkillChoice } from "./CloudAgentPreferences";
import {CloudHandoffPanel,CloudPendingHandoffs,type CloudHandoff} from "./CloudHandoff";

type Connection = { endpoint: string; binding: string };
type Account = CloudAccount;
export type CloudThreadSummary = { id: string; title: string; updated: number; archived?: boolean; preview?: string; status?: Turn["status"]; matches?: boolean | number | null };
type Summary = CloudThreadSummary;
export type CloudContinuationPayload = { threadId: string; title: string; text: string };
export type CloudEmbedRequest = { token: number; mode: "thread" | "new" | "settings" | "list"; threadId?: string };
type Attachment = { id: string; name: string; seconds?: number | null };
type Progress = { startedAt?: number; finishedAt?: number; summary?: string[]; updates?: string[] };
type Turn = { id: string; seq: number; created?: number; text: string; answer: string; error?: string; status: "queued" | "running" | "stopping" | "completed" | "failed" | "stopped"; attachments: Attachment[]; material?: MaterialSnapshot; progress?: Progress };
type Thread = Summary & { turns: Turn[]; before: number | null; handoff?:CloudHandoff|null; skill?: { name: string; version: string; paths: string[] } | null; selection?: ModelSelection | null };
type CacheState = {cached?:boolean;cachedAt?:number;cacheWarning?:string;accessDenied?:boolean;error?:string};
type Snapshot = CacheState & { thread: Thread | null; account?: Account };
type Delivery = { turn: string; phase: "sending" | "checking" | "accepted" | "rejected"; error?: string };
type ChatView = "chat" | "materials" | "results";
const active = (turn?: Pick<Turn, "status">) => turn && ["queued", "running", "stopping"].includes(turn.status);
const statusText = { queued: "云端已接收，等待执行", running: "正在回复", stopping: "等待停止确认", completed: "已完成", failed: "未完成", stopped: "已停止" };
const call = <T,>(op: string, fields: Record<string, unknown> = {}) => invoke<T>("cloud_agents", { action: { op, ...fields } });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const attachmentLabel = (file: { name: string; seconds?: number | null }) => file.seconds == null ? file.name : `${file.name} · ${file.seconds.toFixed(2)} 秒`;
const asImage = (file: Upload) => `data:${file.mime};base64,${file.data}`;
const stamp = (value: number) => new Date(value).toLocaleString("zh-CN", new Date(value).toDateString() === new Date().toDateString() ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric" });

function dataUrlToFile(src: string, name: string): File | null {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(src);
  if (!match) return null;
  const binary = atob(match[2].replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: match[1] });
}

function buildLocalContinuation(title: string, turns: Turn[], handoff?: CloudHandoff | null): string {
  const parts: string[] = [`【来自个人云端会话：${title}】`];
  if (handoff?.state === "published" && handoff.manifest.report?.text) {
    parts.push(`桌面交接报告（第 ${handoff.manifest.origin.revision} 版）：\n${handoff.manifest.report.text.trim()}`);
  }
  const recent = turns.slice(-2);
  for (const turn of recent) {
    if (turn.text.trim()) parts.push(`提问：${turn.text.trim()}`);
    if (turn.answer.trim()) parts.push(`云端回复：${turn.answer.trim()}`);
  }
  const full = parts.join("\n\n");
  if (full.length <= 2350) return full;
  return full.slice(0, 2320) + "\n…（已截断，完整内容请回到云端会话查看）";
}

function AttachmentPreview({ file, local, onAttachToLocal }: { file: Attachment; local?: Upload; onAttachToLocal?: (file: File) => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const imageSrc = local ? asImage(local) : url;
  async function toggle() {
    setOpen(true);
    if (url || local || loading) return;
    setError("");
    setLoading(true);
    try { setUrl((await call<{ url: string }>("attachment", { id: file.id })).url); }
    catch (failure) { setError(errorText(failure)); }
    finally { setLoading(false); }
  }
  return <div className="cloud-agent-attachment">
    <button type="button" onClick={() => void toggle()} aria-haspopup="dialog">
      {local ? <img className="cloud-agent-thumbnail" src={asImage(local)} alt="" /> : <Image size={17} />}
      <span>{attachmentLabel(file)}</span>
    </button>
    {open && <CloudAgentSheet title={attachmentLabel(file)} compact onClose={() => setOpen(false)}>
      {imageSrc ? <>
        <img className="cloud-agent-preview" src={imageSrc} alt={attachmentLabel(file)} />
        {!runtimeCapabilities.mobile && <footer className="cloud-agent-attachment-footer">
          <a className="cloud-agent-attachment-link" href={imageSrc} download={file.name}><Download size={14} aria-hidden="true"/>保存图片副本</a>
          {onAttachToLocal && <button type="button" onClick={() => {
            const prepared = dataUrlToFile(imageSrc, file.name);
            if (!prepared) { setError("暂不支持将此格式图片添加到本机对话。"); return; }
            onAttachToLocal(prepared);
            setOpen(false);
          }}>带入本机对话</button>}
        </footer>}
      </> :
        error ? <><p role="alert">{error}</p><button type="button" onClick={() => void toggle()}>重新读取图片</button></> :
          <p role="status">正在读取图片…</p>}
    </CloudAgentSheet>}
  </div>;
}

function RunProgress({ turn, waitingToStop }: { turn: Turn; waitingToStop: boolean }) {
  const [open, setOpen] = useState(false);
  const { progress } = turn;
  const summary = progress?.summary ?? [];
  const updates = progress?.updates ?? [];
  const state = waitingToStop ? statusText.stopping : statusText[turn.status];
  const latest = (summary[summary.length - 1] ?? updates[updates.length - 1])?.trim().split(/\r?\n/, 1)[0].replace(/^#+\s+/, "").replace(/\*\*/g, "");
  return <>
    <button type="button" className="cloud-agents-process" aria-label="查看运行过程" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      {active(turn) ? <LoaderCircle size={15} className="cloud-agents-spinner"/> : <Clock3 size={15}/>}
      <span>{latest || (active(turn) ? state : "运行过程")}</span><ChevronRight size={14}/>
    </button>
    {open && <CloudAgentSheet title="运行过程" compact onClose={() => setOpen(false)}>
      <div className="cloud-agents-progress-meta"><span>个人云端</span>
        {progress?.startedAt && progress.finishedAt && <span>{Math.max(1, Math.round((progress.finishedAt - progress.startedAt) / 1000))} 秒</span>}
      </div>
      {updates.length > 0 && <ol className="cloud-agents-timeline" aria-label="Codex 进度">{updates.map((part, index) => <li key={index}>{part}</li>)}</ol>}
      {summary.length > 0 ? <>
        <h3>模型公开摘要</h3><ol className="cloud-agents-timeline">{summary.map((part, index) => <li key={index}>{part}</li>)}</ol>
      </> : <p>{active(turn) ? "等待 Codex 返回可显示的摘要。" : "本轮没有可显示的模型摘要。"}</p>}
      <p className="cloud-agents-progress-state" role="status">
        {active(turn) && <LoaderCircle size={15} className="cloud-agents-spinner"/>}{state}
      </p>
    </CloudAgentSheet>}
  </>;
}

export type CloudCatalogUpdate = { threads: CloudThreadSummary[]; account?: Account; threadManagement: boolean; endpoint?: string };

export default function CloudAgents({
  onClose,
  initialSettings = false,
  openRecentOnEntry = false,
  embedded = false,
  request,
  onBackToLocal,
  onContinueInLocal,
  onAttachImageToLocal,
  onCatalogUpdated,
  onHandoffStateChange,
}: {
  onClose?: () => void;
  initialSettings?: boolean;
  openRecentOnEntry?: boolean;
  embedded?: boolean;
  request?: CloudEmbedRequest;
  onBackToLocal?: () => void;
  onContinueInLocal?: (payload: CloudContinuationPayload) => void;
  onAttachImageToLocal?: (file: File) => void;
  onCatalogUpdated?: (update: CloudCatalogUpdate) => void;
  onHandoffStateChange?: (handoff: CloudHandoff, meta: { cached: boolean }) => void;
}) {
  const mobile = runtimeCapabilities.mobile;
  const desktopEmbedded = embedded && !mobile;
  const [connection, setConnection] = useState<Connection | null>();
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [settings, setSettings] = useState(initialSettings || request?.mode === "settings");
  const [chatOpen, setChatOpen] = useState(!initialSettings && (request?.mode === "thread" || request?.mode === "new"));
  const [view, setView] = useState<ChatView>("chat");
  const [sheet, setSheet] = useState<"attachments" | "model" | "effort" | "usage" | "skills">();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [catalogQuery, setCatalogQuery] = useState<string>();
  const [scope, setScope] = useState<"active" | "archived" | "all">("active");
  const [management, setManagement] = useState(false);
  const [rename, setRename] = useState<string>();
  const [updating, setUpdating] = useState(false);
  const [catalog, setCatalog] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<string | undefined>(!initialSettings && request?.mode === "thread" ? request.threadId : undefined);
  const lastRequestToken = useRef(request?.token ?? 0);
  const onCatalogUpdatedRef = useRef(onCatalogUpdated);
  onCatalogUpdatedRef.current = onCatalogUpdated;
  const onHandoffStateChangeRef = useRef(onHandoffStateChange);
  onHandoffStateChangeRef.current = onHandoffStateChange;
  const [snapshot, setSnapshot] = useState<Thread>();
  const [earlier, setEarlier] = useState<Turn[]>([]);
  const [before, setBefore] = useState<number | null>();
  const [account, setAccount] = useState<Account>();
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>();
  const [modelSelection, setModelSelection] = useState<ModelSelection>();
  const [skillError, setSkillError] = useState("");
  const [network, setNetwork] = useState("");
  const [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Upload[]>([]);
  const [material,setMaterial]=useState<MaterialSnapshot>();
  const [materialPicker,setMaterialPicker]=useState(false);
  const [checkedAt,setCheckedAt]=useState<number>();
  const [skills, setSkills] = useState<SkillChoice[]>();
  const [skillVersion, setSkillVersion] = useState("");
  const [skillPaths, setSkillPaths] = useState<string[]>([]);
  const [pending, setPending] = useState<DraftTurn>();
  const [delivery, setDelivery] = useState<Delivery>();
  const [confirmedUpload, setConfirmedUpload] = useState<DraftTurn>();
  const [waitingToStop, setWaitingToStop] = useState<string>();
  const [preview, setPreview] = useState<Upload | MaterialSnapshot>();
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [syncVersion, refresh] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const sending = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const listScroll = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const historyOwner = useRef(crypto.randomUUID());
  const drafts = useRef(new Map<string, ComposerDraft>());
  const draftOwner = useRef<string | undefined>(undefined);
  const [draftsReady, setDraftsReady] = useState(false);
  const current = snapshot?.id === selected ? snapshot : undefined;
  const last = current?.turns[current.turns.length - 1];
  const binding = connection?.binding;
  const autoOpenedFor = useRef<string | undefined>(undefined);
  const known = Boolean(current || selected && catalog.some(item => item.id === selected));
  const localPending = pending?.thread === selected ? pending : undefined;
  const displayedPending = localPending && !current?.turns.some(turn => turn.id === localPending.turn) ? localPending : undefined;
  const deliveryPhase = delivery?.turn === pending?.turn ? delivery?.phase : "checking";
  const chosenSkill = skills?.find(skill => skill.methodVersion === skillVersion);
  const boundSkill = current?.skill;
  const archived = Boolean(current?.archived ?? catalog.find(item => item.id === selected)?.archived);
  const handoffWithdrawn = current?.handoff?.state === "withdrawn";

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!chatOpen && list.current) list.current.scrollTop = listScroll.current;
  }, [chatOpen, settings]);
  useEffect(() => {
    if (!mobile) return;
    const pop = () => {
      const own = window.history.state?.hubCloudAgentOwner === historyOwner.current;
      setChatOpen(own && Boolean(window.history.state?.hubCloudAgentChat));
      if (!own || !window.history.state?.hubCloudAgentChat) setView("chat");
      setSettings(own && Boolean(window.history.state?.hubCloudAgentSettings));
      setRename(undefined);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [mobile]);

  async function showSkills() {
    setSkillError("");
    try {
      const latest = await call<SkillChoice[]>("skillVersions");
      setSkills(current => {
        const pinned = current?.find(item => item.methodVersion === skillVersion);
        return pinned && !latest.some(item => item.methodVersion === pinned.methodVersion) ? [...latest, pinned] : latest;
      });
    }
    catch (error) { setSkillError(errorText(error)); }
  }

  useEffect(() => {
    let live = true;
    void call<Connection | null>("config").then(value => {
      if (live) { setConnection(value); setEndpoint(value?.endpoint ?? ""); }
    }).catch(error => { if (live) { setConnection(null); setNotice(errorText(error)); } });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!binding || initialSettings) return;
    let live = true;
    draftOwner.current=undefined;
    setDraftsReady(false);
    void Promise.all([outbox(binding), mobile ? loadComposerDrafts(binding) : Promise.resolve(new Map<string,ComposerDraft>())]).then(([saved,stored]) => {
      if (!live) return;
      drafts.current=stored;draftOwner.current=binding;setDraftsReady(true);
      if (saved) { setPending(saved); if (!desktopEmbedded || !request) select(saved.thread,false,true); }
      else if(mobile){try{const previous=JSON.parse(localStorage.getItem("hub-cloud-last:"+binding)||"null");if(previous?.thread){select(previous.thread,false,true);if(["chat","results","materials"].includes(previous.view)){setView(previous.view);remember(previous.thread,previous.view);}}else if(stored.has("new"))select(undefined,false,true);}catch{}}
    }).catch(() => { if (live) setNotice("无法读取本机草稿或待重试的消息。原数据已保留，请重新打开后重试。"); });
    return () => { live = false; };
  }, [binding]);

  useEffect(() => {
    if (!desktopEmbedded || !request || request.token === lastRequestToken.current) return;
    lastRequestToken.current = request.token;
    if (request.mode === "settings") {
      setSettings(true);
      setNotice("");
    } else if (request.mode === "list") {
      setSettings(false);
      setRename(undefined);
      setChatOpen(false);
      setView("chat");
    } else if (request.mode === "new") {
      select(undefined);
    } else if (request.mode === "thread" && request.threadId) {
      select(request.threadId);
    }
  }, [desktopEmbedded, request]);

  useEffect(() => {
    if (!mobile || !binding || !chatOpen || pending || draftOwner.current!==binding) return;
    const id=selected??"new";
    const draft={text,attachments,material,skillVersion,skillPaths,selection:modelSelection};
    drafts.current.set(id,draft);
    void saveComposerDraft(binding,id,draft).catch(()=>{if(draftOwner.current===binding)setNotice("草稿尚未保存，请保留应用并重试。原内容仍在输入框中。");});
  },[mobile,binding,draftsReady,chatOpen,selected,pending,text,attachments,material,skillVersion,skillPaths,modelSelection]);

  useEffect(() => {
    if (!binding || settings) return;
    const outboxKey = binding;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let nextList = 0;
    let missed = 0;
    async function sync() {
      const selectedThread = chatOpen && selected && (known || desktopEmbedded) ? selected : undefined;
      const threads = [...new Set([selectedThread, pending?.thread].filter((id): id is string => Boolean(id)))];
      let running = false;
      let cachedAt:number|undefined;
      let cacheWarning:string|undefined;
      function access(data:CacheState){if(data.accessDenied){setCatalog([]);setSnapshot(undefined);setChatOpen(false);throw new Error(data.error||"云端访问已撤销，缓存已清除。");}if(data.cached)cachedAt=data.cachedAt;cacheWarning=data.cacheWarning||cacheWarning;}
      const readList = Date.now() >= nextList ? [call<CacheState & { threads: Summary[]; account: Account; threadManagement?: boolean; modelCatalog?: ModelCatalog; modelSelection?: boolean }>("list", { query }).then(data => {
        if (!live) return;
        access(data);
        setCatalog(data.threads);
        setManagement(Boolean(data.threadManagement));
        setModelCatalog(data.modelSelection ? data.modelCatalog : undefined);
        setCatalogQuery(query);
        if (!threads.length) setAccount(data.account);
        if (!query) onCatalogUpdatedRef.current?.({ threads: data.threads, account: data.account, threadManagement: Boolean(data.threadManagement), endpoint: connection?.endpoint });
        nextList = Date.now() + 4500;
      })] : [];
      const reads = threads.map(thread => call<Snapshot>("read", {
        thread, missing: thread === pending?.thread && thread !== selectedThread,
      }).then(data => {
        if (!live) return;
        access(data);
        const result = data.thread;
        if (!result) return;
        if (thread === selected) setSnapshot(result);
        if (result.handoff) onHandoffStateChangeRef.current?.(result.handoff, { cached: Boolean(data.cached) });
        if (data.account) setAccount(data.account);
        if (active(result.turns[result.turns.length - 1])) running = true;
        if (pending?.thread === thread && result.turns.some(item => item.id === pending.turn)) {
          setConfirmedUpload(pending);
          setPending(value => value?.turn === pending.turn ? undefined : value);
          void outbox(outboxKey, null, pending.turn).catch(() => {
            if (live) setNotice("云端已收到这条消息。本机记录将在下次打开时重新核对。");
          });
        }
      }));

      const results = await Promise.allSettled([...reads, ...readList]);
      if (!live) return;
      const relevant = threads.length ? results.slice(0, threads.length) : results;
      const failure = relevant.find(item => item.status === "rejected");
      if (relevant.some(item => item.status === "fulfilled")) {
        setNetwork(cachedAt?`显示本机缓存（截至 ${new Date(cachedAt).toLocaleString("zh-CN")}），恢复连接后重新核对。`:"");
        if(cacheWarning)setNotice(cacheWarning);
        setCheckedAt(cachedAt||Date.now());
        missed = 0;
      } else if (failure?.status === "rejected" && (++missed >= 2 || !navigator.onLine)) {
        setNetwork(errorText(failure.reason));
      }
      timer = setTimeout(() => void sync(), running ? 700 : pending ? 1600 : 4500);
    }
    const wake = () => { if (!document.hidden) refresh(value => value + 1); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    void sync();
    return () => { live = false; clearTimeout(timer); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake); };
  }, [binding, selected, chatOpen, settings, known, pending, syncVersion, query]);

  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [current, displayedPending, selected, view, chatOpen]);

  useEffect(() => {
    const messages = scroll.current;
    if (!mobile || !chatOpen || view !== "chat" || !messages || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follow.current) messages.scrollTop = messages.scrollHeight;
    });
    observer.observe(messages);
    return () => observer.disconnect();
  }, [mobile, chatOpen, view, settings]);

  function select(id?: string, sent = false, restoring = false) {
    if (mobile && !restoring && draftOwner.current !== binding) return;
    if(!restoring)drafts.current.set(selected ?? "new", sent ? { text: "", attachments: [], skillVersion: "", skillPaths: [] } : { text, attachments, material, skillVersion, skillPaths, selection: modelSelection });
    const draft = sent ? undefined : drafts.current.get(id ?? "new");
    setText(draft?.text ?? ""); setAttachments(draft?.attachments ?? []); setMaterial(draft?.material); setMaterialPicker(false);
    setSkillVersion(draft?.skillVersion ?? ""); setSkillPaths(draft?.skillPaths ?? []);
    setModelSelection(draft?.selection);
    follow.current = true;
    setSelected(id);
    remember(id,"chat");
    setEarlier([]);
    setBefore(undefined);
    setChatOpen(true); setView("chat"); setSettings(false); setRename(undefined);
    setSheet(undefined); setPreview(undefined);
    if (mobile && (window.history.state?.hubCloudAgentOwner !== historyOwner.current || !window.history.state?.hubCloudAgentChat)) {
      window.history.pushState({ ...(window.history.state ?? {}), hubCloudAgentOwner: historyOwner.current, hubCloudAgentChat: true, hubCloudAgentSettings: false }, "");
    }
    setNotice("");
  }

  useEffect(() => {
    if (!openRecentOnEntry || !mobile || !binding || !draftsReady || draftOwner.current !== binding || settings || query || autoOpenedFor.current === binding) return;
    if (chatOpen) { autoOpenedFor.current = binding; return; }
    const recent = catalog.find(thread => !thread.archived);
    if (!recent) return;
    autoOpenedFor.current = binding;
    try {
      if (JSON.parse(localStorage.getItem("hub-cloud-last:" + binding) || "null")?.view === "list") return;
    } catch { /* Start with the most recent active conversation. */ }
    select(recent.id, false, true);
  }, [openRecentOnEntry, mobile, binding, draftsReady, settings, query, chatOpen, catalog]);

  function showList() {
    remember(undefined,"chat");
    setSettings(false); setRename(undefined); setChatOpen(false); setView("chat");
    if (mobile && window.history.state?.hubCloudAgentOwner === historyOwner.current && window.history.state?.hubCloudAgentChat) window.history.back();
  }

  function remember(id:string|undefined,next:ChatView){if(!mobile||!binding)return;try{if(id)localStorage.setItem("hub-cloud-last:"+binding,JSON.stringify({thread:id,view:next}));else localStorage.setItem("hub-cloud-last:"+binding,JSON.stringify({view:"list"}));}catch{}}
  function changeView(next:ChatView){setView(next);remember(selected,next);}

  function showSettings() {
    setNotice("");
    if (mobile && (window.history.state?.hubCloudAgentOwner !== historyOwner.current || !window.history.state?.hubCloudAgentSettings)) {
      window.history.pushState({ ...(window.history.state ?? {}), hubCloudAgentOwner: historyOwner.current, hubCloudAgentChat: chatOpen, hubCloudAgentSettings: true }, "");
    }
    setSettings(true);
  }

  function closeSettings() {
    if (initialSettings) { onClose?.(); return; }
    setSettings(false);
    if (mobile && window.history.state?.hubCloudAgentOwner === historyOwner.current && window.history.state?.hubCloudAgentSettings) window.history.back();
    refresh(value => value + 1);
  }

  async function updateThread(changes: { title?: string; archived?: boolean }) {
    if (!selected || updating) return;
    const thread = selected;
    setUpdating(true); setNotice("");
    try {
      const result = await call<{ thread: Thread }>("update", { thread, ...changes });
      if (selectedRef.current === thread) {
        setSnapshot(result.thread); setRename(undefined);
        if (changes.archived) showList();
      }
      refresh(v => v + 1);
    } catch (error) { setNotice(errorText(error)); }
    finally { setUpdating(false); }
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const value = await call<Connection>("connect", { endpoint, token });
      if (value.binding !== binding) {
        setCatalog([]); setCatalogQuery(undefined); setSnapshot(undefined); setAccount(undefined); setPending(undefined); setDelivery(undefined); setConfirmedUpload(undefined);
        setText(""); setAttachments([]); setMaterial(undefined); setSelected(undefined); drafts.current.clear();
        setModelCatalog(undefined); setModelSelection(undefined); setSkills(undefined); setSkillVersion(""); setSkillPaths([]);
        if (mobile && window.history.state?.hubCloudAgentOwner === historyOwner.current && window.history.state?.hubCloudAgentSettings && window.history.state?.hubCloudAgentChat) {
          setChatOpen(false); setView("chat"); setSettings(false); window.history.go(-2);
        } else closeSettings();
      } else {
        closeSettings();
      }
      setConnection(value);
      setEndpoint(value.endpoint);
      setToken("");
    } catch (error) { setNotice(errorText(error)); }
    finally { setBusy(false); }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!binding || mobile && !draftsReady || sending.current || preparing || archived || handoffWithdrawn || (deliveryPhase === "accepted" && pending) ||
      (pending && pending.thread !== selected) || (!pending && (!text.trim() && !attachments.length && !material || active(last)))) return;
    sending.current = true;
    setBusy(true);
    setNotice("");
    let sendingTurn: string | undefined;
    try {
      const skill = !pending && chosenSkill && !boundSkill
        ? await call<CloudSkillPayload>("prepareSkill", { version: chosenSkill.methodVersion, paths: skillPaths })
        : undefined;
      if (!pending && modelCatalog?.state !== "ready" && (modelCatalog || effectiveSelection)) {
        setNotice("暂时无法核对所选模型，请重新读取模型目录后发送。草稿已保留。"); return;
      }
      if (!pending && modelCatalog?.state === "ready" && (!selectedModel || effectiveSelection?.effort && !selectedModel.supportedReasoningEfforts.some(option => option.reasoningEffort === effectiveSelection.effort))) {
        setNotice("先重新选择可用的模型和推理强度，再发送消息。"); return;
      }
      const selection = pending?.selection ?? effectiveSelection;
      if (selection) {
        const capabilities = await call<{ modelSelection?: boolean }>("list", { query: "" });
        if (!capabilities.modelSelection) { setNotice("当前云端不支持模型切换，请更新服务后重试。消息尚未执行。"); return; }
      }
      const draft = pending ?? { thread: selected ?? crypto.randomUUID(), turn: crypto.randomUUID(), text: text.trim(), attachments, skill, material, ...(selection && { selection }), created: Date.now() };
      if (!pending) {
        await outbox(binding, draft, undefined, selected??"new");
        setPending(draft);
        setText(""); setAttachments([]); setMaterial(undefined);
      }
      if (selected !== draft.thread) select(draft.thread, true);
      setModelSelection(draft.selection);
      drafts.current.delete(draft.thread);
      follow.current = true;
      sendingTurn = draft.turn;
      setDelivery({ turn: draft.turn, phase: "sending" });
      const receipt = await call<{ id?: string; delivery?: "accepted" | "rejected" | "unknown"; error?: string }>("send", {
        thread: draft.thread, turn: draft.turn,
        message: { text: draft.text, attachments: draft.attachments, ...(draft.skill && { skill: draft.skill }), ...(draft.material && { material: draft.material }), ...(draft.selection && { selection: draft.selection }) },
      });
      setDelivery(receipt?.delivery === "rejected" ?
        { turn: draft.turn, phase: "rejected", error: receipt.error } :
        { turn: draft.turn, phase: receipt?.id === draft.turn ? "accepted" : "checking" });
    } catch (error) {
      if (sendingTurn) setDelivery({ turn: sendingTurn, phase: "checking" });
      else setNotice(errorText(error));
    } finally {
      refresh(v => v + 1);
      sending.current = false;
      setBusy(false);
    }
  }

  async function stop(turn: string) {
    if (!selected || waitingToStop === turn) return;
    setWaitingToStop(turn);
    setNotice("");
    try { await call("stop", { thread: selected, turn }); }
    catch {
      setWaitingToStop(undefined);
      setNotice("暂未确认停止，请查看本轮状态后重试。");
    } finally { refresh(v => v + 1); }
  }

  async function releasePending() {
    if (!binding || !displayedPending || sending.current) return;
    try {
      await outbox(binding, null, displayedPending.turn);
      if (pendingRef.current?.turn !== displayedPending.turn) return;
      setPending(value => value?.turn === displayedPending.turn ? undefined : value);
      if (deliveryPhase === "rejected") {
        setText(displayedPending.text);
        setAttachments(displayedPending.attachments);
        setMaterial(displayedPending.material);
        setSkillVersion(displayedPending.skill?.version ?? "");
        setSkillPaths(Object.keys(displayedPending.skill?.files ?? {}).filter(path => path !== "SKILL.md"));
        setView("chat");
      }
    } catch (error) { setNotice(errorText(error)); }
  }

  async function add(files: FileList | null, video = false) {
    if (!files?.length) return;
    const origin = selected;
    const draftKey = origin ?? "new";
    setSheet(undefined);
    setPreparing(true); setNotice("");
    try {
      if (attachments.length + (video ? 1 : files.length) > 6) throw new Error("每条消息最多 6 张图片或视频关键帧。");
      const added = video ? await videoUploads(files[0], 6 - attachments.length) : await Promise.all(Array.from(files, imageUpload));
      const next = [...attachments, ...added];
      if (uploadSize(next) > 12 * 1024 * 1024) throw new Error("一条消息的附件合计最多 12 MiB。");
      if (selectedRef.current === origin) setAttachments(next);
      else {
        const draft = drafts.current.get(draftKey);
        if (draft) drafts.current.set(draftKey, { ...draft, attachments: next });
      }
    } catch (error) { if (selectedRef.current === origin) setNotice(errorText(error)); }
    finally { setPreparing(false); }
  }

  async function loadEarlier() {
    const cursor = before === undefined ? current?.before : before;
    if (!selected || !cursor) return;
    const thread = selected;
    setLoadingEarlier(true);
    try {
      const data = await call<{ thread: Thread }>("read", { thread, before: cursor });
      if (selectedRef.current !== thread) return;
      follow.current = false;
      setEarlier(value => [...data.thread.turns, ...value]);
      setBefore(data.thread.before);
    } catch (error) { setNotice(errorText(error)); }
    finally { setLoadingEarlier(false); }
  }
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const connectionLabel = network ? "连接中断" : account?.state === "login" ? "云端需要登录" : account?.state === "quota" ? "Codex 额度受限" : account?.state === "ready" ? "个人云端 · ChatGPT" : connection ? "已配置个人云端" : "云端对话";
  const turns = [...earlier.filter(item => !current?.turns.some(turn => turn.id === item.id)), ...(current?.turns ?? [])];
  const count = catalog.filter(item => item.archived).length;
  const rows = catalog.filter(item => (scope === "all" || Boolean(item.archived) === (scope === "archived")) &&
    (management ? item.matches : item.title.toLowerCase().includes(query.toLowerCase())));

  const title = selected ? current?.title || catalog.find(item => item.id === selected)?.title ||
    localPending?.text.slice(0, 48) || (localPending?.attachments.length ? "附件对话" : "对话") : "新对话";
  const activeTurn = active(last) ? last?.id : deliveryPhase === "accepted" ? displayedPending?.turn : undefined;
  const stopPending = Boolean(activeTurn && (activeTurn === waitingToStop || last?.status === "stopping"));
  const warning = account?.state === "login" ? "ChatGPT 登录已失效" : account?.state === "quota" ? "订阅额度不足" : network || "";
  const attachDisabled = busy || preparing || mobile && !draftsReady || archived || handoffWithdrawn || Boolean(pending);
  const defaultModel = modelCatalog?.models.find(item => item.isDefault) ?? modelCatalog?.models[0];
  const effectiveSelection = localPending?.selection ?? modelSelection ?? current?.selection ?? (defaultModel ? { model: defaultModel.model, effort: defaultModel.defaultReasoningEffort } : undefined);
  const selectedModel = modelCatalog?.models.find(item => item.model === effectiveSelection?.model);
  const model = modelLabel(effectiveSelection?.model || account?.model || "Codex");
  const selectedSkill = boundSkill?.name || localPending?.skill?.name || chosenSkill?.title;
  function openSkills() { setSheet("skills"); void showSkills(); }

  const materialButton = (file: MaterialSnapshot) => <button type="button" className="cloud-agents-material-open" onClick={() => setPreview(file)}>
    <FileText size={17}/><span><strong>{file.title}</strong><small>{file.source}</small></span>
  </button>;
  const draftFiles = (files: Upload[], remove = false) => files.length > 0 && <div className="cloud-agents-files">
    {files.map((file, index) => <div className={`cloud-agents-file${file.seconds == null ? "" : " is-video-frame"}`} key={`${file.name}-${file.seconds ?? ""}-${index}`}>
      <button type="button" onClick={() => setPreview(file)} aria-label={`预览 ${attachmentLabel(file)}`}>
        <img className="cloud-agent-thumbnail" src={asImage(file)} alt=""/><span>{attachmentLabel(file)}</span>
      </button>
      {remove && <button type="button" className="cloud-agents-remove" disabled={preparing} onClick={() => setAttachments(items => items.filter((_, i) => i !== index))} aria-label={`移除 ${attachmentLabel(file)}`}><X size={14}/></button>}
    </div>)}
  </div>;

  const markdown = (answer: string) => <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    table: CloudMarkdownTable,
    img: () => null,
    a: ({ href, children }) => <a href={href} onClick={event => {
      event.preventDefault();
      if (href?.startsWith("https://")) void openUrl(href).catch(() => setNotice("无法打开链接。"));
    }}>{children}</a>,
  }}>{answer}</ReactMarkdown>;

  const followUp = () => {
    setView("chat");
    if (textarea.current) textarea.current.focus();
    else requestAnimationFrame(() => textarea.current?.focus());
  };

  const answerActions = (turn: Turn) => <div className="cloud-agents-answer-actions">
    {(mobile || desktopEmbedded) && <AgentAnswerActions showLabel={desktopEmbedded} text={turn.answer}/>}
    {turn.status === "completed" && selected && <CloudAnswerNote key={(binding || "") + turn.id} thread={selected} turn={turn.id}/>}
    {mobile && !archived && turn.status === "completed" && <button type="button" onClick={followUp} disabled={Boolean(pending)}>继续追问</button>}
  </div>;

  const canContinueInLocal = Boolean(desktopEmbedded && onContinueInLocal && chatOpen && !settings && selected && (turns.length > 0 || current?.handoff?.state === "published"));

  const skillControls = <button type="button" onClick={openSkills}><Sparkles size={17}/>{selectedSkill || "技能"}</button>;

  const attachmentControls = (describe: boolean) => <>
    <label title="拍照"><Camera size={20}/>{describe && <span>相机</span>}
      <input type="file" aria-label="拍照" accept="image/*" capture="environment" disabled={attachDisabled} onChange={event => { void add(event.currentTarget.files); event.currentTarget.value = ""; }}/>
    </label>
    <label title="选择图片"><Image size={20}/>{describe && <span>照片</span>}
      <input type="file" aria-label="选择图片" accept="image/jpeg,image/png,image/webp" multiple disabled={attachDisabled} onChange={event => { void add(event.currentTarget.files); event.currentTarget.value = ""; }}/>
    </label>
    <label title="选择短视频"><Video size={20}/>{describe && <span>短视频</span>}
      <input type="file" aria-label="选择短视频" accept="video/*" disabled={attachDisabled} onChange={event => { void add(event.currentTarget.files, true); event.currentTarget.value = ""; }}/>
    </label>
    <button type="button" disabled={attachDisabled} onClick={() => { setSheet(undefined); setMaterialPicker(true); }}>
      <FileText size={20}/><span>{describe ? "选择已下载资料" : "资料"}{describe && <small>预览并加入一份正文</small>}</span>{describe && <ChevronRight size={16}/>}
    </button>
    {describe && <button type="button" onClick={openSkills}><Sparkles size={20}/><span>技能<small>查看方法，添加到消息</small></span><ChevronRight size={16}/></button>}
  </>;

  return <section className={`cloud-agents${mobile ? " is-mobile" : ""}${desktopEmbedded ? " is-desktop-embedded" : ""}`} aria-label="云端助手">
    {desktopEmbedded && <div className="cloud-agents-context-strip" role="region" aria-label="个人云端会话">
      <div className="cloud-agents-context-copy">
        <Cloud size={14} aria-hidden="true"/>
        <strong>{settings ? "个人云端 · 连接与设备" : current?.handoff ? (current.handoff.state === "withdrawn" ? "桌面交接 · 已撤回" : "桌面交接 · 个人云端会话") : "个人云端会话"}</strong>
        <span>{settings ? (connection ? connection.endpoint : "未连接个人 VPS") : current?.handoff?.state === "withdrawn" ? "已移除云端交接副本，历史回答仍可查看" : current?.handoff ? "桌面固定成果副本，手机与电脑可同步查看与续聊" : "云端与手机同步，可继续追问或带入本机"}</span>
      </div>
      <div className="cloud-agents-context-actions">
        {canContinueInLocal && <button type="button" className="cloud-agents-context-btn is-accent" onClick={() => onContinueInLocal?.({ threadId: selected!, title, text: buildLocalContinuation(title, turns, current?.handoff) })}>带入本机继续</button>}
        {onBackToLocal && <button type="button" className="cloud-agents-context-btn" onClick={onBackToLocal}>返回本机对话</button>}
      </div>
    </div>}
    {mobile && (sheet === "attachments" || materialPicker) && <CloudAgentSheet
      title={materialPicker ? "选择已下载资料" : "添加材料"}
      compact={!materialPicker} onClose={() => { setSheet(undefined); setMaterialPicker(false); }}>
      {materialPicker ? <CloudMaterialPicker embedded onClose={() => setMaterialPicker(false)} onConfirm={value => { setMaterial(value); setMaterialPicker(false); }}/> :
        <div className="cloud-agents-picker-rows">{attachmentControls(true)}</div>}
    </CloudAgentSheet>}
    {(sheet === "model" || sheet === "effort" || sheet === "usage") && <CloudAgentSheet title={sheet === "model" ? "选择模型" : sheet === "effort" ? "推理强度" : "订阅用量"} compact onClose={() => setSheet(undefined)} onBack={sheet !== "model" ? () => setSheet("model") : undefined}>
      <CloudModelPanel page={sheet} catalog={modelCatalog} account={account} selection={effectiveSelection} disabled={Boolean(pending) || busy}
        onSelect={value => { setModelSelection(value); setSheet(undefined); }} onPage={setSheet} onRefresh={() => refresh(value => value + 1)}/>
    </CloudAgentSheet>}
    {sheet === "skills" && <CloudSkillSheet skills={skills} chosen={chosenSkill} paths={skillPaths} bound={boundSkill || (localPending?.skill ? { name: localPending.skill.name, version: localPending.skill.version, paths: Object.keys(localPending.skill.files) } : undefined)} loadingError={skillError} onRetry={() => void showSkills()}
      onClose={() => setSheet(undefined)} onChoose={async (skill, paths = []) => { if (skill) await call("prepareSkill", {version:skill.methodVersion,paths}); setSkillVersion(skill?.methodVersion || ""); setSkillPaths(paths); setNotice(""); setSheet(undefined); }}/>}
    {preview && <CloudAgentSheet title={"data" in preview ? attachmentLabel(preview) : preview.title} compact onClose={() => setPreview(undefined)}>
      {"data" in preview ? <img className="cloud-agent-preview" src={asImage(preview)} alt={attachmentLabel(preview)}/> : <><small>{preview.source}</small><pre>{preview.text}</pre></>}
    </CloudAgentSheet>}
    {!mobile && materialPicker && <CloudMaterialPicker onClose={() => setMaterialPicker(false)} onConfirm={value => { setMaterial(value); setMaterialPicker(false); }}/>}
    <header className="cloud-agents-header">
      {mobile && settings ? <>
        <button type="button" onClick={closeSettings} aria-label="返回"><ArrowLeft size={21}/></button><div><h1>连接与设备</h1></div>
      </> : <>
        {connection && !mobile && <button type="button" onClick={showList} aria-label={mobile ? "返回会话列表" : "对话列表"}>{mobile ? <ArrowLeft size={21}/> : <PanelLeft size={20}/>}</button>}
        {mobile && chatOpen ? <button type="button" className="cloud-agents-header-title" onClick={showSettings} aria-label="查看云端连接与设备">
          <strong>云端助手</strong><span>{connectionLabel}</span>
        </button> : mobile && connection ? <button type="button" className="cloud-agents-header-title cloud-agents-home-connection" onClick={showSettings} aria-label={`查看连接与设备：${warning || connectionLabel}`}>
          <h1>云端助手</h1><span><Cloud size={13}/>{warning || connectionLabel}<ChevronRight size={13}/></span>
        </button> : <div><h1>{chatOpen ? title : mobile ? "云端助手" : "助手"}</h1><span>{connectionLabel}</span></div>}
        {connection && (!mobile || !chatOpen) && <button type="button" onClick={() => select()} disabled={busy || preparing} aria-label="新对话"><Plus size={22}/></button>}
        {connection && (!mobile || !chatOpen) && <button type="button" onClick={settings ? closeSettings : showSettings} disabled={busy || preparing} aria-label="VPS 连接设置"><Settings2 size={20}/></button>}
        {chatOpen && (mobile || known && management) && <details className="cloud-agents-menu"><summary aria-label="会话选项"><MoreHorizontal size={20}/></summary><div>
          {mobile && <button type="button" disabled={busy || preparing} onClick={event => { event.currentTarget.closest("details")!.open = false; select(); }}>新对话</button>}
          {known && management && <>
            <button type="button" disabled={updating} onClick={event => { event.currentTarget.closest("details")!.open = false; setRename(title); }}>重命名</button>
            <button type="button" disabled={updating || Boolean(active(last)) || Boolean(localPending)} onClick={event => { event.currentTarget.closest("details")!.open = false; void updateThread({ archived: !archived }); }}>{archived ? "恢复会话" : "归档会话"}</button>
          </>}
          {mobile && <button type="button" onClick={event => { event.currentTarget.closest("details")!.open = false; showSettings(); }}>连接与设备</button>}
        </div></details>}
        {onClose && (!mobile || !chatOpen) && <button type="button" onClick={onClose} aria-label="关闭云端助手"><X size={21}/></button>}
      </>}
    </header>
    {mobile && connection && chatOpen && !settings && <div className="bw-chat-tools">
      <button type="button" aria-label="返回会话列表" onClick={showList}><MessageSquare size={14}/><span>{title}</span><ChevronRight size={13}/></button>
      <button type="button" aria-label="配置会话模型" onClick={() => setSheet("model")}><span>{model}{effectiveSelection?.effort ? " · " + effortLabel(effectiveSelection.effort) : ""}</span><Settings2 size={13}/></button>
    </div>}
    {connection === undefined ? <p className="cloud-agents-empty" role="status">正在读取连接…</p> : !connection || settings ? <form className="cloud-agents-connect" onSubmit={event => void connect(event)}>
      <h2><Cloud size={22} /> 连接与设备</h2>
      {connection && <><p role="status">{connectionLabel}</p><p>{connection.endpoint}</p>{network && <p role="alert">{network}</p>}<small>{checkedAt ? `最近成功读取 ${new Date(checkedAt).toLocaleString()}` : "尚未取得本次连接状态"}</small>
        <button type="button" onClick={() => setSheet("usage")}>订阅用量</button>{pending && <p>有一条消息待核对。恢复连接后会查询原请求。</p>}<button type="button" onClick={closeSettings}>{initialSettings ? "返回语音速记" : "返回并重新读取"}</button>
      </>}
      <label>服务地址<input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://agents.example.com" required autoCapitalize="none" /></label>
      <label>设备密钥<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required /></label>
      <button className="cloud-agents-primary" disabled={busy}>{busy ? "正在连接…" : "连接"}</button>
      {notice && <p role="alert">{notice}</p>}
      {connection&&<CloudPendingHandoffs/>}
    </form> : !chatOpen ? <div ref={list} className="cloud-agents-home" onScroll={event => { listScroll.current = event.currentTarget.scrollTop; }}>
      <h2>你的云端对话</h2><p className="cloud-agents-lede">在手机上开始，随时接着聊。</p>
      {!mobile && <button type="button" className="cloud-agents-connection-card" onClick={showSettings}><Cloud size={21}/><span><strong>{warning || "个人云端"}</strong><small>{connectionLabel}</small></span><ChevronRight size={18}/></button>}
      <label className="cloud-agents-search"><Search size={20}/><input type="search" aria-label="搜索会话标题或消息" placeholder={management ? "搜索标题或消息" : "搜索会话标题"} maxLength={200} value={search} onChange={event => setSearch(event.target.value)}/></label>
      <div className="cloud-agents-scopes" aria-label="会话范围">{([ ["active", "当前", catalog.length - count], ["archived", "已归档", count], ["all", "全部", catalog.length] ] as const).map(([id,label,total]) => <button type="button" key={id} aria-pressed={scope === id} onClick={() => { setScope(id); listScroll.current = 0; }}>{label} {total}</button>)}</div>
      {(network || notice) && <p role="status" className="cloud-agents-notice">{notice || network} <button type="button" onClick={() => refresh(v => v + 1)}>重新读取</button></p>}
      {pending && <button type="button" className="cloud-agents-resume" onClick={() => select(pending.thread)}>有一条待确认消息 · 返回原会话</button>}
      <div className="cloud-agents-list-heading"><h3>会话</h3><button type="button" onClick={() => select()} disabled={busy || preparing}><Plus size={18}/>新对话</button></div>
      {catalogQuery !== query || search.trim() !== query ? <p role="status">{network ? "恢复连接后继续查找。" : "正在读取会话…"}</p> : rows.length ? <div className="cloud-agents-rows">{rows.map(item => <button type="button" key={item.id} className="cloud-agents-thread" onClick={() => select(item.id)}>
        <span className="cloud-agents-thread-icon">{item.archived ? <Archive size={20}/> : <MessageSquare size={20}/>}</span><span className="cloud-agents-thread-copy"><strong>{item.title}</strong><small>{item.status && active({ status: item.status }) ? statusText[item.status] : item.preview || "打开查看对话"}</small></span><span className="cloud-agents-thread-meta"><time dateTime={new Date(item.updated).toISOString()}>{stamp(item.updated)}</time><ChevronRight size={17}/></span>
      </button>)}</div> : <div className="cloud-agents-home-empty"><MessageSquare size={28}/><h3>{query ? "没有找到这段对话" : scope === "archived" ? "还没有归档会话" : "从一个问题开始"}</h3><p>{query ? "换一个词，或切换会话范围再试。" : scope === "archived" ? "归档只收起会话，消息和附件都会保留。" : "点击新对话，写下你的问题。"}</p></div>}
    </div> : <div className="cloud-agents-body">
      <div className="cloud-agents-chat">
        {mobile && <div className="cloud-agents-views" aria-label="会话视图">
          {([["chat", "对话"], ["materials", "材料"], ["results", "成果"]] as const).map(([id, label]) =>
            <button type="button" key={id} aria-pressed={view === id} onClick={() => changeView(id)}>{label}</button>)}
        </div>}
        {rename !== undefined && <form className="cloud-agents-rename" aria-label="重命名会话" onSubmit={event => { event.preventDefault(); void updateThread({ title: rename.trim() }); }}><label>会话名称<input autoFocus maxLength={80} value={rename} onChange={event => setRename(event.target.value)}/></label><button type="submit" disabled={updating || !rename.trim()}>保存名称</button><button type="button" disabled={updating} onClick={() => setRename(undefined)}>取消</button></form>}
        {archived && <div className="cloud-agents-archived"><span>这段会话已归档，消息和附件均保留。</span><button type="button" disabled={updating} onClick={() => void updateThread({ archived: false })}>恢复会话</button></div>}
        {warning && !displayedPending && <div className="cloud-agents-banner" role="status"><span>{warning}{network && activeTurn ? "，正在核对本轮进度" : ""}</span>
          <button type="button" onClick={network ? () => refresh(value => value + 1) : showSettings}>{network ? "重新读取" : "查看连接"}</button>
        </div>}
        {notice && <p className="cloud-agents-notice" role="status">{notice}</p>}
        <div ref={scroll} className="cloud-agents-messages" role="log" aria-label="会话消息" aria-live="off" hidden={view !== "chat"} onScroll={event => {
          const el = event.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        }}>
          {(before === undefined ? current?.before : before) && <button type="button" disabled={loadingEarlier} onClick={() => void loadEarlier()}>查看更早消息</button>}
          {current?.handoff&&<CloudHandoffPanel handoff={current.handoff} compact={mobile} onOpen={()=>changeView("results")} onWithdraw={()=>{if(current.handoff)onHandoffStateChangeRef.current?.({...current.handoff,state:"withdrawn"},{cached:false});refresh(v=>v+1);}}/>}
          {turns.length === 0 && !displayedPending && !current?.handoff && (selected && known ? <p className="cloud-agents-empty" role="status">正在读取对话…</p> :
            <div className="cloud-agents-empty">
              {mobile && <span className="cloud-agents-empty-icon"><Sparkles size={27}/></span>}
              <h2>{mobile ? "从一个问题开始" : "新对话"}</h2>
              {mobile && <p>{material || attachments.length ? "材料已放好。想从哪里开始看？" : "写下想法，或带上一张照片、几条资料。"}</p>}
              {mobile && !archived && <button type="button" onClick={() => setSheet("attachments")} disabled={attachDisabled}><Image size={17}/>试试图片提问</button>}
            </div>)}
          {turns.map(turn => <article key={turn.id} className="cloud-agents-turn">
            <div className="cloud-agents-user-message">
              {(mobile || desktopEmbedded) && turn.created && <div className="cloud-agents-metadata"><span>你</span><time dateTime={new Date(turn.created).toISOString()}>{stamp(turn.created)}</time></div>}
              <div className="cloud-agents-user">
                {turn.text && <div>{turn.text}</div>}
                {turn.material && materialButton(turn.material)}
                {turn.attachments.map((file, index) => <AttachmentPreview key={file.id} file={file} local={confirmedUpload?.turn === turn.id ? confirmedUpload.attachments[index] : undefined} onAttachToLocal={desktopEmbedded ? onAttachImageToLocal : undefined}/>)}
              </div>
            </div>
            <div className="cloud-agents-answer">
              {mobile && <div className="cloud-agents-metadata"><Sparkles size={15}/><strong>Hub</strong></div>}
              {(mobile || (desktopEmbedded && (active(turn) || (turn.progress?.summary?.length ?? 0) > 0 || (turn.progress?.updates?.length ?? 0) > 0))) && <RunProgress turn={turn} waitingToStop={waitingToStop === turn.id && Boolean(active(turn))}/>}
              {turn.answer ? markdown(turn.answer) : !mobile && !desktopEmbedded && active(turn) && <p className="cloud-agents-answer-state" role="status">{waitingToStop === turn.id ? statusText.stopping : statusText[turn.status]}</p>}
              {mobile && turn.material && turn.answer.includes("[资料1]") && <div className="cloud-agents-citation">{materialButton(turn.material)}</div>}
              {!active(turn) && turn.status !== "completed" && <p className="cloud-agents-answer-state" role="status">{turn.error || statusText[turn.status]}</p>}
              {turn.answer && !active(turn) && answerActions(turn)}
            </div>
          </article>)}
          {displayedPending && <article className="cloud-agents-turn is-pending">
            <div className="cloud-agents-user-message">
              <div className="cloud-agents-metadata"><span>你</span>{displayedPending.created && <time dateTime={new Date(displayedPending.created).toISOString()}>{stamp(displayedPending.created)}</time>}</div>
              <div className="cloud-agents-user">
                {displayedPending.text && <div>{displayedPending.text}</div>}
                {displayedPending.material && materialButton(displayedPending.material)}
                {draftFiles(displayedPending.attachments)}
              </div>
            </div>
            <div className="cloud-agents-delivery">
              <p role="status">
                {(deliveryPhase === "sending" || deliveryPhase === "accepted") && <LoaderCircle size={15} className="cloud-agents-spinner"/>}
                {deliveryPhase === "sending" ? displayedPending.attachments.length ? "正在上传附件…" : "正在发送…" :
                  deliveryPhase === "accepted" ? statusText.queued :
                  deliveryPhase === "rejected" ? delivery?.error || "个人云端未接收这条消息。" :
                  network ? "连接不稳定 · 恢复后继续查询原请求" : "正在确认是否送达 · 消息已保存在此设备"}
              </p>
              {(deliveryPhase === "rejected" || deliveryPhase === "checking") && !busy && <div className="cloud-agents-pending">
                {deliveryPhase === "checking" && <button type="button" onClick={() => refresh(value => value + 1)}>查询原结果</button>}
                <button type="button" onClick={() => void send()}>用原编号重试</button>
                <button type="button" onClick={() => {
                  if (deliveryPhase === "rejected" || window.confirm("移除本机的重试记录？云端可能已接收这条消息。")) void releasePending();
                }}>{deliveryPhase === "rejected" ? "放回输入框" : "移除本机重试"}</button>
              </div>}
            </div>
          </article>}
        </div>
        {mobile && view === "materials" && <div className="cloud-agents-panel" aria-label="会话材料">
          {(attachments.length > 0 || material) && <section className="cloud-agents-panel-card"><h2>待发送</h2>{material && materialButton(material)}{draftFiles(attachments)}</section>}
          {displayedPending && (displayedPending.attachments.length > 0 || displayedPending.material) &&
            <section className="cloud-agents-panel-card"><h2>{deliveryPhase === "accepted" ? "云端已接收" : "待确认"}</h2>{displayedPending.material && materialButton(displayedPending.material)}{draftFiles(displayedPending.attachments)}</section>}
          {turns.filter(turn => turn.material || turn.attachments.length).map(turn => <section className="cloud-agents-panel-card" key={turn.id}>
            <h2>{turn.text.slice(0, 48) || "附件"}{turn.created && <time>{stamp(turn.created)}</time>}</h2>
            {turn.material && materialButton(turn.material)}
            {turn.attachments.map((file, index) => <AttachmentPreview key={file.id} file={file} local={confirmedUpload?.turn === turn.id ? confirmedUpload.attachments[index] : undefined}/>)}
          </section>)}
          {!(attachments.length || material || displayedPending?.attachments.length || displayedPending?.material || turns.some(turn => turn.material || turn.attachments.length)) &&
            <div className="cloud-agents-empty"><FileText size={27}/><h2>还没有附上材料</h2><p>已选资料、图片和视频关键帧会显示在这里。</p></div>}
          {!archived && <button className="cloud-agents-add-material" type="button" disabled={attachDisabled} onClick={() => setSheet("attachments")}><Plus size={17}/>添加材料</button>}
          {(before === undefined ? current?.before : before) && <button type="button" disabled={loadingEarlier} onClick={() => void loadEarlier()}>查看更早材料</button>}
        </div>}
        {mobile && view === "results" && <div className="cloud-agents-panel" aria-label="会话成果">
          {current?.handoff&&<CloudHandoffPanel handoff={current.handoff} onWithdraw={()=>{if(current.handoff)onHandoffStateChangeRef.current?.({...current.handoff,state:"withdrawn"},{cached:false});refresh(v=>v+1);}}/>}
          {turns.filter(turn => turn.status === "completed" && turn.answer).reverse().map(turn => <article className="cloud-agents-panel-card cloud-agents-answer" key={turn.id}>
            <h2>{turn.text.slice(0, 48) || title}{turn.created && <time>{stamp(turn.created)}</time>}</h2>{markdown(turn.answer)}{answerActions(turn)}
          </article>)}
          {!current?.handoff&&!turns.some(turn => turn.status === "completed" && turn.answer) && <div className="cloud-agents-empty"><FileText size={27}/><h2>完成的回答会留在这里</h2><button type="button" onClick={() => changeView("chat")}>回到对话</button></div>}
          {(before === undefined ? current?.before : before) && <button type="button" disabled={loadingEarlier} onClick={() => void loadEarlier()}>查看更早成果</button>}
        </div>}
        {view === "chat" && (!mobile || !archived) && <form className="cloud-agents-compose" onSubmit={event => void send(event)}>
          {!mobile && skillControls}
          {selectedSkill && <div className="cloud-agents-skill-chip"><button type="button" onClick={openSkills}><Sparkles size={15}/><span>{selectedSkill}</span><small>{boundSkill ? "本对话" : skillPaths.length ? `${skillPaths.length} 份参考` : ""}</small></button>{!boundSkill && !localPending && <button type="button" aria-label="移除待发送技能" onClick={() => { setSkillVersion(""); setSkillPaths([]); }}><X size={15}/></button>}</div>}
          {pending && pending.thread !== selected && <button type="button" className="cloud-agents-resume" onClick={() => select(pending.thread)}>返回待确认消息</button>}
          {material && <div className="cloud-agents-draft-material">{materialButton(material)}<button type="button" className="cloud-agents-remove" aria-label="移除本次资料" onClick={() => setMaterial(undefined)}><X size={14}/></button></div>}
          {mobile && (attachments.length>0||material) && <small className="cloud-agents-pending-count">待发送材料 {attachments.length+Number(Boolean(material))} 份</small>}
          {draftFiles(attachments, true)}
          {attachments.some(file => file.seconds != null) && <small>将发送带时间戳的关键帧，短暂变化可能漏掉。</small>}
          <textarea ref={textarea} value={text} onChange={event => setText(event.target.value)} disabled={attachDisabled} maxLength={20000} placeholder={handoffWithdrawn?"交接已撤回，可新建其他对话":archived ? "恢复会话后可继续提问" : "问一个问题，或接着聊…"} aria-label="消息" rows={mobile ? 1 : 2}/>
          <div className="cloud-agents-tools">
            {mobile ? <>
              <button type="button" aria-label="添加照片或资料" aria-haspopup="dialog" disabled={attachDisabled} onClick={() => setSheet("attachments")}><Plus size={22}/></button>
              <button type="button" aria-label="选择模型" aria-haspopup="dialog" className="cloud-agents-model" onClick={() => setSheet("model")}><span>{model}{effectiveSelection?.effort ? ` · ${effortLabel(effectiveSelection.effort)}` : ""}</span><ChevronRight size={14}/></button>
            </> : <>
              {attachmentControls(false)}
              {desktopEmbedded && modelCatalog && <button type="button" aria-label="选择云端模型" aria-haspopup="dialog" className="cloud-agents-model" onClick={() => setSheet("model")}><span>{model}{effectiveSelection?.effort ? ` · ${effortLabel(effectiveSelection.effort)}` : ""}</span><ChevronRight size={14}/></button>}
            </>}
            {preparing && <small role="status">正在处理附件…</small>}
            {activeTurn ? <button type="button" className="cloud-agents-primary" aria-label="停止生成" disabled={stopPending} onClick={() => void stop(activeTurn)}><Square size={17}/></button> :
              <button type="submit" className="cloud-agents-primary" aria-label="发送" disabled={attachDisabled || (!text.trim() && !attachments.length && !material)}><ArrowUp size={21}/></button>}
          </div>
        </form>}
      </div>
    </div>}
  </section>;
}
