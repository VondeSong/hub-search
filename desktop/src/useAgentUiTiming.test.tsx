// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentUiTiming } from "./useAgentUiTiming";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let api: ReturnType<typeof useAgentUiTiming>;
let frames = new Map<number, FrameRequestCallback>(), next = 0;
const host = document.createElement("div");
let root = createRoot(host);
type V = Parameters<typeof useAgentUiTiming>[0];
function Probe({ view, visible = true, accepting = false }: { view: V; visible?: boolean; accepting?: boolean }) { api = useAgentUiTiming(view, visible, accepting); return <p>{view?.work.state}</p>; }
const view = (id: string, state = "investigating", eventKind = "status"): NonNullable<V> => ({ work: { id: "work", state, report: state === "completed" ? {} : null }, run: { id }, nativeTiming: { hostEpochMs: Date.now(), projectionMs: 2 }, activity: [{ runId: id, events: [{ kind: eventKind, label: "正在处理" }] }] });
async function render(value: V, visible = true, accepting = false) { await act(async () => root.render(<Probe view={value} visible={visible} accepting={accepting} />)); }
async function paint() { for (let i = 0; i < 2; i++) { const current = [...frames.values()]; frames.clear(); await act(async () => current.forEach(fn => fn(performance.now()))); } }
function setup() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.set(++next, fn); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  invoke.mockReset().mockImplementation(async (_command, { args }) => args.action === "uiTimingClock" ? { hostEpochMs: performance.timeOrigin + performance.now() } : { recorded: true });
}
afterEach(async () => { await act(async () => root.unmount()); host.replaceChildren(); root = createRoot(host); frames.clear(); vi.unstubAllGlobals(); });
it("keeps phases only for the largest rendered projection of this run in its single terminal record", async () => {
  setup(); await render(view("old", "completed")); api.begin("revision");
  const old = { ...view("old", "completed"), nativeTiming: { hostEpochMs: Date.now(), projectionMs: 999, phases: [{ phase: "foreign", elapsedMs: 999 }] } };
  api.snapshotReceived(old); await render(old); await paint();
  const slow = { ...view("new"), nativeTiming: { hostEpochMs: Date.now(), projectionMs: 170.1, phases: [{ phase: "readPermit", elapsedMs: 1 }, { phase: "databaseSnapshot", elapsedMs: 160 }] } };
  api.snapshotReceived(slow); await render(slow); await paint();
  const done = { ...view("new", "completed"), nativeTiming: { hostEpochMs: Date.now(), projectionMs: 10, phases: [{ phase: "readPermit", elapsedMs: 1 }] } };
  api.snapshotReceived(done); await render(done); await paint();
  const saves = invoke.mock.calls.filter(([, x]) => x.args.action === "uiTiming"); expect(saves).toHaveLength(1);
  const sample = saves[0][1].args.sample;
  expect(sample.slowestProjection).toEqual({ renderIndex: 0, projectionMs: 170.1, phases: slow.nativeTiming.phases, phaseStatus: "recorded" });
  expect(sample.renders[0].projectionMs).toBe(170.1); expect(sample.renders.at(-1).projectionMs).toBe(10);
  expect(invoke.mock.calls.every(([, x]) => ["uiTimingClock", "uiTiming"].includes(x.args.action))).toBe(true);
});
it("retains a larger unqualified peak as unknown instead of replacing it with a smaller valid phase set", async () => {
  setup(); await render(null); api.begin("submit");
  const slow = { ...view("new"), nativeTiming: { hostEpochMs: Date.now(), projectionMs: 180, phases: [{ phase: "databaseSnapshot", elapsedMs: 181 }] } };
  api.snapshotReceived(slow); await render(slow); await paint();
  const done = { ...view("new", "completed"), nativeTiming: { hostEpochMs: Date.now(), projectionMs: 5, phases: [{ phase: "readPermit", elapsedMs: 1 }] } };
  api.snapshotReceived(done); await render(done); await paint();
  const sample = invoke.mock.calls.find(([, x]) => x.args.action === "uiTiming")![1].args.sample;
  expect(sample.slowestProjection).toEqual({ renderIndex: 0, projectionMs: 180, phases: null, phaseStatus: "unavailable" });
});
it("measures the new run after paint, excludes fixed activity and old delivery, and correlates revision", async () => {
  setup(); await render(view("old", "completed")); api.begin("revision");
  api.snapshotReceived(view("old", "completed")); await render(view("old", "completed"), true, true); await paint();
  expect(invoke.mock.calls.filter(([, x]) => x.args.action === "uiTiming")).toHaveLength(0);
  const running = view("new"); api.snapshotReceived(running); await render(running, true, true); await paint();
  api.observeEvent({ workId: "foreign", runId: "new", eventId: "ignore" });
  api.observeEvent({ workId: "work", runId: "new", eventId: "public", eventCategory: "publicStream", publicKind: "message", publicHasText: false, hostObservedEpochMs: Date.now() });
  const feedback = view("new", "investigating", "tool"); api.snapshotReceived(feedback); await render(feedback); await paint();
  const done = view("new", "completed"); api.snapshotReceived(done); await render(done); await paint();
  const saved = invoke.mock.calls.find(([, x]) => x.args.action === "uiTiming")![1].args;
  expect(saved.runId).toBe("new"); expect(saved.id).toBe("work");
  expect(saved.sample.uiAcceptMs).toBeGreaterThanOrEqual(saved.sample.uiSubmitMs);
  expect(saved.sample.uiFirstFeedbackMs).toBeLessThanOrEqual(saved.sample.uiDoneMs);
  expect(saved.sample.uiPatchVisibleMs).toBe(saved.sample.uiDoneMs);
  expect(saved.sample.events.map((e: { eventId: string }) => e.eventId)).toEqual(["public"]);
  expect(saved.sample.events[0].visibleMs).toBeTypeOf("number");
  expect(saved.sample.events[0].eventCategory).toBe("publicStream"); expect(saved.sample.events[0].publicHasText).toBe(false);
  expect(saved.sample.clock.upperHostMinusUiMs).toBeGreaterThanOrEqual(saved.sample.clock.lowerHostMinusUiMs);
});
it("does not manufacture visible timings while the native surface is hidden", async () => {
  setup(); await render(null); api.begin("submit");
  const done = view("new", "completed"); api.snapshotReceived(done); await render(done, false); await paint();
  expect(invoke.mock.calls.some(([, x]) => x.args.action === "uiTiming")).toBe(false);
  await render(done, true); await paint();
  const saved = invoke.mock.calls.find(([, x]) => x.args.action === "uiTiming")![1].args.sample;
  expect(saved.uiAcceptMs).toBeNull(); expect(saved.uiFirstFeedbackMs).toBe(saved.uiDoneMs);
});
it("persists failed terminal observations without inventing useful or delivered output", async () => {
  setup(); await render(null); api.begin("submit");
  const failed = view("new", "failed"); api.snapshotReceived(failed); await render(failed); await paint();
  const saved = invoke.mock.calls.find(([, x]) => x.args.action === "uiTiming")![1].args.sample;
  expect(saved.terminalState).toBe("failed"); expect(saved.uiDoneMs).toBeNull(); expect(saved.uiUsefulMs).toBeNull();
});
it("excludes the DeepSeek waiting marker from real feedback but counts a public summary", async () => {
  setup();
  for (const [label, real] of [["正在思考，等待公开摘要…", false], ["核对分类与标签的用途", true]] as const) {
    await render(null); api.begin("submit");
    const failed = view("new", "failed", "reasoning");
    failed.activity![0].events[0].label = label;
    api.snapshotReceived(failed); await render(failed); await paint();
    const saved = invoke.mock.calls.filter(([, x]) => x.args.action === "uiTiming").slice(-1)[0][1].args.sample;
    expect(saved.uiFirstFeedbackMs !== null).toBe(real);
    expect(saved.uiUsefulMs).toBeNull(); expect(saved.uiDoneMs).toBeNull();
  }
});
it("counts a direct validated answer as first real feedback without requiring a process message", async () => {
  setup(); await render(null); api.begin("submit");
  const running = view("new"); api.snapshotReceived(running); await render(running); await paint();
  expect(invoke.mock.calls.some(([, x]) => x.args.action === "uiTiming")).toBe(false);
  const done = view("new", "completed"); api.snapshotReceived(done); await render(done); await paint();
  const saved = invoke.mock.calls.find(([, x]) => x.args.action === "uiTiming")![1].args.sample;
  expect(saved.uiFirstFeedbackMs).toBeTypeOf("number");
  expect(saved.uiFirstFeedbackMs).toBe(saved.uiUsefulMs);
  expect(saved.uiFirstFeedbackMs).toBe(saved.uiDoneMs);
});
it.each(["正文预览", ""]) ("counts only nonempty answer previews as feedback and never as delivery (%s)", async label => {
  setup(); await render(null); api.begin("submit");
  const running = view("new", "investigating", "answer");
  running.activity![0].events[0].label = label;
  api.snapshotReceived(running); await render(running); await paint();
  const failed = view("new", "failed", "unpublishedAnswer");
  failed.activity![0].events[0].label = "未经核验的正文";
  api.snapshotReceived(failed); await render(failed); await paint();
  const saved = invoke.mock.calls.find(([, x]) => x.args.action === "uiTiming")![1].args.sample;
  expect(saved.uiFirstFeedbackMs !== null).toBe(Boolean(label));
  expect(saved.uiUsefulMs).toBeNull(); expect(saved.uiDoneMs).toBeNull();
});
it("does not mark an invalidated report as feedback, useful output or final visible delivery", async () => {
  setup(); await render(null); api.begin("submit");
  const invalid = { ...view("new", "completed"), validity: "sourceChanged" };
  api.snapshotReceived(invalid); await render(invalid); await paint();
  const saved = invoke.mock.calls.find(([, x]) => x.args.action === "uiTiming")![1].args.sample;
  expect(saved.uiFirstFeedbackMs).toBeNull();
  expect(saved.uiUsefulMs).toBeNull(); expect(saved.uiDoneMs).toBeNull();
});
it("keeps the representative month notification count and terminal renders within the bounded record", async () => {
  setup(); await render(null); api.begin("submit");
  const running = view("month"); api.snapshotReceived(running); await render(running, true, true); await paint();
  for (let i = 0; i < 92; i++) api.observeEvent({ workId: "work", runId: "month", eventId: `month-event-${i}`, eventCategory: i % 2 ? "state" : "publicStream", publicKind: "message", publicHasText: i % 2 === 0, hostObservedEpochMs: Date.now() });
  // C6's saved month trace reached200 observations and lost its final8.
  for (let i = 0; i < 200; i++) { const next = view("month"); api.snapshotReceived(next); await render(next); await paint(); }
  const done = view("month", "completed"); api.snapshotReceived(done); await render(done); await paint();
  const saved = invoke.mock.calls.find(([, x]) => x.args.action === "uiTiming")![1].args.sample;
  expect(saved.events).toHaveLength(92); expect(saved.eventsOmitted).toBe(0);
  expect(saved.renders).toHaveLength(202); expect(saved.rendersOmitted).toBe(0);
  expect(saved.events.every((event: {visibleMs?:number}) => typeof event.visibleMs === "number")).toBe(true);
  expect(saved.renders.at(-1).visibleMs).toBe(saved.uiDoneMs);
  expect(new TextEncoder().encode(JSON.stringify(saved)).length).toBeLessThan(61_440);
});
it("preserves the original run trace and measures the live steering patch without resetting elapsed time", async () => {
  setup(); await render(view("old", "completed")); api.begin("revision");
  const running = view("new", "investigating", "tool");
  api.snapshotReceived(running); await render(running, true, true); await paint();
  api.observeEvent({ workId: "work", runId: "new", eventId: "before-steer", eventCategory: "publicStream", publicHasText: true });
  api.begin("steer");
  api.observeEvent({ workId: "work", runId: "new", eventId: "after-steer", eventCategory: "publicStream", publicHasText: true });
  api.snapshotReceived(running); await render({ ...running }); await paint();
  const done = view("new", "completed"); api.snapshotReceived(done); await render(done); await paint();
  const saves = invoke.mock.calls.filter(([, x]) => x.args.action === "uiTiming"); expect(saves).toHaveLength(1);
  const { sample, runId } = saves[0][1].args;
  expect(runId).toBe("new"); expect(sample.kind).toBe("revision");
  expect(sample.uiSubmitMs).toBeLessThan(sample.uiPatchStartMs);
  expect(sample.uiFirstFeedbackMs).toBeLessThanOrEqual(sample.uiPatchStartMs);
  expect(sample.uiPatchVisibleMs).toBe(sample.uiDoneMs);
  expect(sample.events.map((e: { eventId: string }) => e.eventId)).toEqual(["before-steer", "after-steer"]);
  expect(sample.events.every((e: { visibleMs?: number }) => typeof e.visibleMs === "number")).toBe(true);
});
it("binds a steering observation to the current run when that run was opened after it started", async () => {
  setup(); const running = view("already-running", "investigating", "tool");
  await render(running); api.begin("steer");
  api.snapshotReceived(running); await render({ ...running }, true, true); await paint();
  const done = view("already-running", "completed"); api.snapshotReceived(done); await render(done); await paint();
  const saves = invoke.mock.calls.filter(([, x]) => x.args.action === "uiTiming"); expect(saves).toHaveLength(1);
  expect(saves[0][1].args.runId).toBe("already-running");
  expect(saves[0][1].args.sample.kind).toBe("steer");
  expect(saves[0][1].args.sample.uiPatchVisibleMs).toBe(saves[0][1].args.sample.uiDoneMs);
});

it("retains real public text when state notifications fill the bounded trace and accounts for every displaced event", async () => {
  setup(); await render(null); api.begin("submit");
  const running = view("full"); api.snapshotReceived(running); await render(running); await paint();
  for (let i = 0; i < 101; i++) api.observeEvent({ workId: "work", runId: "full", eventId: `state-${i}`, eventCategory: "state", publicHasText: false });
  api.observeEvent({ workId: "work", runId: "full", eventId: "real-text", eventCategory: "publicStream", publicKind: "message", publicHasText: true, hostObservedEpochMs: Date.now() });
  const done = view("full", "completed"); api.snapshotReceived(done); await render(done); await paint();
  const saved = invoke.mock.calls.find(([, x]) => x.args.action === "uiTiming")![1].args.sample;
  expect(saved.events).toHaveLength(96); expect(saved.eventsOmitted).toBe(6);
  expect(saved.nonContentEventsOmitted).toBe(6); expect(saved.publicContentEventsOmitted).toBe(0);
  expect(saved.publicContentEventsSeen).toBe(1);
  const content = saved.events.filter((e: { publicHasText?: boolean }) => e.publicHasText);
  expect(content).toHaveLength(1); expect(content[0].eventId).toBe("real-text");
  expect(content[0].visibleMs).toBeTypeOf("number");
  expect(new TextEncoder().encode(JSON.stringify(saved)).length).toBeLessThan(61_440);
});

it("keeps actual public content overflow explicit instead of treating a retained prefix as complete", async () => {
  setup(); await render(null); api.begin("submit");
  const running = view("content-full"); api.snapshotReceived(running); await render(running); await paint();
  for (let i = 0; i < 97; i++) api.observeEvent({ workId: "work", runId: "content-full", eventId: `public-${i}`, eventCategory: "publicStream", publicHasText: true, hostObservedEpochMs: Date.now() });
  api.observeEvent({ workId: "work", runId: "content-full", eventId: "empty", eventCategory: "publicStream", publicHasText: false });
  const done = view("content-full", "completed"); api.snapshotReceived(done); await render(done); await paint();
  const saved = invoke.mock.calls.find(([, x]) => x.args.action === "uiTiming")![1].args.sample;
  expect(saved.events).toHaveLength(96); expect(saved.eventsOmitted).toBe(2);
  expect(saved.publicContentEventsSeen).toBe(97); expect(saved.publicContentEventsOmitted).toBe(1);
  expect(saved.nonContentEventsOmitted).toBe(1);
  expect(saved.events.every((e: { publicHasText?: boolean }) => e.publicHasText)).toBe(true);
});
