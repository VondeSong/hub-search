import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

type Entry = {
  id: string; revisionId: string; topicKey: string; title: string; projectId: string;
  kind: "rule" | "decision"; version: number; state: string; body: string | null; detail?: string;
};
type View = {
  configured: boolean; runtimeDetail?: string | null; entries: Entry[]; projects: { id: string; name: string }[];
  selection: { projectId: string; enabled: boolean };
};
export type MemorySelection = { projectId: string; enabled: boolean };
export type MemoryUse = { projectId: string; items: { id: string; version: number; kind: string; reason: string }[] };
const call = (args: Record<string, unknown>) => invoke<View>("shared_memory", { args });
const states: Record<string, string> = {
  pending: "等待索引核验", active: "已生效", inactive: "已停用", deleting: "已停止使用，正在清除", review: "恢复的历史记忆，需要重新确认",
};

export function SharedMemory({ workId, disabled, onSelectionChange, usage, compact = false }: { compact?: boolean; workId?: string; disabled: boolean; onSelectionChange?: (selection: MemorySelection) => void; usage?: MemoryUse | null }) {
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"rule" | "decision">("decision");
  const [edit, setEdit] = useState<Entry | null>(null);
  const [projectName, setProjectName] = useState("");
  const alive = useRef(true);
  const draftSelection = useRef<MemorySelection>({ projectId: "", enabled: false });
  // Retain the identity after an interrupted submission. Changed content gets a
  // new request identity; exact retry reconciles the accepted version.
  const request = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function perform(args: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      const next = await call({ ...args, workId });
      if (alive.current) {setView(workId ? next : { ...next, selection: draftSelection.current }); if(workId) onSelectionChange?.(next.selection);}
      return true;
    } catch (reason) {
      if (alive.current) {
        setError(String(reason));
        try {
          const next = await call({ action: "status", workId });
          if (alive.current) {setView(workId ? next : { ...next, selection: draftSelection.current }); if(workId) onSelectionChange?.(next.selection);}
        } catch { /* Preserve the original failure. */ }
      }
      return false;
    } finally { if (alive.current) setBusy(false); }
  }
  function select(selection: MemorySelection) {
    if (workId) { void perform({ action: "selectScope", ...selection }); return; }
    draftSelection.current = selection;
    setView(current => current ? { ...current, selection } : current);
    onSelectionChange?.(selection);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!view) return;
    const payload = { action: "put", title: title.trim(), body: body.trim(), kind,
      topicKey: edit?.topicKey || title.trim(), projectId: edit?.projectId ?? view.selection.projectId,
      expectedVersion: edit?.version ?? 0, confirmed: true };
    const identity = JSON.stringify(payload);
    if (request.current?.payload !== identity) request.current = { payload: identity, key: crypto.randomUUID() };
    if (await perform({ ...payload, requestKey: request.current.key })) {
      setTitle(""); setBody(""); setEdit(null); request.current = null;
    }
  }
  const blocked = disabled || busy;
  return <details className="agent-run-details" onToggle={event => {
    const next = event.currentTarget.open;
    setExpanded(next);
    if (next && !view && !busy) void perform({ action: "status" });
  }}>
    <summary>{compact && view ? `记忆 · ${view.selection.enabled ? "已启用" : "未启用"}` : "共享记忆"}</summary>
    {expanded && <>
      <p className="agent-note">保存你确认的规则与决定，供其他调查复用。个人通用记忆适用于所有启用记忆的事项，项目记忆只在所选项目内使用。</p>
      {!view && busy && <p role="status">正在准备本地记忆，首次使用可能需要一点时间…</p>}
      {view && <>
        <p>{view.configured ? "本地记忆已就绪。" : view.runtimeDetail || "本地记忆尚未准备完成。"}<button type="button" disabled={blocked} onClick={() => void perform({ action: "repair" })}>{busy ? "正在检查…" : "修复本地记忆"}</button></p>
        <label>本事项的记忆范围<select value={view.selection.projectId} disabled={blocked} onChange={event => select({ projectId: event.target.value, enabled: view.selection.enabled })}>
          <option value="">仅个人通用</option>
          {view.projects.map(project => <option value={project.id} key={project.id}>{project.name}＋个人通用</option>)}
        </select></label>
        <label><input type="checkbox" checked={view.selection.enabled} disabled={blocked || !view.configured}
          onChange={event => select({ projectId: view.selection.projectId, enabled: event.target.checked })} />{workId ? "下一轮" : "首轮调查"}使用此范围内的记忆</label>
        {usage && <section aria-label="本轮记忆使用记录"><p>本轮使用 {usage.items.length} 条共享记忆。</p><ul>{usage.items.map(item => <li key={item.id}>{view.entries.find(entry => entry.id === item.id)?.title || item.id} · 第 {item.version} 版 · {item.kind === "rule" ? "范围内规则" : "相关决定候选"}</li>)}</ul><p className="agent-note">候选仍需结合当前问题核对；此处记录实际送入模型的版本。</p></section>}
        <form onSubmit={event => { event.preventDefault(); if (projectName.trim()) void perform({ action: "createProject", name: projectName.trim() }).then(ok => { if (ok) setProjectName(""); }); }}>
          <label>新建记忆项目<input value={projectName} maxLength={60} onChange={event => setProjectName(event.target.value)} placeholder="例如：Hub 开发" /></label>
          <button type="submit" disabled={blocked || !projectName.trim()}>创建项目</button>
        </form>
        <form onSubmit={save}>
          <label>{edit ? "修改记忆" : "记忆主题"}<input value={title} required maxLength={90} onChange={event => setTitle(event.target.value)} placeholder="用稳定的名称标识这项规则或决定" /></label>
          <label>类型<select value={kind} onChange={event => setKind(event.target.value as "rule" | "decision")}>
            <option value="decision">决定 · 相关时参考</option><option value="rule">规则 · 每次加载</option>
          </select></label>
          <label>确认的内容<textarea value={body} required maxLength={1800} onChange={event => setBody(event.target.value)} /></label>
          <p className="agent-note">保存到：{(edit?.projectId ?? view.selection.projectId) ? view.projects.find(p => p.id === (edit?.projectId ?? view.selection.projectId))?.name : "个人通用"}。修改后旧版本停止使用；外部改动需要重新确认。</p>
          <button type="submit" disabled={blocked || !view.configured || !title.trim() || !body.trim()}>确认并保存记忆</button>
          {edit && <button type="button" disabled={blocked} onClick={() => { setEdit(null); setTitle(""); setBody(""); request.current = null; }}>取消修改</button>}
        </form>
        <ul>{view.entries.filter(entry => !entry.projectId || entry.projectId === view.selection.projectId).map(entry => <li key={entry.id}>
          <strong>{entry.title}</strong> · {states[entry.state] || entry.state} · 第 {entry.version} 版
          {entry.body && <p>{entry.body}</p>}
          {entry.detail && <p className="agent-note">{entry.detail}</p>}
          {entry.state === "pending" && <button type="button" disabled={blocked} onClick={() => void perform({ action: "retry", id: entry.id })}>重试核验</button>}
          {["active", "inactive", "review"].includes(entry.state) && <button type="button" disabled={blocked} onClick={() => { setEdit(entry); setTitle(entry.title); setKind(entry.kind); setBody(entry.body || ""); request.current = null; }}>修改</button>}
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
