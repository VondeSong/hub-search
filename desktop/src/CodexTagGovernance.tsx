import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { CodexDefinitionModel } from "./CodexDefinitionModel";
import { publishCodexNotice, useCodexSuite } from "./CodexSuite";
import "./CodexTagGovernance.css";
import { TagTaskActivity } from "./ModelJobActivity";

type Audit = { status: string; stale: boolean; catalogReviewed: number; catalogTotal: number; tagsAnalyzed: number; pairsAnalyzed: number; candidatePending: number };
type Report = { analyzed: number; submitted: { proposalId: string; tags: string[]; previewError?: string; preview?: { stale?: boolean; reviewBlocked?: boolean; reviewBlockers?: { message?: string }[] } }[]; errors: string[]; coverage: string; audit?: Audit };

export function CodexTagGovernance({ tagId, onCompleted }: { tagId?: string; onCompleted: () => void }) {
  const suite = useCodexSuite();
  const { model, reasoningEffort: effort, fast } = suite.settings;
  const available = suite.loaded && !suite.error;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(() => { if (error) publishCodexNotice(error, "error", 6000); }, [error]);
  useEffect(() => {
    const token = ++generation.current;
    setReport(null); setError(""); setAudit(null);
    if (!tagId) void invoke<{ run: Audit | null }>("tag_assignment", { args: { action: "governance_audit_status" } })
      .then(result => { if (generation.current === token) setAudit(result.run); })
      .catch(reason => { if (generation.current === token) setError(`无法读取进度：${String(reason)}`); });
    return () => { generation.current++; };
  }, [tagId]);
  const run = async () => {
    if (running.current || !available) return;
    const token = generation.current;
    running.current = true; setBusy(true); setError("");
    publishCodexNotice(tagId ? "模型正在分析标签关系…" : "模型正在检查全部标签…", "working", 5000);
    try {
      const result = await invoke<Report>("tag_assignment", { args: { action: "governance_analyze", global: !tagId, restart: !tagId && audit?.status === "completed", tag: tagId, model, reasoningEffort: effort, fast } });
      publishCodexNotice(result.errors.length ? result.errors.join("；") : `标签治理已生成 ${result.submitted.length} 项分析记录，请审核`, result.errors.length ? "warning" : "success", 6000);
      if (token === generation.current) {
        setReport(result); if (result.audit) setAudit(result.audit); onCompleted();
      }
    } catch (reason) {
      if (token !== generation.current) publishCodexNotice(String(reason), "error", 6000);
      if (token === generation.current) {
        setError(String(reason));
        if (!tagId) {
          try {
            const current = await invoke<{ run: Audit | null }>("tag_assignment", { args: { action: "governance_audit_status" } });
            if (token === generation.current) {
              setAudit(current.run);
              if (current.run?.stale) setError("检查期间数据发生变化，旧记录已保留。点击“按最新数据重新检查”即可继续。");
            }
          } catch { /* Keep the original failure when status is unavailable. */ }
        }
      }
    } finally { running.current = false; setBusy(false); }
  };
  const continuing = audit && !audit.stale && audit.status !== "completed";
  return <div className="tag-governance-codex">
    <div className="tag-governance-codex-toolbar">
      <CodexDefinitionModel />
      <button className="codex-governance-run" type="button" disabled={busy || !available} onClick={() => void run()}>
        {busy ? "模型正在分析…" : tagId ? "用模型 分析标签关系" : audit?.stale ? "按最新数据重新检查" : continuing ? "继续全局检查" : audit?.status === "completed" ? "重新全局检查" : "用模型 检查全部标签"}
      </button>
    </div>
    <p>{tagId ? "比较当前标签与相关标签的原文证据，生成待审核的关系建议。" : "分批筛选全部标签，每次深入核对最多 2 个候选；进度自动保存。"} 建议由你审核后生效。</p>
    <TagTaskActivity tag={tagId || ""} workflows={["tag-governance"]}/>
    {audit && <div className="tag-governance-codex-progress">{audit.stale ? "旧检查依据已过期，记录仍保留。点击上方按钮，按最新数据建立新一轮检查。" : <>目录已筛选 {audit.catalogReviewed} / {audit.catalogTotal} 个 · 深入核对 {audit.tagsAnalyzed} 个标签、{audit.pairsAnalyzed} 对关系 · 待继续 {audit.candidatePending} 项</>}</div>}
    {report && <div aria-live="polite" className="tag-governance-codex-result">
      <strong>本次已保存 {report.submitted.length} 项分析记录</strong>
      <p>具体结论、依据和可执行建议见下方。证据不足的记录不会直接修改标签。</p>
      {report.submitted.filter(item => item.previewError || item.preview?.stale || item.preview?.reviewBlocked).map(item => <p key={item.proposalId}>{item.tags.join(" / ")}：{item.previewError ? `已保存，但预演失败：${item.previewError}` : item.preview?.stale ? "证据已过期，需要重新分析" : "暂不能批准，请查看下方记录中的原因"}</p>)}
      <small>{report.coverage}</small>
    </div>}
  </div>;
}
