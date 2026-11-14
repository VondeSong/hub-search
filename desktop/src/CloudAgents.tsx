import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUp, Camera, Cloud, Image, PanelLeft, Plus, Settings2, Square, Video, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import { imageUpload, outbox, uploadSize, videoUploads, type CloudSkillPayload, type DraftTurn, type Upload } from "./CloudAgentMedia";
import "./CloudAgents.css";

type Connection = { endpoint: string; binding: string };
type Account = { state: "unknown" | "ready" | "login" | "quota"; plan?: string; model?: string; limits?: { usedPercent?: number; windowDurationMins?: number }[] };
type Summary = { id: string; title: string; updated: number };
type Attachment = { id: string; name: string; seconds?: number | null };
type Turn = { id: string; seq: number; text: string; answer: string; error?: string; status: "queued" | "running" | "stopping" | "completed" | "failed" | "stopped"; attachments: Attachment[] };
type Thread = Summary & { turns: Turn[]; before: number | null; skill?: { name: string; version: string; paths: string[] } | null };
type SkillChoice = { name: string; title: string; methodVersion: string; paths: string[] };
const active = (turn?: Turn) => turn && ["queued", "running", "stopping"].includes(turn.status);
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
  const [listOpen, setListOpen] = useState(false);
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
  const current = snapshot?.id === selected ? snapshot : undefined;
  const last = current?.turns[current.turns.length - 1];
  const binding = connection?.binding;
  const known = Boolean(selected && catalog.some(item => item.id === selected));
  const chosenSkill = skills?.find(skill => skill.methodVersion === skillVersion);
  const boundSkill = current?.skill;

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
      if (live && saved) { setPending(saved); setSelected(saved.thread); }
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
          const data = await call<{ threads: Summary[]; account: Account }>("list");
          if (!live) return;
          setCatalog(data.threads);
          setAccount(data.account);
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
  }, [binding, selected, settings, known, syncVersion]);

  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [current, selected]);

  useEffect(() => {
    if (!binding || !pending || !current?.turns.some(item => item.id === pending.turn)) return;
    setPending(undefined);
    void outbox(binding, null).catch(() => setNotice("云端已收到消息，本机重试记录将在下次打开时重新核对。"));
  }, [binding, current, pending]);

  function select(id?: string) {
    follow.current = true;
    setSelected(id);
    setEarlier([]);
    setBefore(undefined);
    setListOpen(false);
    setNotice("");
    setSkillVersion("");
    setSkillPaths([]);
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const value = await call<Connection>("connect", { endpoint, token });
      if (value.binding !== binding) {
        setCatalog([]); setSnapshot(undefined); setAccount(undefined); setPending(undefined); setText(""); setAttachments([]); select();
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
    if (!binding || sending.current || preparing || (!pending && (!text.trim() && !attachments.length || active(last)))) return;
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
      if (selected !== draft.thread) select(draft.thread);
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

  return <section className="cloud-agents" aria-label="云端 Agents">
    <header className="cloud-agents-header">
      {connection && <button type="button" onClick={() => setListOpen(v => !v)} aria-expanded={listOpen} aria-label="对话列表"><PanelLeft size={20} /></button>}
      <div><h1>Agents</h1><span>{connectionLabel}</span></div>
      {connection && <button type="button" onClick={() => select()} disabled={busy || preparing} aria-label="新对话"><Plus size={22} /></button>}
      {connection && <button type="button" onClick={() => { setSettings(v => !v); setNotice(""); }} disabled={busy || preparing} aria-label="VPS 连接设置"><Settings2 size={20} /></button>}
      {onClose && <button type="button" onClick={onClose} aria-label="关闭云端 Agents"><X size={21} /></button>}
    </header>
    {connection === undefined ? <p className="cloud-agents-empty" role="status">正在读取连接…</p> : !connection || settings ? <form className="cloud-agents-connect" onSubmit={event => void connect(event)}>
      <h2><Cloud size={22} /> 连接 VPS</h2>
      <label>服务地址<input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://agents.example.com" required autoCapitalize="none" /></label>
      <label>设备密钥<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required /></label>
      <button className="cloud-agents-primary" disabled={busy}>{busy ? "正在连接…" : "连接"}</button>
      {notice && <p role="alert">{notice}</p>}
    </form> : <div className="cloud-agents-body">
      {listOpen && <aside className="cloud-agents-list" aria-label="云端对话">
        <button type="button" onClick={() => select()}><Plus size={18} /> 新对话</button>
        {catalog.map(item => <button type="button" key={item.id} aria-current={item.id === selected ? "page" : undefined} onClick={() => select(item.id)}>{item.title}</button>)}
      </aside>}
      <div className="cloud-agents-chat">
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
            <textarea value={text} onChange={event => setText(event.target.value)} maxLength={20000} placeholder="给 Agents 发消息" aria-label="消息" rows={2} />
            <div className="cloud-agents-tools">
              <label title="拍照"><Camera size={19} /><input type="file" aria-label="拍照" accept="image/*" capture="environment" disabled={busy || preparing} onChange={event => { void add(event.currentTarget.files); event.currentTarget.value = ""; }} /></label>
              <label title="选择图片"><Image size={19} /><input type="file" aria-label="选择图片" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || preparing} onChange={event => { void add(event.currentTarget.files); event.currentTarget.value = ""; }} /></label>
              <label title="选择短视频"><Video size={19} /><input type="file" aria-label="选择短视频" accept="video/*" disabled={busy || preparing} onChange={event => { void add(event.currentTarget.files, true); event.currentTarget.value = ""; }} /></label>
              {preparing && <span role="status">正在处理附件…</span>}
              {active(last) ? <button type="button" className="cloud-agents-primary" aria-label="停止生成" disabled={last?.status === "stopping"} onClick={() => void stop()}><Square size={18} /></button> : <button type="submit" className="cloud-agents-primary" aria-label="发送" disabled={busy || preparing || (!text.trim() && !attachments.length)}><ArrowUp size={20} /></button>}
            </div>
          </>}
        </form>
      </div>
    </div>}
  </section>;
}
