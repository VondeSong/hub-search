import { AgentArtifactSource } from "./AgentArtifactSource";
import type { SleepDatasetItem } from "./AgentSleepDatasets";
import { Component, memo, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

type SleepDataset = {
  datasetId?: string;
  revision: number; inclusionRule: string; dateRule: string;
  coverage: { material: { read: number; matched: number }; dates: { recognizedSections: number; uniqueDates: number; unassignedCharacters: number }; metric: { candidates: number; accepted: number; excluded: number; datesWithoutAcceptedValue: number } };
  rows: { rowId: string; eventDate: string | null; rawValue: string; normalizedValue: number | null; timezone: string; reviewState: string; reviewBasis: { kind: string; reason: string }; ambiguity: string; exclusionReason: string; evidenceRefs: { itemIndex: number; start: number; end: number; text: string }[] }[];
};

export type AnalysisChart = {
  artifactId: string; revision: number; state: "draft" | "checked" | "stale" | "unavailable"; message?: string;
  content?: {
    contentHash?: string;
    specVersion: number; spec: { title: string; mark: "bar" | "line"; term: string | null };
    data: { unit: string; rows: { group: string; value: number; sampleCount?: number }[]; extractionDataset?: SleepDataset; statistics: {
      documentsAnalyzed: number; unassignedCharacters: number; duplicateDateSections: number;
      inputSet: { sourceAsOf: number; expiresAt: number };
    } };
  };
};

class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">图形暂时无法显示，仍可展开下方数据表核对。</p> : this.props.children; }
}

const ChartGraphic = memo(function ChartGraphic({ chart }: { chart: NonNullable<AnalysisChart["content"]>; identity: string }) {
  const { rows, unit } = chart.data;
  const axes = <>
    <CartesianGrid vertical={false} stroke="var(--hub-separator)" strokeDasharray="3 4" />
    <XAxis dataKey="group" tick={{ fontSize: 11, fill: "var(--hub-text-secondary)" }} minTickGap={28} tickLine={false} axisLine={false} />
    <YAxis allowDecimals={Boolean(chart.data.extractionDataset)} domain={[0, "auto"]} tick={{ fontSize: 11, fill: "var(--hub-text-secondary)" }} width={52} tickLine={false} axisLine={false} />
    <Tooltip contentStyle={{ background: "var(--hub-content-surface)", borderColor: "var(--hub-separator)", borderRadius: 8, color: "var(--hub-text-primary)" }} />
  </>;
  return <div className="agent-chart-canvas" role="img" aria-label={`${chart.spec.title}，${rows.length} 个分组，单位：${unit}。完整数值见下方数据表。`}>
      {chart.spec.mark === "bar" ? <BarChart responsive data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} accessibilityLayer>
        {axes}<Bar dataKey="value" name={unit} fill="var(--hub-accent)" maxBarSize={44} isAnimationActive={false} />
      </BarChart> : <LineChart responsive data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} accessibilityLayer>
        {axes}<Line type="linear" dataKey="value" name={unit} stroke="var(--hub-accent)" strokeWidth={2} isAnimationActive={false} dot={{ r: 3 }} />
      </LineChart>}
  </div>;
// Artifact revisions are immutable. Fresh host eligibility still decides whether
// this graphic is mounted; status records need not rerun the chart's Redux tree.
}, (before, after) => before.identity === after.identity);

export function AgentCharts({ items, revoked, workId, recordVersion, separateSleepDatasets }: { items: AnalysisChart[]; revoked: boolean; workId?: string; recordVersion?: number; separateSleepDatasets?: SleepDatasetItem[] }) {
  if (revoked || !items.length) return null;
  return <section className="agent-charts" aria-label="分析图表">
    <h3>分析图表</h3>
    {items.map(item => {
      const chart = item.content;
      if (item.state === "unavailable" || !chart || chart.specVersion !== 1) return <p key={item.artifactId} className="agent-notice">{item.message || "此图表暂不可用，请重新检查分析输入。"}</p>;
      const { statistics, rows, unit, extractionDataset: sleep } = chart.data;
      return <section className="agent-chart" key={`${item.artifactId}:${item.revision}`} aria-label={chart.spec.title}>
        <h4>{chart.spec.title}</h4>
        <p className="agent-note">第 {item.revision} 版 · {item.state === "checked" ? "数值已核对" : item.state === "stale" ? "要求或依据已更新，需修订并重新检查" : "数值待核对"} · 视觉待检查</p>
        <ChartBoundary key={`${item.artifactId}:${item.revision}`}><ChartGraphic chart={chart} identity={`${item.artifactId}:${item.revision}`} /></ChartBoundary>
        <details className="agent-chart-table"><summary>查看数据（{rows.length} 个分组）</summary>
          <div className="agent-table-scroll"><table><caption>{chart.spec.title} · 第 {item.revision} 版{chart.spec.term ? ` · 关键词：${chart.spec.term}` : ""}</caption>
            <thead><tr><th scope="col">分组</th><th scope="col">{unit}</th>{sleep && <th scope="col">有效样本数</th>}</tr></thead>
            <tbody>{rows.map(row => <tr key={row.group}><th scope="row">{row.group || "全部"}</th><td>{row.value.toLocaleString()}</td>{sleep && <td>{row.sampleCount}</td>}</tr>)}</tbody>
          </table></div>
        </details>
        <p className="agent-note">基于 {statistics.documentsAnalyzed} 份本地材料的固定输入，未核验远端完整性。{statistics.inputSet?.sourceAsOf ? `捕获于 ${new Date(statistics.inputSet.sourceAsOf * 1000).toLocaleString()}。` : ""}{sleep ? "只聚合已接受的精确主睡眠时长；空缺月份不补零。" : "文字提及不代表事件发生率。"}</p>
        {sleep && (separateSleepDatasets?.some(dataset => dataset.state !== "unavailable" && dataset.content && dataset.datasetId === sleep.datasetId && dataset.revision === sleep.revision)
          ? <p className="agent-note">此图采用的数据第 {sleep.revision} 版，逐行依据见下方同版睡眠证据表；筛选不改变本图统计。</p>
          : <details className="agent-chart-table"><summary>核对睡眠记录与出处（数据第 {sleep.revision} 版）</summary>
          <p className="agent-note">{sleep.inclusionRule}。{sleep.dateRule}。</p>
          <p className="agent-note">材料读取：{sleep.coverage.material.read}/{sleep.coverage.material.matched} 份固定材料（宿主读取）；日期识别：{sleep.coverage.dates.recognizedSections} 个日期段、{sleep.coverage.dates.uniqueDates} 个记录日，无日期文字 {sleep.coverage.dates.unassignedCharacters} 字符；指标：{sleep.coverage.metric.candidates} 个候选中纳入 {sleep.coverage.metric.accepted} 个、排除 {sleep.coverage.metric.excluded} 个，{sleep.coverage.metric.datesWithoutAcceptedValue} 个记录日无有效值；来源历史覆盖：未知。</p>
          {sleep.rows.map(row => <section key={row.rowId} aria-label={row.eventDate || "日期未知"}>
            <p>{row.eventDate || "日期未知"} · {row.timezone} · {row.reviewState === "accepted_for_analysis" ? `纳入：${row.normalizedValue} 小时` : "未纳入"} · 原值：{row.rawValue}</p>
            <p className="agent-note">{row.reviewBasis.kind === "userCorrection" ? "依据用户纠正" : "模型语义评审"}：{row.reviewBasis.reason}。{row.ambiguity} {row.exclusionReason}</p>
            {row.evidenceRefs.map((e, index) => <div key={index}><blockquote><p>{e.text}</p><footer>固定材料 {e.itemIndex + 1} · 字符区间 [{e.start}, {e.end})</footer></blockquote>{workId && <AgentArtifactSource key={recordVersion} workId={workId} artifactId={item.artifactId} revision={item.revision} rowId={row.rowId} evidenceIndex={index} />}</div>)}
          </section>)}
          <p className="agent-note">出处与数值结构已核对；语义评审不等于独立事实认证。</p>
        </details>)}
        {!sleep && (statistics.unassignedCharacters > 0 || statistics.duplicateDateSections > 0) && <p className="agent-note">无日期文字：{statistics.unassignedCharacters.toLocaleString()} 字符；同库重复日期段：{statistics.duplicateDateSections}。重复日期合并计天数，正文中的提及次数仍累计。</p>}
      </section>;
    })}
    <p className="agent-note">继续输入修改要求，可调整同一图表并保留版本。</p>
  </section>;
}
