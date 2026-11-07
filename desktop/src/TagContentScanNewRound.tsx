import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

type Plan = { tag: string; definition: { version: number; definition: { description: string; libraryIds: string[] } };
  maxEntities: number; maxChars: number; totalEntities: number; activeRunCount: number; previousRunCount: number; incrementalFromRunId?: string; manifestMode?: string; manifestScope?: string[]; jointSelection?: { tag: string; definitionVersion: number }[]; unionTags?: { tag: string; definitionVersion: number }[] };
type Preview = { plan: Plan; confirmationToken: string };
export function TagContentScanNewRound({ tagId, onCreated, unionTags, incrementalFromRunId }: { tagId: string; onCreated: (id: string) => void; unionTags?: { tag: string; definitionVersion: number }[]; incrementalFromRunId?: string }) {
  const [entities, setEntities] = useState("30"), [chars, setChars] = useState("15000");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const guard = useRef(false), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const valid = Number.isSafeInteger(Number(entities)) && Number(entities) > 0 && Number(entities) <= 5000
    && Number.isSafeInteger(Number(chars)) && Number(chars) > 0 && Number(chars) <= 5000000;
  const inspect = async () => {
    if (!valid || guard.current) return;
    guard.current = true; setBusy(true); setError(""); const n = generation.current;
    try {
      const result = await invoke<Preview>("tag_assignment", { args: { action: "scan_preview_new", tag: tagId, maxEntities: Number(entities), maxChars: Number(chars), ...(unionTags?.length ? { unionTags } : {}), ...(incrementalFromRunId ? { incrementalFromRunId } : {}) } });
      if (n === generation.current) setPreview(result);
    } catch (e) { if (n === generation.current) setError(String(e)); }
    finally { if (n === generation.current) { guard.current = false; setBusy(false); } }
  };
  const create = async () => {
    if (!preview || guard.current) return;
    guard.current = true; setBusy(true); setError(""); const n = generation.current; const p = preview;
    try {
      const result = await invoke<{ run: { runId: string } }>("tag_assignment", { args: { action: "scan_create_new", tag: tagId,
        maxEntities: p.plan.maxEntities, maxChars: p.plan.maxChars, definitionVersion: p.plan.definition.version,
        confirmationToken: p.confirmationToken, requestId: `round-${p.confirmationToken}`, ...(p.plan.unionTags?.length ? { unionTags: p.plan.unionTags } : {}), ...(p.plan.incrementalFromRunId ? { incrementalFromRunId: p.plan.incrementalFromRunId } : {}) } });
      if (n === generation.current) { setPreview(null); onCreated(result.run.runId); }
    } catch (e) { if (n === generation.current) { setPreview(null); setError(`未确认创建结果：${String(e)}。请先刷新历史核对是否已有新任务，不要盲目重复创建。`); } }
    finally { if (n === generation.current) { guard.current = false; setBusy(false); } }
  };
  return <details className="tag-scan-new-round"><summary>{incrementalFromRunId ? "仅检查新增内容" : unionTags?.length ? "新建合并范围检查" : "新建一轮检查"}</summary>
    <p>{incrementalFromRunId ? "继承当前任务的标签定义和资料库范围，只纳入当前任务及其基准链之外的新增定位。不检查旧内容变化，不转移旧任务未完成项；同一基准的其他分支不在排除范围内。" : "新轮次会按当前已确认定义重新建立清单，可能重复读取旧内容。仅想继续旧任务时，请追加原任务预算。"}</p>
    <fieldset className="tag-scan-budget" disabled={busy}>
      {!preview ? <><label>新任务实体额度<input type="number" min={1} max={5000} value={entities} onChange={e => setEntities(e.target.value)} /></label>
        <label>新任务正文字符额度<input type="number" min={1} max={5000000} value={chars} onChange={e => setChars(e.target.value)} /></label>
        <button type="button" disabled={!valid} onClick={() => void inspect()}>预览新轮次</button></> : <div role="group" aria-label="确认新轮次" className="tag-scan-confirm">
        <p>标签 #{preview.plan.tag} · 定义版本 {preview.plan.definition.version}：{preview.plan.definition.definition.description}</p>
        {preview.plan.incrementalFromRunId && <p>增量基准：{preview.plan.incrementalFromRunId}。仅新建新增定位清单，保留基准链及其未完成项；不代表旧内容已分析。</p>}
        {preview.plan.incrementalFromRunId && !!preview.plan.jointSelection?.length && <p>继承额外标签：{preview.plan.jointSelection.map(t => `#${t.tag}（v${t.definitionVersion}）`).join("、")}。</p>}
        {!!preview.plan.unionTags?.length && <p>合并检查：{preview.plan.unionTags.map(t => `#${t.tag}（v${t.definitionVersion}）`).join("、")}。所有标签定义在创建时固定；已有一个标签不跳过其他标签。</p>}
        <p>范围：{(preview.plan.manifestScope ?? preview.plan.definition.definition.libraryIds).join("、")}；当前去重清单 {preview.plan.totalEntities} 个实体。</p>
        <p>新预算：{preview.plan.maxEntities} 个实体、{preview.plan.maxChars.toLocaleString()} 正文字符（不是 token）。</p>
        <p>保留全部 {preview.plan.previousRunCount} 个旧任务，其中 {preview.plan.activeRunCount} 个尚未结束。创建不取消旧任务、不读取正文、不启动 Codex、不批准标签。清单不是全文快照。</p>
        <button type="button" onClick={() => void create()}>确认创建新轮次</button><button type="button" onClick={() => setPreview(null)}>取消新轮次</button>
      </div>}
    </fieldset>
    {busy && <p role="status">正在处理新轮次…</p>}{error && <p role="alert">{error}</p>}
  </details>;
}
