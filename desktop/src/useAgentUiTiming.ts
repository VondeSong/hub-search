import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

type Phase = { phase: string; elapsedMs: number };
type Projection = { renderIndex: number; projectionMs: number; phases: Phase[] | null; phaseStatus: "recorded" | "unavailable" };
type View = { work: { id: string; state: string; report: unknown }; run?: { id?: string } | null; validity?: string; nativeTiming?: { hostEpochMs: number; projectionMs: number; phases?: Phase[] }; analysisArtifacts?: { state: string }[]; activity?: { runId: string; events: { kind: string; label: string }[] }[] };
export type TimedEvent = { workId: string; runId: string; eventId?: string; eventCategory?: "state" | "publicStream"; publicKind?: string | null; publicHasText?: boolean; hostObservedEpochMs?: number; hostEmittedEpochMs?: number };
const now = () => performance.timeOrigin + performance.now();
// Match native ui_timing admission; the full sample remains below one 64KiB record.
const MAX_EVENTS = 96, MAX_RENDERS = 256;
type EventSample = TimedEvent & { receivedMs: number; visibleMs?: number; snapshotReady?: boolean };
type Trace = { schemaVersion: number; traceId: string; kind: string; workId?: string; runId?: string; baselineRunId?: string; uiSubmitMs: number; uiAcceptMs: number | null; uiFirstFeedbackMs: number | null; uiUsefulMs: number | null; uiDoneMs: number | null; uiPatchStartMs: number | null; uiPatchVisibleMs: number | null; clock: { lowerHostMinusUiMs: number; upperHostMinusUiMs: number; roundTripMs: number; nativeGeometry?: unknown } | null; renders: { startedMs: number; visibleMs: number; projectionMs: number | null }[]; slowestProjection?: Projection; rendersOmitted: number; events: EventSample[]; eventsOmitted: number; publicContentEventsSeen: number; publicContentEventsOmitted: number; nonContentEventsOmitted: number; saved?: boolean; calibrating?: boolean };

// One bounded observation per submission. It cannot change business state.
export function useAgentUiTiming(view: View | null, visible: boolean, accepting: boolean) {
  const trace = useRef<Trace | null>(null), latest = useRef(view);
  latest.current = view;
  const renderStart = now();
  const begin = (kind: string) => {
    const at = now();
    const current = trace.current;
    if (kind === "steer" && current && !current.saved && current.workId === view?.work.id && current.runId === view?.run?.id) {
      // Steering belongs to the same Run. Preserve its original start and
      // observations while measuring the newly requested visible revision.
      current.uiPatchStartMs = at; current.uiPatchVisibleMs = null;
      return;
    }
    trace.current = { schemaVersion: 1, traceId: crypto.randomUUID(), kind, workId: view?.work.id, baselineRunId: kind === "steer" ? undefined : view?.run?.id, runId: kind === "steer" ? view?.run?.id : undefined, uiSubmitMs: at, uiAcceptMs: null, uiFirstFeedbackMs: null, uiUsefulMs: null, uiDoneMs: null, uiPatchStartMs: kind === "revision" || kind === "steer" ? at : null, uiPatchVisibleMs: null, clock: null, renders: [], rendersOmitted: 0, events: [], eventsOmitted: 0, publicContentEventsSeen: 0, publicContentEventsOmitted: 0, nonContentEventsOmitted: 0 };
  };
  const observeEvent = (event: TimedEvent) => {
    const t = trace.current;
    if (!t || t.saved || t.workId !== event.workId || event.runId === t.baselineRunId) return;
    const publicContent = event.eventCategory === "publicStream" && event.publicHasText === true;
    if (publicContent) t.publicContentEventsSeen++;
    if (t.events.length >= MAX_EVENTS) {
      // Keep actual public text ahead of state notifications and empty events.
      // Every displaced event remains counted; no missing content becomes zero.
      const replace = publicContent ? t.events.findIndex(e => e.eventCategory !== "publicStream" || e.publicHasText !== true) : -1;
      t.eventsOmitted++;
      if (replace < 0) {
        if (publicContent) t.publicContentEventsOmitted++;
        else t.nonContentEventsOmitted++;
        return;
      }
      t.events.splice(replace, 1); t.nonContentEventsOmitted++;
    }
    t.events.push({ ...event, receivedMs: now() });
  };
  const snapshotReceived = (value: View, requestedAt = Infinity) => {
    const t = trace.current;
    if (!t || t.saved || !value.nativeTiming) return;
    t.workId ??= value.work.id;
    if (t.workId !== value.work.id) return;
    if (value.run?.id && value.run.id !== t.baselineRunId) t.runId = value.run.id;
    for (const e of t.events) if (e.runId === t.runId && e.receivedMs <= requestedAt) e.snapshotReady = true;
    if (!t.clock && !t.calibrating) {
      t.calibrating = true;
      const sent = now();
      void invoke<{ hostEpochMs: number; nativeGeometry?: unknown }>("agent_investigation", { args: { action: "uiTimingClock" } }).then(result => {
        const received = now();
        if (trace.current === t && Number.isFinite(result.hostEpochMs)) t.clock = { lowerHostMinusUiMs: result.hostEpochMs - received, upperHostMinusUiMs: result.hostEpochMs - sent, roundTripMs: received - sent, nativeGeometry: result.nativeGeometry };
      }).catch(() => {});
    }
  };
  useEffect(() => {
    const t = trace.current;
    if (!t || t.saved || !visible || typeof requestAnimationFrame !== "function") return;
    let cancelled = false, second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if (cancelled || trace.current !== t || document.visibilityState !== "visible") return;
      const shown = latest.current, painted = now();
      if (accepting && t.uiAcceptMs === null) t.uiAcceptMs = painted;
      if (!shown || shown.work.id !== t.workId || !t.runId || shown.run?.id !== t.runId) return;
      if (t.renders.length < MAX_RENDERS) {
        t.renders.push({ startedMs: renderStart, visibleMs: painted, projectionMs: shown.nativeTiming?.projectionMs ?? null });
        const ms = shown.nativeTiming?.projectionMs;
        if (ms !== undefined && Number.isFinite(ms) && ms >= 0 && ms > (t.slowestProjection?.projectionMs ?? -1)) {
          const phases = shown.nativeTiming?.phases;
          let previous = 0;
          const valid = Array.isArray(phases) && phases.length > 0 && phases.length <= 16 && phases.every(p => {
            if (!p || typeof p.phase !== "string" || !p.phase.length || [...p.phase].length > 64 || !Number.isFinite(p.elapsedMs) || p.elapsedMs < previous || p.elapsedMs > ms) return false;
            previous = p.elapsedMs; return true;
          });
          // Retain one largest rendered snapshot in the existing terminal write.
          t.slowestProjection = { renderIndex: t.renders.length - 1, projectionMs: ms, phases: valid ? phases.map(p => ({ phase: p.phase, elapsedMs: p.elapsedMs })) : null, phaseStatus: valid ? "recorded" : "unavailable" };
        }
      }
      else t.rendersOmitted++;
      for (const e of t.events) if (e.snapshotReady && e.visibleMs === undefined) e.visibleMs = painted;
      const feedback = shown.activity?.some(run => run.runId === t.runId && run.events.some(e => e.kind === "tool" || (["message", "reasoning", "answer"].includes(e.kind) && e.label.trim() && e.label.trim() !== "正在思考，等待公开摘要…")));
      const deliveredAnswer = !shown.validity && Boolean(shown.work.report);
      if ((feedback || deliveredAnswer) && t.uiFirstFeedbackMs === null) t.uiFirstFeedbackMs = painted;
      if (!shown.validity && (shown.work.report || shown.analysisArtifacts?.some(a => a.state === "checked")) && t.uiUsefulMs === null) t.uiUsefulMs = painted;
      if (!["investigating", "ready"].includes(shown.work.state)) {
        if (deliveredAnswer) {
          t.uiDoneMs = painted;
          if (t.uiPatchStartMs !== null) t.uiPatchVisibleMs = painted;
        }
        t.saved = true;
        const { workId, runId, baselineRunId: _old, saved: _saved, calibrating: _calibrating, ...sample } = t;
        void invoke("agent_investigation", { args: { action: "uiTiming", id: workId, runId, sample: { ...sample, geometry: { innerWidth: innerWidth, innerHeight: innerHeight, devicePixelRatio }, visibility: "visible", terminalState: shown.work.state, usefulCriterion: "current host-validated report or checked artifact; second animation frame after commit is a paint opportunity, not a physical-display sensor" } } }).catch(() => {});
      }
    }); });
    return () => { cancelled = true; cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [view, visible, accepting]);
  return { begin, observeEvent, snapshotReceived };
}
