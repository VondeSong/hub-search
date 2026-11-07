import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
type Confirmation = { confirmationToken: string; change: { title: string; tag: string; excluded: boolean; entityId?: string; exclusionEventId?: number; proposalId?: string } };
type Target = { proposalId: string; exclusionEventId?: never } | { proposalId?: never; exclusionEventId: number };
export function TagAssignmentExclusion({ proposalId, exclusionEventId, excluded, disabled, onChanged }: Target & { excluded: boolean; disabled: boolean; onChanged: () => void }) {
  const [preview, setPreview] = useState<Confirmation | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function run(apply: boolean) {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); setError(""); const n = generation.current;
    try {
      const result = await invoke<Confirmation>("tag_assignment", { args: { action: apply ? "apply_exclusion" : "preview_exclusion", ...(exclusionEventId !== undefined ? { exclusionEventId, excluded: false } : { proposalId, excluded: !excluded }), ...(apply && preview ? { confirmationToken: preview.confirmationToken, requestId: `exclusion-${preview.confirmationToken}` } : {}) } });
      if (n !== generation.current) return;
      if (apply) { setPreview(null); onChanged(); } else setPreview(result);
    } catch (e) { if (n === generation.current) { setPreview(null); setError(`${String(e)}；请刷新详情核对后再操作。`); } }
    finally { if (n === generation.current) { lock.current = false; setBusy(false); } }
  }
  return <details><summary>持续排除偏好 · {excluded ? "已启用" : "未启用"}</summary>
    <p>仅阻止此标签对这一篇内容的新补标建议及批准，跨正文和定义版本持续生效，直到你撤销。不会删除历史、已有标签或来源内容。逐篇扫描可在取证前按此偏好跳过未读项，不算已分析；撤销后须单项确认恢复，不自动重开扫描。</p>
    <fieldset disabled={busy || disabled}>
      {!preview ? <button type="button" onClick={() => void run(false)}>{excluded ? "预览撤销排除" : "预览持续排除"}</button> : <>
        <p>{preview.change.title} · #{preview.change.tag}：{preview.change.excluded ? "持续阻止再次补标" : "恢复允许提交；历史驳回仍保留"}</p>
        {preview.change.exclusionEventId !== undefined && <p style={{ overflowWrap: "anywhere" }}>请核对精确作用域：{preview.change.entityId}<br/>当前排除事件：{preview.change.exclusionEventId}<br/>原建议编号（可能已不可用）：{preview.change.proposalId}</p>}
        <button type="button" onClick={() => void run(true)}>{preview.change.excluded ? "确认持续排除" : "确认撤销排除"}</button>
        <button type="button" onClick={() => setPreview(null)}>取消</button>
      </>}
    </fieldset>
    {busy && <p role="status">正在核对偏好…</p>}{error && <p role="alert">{error}</p>}
  </details>;
}
