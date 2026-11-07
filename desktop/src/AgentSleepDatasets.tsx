import { AgentArtifactSource } from "./AgentArtifactSource";
import { useState } from "react";

export type SleepDatasetItem = {
  datasetId: string; revision: number; state: "current" | "stale" | "unavailable"; message?: string;
  content?: {
    inclusionRule: string; dateRule: string;
    coverage: { material: { read: number; matched: number }; dates: { uniqueDates: number }; metric: { accepted: number } };
    rows: { rowId: string; eventDate: string | null; rawValue: string; normalizedValue: number | null; timezone: string;
      valueKind?: string;
      reviewState: string; ambiguity: string; exclusionReason: string; reviewBasis: { kind: string; reason: string; sourceRef?: string | null };
      correctionSource?: { kind: string; reason: string; sourceRef?: string | null } | null; supersedes?: string | null;
      evidenceRefs: { itemIndex: number; start: number; end: number; text: string }[] }[];
  };
};

const valueKinds: Record<string, string> = { exact: "精确值", ambiguous: "有歧义", missing: "未记载时长", conflicting: "有冲突" };
const reviewStates: Record<string, string> = { proposed: "待评审", accepted_for_analysis: "纳入分析", rejected: "排除" };

function EvidenceTable({ item, workId, recordVersion, onCorrect }: { item: SleepDatasetItem; workId: string; recordVersion?: number; onCorrect?: (item: SleepDatasetItem, rowId: string) => void }) {
  const [kind, setKind] = useState(""), [review, setReview] = useState("");
  const rows = item.content!.rows;
  const shown = rows.filter(row => (!kind || (kind === "unknown" ? !valueKinds[row.valueKind || ""] : row.valueKind === kind)) && (!review || row.reviewState === review));
  return <>
    <p className="agent-note">粒度：保存的主睡眠候选事件。来源为当前事项授权笔记；记载由模型抽取，评审依据另列。没有候选行不表示未记载、未读或零；读取失败与未覆盖材料不能由此表推断。</p>
    <div className="agent-evidence-filters">
      <label>值的类型<select value={kind} onChange={event => setKind(event.target.value)}><option value="">全部类型</option>{Object.entries(valueKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="unknown">类型未记录</option></select></label>
      <label>分析采用<select value={review} onChange={event => setReview(event.target.value)}><option value="">全部状态</option>{Object.entries(reviewStates).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    <p role="status">显示 {shown.length}/{rows.length} 行。仅筛选显示，覆盖、统计、图表和报告不变，不启动分析。</p>
    <div className="agent-table-scroll" tabIndex={0} role="region" aria-label="睡眠证据表，可横向滚动"><table className="agent-evidence-table">
      <caption>主睡眠候选事件 · 数据第 {item.revision} 版 · 标准单位：小时</caption>
      <thead><tr><th scope="col">日期与时区</th><th scope="col">保存的记载</th><th scope="col">本版值（小时）</th><th scope="col">值的类型</th><th scope="col">分析采用</th><th scope="col">依据与出处</th></tr></thead>
      <tbody>{shown.map(row => <tr key={row.rowId} data-row-id={row.rowId}>
        <th scope="row">{row.eventDate || "日期未知"}<br />{row.timezone}</th><td>{row.rawValue}</td><td>{row.normalizedValue === null ? "未知，不补零" : row.normalizedValue}</td>
        <td>{valueKinds[row.valueKind || ""] || "类型未记录"}</td><td>{reviewStates[row.reviewState] || "状态待核对"}</td>
        <td><p>{row.reviewBasis.kind === "userCorrection" ? "依据用户纠正" : row.reviewBasis.kind === "modelReview" ? "模型语义评审" : "评审来源待核对"}：{row.reviewBasis.reason}</p><p>{row.ambiguity} {row.exclusionReason}</p>
          {row.correctionSource && <p>纠正来源：{row.correctionSource.kind === "userCorrection" ? "用户要求" : row.correctionSource.kind === "modelReview" ? "模型复核" : "来源待核对"}；{row.correctionSource.reason}。{row.supersedes && `替代记录 ${row.supersedes}。`}{row.correctionSource.sourceRef && `依据要求 ${row.correctionSource.sourceRef}。`}</p>}
          {onCorrect && item.state === "current" && <button type="button" onClick={() => onCorrect(item, row.rowId)}>纠正这条记录</button>}
          {row.evidenceRefs.map((evidence, index) => <div key={index}><blockquote><p>{evidence.text}</p><footer>固定材料 {evidence.itemIndex + 1} · 字符区间 [{evidence.start}, {evidence.end})</footer></blockquote><AgentArtifactSource key={recordVersion} workId={workId} datasetId={item.datasetId} revision={item.revision} rowId={row.rowId} evidenceIndex={index} /></div>)}
        </td>
      </tr>)}</tbody>
    </table></div>
    {!shown.length && <p>没有符合当前筛选的保存行；不表示原材料没有记录。</p>}
  </>;
}

function SavedDataset({ item, workId, recordVersion, evidenceTable, onCorrect }: {
  item: SleepDatasetItem; workId: string; recordVersion?: number; evidenceTable?: boolean; onCorrect?: (item: SleepDatasetItem, rowId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return <section className="agent-chart">
      {item.state === "unavailable" || !item.content ? <p role="status">{item.message || "数据依据暂不可用，请重新核对来源。"}</p> : <details className="agent-chart-table" onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>核对睡眠数据与出处（第 {item.revision} 版，{item.content.rows.length} 行）</summary>
        {open && <>
        <p className="agent-note">{item.state === "stale" ? "这是历史数据版本。" : "当前数据版本。"}{item.content.inclusionRule}。{item.content.dateRule}。</p>
        <p className="agent-note">材料读取 {item.content.coverage.material.read}/{item.content.coverage.material.matched} 份，{item.content.coverage.dates.uniqueDates} 个文件记录日；精确时长纳入 {item.content.coverage.metric.accepted} 条。保存行包含候选和排除线索，不等于已确认主睡眠事件数；无值不补零。</p>
        {evidenceTable ? <EvidenceTable item={item} workId={workId} recordVersion={recordVersion} onCorrect={onCorrect} /> : item.content.rows.map(row => <section key={row.rowId} aria-label={`${row.eventDate || "日期未知"} 睡眠记录`}>
          <p>{row.eventDate || "日期未知"} · {row.timezone} · {row.reviewState === "accepted_for_analysis" ? `纳入：${row.normalizedValue} 小时` : "未纳入，数值未知"} · 原值：{row.rawValue}</p>
          <p className="agent-note">{row.reviewBasis.kind === "userCorrection" ? "依据用户纠正" : "模型语义评审"}：{row.reviewBasis.reason}。{row.ambiguity} {row.exclusionReason}</p>
          {row.evidenceRefs.map((evidence, index) => <div key={index}>
            <blockquote><p>{evidence.text}</p><footer>固定材料 {evidence.itemIndex + 1} · 字符区间 [{evidence.start}, {evidence.end})</footer></blockquote>
            <AgentArtifactSource key={recordVersion} workId={workId} datasetId={item.datasetId} revision={item.revision} rowId={row.rowId} evidenceIndex={index} />
          </div>)}
        </section>)}
        <p className="agent-note">固定出处每次打开均重新核对授权和来源；模型分类尚非人工确认金标。</p>
        </>}
      </details>}
    </section>;
}

export function AgentSleepDatasets({ items, workId, recordVersion, revoked, evidenceTable, onCorrect }: {
  items: SleepDatasetItem[]; workId: string; recordVersion?: number; revoked: boolean; evidenceTable?: boolean; onCorrect?: (item: SleepDatasetItem, rowId: string) => void;
}) {
  if (revoked || !items.length) return null;
  return <section className="agent-charts" aria-label="已保存睡眠数据与出处">
    <h3>已保存睡眠数据与出处</h3>
    {items.map(item => <SavedDataset key={`${item.datasetId}:${item.revision}`} item={item} workId={workId} recordVersion={recordVersion} evidenceTable={evidenceTable} onCorrect={onCorrect} />)}
  </section>;
}
