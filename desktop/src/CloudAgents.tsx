import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Archive, ArrowLeft, ArrowUp, Camera, Check, ChevronRight, Clock3, Cloud, FileText, Image, Info, LoaderCircle, MessageSquare, MoreHorizontal, PanelLeft, Plus, Search, Settings2, Sparkles, Square, Video, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import { imageUpload, outbox, uploadSize, videoUploads, type CloudSkillPayload, type DraftTurn, type Upload, type MaterialSnapshot } from "./CloudAgentMedia";
import "./CloudAgents.css";
import { CloudAgentSheet, CloudAnswerNote, CloudMaterialPicker } from "./CloudAgentMaterials";
import { AgentAnswerActions } from "./AgentAnswerActions";
import { runtimeCapabilities } from "./RuntimePlatform";

type Connection = { endpoint: string; binding: string };
type Account = { state: "unknown" | "ready" | "login" | "quota"; plan?: string; model?: string; limits?: { usedPercent?: number; windowDurationMins?: number }[] };
type Summary = { id: string; title: string; updated: number; archived?: boolean; preview?: string; status?: Turn["status"]; matches?: boolean };
type Attachment = { id: string; name: string; seconds?: number | null };
type Progress = { startedAt?: number; finishedAt?: number; summary?: string[]; updates?: string[] };
type Turn = { id: string; seq: number; created?: number; text: string; answer: string; error?: string; status: "queued" | "running" | "stopping" | "completed" | "failed" | "stopped"; attachments: Attachment[]; material?: MaterialSnapshot; progress?: Progress };
type Thread = Summary & { turns: Turn[]; before: number | null; skill?: { name: string; version: string; paths: string[] } | null };
type SkillChoice = { name: string; title: string; methodVersion: string; paths: string[] };
type Snapshot = { thread: Thread | null; account?: Account };
type Delivery = { turn: string; phase: "sending" | "checking" | "accepted" | "rejected"; error?: string };
type ChatView = "chat" | "materials" | "results";
const active = (turn?: Pick<Turn, "status">) => turn && ["queued", "running", "stopping"].includes(turn.status);
const statusText = { queued: "云端已接收，等待执行", running: "正在回复", stopping: "等待停止确认", completed: "已完成", failed: "未完成", stopped: "已停止" };
const call = <T,>(op: string, fields: Record<string, unknown> = {}) => invoke<T>("cloud_agents", { action: { op, ...fields } });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const attachmentLabel = (file: { name: string; seconds?: number | null }) => file.seconds == null ? file.name : `${file.name} · ${file.seconds.toFixed(2)} 秒`;
const asImage = (file: Upload) => `data:${file.mime};base64,${file.data}`;
const stamp = (value: number) => new Date(value).toLocaleString("zh-CN", new Date(value).toDateString() === new Date().toDateString() ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric" });

function AttachmentPreview({ file, local }: { file: Attachment; local?: Upload }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
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
      {local || url ? <img className="cloud-agent-preview" src={local ? asImage(local) : url} alt={attachmentLabel(file)} /> :
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

export default function CloudAgents({ onClose }: { onClose?: () => void }) {
  const mobile = runtimeCapabilities.mobile;
  const [connection, setConnection] = useState<Connection | null>();
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [settings, setSettings] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [view, setView] = useState<ChatView>("chat");
  const [sheet, setSheet] = useState<"attachments" | "model">();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [catalogQuery, setCatalogQuery] = useState<string>();
  const [scope, setScope] = useState<"active" | "archived" | "all">("active");
  const [management, setManagement] = useState(false);
  const [rename, setRename] = useState<string>();
  const [updating, setUpdating] = useState(false);
  const [catalog, setCatalog] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [snapshot, setSnapshot] = useState<Thread>();
  const [earlier, setEarlier] = useState<Turn[]>([]);
  const [before, setBefore] = useState<number | null>();
  const [account, setAccount] = useState<Account>();
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
  const drafts = useRef(new Map<string, { text: string; attachments: Upload[]; material?:MaterialSnapshot; skillVersion: string; skillPaths: string[] }>());
  const current = snapshot?.id === selected ? snapshot : undefined;
  const last = current?.turns[current.turns.length - 1];
  const binding = connection?.binding;
  const known = Boolean(current || selected && catalog.some(item => item.id === selected));
  const localPending = pending?.thread === selected ? pending : undefined;
  const displayedPending = localPending && !current?.turns.some(turn => turn.id === localPending.turn) ? localPending : undefined;
  const deliveryPhase = delivery?.turn === pending?.turn ? delivery?.phase : "checking";
  const chosenSkill = skills?.find(skill => skill.methodVersion === skillVersion);
  const boundSkill = current?.skill;
  const archived = Boolean(current?.archived ?? catalog.find(item => item.id === selected)?.archived);

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
      setChatOpen(Boolean(window.history.state?.hubCloudAgentChat));
      if (!window.history.state?.hubCloudAgentChat) setView("chat");
      setSettings(Boolean(window.history.state?.hubCloudAgentSettings));
      setRename(undefined);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [mobile]);

  async function showSkills() {
    try {
      const latest = await call<SkillChoice[]>("skillVersions");
      setSkills(current => {
        const pinned = current?.find(item => item.methodVersion === skillVersion);
        return pinned && !latest.some(item => item.methodVersion === pinned.methodVersion) ? [...latest, pinned] : latest;
      });
    }
    catch (error) { setNotice(errorText(error)); }
  }

  useEffect(() => {
    let live = true;
    void call<Connection | null>("config").then(value => {
      if (live) { setConnection(value); setEndpoint(value?.endpoint ?? ""); }
    }).catch(error => { if (live) { setConnection(null); setNotice(errorText(error)); } });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!binding) return;
    let live = true;
    void outbox(binding).then(saved => {
      if (live && saved) { setPending(saved); select(saved.thread); }
    }).catch(() => { if (live) setNotice("无法读取本机待重试的消息。"); });
    return () => { live = false; };
  }, [binding]);

  useEffect(() => {
    if (!binding || settings) return;
    const outboxKey = binding;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let nextList = 0;
    let missed = 0;
    async function sync() {
      const selectedThread = chatOpen && selected && known ? selected : undefined;
      const threads = [...new Set([selectedThread, pending?.thread].filter((id): id is string => Boolean(id)))];
      let running = false;
      const readList = Date.now() >= nextList ? [call<{ threads: Summary[]; account: Account; threadManagement?: boolean }>("list", { query }).then(data => {
        if (!live) return;
        setCatalog(data.threads);
        setManagement(Boolean(data.threadManagement));
        setCatalogQuery(query);
        if (!threads.length) setAccount(data.account);
        nextList = Date.now() + 4500;
      })] : [];
      const reads = threads.map(thread => call<Snapshot>("read", {
        thread, missing: thread === pending?.thread && thread !== selectedThread,
      }).then(data => {
        if (!live) return;
        const result = data.thread;
        if (!result) return;
        if (thread === selected) setSnapshot(result);
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
        setNetwork("");
        setCheckedAt(Date.now());
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

  function select(id?: string, sent = false) {
    drafts.current.set(selected ?? "new", sent ? { text: "", attachments: [], skillVersion: "", skillPaths: [] } : { text, attachments, material, skillVersion, skillPaths });
    const draft = sent ? undefined : drafts.current.get(id ?? "new");
    setText(draft?.text ?? ""); setAttachments(draft?.attachments ?? []); setMaterial(draft?.material); setMaterialPicker(false);
    setSkillVersion(draft?.skillVersion ?? ""); setSkillPaths(draft?.skillPaths ?? []);
    follow.current = true;
    setSelected(id);
    setEarlier([]);
    setBefore(undefined);
    setChatOpen(true); setView("chat"); setSettings(false); setRename(undefined);
    setSheet(undefined); setPreview(undefined);
    if (mobile && !window.history.state?.hubCloudAgentChat) {
      window.history.pushState({ ...(window.history.state ?? {}), hubCloudAgentChat: true }, "");
    }
    setNotice("");
  }

  function showList() {
    setSettings(false); setRename(undefined); setChatOpen(false); setView("chat");
    if (mobile && window.history.state?.hubCloudAgentChat) window.history.back();
  }

  function showSettings() {
    setNotice("");
    if (mobile && !window.history.state?.hubCloudAgentSettings) {
      window.history.pushState({ ...(window.history.state ?? {}), hubCloudAgentSettings: true }, "");
    }
    setSettings(true);
  }

  function closeSettings() {
    setSettings(false);
    if (mobile && window.history.state?.hubCloudAgentSettings) window.history.back();
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
        if (mobile && window.history.state?.hubCloudAgentSettings && window.history.state?.hubCloudAgentChat) {
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
    if (!binding || sending.current || preparing || archived || (deliveryPhase === "accepted" && pending) ||
      (pending && pending.thread !== selected) || (!pending && (!text.trim() && !attachments.length && !material || active(last)))) return;
    sending.current = true;
    setBusy(true);
    setNotice("");
    let sendingTurn: string | undefined;
    try {
      const skill = !pending && chosenSkill && !boundSkill
        ? await call<CloudSkillPayload>("prepareSkill", { version: chosenSkill.methodVersion, paths: skillPaths })
        : undefined;
      const draft = pending ?? { thread: selected ?? crypto.randomUUID(), turn: crypto.randomUUID(), text: text.trim(), attachments, skill, material, created: Date.now() };
      if (!pending) {
        await outbox(binding, draft);
        setPending(draft);
        setText(""); setAttachments([]); setMaterial(undefined);
      }
      if (selected !== draft.thread) select(draft.thread, true);
      drafts.current.delete(draft.thread);
      follow.current = true;
      sendingTurn = draft.turn;
      setDelivery({ turn: draft.turn, phase: "sending" });
      const receipt = await call<{ id?: string; delivery?: "accepted" | "rejected" | "unknown"; error?: string }>("send", {
        thread: draft.thread, turn: draft.turn,
        message: { text: draft.text, attachments: draft.attachments, ...(draft.skill && { skill: draft.skill }), ...(draft.material && { material: draft.material }) },
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

  const connectionLabel = network ? "连接中断" : account?.state === "login" ? "VPS 需要登录" : account?.state === "quota" ? "Codex 额度受限" : account?.state === "ready" ? [account.model || "Codex", account.plan].filter(Boolean).join(" · ") : connection ? "已配置 VPS" : "云端对话";
  const turns = [...earlier.filter(item => !current?.turns.some(turn => turn.id === item.id)), ...(current?.turns ?? [])];
  const count = catalog.filter(item => item.archived).length;
  const rows = catalog.filter(item => (scope === "all" || Boolean(item.archived) === (scope === "archived")) &&
    (management ? item.matches : item.title.toLowerCase().includes(query.toLowerCase())));

  const title = selected ? current?.title || catalog.find(item => item.id === selected)?.title ||
    localPending?.text.slice(0, 48) || (localPending?.attachments.length ? "附件对话" : "对话") : "新对话";
  const activeTurn = active(last) ? last?.id : deliveryPhase === "accepted" ? displayedPending?.turn : undefined;
  const stopPending = Boolean(activeTurn && (activeTurn === waitingToStop || last?.status === "stopping"));
  const warning = account?.state === "login" ? "ChatGPT 登录已失效" : account?.state === "quota" ? "订阅额度不足" : network ? "暂时连不上个人云端" : "";
  const attachDisabled = busy || preparing || archived || Boolean(pending);
  const model = account?.model || "Codex";

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

  const markdown = (answer: string) => <ReactMarkdown skipHtml components={{
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
    {mobile && <AgentAnswerActions text={turn.answer}/>}
    {turn.status === "completed" && selected && <CloudAnswerNote key={(binding || "") + turn.id} thread={selected} turn={turn.id}/>}
    {mobile && !archived && turn.status === "completed" && <button type="button" onClick={followUp} disabled={Boolean(pending)}>继续追问</button>}
  </div>;

  const skillControls = boundSkill ? <details><summary>本对话固定技能 · {boundSkill.name}</summary><small>{boundSkill.version}</small><ul>{boundSkill.paths.map(path => <li key={path}>{path}</li>)}</ul></details>
    : !pending && <details onToggle={event => { if (event.currentTarget.open) void showSkills(); }}>
      <summary>固定技能{chosenSkill ? ` · ${chosenSkill.title}` : ""}</summary>
      {skills?.length ? <><label>技能 <select value={skillVersion} onChange={event => { setSkillVersion(event.target.value); setSkillPaths([]); }}>
        <option value="">不使用技能</option>
        {skills.map(item => <option key={item.methodVersion} value={item.methodVersion}>{item.title}</option>)}
      </select></label>
        {chosenSkill && <div><small>选入本次需要发送到 VPS 的配套文字文件。该版本将在这段对话中继续使用。</small>
          {chosenSkill.paths.map(path => <label key={path}><input type="checkbox" checked={skillPaths.includes(path)} onChange={event => setSkillPaths(old => event.target.checked ? [...old, path] : old.filter(value => value !== path))}/>{path}</label>)}</div>}</>
      : <small>{skills ? "本机暂无适合云端运行的已保存文字技能。" : "正在读取本机技能…"}</small>}
    </details>;
  const quota = account?.state === "ready" && account.limits?.some(limit => typeof limit.usedPercent === "number") &&
    <small className="cloud-agents-quota">额度已用 {account.limits.filter(limit => typeof limit.usedPercent === "number").map(limit => `${limit.usedPercent}%${limit.windowDurationMins ? `（${limit.windowDurationMins} 分钟）` : ""}`).join(" / ")}</small>;

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
  </>;

  return <section className={`cloud-agents${mobile ? " is-mobile" : ""}`} aria-label="云端 Agents">
    {mobile && (sheet === "attachments" || materialPicker) && <CloudAgentSheet
      title={materialPicker ? "选择已下载资料" : "添加材料"}
      compact={!materialPicker} onClose={() => { setSheet(undefined); setMaterialPicker(false); }}>
      {materialPicker ? <CloudMaterialPicker embedded onClose={() => setMaterialPicker(false)} onConfirm={value => { setMaterial(value); setMaterialPicker(false); }}/> :
        <div className="cloud-agents-picker-rows">{attachmentControls(true)}</div>}
    </CloudAgentSheet>}
    {sheet === "model" && <CloudAgentSheet title="模型与技能" compact onClose={() => setSheet(undefined)}>
      <div className="cloud-agents-model-current"><div><strong>{model}</strong><small>{account?.plan ? `ChatGPT · ${account.plan}` : "个人云端"}</small></div><Check size={18}/></div>
      {quota}{skillControls}
    </CloudAgentSheet>}
    {preview && <CloudAgentSheet title={"data" in preview ? attachmentLabel(preview) : preview.title} compact onClose={() => setPreview(undefined)}>
      {"data" in preview ? <img className="cloud-agent-preview" src={asImage(preview)} alt={attachmentLabel(preview)}/> : <><small>{preview.source}</small><pre>{preview.text}</pre></>}
    </CloudAgentSheet>}
    {!mobile && materialPicker && <CloudMaterialPicker onClose={() => setMaterialPicker(false)} onConfirm={value => { setMaterial(value); setMaterialPicker(false); }}/>}
    <header className="cloud-agents-header">
      {mobile && settings ? <>
        <button type="button" onClick={closeSettings} aria-label="返回"><ArrowLeft size={21}/></button><div><h1>连接与设备</h1></div>
      </> : <>
        {connection && (!mobile || chatOpen) && <button type="button" onClick={showList} aria-label={mobile ? "返回会话列表" : "对话列表"}>{mobile ? <ArrowLeft size={21}/> : <PanelLeft size={20}/>}</button>}
        {mobile && chatOpen ? <button type="button" className="cloud-agents-header-title" onClick={showSettings} aria-label="查看云端连接与设备">
          <strong>{title}</strong><span>{connectionLabel}</span>
        </button> : <div><h1>{chatOpen ? title : "Agents"}</h1><span>{connectionLabel}</span></div>}
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
        {onClose && (!mobile || !chatOpen) && <button type="button" onClick={onClose} aria-label="关闭云端 Agents"><X size={21}/></button>}
      </>}
    </header>
    {connection === undefined ? <p className="cloud-agents-empty" role="status">正在读取连接…</p> : !connection || settings ? <form className="cloud-agents-connect" onSubmit={event => void connect(event)}>
      <h2><Cloud size={22} /> 连接与设备</h2>
      {connection && <><p role="status">{connectionLabel}</p><p>{connection.endpoint}</p>{network && <p role="alert">{network}</p>}<small>{checkedAt ? `最近成功读取 ${new Date(checkedAt).toLocaleString()}` : "尚未取得本次连接状态"}</small>
        {quota}{pending && <p>有一条消息待核对。恢复连接后会查询原请求。</p>}<button type="button" onClick={closeSettings}>返回并重新读取</button>
      </>}
      <label>服务地址<input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://agents.example.com" required autoCapitalize="none" /></label>
      <label>设备密钥<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required /></label>
      <button className="cloud-agents-primary" disabled={busy}>{busy ? "正在连接…" : "连接"}</button>
      {notice && <p role="alert">{notice}</p>}
    </form> : !chatOpen ? <div ref={list} className="cloud-agents-home" onScroll={event => { listScroll.current = event.currentTarget.scrollTop; }}>
      <h2>你的云端对话</h2><p className="cloud-agents-lede">在手机上开始，随时接着聊。</p>
      <button type="button" className="cloud-agents-connection-card" onClick={showSettings}><Cloud size={21}/><span><strong>{warning || "个人云端"}</strong><small>{connectionLabel}</small></span><ChevronRight size={18}/></button>
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
            <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}
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
          {turns.length === 0 && !displayedPending && (selected && known ? <p className="cloud-agents-empty" role="status">正在读取对话…</p> :
            <div className="cloud-agents-empty">
              {mobile && <span className="cloud-agents-empty-icon"><Sparkles size={27}/></span>}
              <h2>{mobile ? "从一个问题开始" : "新对话"}</h2>
              {mobile && <p>{material || attachments.length ? "材料已放好。想从哪里开始看？" : "写下想法，或带上一张照片、几条资料。"}</p>}
              {mobile && !archived && <button type="button" onClick={() => setSheet("attachments")} disabled={attachDisabled}><Image size={17}/>试试图片提问</button>}
            </div>)}
          {turns.map(turn => <article key={turn.id} className="cloud-agents-turn">
            <div className="cloud-agents-user-message">
              {mobile && turn.created && <div className="cloud-agents-metadata"><span>你</span><time dateTime={new Date(turn.created).toISOString()}>{stamp(turn.created)}</time></div>}
              <div className="cloud-agents-user">
                {turn.text && <div>{turn.text}</div>}
                {turn.material && materialButton(turn.material)}
                {turn.attachments.map((file, index) => <AttachmentPreview key={file.id} file={file} local={confirmedUpload?.turn === turn.id ? confirmedUpload.attachments[index] : undefined}/>)}
              </div>
            </div>
            <div className="cloud-agents-answer">
              {mobile && <div className="cloud-agents-metadata"><Sparkles size={15}/><strong>Hub</strong></div>}
              {mobile && <RunProgress turn={turn} waitingToStop={waitingToStop === turn.id && Boolean(active(turn))}/>}
              {turn.answer ? markdown(turn.answer) : !mobile && active(turn) && <p className="cloud-agents-answer-state" role="status">{waitingToStop === turn.id ? statusText.stopping : statusText[turn.status]}</p>}
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
          {turns.filter(turn => turn.status === "completed" && turn.answer).reverse().map(turn => <article className="cloud-agents-panel-card cloud-agents-answer" key={turn.id}>
            <h2>{turn.text.slice(0, 48) || title}{turn.created && <time>{stamp(turn.created)}</time>}</h2>{markdown(turn.answer)}{answerActions(turn)}
          </article>)}
          {!turns.some(turn => turn.status === "completed" && turn.answer) && <div className="cloud-agents-empty"><FileText size={27}/><h2>完成的回答会留在这里</h2><button type="button" onClick={() => setView("chat")}>回到对话</button></div>}
          {(before === undefined ? current?.before : before) && <button type="button" disabled={loadingEarlier} onClick={() => void loadEarlier()}>查看更早成果</button>}
        </div>}
        {view === "chat" && (!mobile || !archived) && <form className="cloud-agents-compose" onSubmit={event => void send(event)}>
          {!mobile && <>{skillControls}{quota}</>}
          {pending && pending.thread !== selected && <button type="button" className="cloud-agents-resume" onClick={() => select(pending.thread)}>返回待确认消息</button>}
          {material && <div className="cloud-agents-draft-material">{materialButton(material)}<button type="button" className="cloud-agents-remove" aria-label="移除本次资料" onClick={() => setMaterial(undefined)}><X size={14}/></button></div>}
          {draftFiles(attachments, true)}
          {attachments.some(file => file.seconds != null) && <small>将发送带时间戳的关键帧，短暂变化可能漏掉。</small>}
          <textarea ref={textarea} value={text} onChange={event => setText(event.target.value)} disabled={archived || busy || Boolean(pending)} maxLength={20000} placeholder={archived ? "恢复会话后可继续提问" : "问一个问题，或接着聊…"} aria-label="消息" rows={mobile ? 1 : 2}/>
          <div className="cloud-agents-tools">
            {mobile ? <>
              <button type="button" aria-label="添加照片或资料" aria-haspopup="dialog" disabled={attachDisabled} onClick={() => setSheet("attachments")}><Plus size={22}/></button>
              <button type="button" aria-label="查看模型与技能" aria-haspopup="dialog" className="cloud-agents-model" onClick={() => setSheet("model")}><span>{model}</span><Info size={14}/></button>
            </> : attachmentControls(false)}
            {preparing && <small role="status">正在处理附件…</small>}
            {activeTurn ? <button type="button" className="cloud-agents-primary" aria-label="停止生成" disabled={stopPending} onClick={() => void stop(activeTurn)}><Square size={17}/></button> :
              <button type="submit" className="cloud-agents-primary" aria-label="发送" disabled={attachDisabled || (!text.trim() && !attachments.length && !material)}><ArrowUp size={21}/></button>}
          </div>
        </form>}
      </div>
    </div>}
  </section>;
}
