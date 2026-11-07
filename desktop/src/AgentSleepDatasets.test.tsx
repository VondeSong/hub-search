// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSleepDatasets, type SleepDatasetItem } from "./AgentSleepDatasets";
import { AgentArtifactSource } from "./AgentArtifactSource";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const dataset = (): SleepDatasetItem => ({ datasetId: "sleep-same", revision: 1, state: "current", content: {
  inclusionRule: "未知不补零", dateRule: "固定文件日",
  coverage: { material: { read: 26, matched: 26 }, dates: { uniqueDates: 26 }, metric: { accepted: 0 } },
  rows: Array.from({ length: 10 }, (_, i) => ({ rowId: `row-${i}`, eventDate: `2025-07-${String(i + 1).padStart(2, "0")}`,
    rawValue: "未知", normalizedValue: null, timezone: "Asia/Shanghai", reviewState: "rejected", ambiguity: "无精确值", exclusionReason: "排除",
    reviewBasis: { kind: "modelReview", reason: "依据原文" }, evidenceRefs: [{ itemIndex: i, start: 1, end: 4, text: "😀e\u0301" }] })),
} });
const source = () => ({ title: "固定原文", content: "前😀e\u0301后", start: 0, end: 5, totalCharacters: 5,
  inputSet: { sourceAsOf: 1, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, evidence: { start: 1, end: 4, text: "😀e\u0301" } });
const click = (button: HTMLButtonElement) => act(async () => button.click());
const openData = () => act(async () => {
  const table = host.querySelector<HTMLDetailsElement>("details")!;
  table.open = true; table.dispatchEvent(new Event("toggle"));
});

it("opens all saved rows without a chart, keeping exact identity and scalar highlights", async () => {
  await act(async () => root.render(<AgentSleepDatasets items={[dataset()]} workId="work-same" revoked={false} />));
  expect(host.querySelector("svg")).toBeNull(); expect(host.textContent).toContain("10 行");
  expect(host.querySelector("button")).toBeNull(); await openData();
  expect(host.textContent).toContain("不等于已确认主睡眠事件数"); expect(host.textContent).not.toContain("0 小时");
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")]; expect(buttons).toHaveLength(10);
  expect(invoke).not.toHaveBeenCalled(); invoke.mockResolvedValue(source()); await click(buttons[0]);
  expect(invoke).toHaveBeenCalledWith("agent_investigation", { args: { action: "sleepDatasetSource", id: "work-same", datasetId: "sleep-same", revision: 1, rowId: "row-0", evidenceIndex: 0 } });
  expect(host.querySelector("mark")?.textContent).toBe("😀e\u0301");
});
it("discards a late private source response on revocation", async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockImplementation(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(<AgentSleepDatasets items={[dataset()]} workId="work-same" revoked={false} />));
  await openData();
  await click(host.querySelector<HTMLButtonElement>("button")!);
  await act(async () => root.render(<AgentSleepDatasets items={[dataset()]} workId="work-same" revoked />));
  await act(async () => resolve(source())); expect(host.textContent).toBe("");
});
it("resets open source state at a new revision and hides unavailable data", async () => {
  invoke.mockResolvedValue(source());
  await act(async () => root.render(<AgentSleepDatasets items={[dataset()]} workId="work-same" revoked={false} />));
  await openData();
  await click(host.querySelector<HTMLButtonElement>("button")!); expect(host.querySelector("mark")).not.toBeNull();
  await act(async () => root.render(<AgentSleepDatasets items={[{ ...dataset(), revision: 2 }]} workId="work-same" revoked={false} />));
  expect(host.querySelector("mark")).toBeNull();
  await act(async () => root.render(<AgentSleepDatasets items={[{ datasetId: "sleep-same", revision: 2, state: "unavailable", message: "授权已改变" }]} workId="work-same" revoked={false} />));
  expect(host.textContent).toContain("授权已改变"); expect(host.querySelector("button")).toBeNull();
});
it("keeps the data table open on progress while invalidating its separately authorized source preview", async () => {
  invoke.mockResolvedValue(source());
  await act(async () => root.render(<AgentSleepDatasets items={[dataset()]} workId="work-same" recordVersion={1} revoked={false} />));
  await openData(); const table = host.querySelector<HTMLDetailsElement>("details")!;
  await click(host.querySelector<HTMLButtonElement>("button")!);
  expect(host.querySelector("mark")).not.toBeNull();
  await act(async () => root.render(<AgentSleepDatasets items={[dataset()]} workId="work-same" recordVersion={2} revoked={false} />));
  expect(host.querySelector("details")).toBe(table);
  expect(table.open).toBe(true);
  expect(host.querySelector("mark")).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("preserves the chart-bound source route", async () => {
  invoke.mockResolvedValue(source());
  await act(async () => root.render(<AgentArtifactSource workId="work-same" artifactId="chart-same" revision={3} rowId="row-old" evidenceIndex={0} />));
  await click(host.querySelector<HTMLButtonElement>("button")!);
  expect(invoke).toHaveBeenCalledWith("agent_investigation", { args: { action: "artifactSource", id: "work-same", artifactId: "chart-same", revision: 3, rowId: "row-old", evidenceIndex: 0 } });
});

it("filters evidence rows locally without changing coverage, values or issuing any request", async () => {
  const value = dataset(); value.content!.rows = value.content!.rows.slice(0, 3);
  Object.assign(value.content!.rows[0], { rawValue: "主睡眠7小时", normalizedValue: 7, valueKind: "exact", reviewState: "accepted_for_analysis" });
  Object.assign(value.content!.rows[1], { rawValue: "六个多小时", valueKind: "ambiguous" });
  Object.assign(value.content!.rows[2], { rawValue: "明确醒来，未写时长", valueKind: "missing", reviewState: "proposed" });
  const saved = JSON.stringify(value);
  await act(async () => root.render(<AgentSleepDatasets items={[value]} workId="work-same" revoked={false} evidenceTable />));
  await openData();
  expect(host.querySelector("caption")?.textContent).toContain("标准单位：小时");
  expect(host.querySelectorAll('th[scope="col"]')).toHaveLength(6);
  const [kind, review] = host.querySelectorAll("select");
  expect(kind.closest("label")?.textContent).toContain("值的类型");
  await act(async () => { kind.value = "ambiguous"; kind.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(host.querySelector("tbody")?.textContent).toContain("六个多小时");
  expect(host.textContent).toContain("显示 1/3 行");
  expect(host.textContent).toContain("材料读取 26/26");
  await act(async () => { review.value = "accepted_for_analysis"; review.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
  expect(host.textContent).toContain("不表示原材料没有记录");
  await act(async () => { kind.value = ""; kind.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { review.value = ""; review.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelectorAll("tbody tr")).toHaveLength(3);
  expect(JSON.stringify(value)).toBe(saved); expect(invoke).not.toHaveBeenCalled();
  expect(host.querySelector("tbody")?.textContent).not.toContain("0 小时");
});

it("keeps legacy value kind unknown and attributed corrections separate from inclusion", async () => {
  const value = dataset(); value.content!.rows = value.content!.rows.slice(0, 1);
  value.content!.rows[0].reviewBasis = { kind: "userCorrection", reason: "用户更正，仍待纳入评审" };
  await act(async () => root.render(<AgentSleepDatasets items={[value]} workId="work-same" revoked={false} evidenceTable />));
  await openData();
  const row = host.querySelector("tbody tr")!;
  expect(row.textContent).toContain("类型未记录"); expect(row.textContent).toContain("依据用户纠正");
  expect(row.textContent).toContain("未知，不补零"); expect(row.textContent).toContain("排除");
  expect(row.getAttribute("data-row-id")).toBe("row-0");
  invoke.mockResolvedValue(source()); await click(row.querySelector("button")!);
  expect(invoke).toHaveBeenCalledWith("agent_investigation", { args: { action: "sleepDatasetSource", id: "work-same", datasetId: "sleep-same", revision: 1, rowId: "row-0", evidenceIndex: 0 } });
});

it("discards a late source when filtering its row away and resets filters at a new revision", async () => {
  const value = dataset(); value.content!.rows = value.content!.rows.slice(0, 1);
  let resolve!: (value: unknown) => void;
  invoke.mockImplementation(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(<AgentSleepDatasets items={[value]} workId="work-same" revoked={false} evidenceTable />));
  await openData(); await click(host.querySelector("tbody button")!);
  await act(async () => { const select = host.querySelector("select")!; select.value = "exact"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => resolve(source())); expect(host.querySelector("mark")).toBeNull();
  await act(async () => root.render(<AgentSleepDatasets items={[{ ...value, revision: 2 }]} workId="work-same" revoked={false} evidenceTable />));
  await openData(); expect(host.querySelector("select")?.value).toBe("");
  expect(host.querySelectorAll("tbody tr")).toHaveLength(1); expect(invoke).toHaveBeenCalledTimes(1);
});

it("captures Escape before an ancestor native listener, closes only the fixed source and returns focus", async () => {
  let ancestorClosed = false;
  host.addEventListener("keydown", event => { if (event.key === "Escape") ancestorClosed = true; });
  invoke.mockResolvedValue(source());
  await act(async () => root.render(<AgentArtifactSource workId="work-same" datasetId="sleep-same" revision={1} rowId="row-0" evidenceIndex={0} />));
  const trigger = host.querySelector<HTMLButtonElement>("button")!;
  await click(trigger); expect(host.querySelector("mark")).not.toBeNull();
  expect(document.activeElement).toBe(host.querySelector(".agent-source-preview"));
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(ancestorClosed).toBe(false); expect(host.querySelector("mark")).toBeNull();
  expect(document.activeElement).toBe(trigger); expect(host.querySelectorAll("button")).toHaveLength(1);
});
