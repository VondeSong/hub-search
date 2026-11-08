import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { loadMemoryPreference, rememberMemoryPreference, type MemorySelection } from "./AgentPreferences";
export type { MemorySelection } from "./AgentPreferences";

type MemorySource = { origin: string; workId?: string; runId?: string; sourceRecordId?: string; proposedBy?: string; confirmedAt?: number; changeReason?: string };
type Proposal = { id: string; projectId: string; expectedVersion: number; candidate: { title: string; topicKey: string; kind: "rule" | "decision"; body: string; reason: string }; source: MemorySource };
type Entry = {
  id: string; revisionId: string; topicKey: string; title: string; projectId: string;
  kind: "rule" | "decision"; version: number; state: string; body: string | null; detail?: string; source?: MemorySource; updatedAt?: number;
  history?: { version: number; source: MemorySource | null }[];
};
type View = {
  configured: boolean; runtimeDetail?: string | null; entries: Entry[]; proposals?: Proposal[]; projects: { id: string; name: string }[];
  selection: { projectId: string; enabled: boolean };
};
export type MemoryUse = { projectId: string; omissions?: {notRetrieved: number; budget: number}; notice?: string | null; items: { id: string; version: number; kind: string; reason: string }[] };
const call = (args: Record<string, unknown>) => invoke<View>("shared_memory", { args });
const states: Record<string, string> = {
  pending: "等待索引核验", active: "已生效", inactive: "已停用", deleting: "已停止使用，正在清除", review: "恢复的历史记忆，需要重新确认",
};

export function SharedMemory({ workId, disabled, onSelectionChange, initialSelection, usage, compact = false }: { compact?: boolean; workId?: string; disabled: boolean; initialSelection?: MemorySelection; onSelectionChange?: (selection: MemorySelection) => void; usage?: MemoryUse | null }) {
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectionNotice, setSelectionNotice] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"rule" | "decision">("decision");
  const [edit, setEdit] = useState<Entry | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [changeReason, setChangeReason] = useState("");
  const [projectName, setProjectName] = useState("");
  const alive = useRef(true);
  const currentWork = useRef(workId); currentWork.current = workId;
  useEffect(() => { setView(null); setEdit(null); setProposal(null); setTitle(""); setBody(""); setChangeReason(""); request.current = null; if (expanded) void perform({ action: "status" }); }, [workId]);
  const draftSelection = useRef<MemorySelection>(initialSelection ?? loadMemoryPreference());
  if (!workId && initialSelection) draftSelection.current = initialSelection;
  useEffect(() => {
    if (!workId && initialSelection) setView(current => current ? { ...current, selection: initialSelection } : current);
  }, [workId, initialSelection?.projectId, initialSelection?.enabled]);
  // Retain the identity after an interrupted submission. Changed content gets a
  // new request identity; exact retry reconciles the accepted version.
  const request = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function perform(args: Record<string, unknown>, rememberSelection = false) {
    setBusy(true); setError("");
    try {
      let next = await call({ ...(!workId ? { projectId: draftSelection.current.projectId } : {}), ...args, workId });
      if (!workId && typeof args.projectId === "string" && args.projectId !== draftSelection.current.projectId) {
        next = await call({ action: "status", projectId: draftSelection.current.projectId });
      }
      if (alive.current && currentWork.current === workId) {setView(workId ? next : { ...next, selection: draftSelection.current }); if(workId) onSelectionChange?.(next.selection); if(rememberSelection) rememberMemoryPreference(next.selection);}
      return true;
    } catch (reason) {
      if (alive.current && currentWork.current === workId) {
        setError(String(reason));
        try {
          let next = await call({ action: "status", workId });
          if (!workId && draftSelection.current.projectId && !next.projects.some(project => project.id === draftSelection.current.projectId)) {
            if (alive.current && currentWork.current === workId) {
              draftSelection.current = { projectId: "", enabled: false };
              rememberMemoryPreference(draftSelection.current); onSelectionChange?.(draftSelection.current);
              setError(""); setSelectionNotice("上次选择的记忆项目已不可用，已关闭记忆。请重新选择范围。");
            }
          } else if (!workId && draftSelection.current.projectId) {
            next = await call({ action: "status", projectId: draftSelection.current.projectId });
          }
          if (alive.current && currentWork.current === workId) {setView(workId ? next : { ...next, selection: draftSelection.current }); if(workId) onSelectionChange?.(next.selection);}
        } catch { /* Preserve the original failure. */ }
      }
      return false;
    } finally { if (alive.current && currentWork.current === workId) setBusy(false); }
  }
  function select(selection: MemorySelection) {
    setSelectionNotice("");
    setProposal(null); setEdit(null); setTitle(""); setBody(""); setChangeReason(""); request.current = null;
    if (workId) { void perform({ action: "selectScope", ...selection }, true); return; }
    draftSelection.current = selection;
    rememberMemoryPreference(selection);
    setView(current => current ? { ...current, selection } : current);
    onSelectionChange?.(selection);
    void perform({ action: "status", projectId: selection.projectId });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!view) return;
    const payload = { action: "put", title: title.trim(), body: body.trim(), kind,
      topicKey: proposal?.candidate.topicKey ?? edit?.topicKey ?? title.trim(), projectId: proposal?.projectId ?? edit?.projectId ?? view.selection.projectId,
      expectedVersion: proposal?.expectedVersion ?? edit?.version ?? 0, confirmed: true,
      ...(proposal ? { proposalId: proposal.id } : {}), changeReason: changeReason.trim() || "用户确认保存" };
    const identity = JSON.stringify(payload);
    if (request.current?.payload !== identity) request.current = { payload: identity, key: crypto.randomUUID() };
    if (await perform({ ...payload, requestKey: request.current.key })) {
      setTitle(""); setBody(""); setEdit(null); setProposal(null); setChangeReason(""); request.current = null;
    }
  }
  const blocked = disabled || busy;
  return <details className="agent-run-details" onToggle={event => {
    const next = event.currentTarget.open;
    setExpanded(next);
    if (next && !busy) void perform({ action: "status" });
  }}>
    <summary>{compact && view ? `记忆 · ${view.selection.enabled ? "已启用" : "未启用"}` : "共享记忆"}{view?.proposals?.length ? ` · ${view.proposals.length} 条待确认` : ""}</summary>
    {expanded && <>
      <p className="agent-note">保存你确认的规则与决定，供其他调查复用。个人通用记忆适用于所有启用记忆的事项，项目记忆只在所选项目内使用。</p>
      <p className="agent-note">新聊天会沿用你最后选择的记忆范围和开关；记忆内容仍需确认保存。</p>
      {selectionNotice && <p role="status">{selectionNotice}</p>}
      {!view && busy && <p role="status">正在准备本地记忆，首次使用可能需要一点时间…</p>}
      {view && <>
        <button type="button" disabled={blocked} onClick={() => void perform({ action: "status" })}>刷新记忆</button>
        <p>{view.configured ? "本地记忆已就绪。" : view.runtimeDetail || "本地记忆尚未准备完成。"}<button type="button" disabled={blocked} onClick={() => void perform({ action: "repair" })}>{busy ? "正在检查…" : "修复本地记忆"}</button></p>
        <label>本事项的记忆范围<select value={view.selection.projectId} disabled={blocked} onChange={event => select({ projectId: event.target.value, enabled: view.selection.enabled })}>
          <option value="">仅个人通用</option>
          {view.projects.map(project => <option value={project.id} key={project.id}>{project.name}＋个人通用</option>)}
        </select></label>
        <label><input type="checkbox" checked={view.selection.enabled} disabled={blocked || !view.configured}
          onChange={event => select({ projectId: view.selection.projectId, enabled: event.target.checked })} />{workId ? "下一轮" : "首轮调查"}使用此范围内的记忆</label>
        {usage && <section aria-label="本轮记忆使用记录"><p>本轮向模型提供 {usage.items.length} 条共享记忆。</p><ul>{usage.items.map(item => <li key={item.id}>{view.entries.find(entry => entry.id === item.id)?.title || item.id} · 第 {item.version} 版 · {item.kind === "rule" ? "范围内规则" : "相关决定候选"}</li>)}</ul>{usage.omissions && <p className="agent-note">未被检索选中 {usage.omissions.notRetrieved} 条；受容量限制未提供 {usage.omissions.budget} 条。未开启、其他项目、停用或待确认的内容不会提供。</p>}{usage.notice && <p className="agent-note">{usage.notice}</p>}<p className="agent-note">此处记录实际送入模型的版本，是否采纳仍需结合回答核对。记忆有变化时，旧上下文不能继续交付；请停止当前轮再继续。</p></section>}
        <form onSubmit={event => { event.preventDefault(); if (projectName.trim()) void perform({ action: "createProject", name: projectName.trim() }).then(ok => { if (ok) setProjectName(""); }); }}>
          <label>新建记忆项目<input value={projectName} maxLength={60} onChange={event => setProjectName(event.target.value)} placeholder="例如：Hub 开发" /></label>
          <button type="submit" disabled={blocked || !projectName.trim()}>创建项目</button>
        </form>
        <section aria-label="待确认记忆建议"><h4>待确认建议</h4><p className="agent-note">模型建议尚未生效，不会被其他对话使用。检查内容和项目后再确认。</p>
          {(view.proposals ?? []).filter(item => item.projectId === view.selection.projectId).map(item => <div key={item.id}>
            <strong>{item.candidate.title}</strong><p>{item.candidate.body}</p><p className="agent-note">{item.candidate.reason} · 来自 {item.source.proposedBy || "模型"} 的建议</p>
            <details><summary>查看建议来源</summary><p>事项：{item.source.workId}；消息：{item.source.sourceRecordId}；运行：{item.source.runId}</p></details>
            <button type="button" disabled={blocked} onClick={() => { setProposal(item); setEdit(null); setTitle(item.candidate.title); setBody(item.candidate.body); setKind(item.candidate.kind); setChangeReason(item.candidate.reason); request.current = null; }}>检查并修改建议</button>
            <button type="button" disabled={blocked} onClick={() => void perform({ action: "dismissProposal", proposalId: item.id }).then(ok => { if (ok && proposal?.id === item.id) { setProposal(null); setTitle(""); setBody(""); } })}>忽略建议</button>
          </div>)}
          {!(view.proposals ?? []).some(item => item.projectId === view.selection.projectId) && <p className="agent-note">此范围暂无待确认建议。</p>}
        </section>
        <form onSubmit={save}>
          <label>{proposal ? "确认模型建议" : edit ? "修改记忆" : "记忆主题"}<input value={title} required maxLength={90} onChange={event => setTitle(event.target.value)} placeholder="用稳定的名称标识这项规则或决定" /></label>
          <label>类型<select value={kind} onChange={event => setKind(event.target.value as "rule" | "decision")}>
            <option value="decision">决定 · 相关时参考</option><option value="rule">规则 · 每次加载</option>
          </select></label>
          <label>确认的内容<textarea value={body} required maxLength={1800} onChange={event => setBody(event.target.value)} /></label>
          {(edit || proposal) && <label>修改或确认原因<input value={changeReason} maxLength={280} onChange={event => setChangeReason(event.target.value)} placeholder="例如：新方案替代旧方案" /></label>}
          <p className="agent-note">保存到：{(proposal?.projectId ?? edit?.projectId ?? view.selection.projectId) ? view.projects.find(p => p.id === (proposal?.projectId ?? edit?.projectId ?? view.selection.projectId))?.name : "个人通用"}。修改后旧版本停止使用；外部改动需要重新确认。</p>
          <button type="submit" disabled={blocked || !view.configured || !title.trim() || !body.trim()}>确认并保存记忆</button>
          {(edit || proposal) && <button type="button" disabled={blocked} onClick={() => { setEdit(null); setProposal(null); setTitle(""); setBody(""); setChangeReason(""); request.current = null; }}>取消修改</button>}
        </form>
        <ul>{view.entries.filter(entry => !entry.projectId || entry.projectId === view.selection.projectId).map(entry => <li key={entry.id}>
          <strong>{entry.title}</strong> · {states[entry.state] || entry.state} · 第 {entry.version} 版
          {entry.updatedAt && <p className="agent-note">更新于 {new Date(entry.updatedAt).toLocaleString()}</p>}
          {entry.body && <p>{entry.body}</p>}
          <details><summary>来源与修订记录</summary><p>{entry.source?.origin === "modelProposal" ? "模型建议，经用户确认" : "用户明确确认"}{entry.source?.confirmedAt ? ` · ${new Date(entry.source.confirmedAt).toLocaleString()}` : " · 旧记录未保存确认时间"}</p>
            {entry.source?.workId && <p>来源事项：{entry.source.workId}；消息：{entry.source.sourceRecordId || "手动填写"}；运行：{entry.source.runId || "无"}</p>}
            <ul>{entry.history?.map(item => <li key={item.version}>第 {item.version} 版：{item.source?.changeReason || "旧记录未保存修改原因"}{item.source?.confirmedAt ? ` · ${new Date(item.source.confirmedAt).toLocaleString()}` : ""}</li>)}</ul>
          </details>
          {entry.detail && <p className="agent-note">{entry.detail}</p>}
          {entry.state === "pending" && <button type="button" disabled={blocked} onClick={() => void perform({ action: "retry", id: entry.id })}>重试核验</button>}
          {["active", "inactive", "review"].includes(entry.state) && <button type="button" disabled={blocked} onClick={() => { setProposal(null); setChangeReason(""); setEdit(entry); setTitle(entry.title); setKind(entry.kind); setBody(entry.body || ""); request.current = null; }}>修改</button>}
          {entry.state === "active" && <button type="button" disabled={blocked} onClick={() => void perform({ action: "deactivate", id: entry.id })}>停用</button>}
          <button type="button" disabled={blocked} onClick={() => {
            if (window.confirm(`遗忘“${entry.title}”及其历史正文？已有备份文件不会被改写。`)) void perform({ action: "forget", id: entry.id, confirmed: true });
          }}>遗忘</button>
        </li>)}</ul>
        {busy && <p role="status">正在处理记忆，完成核验后才会生效。首次准备或重建索引可能需要约两分钟…</p>}
      </>}
      {error && <p role="alert">{error}</p>}
    </>}
  </details>;
}
