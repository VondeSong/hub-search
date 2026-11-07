// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentDatasetVersions } from "./AgentDatasetVersions";
import type { SleepDatasetItem } from "./AgentSleepDatasets";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const item = (): SleepDatasetItem => ({ datasetId: "dataset-original", revision: 2, state: "current", content: { inclusionRule: "仅主睡眠", dateRule: "固定日期", coverage: { material: { read: 1, matched: 1 }, dates: { uniqueDates: 1 }, metric: { accepted: 1 } }, rows: [{ rowId: "row-one", eventDate: "2026-10-01", rawValue: "6.5小时", normalizedValue: 6.5, timezone: "Asia/Shanghai", valueKind: "exact", reviewState: "accepted_for_analysis", ambiguity: "", exclusionReason: "", reviewBasis: { kind: "modelReview", reason: "读取原文更正" }, correctionSource: { kind: "modelReview", sourceRef: null, reason: "复核明确更正" }, supersedes: "1:row-one", evidenceRefs: [] }] } });
const historical = () => ({ ...item(), revision: 1, currentRevision: 2, state: "stale", content: { ...item().content!, rows: [{ ...item().content!.rows[0], rawValue: "7小时", normalizedValue: 7, correctionSource: null, supersedes: null }] } });
let host: HTMLDivElement, root: Root;
const correct = vi.fn();
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset().mockResolvedValue(historical()); correct.mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(workId = "original", value = item(), recordVersion = 10) { await act(async () => root.render(<AgentDatasetVersions key={`${workId}:${value.revision}:${recordVersion}`} item={value} workId={workId} recordVersion={recordVersion} onCorrect={correct} />)); }
async function select(value: string) { await act(async () => { const s = host.querySelector("select")!; s.value = value; s.dispatchEvent(new Event("change", { bubbles: true })); }); }
async function open() { await act(async () => { const d = host.querySelector("details")!; d.open = true; d.dispatchEvent(new Event("toggle")); }); }
it("uses the existing exact revision read and makes history read-only without changing current data", async () => {
 const current = item(), before = JSON.stringify(current); await render("original", current); await open();
 expect(invoke).not.toHaveBeenCalled(); expect(host.textContent).toContain("纠正来源：模型复核"); expect(host.textContent).toContain("1:row-one");
 await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "纠正这条记录")!.click()); expect(correct).toHaveBeenCalledWith(current, "row-one");
 await select("1"); await open();
 expect(invoke).toHaveBeenCalledExactlyOnceWith("agent_investigation", { args: { action: "sleepDataset", id: "original", datasetId: "dataset-original", revision: 1 } });
 expect(host.textContent).toContain("7小时"); expect(host.textContent).toContain("这是历史数据版本"); expect(host.textContent).not.toContain("纠正这条记录"); expect(JSON.stringify(current)).toBe(before);
 await select("2"); await open(); expect(host.textContent).toContain("6.5小时"); expect(invoke).toHaveBeenCalledTimes(1);
});
it.each([{ datasetId: "foreign" }, { revision: 2 }, { currentRevision: 3 }, { state: "current" }])("rejects a mismatched history envelope %j", async wrong => {
 invoke.mockResolvedValue({ ...historical(), ...wrong }); await render(); await select("1");
 expect(host.textContent).toContain("数据身份或当前版本已变化"); expect(host.textContent).not.toContain("7小时"); expect(host.querySelector("table")).toBeNull();
});
it("ignores a late historical response after returning to current data", async () => {
 let finish!: (v: unknown) => void; invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; })); await render(); await select("1"); await select("2"); await act(async () => finish(historical())); await open();
 expect(host.textContent).toContain("6.5小时"); expect(host.textContent).not.toContain("7小时");
});
it.each(["new-work", "refresh"])("discards old requests when %s invalidates ownership", async change => {
 let finish!: (v: unknown) => void; invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; })); await render(); await select("1");
 await render(change === "new-work" ? "different" : "original", item(), 11); await act(async () => finish(historical())); await open();
 expect(host.textContent).toContain("6.5小时"); expect(host.textContent).not.toContain("7小时");
});
it("shows a denied revision read without retaining its previous contents or pretending the revision is current", async () => {
 invoke.mockRejectedValue(new Error("来源授权已撤回")); await render(); await select("1"); expect(host.textContent).toContain("来源授权已撤回"); expect(host.querySelector("table")).toBeNull(); expect(host.textContent).not.toContain("6.5小时");
});
it("does not offer historical reads or corrections for unavailable source data", async () => {
 await render("original", { datasetId: "dataset-original", revision: 2, state: "unavailable", message: "固定来源已过期" }); expect(host.querySelector("select")).toBeNull(); expect(host.textContent).toContain("固定来源已过期"); expect(invoke).not.toHaveBeenCalled();
});
