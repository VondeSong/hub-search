// @vitest-environment jsdom
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSleepDatasets, type SleepDatasetItem } from "./AgentSleepDatasets";
import { AgentCharts, type AnalysisChart } from "./AgentCharts";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 464, 240));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const dataset = (): SleepDatasetItem => ({ datasetId: "saved-month", revision: 1, state: "current", content: {
  inclusionRule: "不补零", dateRule: "固定记录日",
  coverage: { material: { read: 26, matched: 26 }, dates: { uniqueDates: 26 }, metric: { accepted: 0 } },
  rows: Array.from({ length: 9 }, (_, i) => ({ rowId: `row-${i}`, eventDate: "2025-07-01", rawValue: "睡眠未明",
    normalizedValue: null, timezone: "Asia/Shanghai", reviewState: "rejected", ambiguity: "无精确值", exclusionReason: "排除",
    reviewBasis: { kind: "modelReview", reason: "模型阅读固定原文" }, evidenceRefs: [{ itemIndex: i, start: 0, end: 4, text: "睡眠未明" }] })),
} });
async function toggle(open: boolean) {
  await act(async () => { const details = host.querySelector("details")!; details.open = open; details.dispatchEvent(new Event("toggle")); });
}
it("keeps closed saved month rows unmounted until the user opens the disclosure", async () => {
  await act(async () => root.render(<AgentSleepDatasets items={[dataset()]} workId="work-month" recordVersion={1} revoked={false} />));
  expect(host.textContent).toContain("9 行");
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(host.textContent).not.toContain("睡眠未明");
  await toggle(true);
  expect(host.querySelectorAll("button")).toHaveLength(9);
  expect(host.textContent).toContain("睡眠未明"); expect(invoke).not.toHaveBeenCalled();
  const details = host.querySelector("details");
  await act(async () => root.render(<AgentSleepDatasets items={[dataset()]} workId="work-month" recordVersion={2} revoked={false} />));
  expect(host.querySelector("details")).toBe(details); expect(details?.open).toBe(true);
});
it("discards a fixed source response after its disclosure is closed", async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockImplementation(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(<AgentSleepDatasets items={[dataset()]} workId="work-month" revoked={false} />));
  await toggle(true); await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(invoke).toHaveBeenCalledTimes(1);
  await toggle(false);
  await act(async () => resolve({ title: "固定原文", content: "睡眠未明", start: 0, end: 4, totalCharacters: 4,
    inputSet: { sourceAsOf: 1, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, evidence: { start: 0, end: 4, text: "睡眠未明" } }));
  expect(host.querySelector("mark")).toBeNull(); expect(host.querySelector("button")).toBeNull();
  await toggle(true); expect(host.querySelector("mark")).toBeNull();
});
it("first lays out a chart at its measured width without committing a guessed360px chart", async () => {
  const widths: number[] = [];
  const observer = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === "attributes" && r.target instanceof SVGElement && r.target.tagName.toLowerCase() === "svg") {
        if (r.oldValue) widths.push(Number(r.oldValue)); widths.push(Number(r.target.getAttribute("width")));
      }
      for (const added of r.addedNodes) if (added instanceof Element)
        for (const svg of added.matches("svg") ? [added] : added.querySelectorAll("svg")) widths.push(Number(svg.getAttribute("width")));
    }
  });
  observer.observe(host, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["width"] });
  const chart: AnalysisChart = { artifactId: "chart-cold", revision: 1, state: "checked", content: {
    specVersion: 1, spec: { title: "代表数据", mark: "bar", term: null }, data: { unit: "次数", rows: [{ group: "2025-01", value: 2 }],
      statistics: { documentsAnalyzed: 1, unassignedCharacters: 0, duplicateDateSections: 0, inputSet: { sourceAsOf: 1, expiresAt: 9999 } } } } };
  await act(async () => root.render(<AgentCharts items={[chart]} revoked={false} />));
  await Promise.resolve(); observer.disconnect();
  expect(host.querySelector("svg")?.getAttribute("width")).toBe("464");
  expect(widths).not.toContain(360);
});

it.runIf(Boolean(import.meta.env.VITE_HUB_COLD_CHART_JSON))("replays the saved C6 cold chart through its real renderer", async () => {
  const item: AnalysisChart = JSON.parse(import.meta.env.VITE_HUB_COLD_CHART_JSON);
  const commits: { phase: string; duration: number; width: string | null }[] = [];
  const render = async (version: number) => act(async () => root.render(
    <Profiler id="saved-cold-chart" onRender={(_id, phase, duration) => commits.push({ phase, duration, width: host.querySelector("svg")?.getAttribute("width") ?? null })}>
      <AgentCharts items={[JSON.parse(JSON.stringify(item))]} revoked={false} recordVersion={version} />
    </Profiler>));
  await render(1);
  const cold = [...commits]; commits.length = 0;
  await render(2); await render(3);
  console.info("C7_SAVED_CHART_REPLAY", JSON.stringify({ cold, unchangedStatusCommits: commits, nativeFormalGrade: null }));
  expect(host.querySelector("svg")?.getAttribute("width")).toBe("464");
  expect(host.querySelector("tbody tr")?.textContent).toContain("7.25");
  expect(host.textContent).toContain("视觉待检查");
});
