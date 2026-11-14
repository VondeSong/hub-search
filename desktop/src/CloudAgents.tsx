import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Archive, ArrowUp, Camera, ChevronRight, Cloud, Image, MessageSquare, MoreHorizontal, PanelLeft, Plus, Search, Settings2, Square, Video, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import { imageUpload, outbox, uploadSize, videoUploads, type CloudSkillPayload, type DraftTurn, type Upload } from "./CloudAgentMedia";
import "./CloudAgents.css";
import { runtimeCapabilities } from "./RuntimePlatform";

type Connection = { endpoint: string; binding: string };
type Account = { state: "unknown" | "ready" | "login" | "quota"; plan?: string; model?: string; limits?: { usedPercent?: number; windowDurationMins?: number }[] };
type Summary = { id: string; title: string; updated: number; archived?: boolean; preview?: string; status?: Turn["status"]; matches?: boolean };
type Attachment = { id: string; name: string; seconds?: number | null };
type Turn = { id: string; seq: number; text: string; answer: string; error?: string; status: "queued" | "running" | "stopping" | "completed" | "failed" | "stopped"; attachments: Attachment[] };
type Thread = Summary & { turns: Turn[]; before: number | null; skill?: { name: string; version: string; paths: string[] } | null };
type SkillChoice = { name: string; title: string; methodVersion: string; paths: string[] };
const active = (turn?: Pick<Turn, "status">) => turn && ["queued", "running", "stopping"].includes(turn.status);
const statusText = { queued: "VPS 已接收", running: "正在回答", stopping: "正在停止", completed: "", failed: "未完成", stopped: "已停止" };
const call = <T,>(op: string, fields: Record<string, unknown> = {}) => invoke<T>("cloud_agents", { action: { op, ...fields } });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const attachmentLabel = (file: { name: string; seconds?: number | null }) => file.seconds == null ? file.name : `${file.name} · ${file.seconds.toFixed(2)} 秒`;

function AttachmentPreview({ file }: { file: Attachment }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function toggle() {
    if (url) { setUrl(""); return; }
    setError("");
    setLoading(true);
    try { setUrl((await call<{ url: string }>("attachment", { id: file.id })).url); }
    catch (failure) { setError(errorText(failure)); }
    finally { setLoading(false); }
  }
  return <div className="cloud-agent-attachment">
    <button type="button" onClick={() => void toggle()} disabled={loading} aria-expanded={Boolean(url)}><Image size={15} />{attachmentLabel(file)}</button>
    {url && <img src={url} alt={attachmentLabel(file)} />}
    {error && <small role="alert">{error}</small>}
  </div>;
}

export default function CloudAgents({ onClose }: { onClose?: () => void }) {
  const [connection, setConnection] = useState<Connection | null>();
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [settings, setSettings] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
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
  const [skills, setSkills] = useState<SkillChoice[]>();
  const [skillVersion, setSkillVersion] = useState("");
  const [skillPaths, setSkillPaths] = useState<string[]>([]);
  const [pending, setPending] = useState<DraftTurn>();
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [syncVersion, refresh] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const sending = useRef(false);
  const listScroll = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const drafts = useRef(new Map<string, { text: string; attachments: Upload[]; skillVersion: string; skillPaths: string[] }>());
  const current = snapshot?.id === selected ? snapshot : undefined;
  const last = current?.turns[current.turns.length - 1];
  const binding = connection?.binding;
  const known = Boolean(selected && catalog.some(item => item.id === selected));
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
    if (!runtimeCapabilities.mobile) return;
    const pop = () => { setChatOpen(Boolean(window.history.state?.hubCloudAgentChat)); setSettings(false); setRename(undefined); };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

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
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let nextList = 0;
    async function sync() {
      let delay = 4500;
      try {
        if (Date.now() >= nextList) {
          const data = await call<{ threads: Summary[]; account: Account; threadManagement?: boolean }>("list", { query });
          if (!live) return;
          setCatalog(data.threads);
          setAccount(data.account);
          setManagement(Boolean(data.threadManagement));
          setCatalogQuery(query);
          nextList = Date.now() + 4500;
        }
        if (selected && known) {
          const data = await call<{ thread: Thread; account: Account }>("read", { thread: selected });
          if (!live) return;
          setSnapshot(data.thread);
          setAccount(data.account);
          if (active(data.thread.turns[data.thread.turns.length - 1])) delay = 700;
        }
        if (live) setNetwork("");
      } catch (error) {
        if (live) setNetwork(errorText(error));
      } finally {
        if (live) timer = setTimeout(() => void sync(), delay);
      }
    }
    const wake = () => { if (!document.hidden) refresh(value => value + 1); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    void sync();
    return () => { live = false; clearTimeout(timer); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake); };
  }, [binding, selected, settings, known, syncVersion, query]);

  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [current, selected]);

  useEffect(() => {
    if (!binding || !pending || !current?.turns.some(item => item.id === pending.turn)) return;
    setPending(undefined);
    void outbox(binding, null).catch(() => setNotice("云端已收到消息，本机重试记录将在下次打开时重新核对。"));
  }, [binding, current, pending]);

  function select(id?: string, sent = false) {
    drafts.current.set(selected ?? "new", sent ? { text: "", attachments: [], skillVersion: "", skillPaths: [] } : { text, attachments, skillVersion, skillPaths });
    const draft = sent ? undefined : drafts.current.get(id ?? "new");
    setText(draft?.text ?? ""); setAttachments(draft?.attachments ?? []);
    setSkillVersion(draft?.skillVersion ?? ""); setSkillPaths(draft?.skillPaths ?? []);
    follow.current = true;
    setSelected(id);
    setEarlier([]);
    setBefore(undefined);
    setChatOpen(true); setSettings(false); setRename(undefined);
    if (runtimeCapabilities.mobile && !window.history.state?.hubCloudAgentChat) {
      window.history.pushState({ ...(window.history.state ?? {}), hubCloudAgentChat: true }, "");
    }
    setNotice("");
  }

  function showList() {
    setSettings(false); setRename(undefined); setChatOpen(false);
    if (runtimeCapabilities.mobile && window.history.state?.hubCloudAgentChat) window.history.back();
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
        setCatalog([]); setCatalogQuery(undefined); setSnapshot(undefined); setAccount(undefined); setPending(undefined); setText(""); setAttachments([]); setSelected(undefined); drafts.current.clear(); showList();
      }
      setConnection(value);
      setEndpoint(value.endpoint);
      setToken("");
      setSettings(false);
      refresh(v => v + 1);
    } catch (error) { setNotice(errorText(error)); }
    finally { setBusy(false); }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!binding || sending.current || preparing || archived || (pending && pending.thread !== selected) || (!pending && (!text.trim() && !attachments.length || active(last)))) return;
    sending.current = true;
    setBusy(true);
    setNotice("");
    try {
      const skill = !pending && chosenSkill && !boundSkill
        ? await call<CloudSkillPayload>("prepareSkill", { version: chosenSkill.methodVersion, paths: skillPaths })
        : undefined;
      const draft = pending ?? { thread: selected ?? crypto.randomUUID(), turn: crypto.randomUUID(), text: text.trim(), attachments, skill };
      if (!pending) {
        await outbox(binding, draft);
        setPending(draft);
        setText(""); setAttachments([]);
      }
      if (selected !== draft.thread) select(draft.thread, true);
      drafts.current.delete(draft.thread);
      await call("send", { thread: draft.thread, turn: draft.turn, message: { text: draft.text, attachments: draft.attachments, ...(draft.skill && { skill: draft.skill }) } });
      follow.current = true;
      refresh(v => v + 1);
    } catch (error) { setNotice(errorText(error)); refresh(v => v + 1); }
    finally { sending.current = false; setBusy(false); }
  }

  async function stop() {
    if (!selected || !last) return;
    setNotice("");
    try { await call("stop", { thread: selected, turn: last.id }); refresh(v => v + 1); }
    catch (error) { setNotice(errorText(error)); }
  }

  async function add(files: FileList | null, video = false) {
    if (!files?.length) return;
    setPreparing(true); setNotice("");
    try {
      if (attachments.length + (video ? 1 : files.length) > 6) throw new Error("每条消息最多 6 张图片或视频关键帧。");
      const added = video ? await videoUploads(files[0], 6 - attachments.length) : await Promise.all(Array.from(files, imageUpload));
      const next = [...attachments, ...added];
      if (uploadSize(next) > 12 * 1024 * 1024) throw new Error("一条消息的附件合计最多 12 MiB。");
      setAttachments(next);
    } catch (error) { setNotice(errorText(error)); }
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

  const connectionLabel = network ? "连接中断" : account?.state === "login" ? "VPS 需要登录" : account?.state === "quota" ? "Codex 额度受限" : account?.state === "ready" ? [account.model || "Codex", account.plan].filter(Boolean).join(" · ") : connection ? "已配置 VPS" : "云端对话";
  const turns = [...earlier.filter(item => !current?.turns.some(turn => turn.id === item.id)), ...(current?.turns ?? [])];
  const count = catalog.filter(item => item.archived).length;
  const rows = catalog.filter(item => (scope === "all" || Boolean(item.archived) === (scope === "archived")) &&
    (management ? item.matches : item.title.toLowerCase().includes(query.toLowerCase())));
  const stamp = (value: number) => new Date(value).toLocaleString("zh-CN", new Date(value).toDateString() === new Date().toDateString() ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric" });

  return <section className="cloud-agents" aria-label="云端 Agents">
    <header className="cloud-agents-header">
      {connection && <button type="button" onClick={showList} aria-label="对话列表"><PanelLeft size={20} /></button>}
      <div><h1>{chatOpen ? selected ? current?.title || catalog.find(item => item.id === selected)?.title || "Agents" : "新对话" : "Agents"}</h1><span>{connectionLabel}</span></div>
      {connection && <button type="button" onClick={() => select()} disabled={busy || preparing} aria-label="新对话"><Plus size={22} /></button>}
      {connection && <button type="button" onClick={() => { setSettings(v => !v); setNotice(""); }} disabled={busy || preparing} aria-label="VPS 连接设置"><Settings2 size={20} /></button>}
      {chatOpen && known && management && <details className="cloud-agents-menu"><summary aria-label="会话选项"><MoreHorizontal size={20} /></summary><div>
        <button type="button" disabled={updating} onClick={event => { event.currentTarget.closest("details")!.open = false; setRename(current?.title ?? catalog.find(item => item.id === selected)?.title ?? ""); }}>重命名</button>
        <button type="button" disabled={updating || Boolean(active(last)) || Boolean(pending)} onClick={event => { event.currentTarget.closest("details")!.open = false; void updateThread({ archived: !archived }); }}>{archived ? "恢复会话" : "归档会话"}</button>
      </div></details>}
      {onClose && <button type="button" onClick={runtimeCapabilities.mobile && chatOpen ? showList : onClose} aria-label={runtimeCapabilities.mobile && chatOpen ? "返回会话列表" : "关闭云端 Agents"}><X size={21} /></button>}
    </header>
    {connection === undefined ? <p className="cloud-agents-empty" role="status">正在读取连接…</p> : !connection || settings ? <form className="cloud-agents-connect" onSubmit={event => void connect(event)}>
      <h2><Cloud size={22} /> 连接 VPS</h2>
      <label>服务地址<input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://agents.example.com" required autoCapitalize="none" /></label>
      <label>设备密钥<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required /></label>
      <button className="cloud-agents-primary" disabled={busy}>{busy ? "正在连接…" : "连接"}</button>
      {notice && <p role="alert">{notice}</p>}
    </form> : !chatOpen ? <div ref={list} className="cloud-agents-home" onScroll={event => { listScroll.current = event.currentTarget.scrollTop; }}>
      <h2>你的云端对话</h2><p className="cloud-agents-lede">在手机上开始，随时接着聊。</p>
      <button type="button" className="cloud-agents-connection-card" onClick={() => setSettings(true)}><Cloud size={21}/><span><strong>{network ? "暂时无法连接云端" : "个人云端"}</strong><small>{connectionLabel}</small></span><ChevronRight size={18}/></button>
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
        {rename !== undefined && <form className="cloud-agents-rename" aria-label="重命名会话" onSubmit={event => { event.preventDefault(); void updateThread({ title: rename.trim() }); }}><label>会话名称<input autoFocus maxLength={80} value={rename} onChange={event => setRename(event.target.value)}/></label><button type="submit" disabled={updating || !rename.trim()}>保存名称</button><button type="button" disabled={updating} onClick={() => setRename(undefined)}>取消</button></form>}
        {archived && <div className="cloud-agents-archived"><span>这段会话已归档，消息和附件均保留。</span><button type="button" disabled={updating} onClick={() => void updateThread({ archived: false })}>恢复会话</button></div>}
        <div ref={scroll} className="cloud-agents-messages" onScroll={event => {
          const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        }}>
          {(before === undefined ? current?.before : before) && <button type="button" disabled={loadingEarlier} onClick={() => void loadEarlier()}>查看更早消息</button>}
          {turns.length === 0 && <div className="cloud-agents-empty"><h2>{selected && known ? "正在读取对话…" : "新对话"}</h2></div>}
          {turns.map(turn => <article key={turn.id} className="cloud-agents-turn">
            <div className="cloud-agents-user">{turn.text}{turn.attachments.map(file => <AttachmentPreview key={file.id} file={file} />)}</div>
            <div className="cloud-agents-answer">
              {turn.answer && <ReactMarkdown skipHtml components={{ img: () => null, a: ({ href, children }) => <a href={href} onClick={event => { event.preventDefault(); if (href?.startsWith("https://")) void openUrl(href).catch(() => setNotice("无法打开链接。")); }}>{children}</a> }}>{turn.answer}</ReactMarkdown>}
              {turn.status !== "completed" && <small>{turn.error || statusText[turn.status]}</small>}
            </div>
          </article>)}
        </div>
        <form className="cloud-agents-compose" onSubmit={event => void send(event)}>
          {boundSkill ? <details><summary>本对话固定技能 · {boundSkill.name}</summary><small>{boundSkill.version}</small><ul>{boundSkill.paths.map(path => <li key={path}>{path}</li>)}</ul></details>
            : !pending && <details onToggle={event => { if (event.currentTarget.open) void showSkills(); }}>
              <summary>使用固定技能{chosenSkill ? ` · ${chosenSkill.title}` : ""}</summary>
              {skills?.length ? <><label>技能 <select value={skillVersion} onChange={event => { setSkillVersion(event.target.value); setSkillPaths([]); }}>
                <option value="">不使用技能</option>
                {skills.map(item => <option key={item.methodVersion} value={item.methodVersion}>{item.title}</option>)}
              </select></label>
              {chosenSkill && <div><small>选入本次需要发送到 VPS 的配套文字文件。该版本将在这段对话中继续使用。</small>
                {chosenSkill.paths.map(path => <label key={path}><input type="checkbox" checked={skillPaths.includes(path)} onChange={event => setSkillPaths(old => event.target.checked ? [...old, path] : old.filter(value => value !== path))}/>{path}</label>)}</div>}</>
              : <small>{skills ? "本机暂无适合云端运行的已保存文字技能。" : "正在读取本机技能…"}</small>}
            </details>}
          {account?.state === "ready" && account.limits?.some(limit => typeof limit.usedPercent === "number") && <small className="cloud-agents-quota">额度已用 {account.limits.filter(limit => typeof limit.usedPercent === "number").map(limit => `${limit.usedPercent}%${limit.windowDurationMins ? `（${limit.windowDurationMins} 分钟）` : ""}`).join(" / ")}</small>}
          {(network || notice) && <p className="cloud-agents-notice" role="status">{notice || network} {network && <button type="button" onClick={() => refresh(v => v + 1)}>重连</button>}</p>}
          {pending ? <div className="cloud-agents-pending">
            <span>{busy ? "正在发送…" : "待确认 · 消息已保存在此设备"}</span>
            <button type="button" onClick={() => void send()} disabled={busy}>用原编号重试</button>
            <button type="button" disabled={busy} onClick={() => { if (binding) void outbox(binding, null).then(() => setPending(undefined)).catch(error => setNotice(errorText(error))); }}>移除本机重试</button>
          </div> : <>
            {!!attachments.length && <div className="cloud-agents-files">{attachments.map((file, index) => <button type="button" key={index} disabled={preparing} onClick={() => setAttachments(list => list.filter((_, i) => i !== index))} aria-label={`移除 ${attachmentLabel(file)}`}>{attachmentLabel(file)} <X size={14} /></button>)}</div>}
            {attachments.some(file => file.seconds != null) && <small>将发送带时间戳的关键帧，短暂变化可能漏掉。</small>}
          <textarea value={text} onChange={event => setText(event.target.value)} disabled={archived} maxLength={20000} placeholder={archived ? "恢复会话后可继续提问" : "给 Agents 发消息"} aria-label="消息" rows={2} />
            <div className="cloud-agents-tools">
              <label title="拍照"><Camera size={19} /><input type="file" aria-label="拍照" accept="image/*" capture="environment" disabled={busy || preparing} onChange={event => { void add(event.currentTarget.files); event.currentTarget.value = ""; }} /></label>
              <label title="选择图片"><Image size={19} /><input type="file" aria-label="选择图片" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || preparing} onChange={event => { void add(event.currentTarget.files); event.currentTarget.value = ""; }} /></label>
              <label title="选择短视频"><Video size={19} /><input type="file" aria-label="选择短视频" accept="video/*" disabled={busy || preparing} onChange={event => { void add(event.currentTarget.files, true); event.currentTarget.value = ""; }} /></label>
              {preparing && <span role="status">正在处理附件…</span>}
              {active(last) ? <button type="button" className="cloud-agents-primary" aria-label="停止生成" disabled={last?.status === "stopping"} onClick={() => void stop()}><Square size={18} /></button> : <button type="submit" className="cloud-agents-primary" aria-label="发送" disabled={archived || busy || preparing || (!text.trim() && !attachments.length)}><ArrowUp size={20} /></button>}
            </div>
          </>}
        </form>
      </div>
    </div>}
  </section>;
}
