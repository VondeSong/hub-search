import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { buildTagContentScanPrompt } from "./TagContentScanWorkflow";
import { TagContentScanNewRound } from "./TagContentScanNewRound";

export type JointTag = { tag: string; definitionVersion: number; definition: { description: string; libraryIds: string[] } };
type Props = { tagId: string; runId: string; selection?: JointTag[] | null; counts?: Record<string, number>; editable: boolean; union?: boolean; onCreated?: (id: string) => void };
export function TagContentScanJoint({ tagId, runId, selection, counts, editable, union, onCreated }: Props) {
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<JointTag[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0), lock = useRef(false);
  useEffect(() => () => { generation.current++; }, []);
  const fixed = !!selection?.length;
  const chosen = fixed ? selection! : draft;
  const add = async () => {
    if (lock.current || !input.trim() || chosen.length >= 4 || fixed || !editable) return;
    const n = generation.current; lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await invoke<{ definition: { tag: string; version: number; definition: JointTag["definition"] } | null }>("tag_assignment", { args: { action: "definition", tag: input.trim() } });
      if (n !== generation.current) return;
      const d = result.definition;
      if (!d) throw Error("此标签尚未保存补标定义，请先到对应标签页设置定义与范围。");
      if (d.tag === tagId || draft.some(t => t.tag === d.tag)) throw Error("不能重复选择，也不能添加主标签。");
      setDraft(old => [...old, { tag: d.tag, definitionVersion: d.version, definition: d.definition }]); setInput("");
    } catch (e) { if (n === generation.current) setError(String(e)); }
    finally { if (n === generation.current) { lock.current = false; setBusy(false); } }
  };
  const copy = async () => {
    if (lock.current || !chosen.length || !editable) return;
    const n = generation.current; lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await navigator.clipboard.writeText(buildTagContentScanPrompt({ name: tagId, normalizedName: tagId }, runId, chosen.map(({ tag, definitionVersion }) => ({ tag, definitionVersion }))));
      if (n === generation.current) setNotice("联合任务已复制，尚未开始分析。首次成功联合取证后，Hub 才固定选择；复制本身不保存选择或修改标签。");
    } catch { if (n === generation.current) setError("复制失败，请重试。"); }
    finally { if (n === generation.current) { lock.current = false; setBusy(false); } }
  };
  return <section aria-label="多标签联合检查">
    <h4>多标签联合检查</h4>
    <p className="tag-assignment-hint">主标签 #{tagId}。共用正文取证，各标签分别待审核；{union ? "本任务使用已确认的资料库合并范围。" : "当前仍限于主标签清单，合并范围须另建任务确认。"}</p>
    {!fixed && editable && <fieldset className="tag-scan-budget" disabled={busy}>
      <legend>选择额外标签（最多 4 个）</legend>
      <label>额外标签名称<input value={input} maxLength={240} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void add(); } }} /></label>
      <button type="button" disabled={!input.trim() || chosen.length >= 4} onClick={() => void add()}>核对定义并加入</button>
      <p>这里是未保存的交接选择。标签必须已保存补标定义；不会自动创建定义。</p>
    </fieldset>}
    {fixed && <p>已固定选择；定义变化需重新规划，不能在旧任务中替换。</p>}
    {!!chosen.length && <ul>{chosen.map(t => <li key={t.tag}>
      #{t.tag} · 定义版本 {t.definitionVersion} · {t.definition.description}
      <p className="tag-assignment-hint">定义资料库：{t.definition.libraryIds.join("、")}</p>
      {!fixed && <button type="button" disabled={busy} aria-label={`移除额外标签 ${t.tag}`} onClick={() => { setDraft(old => old.filter(v => v.tag !== t.tag)); setNotice(""); }}>移除</button>}
    </li>)}</ul>}
    {fixed && counts && <>
      <dl className="tag-scan-counts">{[["pending", "待判断"], ["recorded", "已记录（非已批准）"], ["unvisited", "尚未覆盖"], ["excluded", "排除跳过"], ["already_tagged", "已有标签"], ["out_of_scope", "范围外"], ["unavailable", "内容不可用"]].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{counts[key]?.toLocaleString("zh-CN") ?? "—"}</dd></div>)}</dl>
      <p className="tag-assignment-hint">单位是“实体 × 额外标签”组合，不是笔记数量。历史记录不代表当前证据有效；未覆盖不算已分析。刷新进度仅查看，不启动分析。</p>
    </>}
    {editable && <button type="button" disabled={busy || !chosen.length} onClick={() => void copy()}>复制联合检查任务</button>}
    {onCreated && !!chosen.length && !busy && <TagContentScanNewRound key={JSON.stringify(chosen)} tagId={tagId} unionTags={chosen.map(({ tag, definitionVersion }) => ({ tag, definitionVersion }))} onCreated={onCreated} />}
    {busy && <p role="status">正在核对…</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
