// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentCharts, type AnalysisChart } from "./AgentCharts";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 360, 240));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const chart = (): AnalysisChart => ({ artifactId: "chart-test", revision: 1, state: "checked", content: {
  specVersion: 1, spec: { title: "学习提及次数", mark: "bar", term: "学习" }, data: {
    unit: "文字提及次数", rows: [{ group: "2025-01", value: 2 }, { group: "2025-02", value: 1 }],
    statistics: { documentsAnalyzed: 2, unassignedCharacters: 3, duplicateDateSections: 1, inputSet: { sourceAsOf: 1, expiresAt: 9999 } },
  },
} });

it("renders the same bounded rows as a chart and accessible table with accurate check labels", async () => {
  await act(async () => root.render(<AgentCharts items={[chart()]} revoked={false} />));
  expect(host.querySelector("svg")).not.toBeNull();
  expect([...host.querySelectorAll("tbody tr")].map(row => row.textContent)).toEqual(["2025-012", "2025-021"]);
  expect(host.textContent).toContain("数值已核对"); expect(host.textContent).toContain("视觉待检查");
  expect(host.textContent).toContain("未核验远端完整性"); expect(host.textContent).toContain("同库重复日期段：1");
  expect(host.querySelector('th[scope="col"]')?.textContent).toBe("分组");
});

it("keeps an unchanged chart and open data table mounted across unrelated Work records", async () => {
  await act(async () => root.render(<AgentCharts items={[chart()]} revoked={false} recordVersion={1} />));
  const graphic = host.querySelector("svg");
  const table = host.querySelector<HTMLDetailsElement>("details")!;
  table.open = true;
  // A progress/public message advances the Work record cursor, not the chart.
  await act(async () => root.render(<AgentCharts items={[chart()]} revoked={false} recordVersion={2} />));
  expect(host.querySelector("svg")).toBe(graphic);
  expect(host.querySelector("details")).toBe(table);
  expect(table.open).toBe(true);
  const revised = chart(); revised.revision = 2; revised.content!.spec.mark = "line";
  await act(async () => root.render(<AgentCharts items={[revised]} revoked={false} recordVersion={3} />));
  expect(host.querySelector("svg")).not.toBe(graphic);
  expect(host.querySelector(".recharts-line")).not.toBeNull();
});

it("replaces the current revision without retaining old numbers and hides inaccessible data", async () => {
  const first = chart(); await act(async () => root.render(<AgentCharts items={[first]} revoked={false} />));
  const next = chart(); next.revision = 2; next.state = "draft"; next.content!.spec.mark = "line"; next.content!.data.rows = [{ group: "新分组", value: 9 }];
  await act(async () => root.render(<AgentCharts items={[next]} revoked={false} />));
  expect(host.textContent).toContain("第 2 版"); expect(host.textContent).toContain("数值待核对"); expect(host.textContent).not.toContain("2025-01");
  expect(host.querySelector(".recharts-line")).not.toBeNull();
  await act(async () => root.render(<AgentCharts items={[{ ...next, state: "unavailable" }]} revoked={false} />));
  expect(host.textContent).not.toContain("学习"); expect(host.querySelector("table")).toBeNull();
  await act(async () => root.render(<AgentCharts items={[next]} revoked />)); expect(host.textContent).toBe("");
});

it("treats future specs as unavailable and never interprets title markup", async () => {
  const value = chart(); value.content!.spec.title = "<script>alert(1)</script>";
  await act(async () => root.render(<AgentCharts items={[value]} revoked={false} />));
  expect(host.querySelector("script")).toBeNull(); expect(host.querySelector("h4")?.textContent).toBe(value.content!.spec.title);
  value.content!.specVersion = 2;
  await act(async () => root.render(<AgentCharts items={[value]} revoked={false} />));
  expect(host.querySelector("svg")).toBeNull(); expect(host.textContent).toContain("暂不可用");
});

it("shares row evidence only when the separately displayed dataset identity and revision match", async () => {
  const value = chart();
  value.content!.data.extractionDataset = { datasetId: "sleep-table", revision: 2, inclusionRule: "原规则", dateRule: "原日期", rows: [],
    coverage: { material: { read: 1, matched: 1 }, dates: { recognizedSections: 1, uniqueDates: 1, unassignedCharacters: 0 }, metric: { candidates: 0, accepted: 0, excluded: 0, datesWithoutAcceptedValue: 1 } } };
  await act(async () => root.render(<AgentCharts items={[value]} revoked={false} separateSleepDatasets={[{ datasetId: "sleep-table", revision: 2, state: "current", content: value.content!.data.extractionDataset! }]} />));
  expect(host.textContent).toContain("逐行依据见下方同版睡眠证据表");
  expect(host.textContent).not.toContain("核对睡眠记录与出处");
  const published = [...host.querySelectorAll("tbody tr")].map(row => row.textContent);
  for (const separate of [{ datasetId: "other", revision: 2, state: "current" as const }, { datasetId: "sleep-table", revision: 3, state: "current" as const }, { datasetId: "sleep-table", revision: 2, state: "unavailable" as const }]) {
    await act(async () => root.render(<AgentCharts items={[value]} revoked={false} separateSleepDatasets={[separate]} />));
    expect(host.textContent).toContain("核对睡眠记录与出处");
    expect([...host.querySelectorAll("tbody tr")].map(row => row.textContent)).toEqual(published);
  }
});

it.runIf(Boolean(import.meta.env.VITE_HUB_CHART_TEST_VIEW_JSON))("consumes the actual Rust serialized Work view through the production chart component", async () => {
  const view = JSON.parse(import.meta.env.VITE_HUB_CHART_TEST_VIEW_JSON);
  expect(view.analysisArtifacts).toHaveLength(1);
  await act(async () => root.render(<AgentCharts items={view.analysisArtifacts} revoked={view.work.state === "revoked"} />));
  const saved = view.analysisArtifacts[0].content;
  expect(saved.data.rows).toEqual([{ group: "2025-01", value: 2 }, { group: "2025-02", value: 1 }]);
  expect(host.querySelectorAll("tbody tr")).toHaveLength(saved.data.rows.length);
  expect(host.querySelector("h4")?.textContent).toBe(saved.spec.title);
  expect(host.textContent).toContain(new Date(saved.data.statistics.inputSet.sourceAsOf * 1000).toLocaleString());
  expect(host.textContent).toContain("数值已核对"); expect(host.querySelector("svg")).not.toBeNull();
});

it.runIf(Boolean(import.meta.env.VITE_HUB_SLEEP_VIEW_JSON))("renders sleep correction, coverage and source evidence from the actual persisted Work sequence", async () => {
  const sequence = JSON.parse(import.meta.env.VITE_HUB_SLEEP_VIEW_JSON);
  const render = async (view: { analysisArtifacts: AnalysisChart[] }) => act(async () => root.render(<AgentCharts items={view.analysisArtifacts} revoked={false} />));
  await render(sequence.before);
  expect(host.querySelector("tbody tr")?.textContent).toBe("2025-017.52");
  expect(host.textContent).toContain("来源历史覆盖：未知");
  expect(host.textContent).toContain("3 个候选中纳入 2 个、排除 1 个");
  expect(host.textContent).toContain("1 个记录日无有效值");
  expect(host.textContent).toContain("起止时间不能证明实际睡眠时长");
  expect(host.textContent).not.toContain("文字提及不代表事件发生率");
  await render(sequence.stale);
  expect(host.textContent).toContain("要求或依据已更新");
  expect(host.textContent).not.toContain("数值已核对");
  expect(host.querySelector("tbody tr")?.textContent).toBe("2025-017.52");
  await render(sequence.repaired);
  expect(host.querySelector("tbody tr")?.textContent).toBe("2025-017.252");
  expect(host.textContent).toContain("数据第 2 版");
  expect(host.textContent).toContain("复核更正：实际主睡眠6.5小时。");
  expect(host.textContent).toContain("数值已核对");
  expect(host.textContent).toContain("模型语义评审");
  expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(host.querySelector("svg")).not.toBeNull();
});
