import assert from "node:assert/strict";
import {
  ensureInteractionDemo, ensureLedgerSeed, executeLedger, getLedger, getInsightValidity,
  headRevision, LEDGER_KEY, originKey, parseLedger,
  type LedgerCommand, type LedgerInsight, type LedgerResult, type LedgerState,
} from "../app/insight-ledger";
import {
  computeReportHash, getEvidenceIssue, getSourceHubItem,
  INTERACTION_DEMO_SELECTIONS, INTERACTION_DEMO_VERSION, INTERACTION_HUB_ITEMS,
  INTERACTION_MEETING_SOURCE_ID, INTERACTION_REPORT_FIXTURES, INTERACTION_WEEKLY_FEEDBACK,
  REPORT_FIXTURES, SAMPLE_METHOD_SOURCE_ID, SEED_SELECTIONS, SOURCE_FIXTURES,
} from "../app/insight-reports";

// Focused fixture/migration checks for the additive browser interaction pack.
// This is synthetic data validation, not a desktop/model/real-source acceptance run.
let checks = 0;
let operation = 0;
const passed = (label: string) => { checks += 1; process.stdout.write(`✓ ${label}\n`); };
const report = (id: string) => REPORT_FIXTURES.find(item => item.id === id)!;
const success = (result: LedgerResult | null): Extract<LedgerResult, { ok: true }> => {
  if (!result?.ok) assert.fail(result ? result.message : "Expected a new successful fixture commit");
  return result;
};
const byOrigin = (state: LedgerState, reportId: string, index: number): LedgerInsight => {
  const origin = state.origins[originKey(report(reportId), `/report/findings/${index}`)];
  assert.ok(origin);
  return state.insights.find(item => item.id === origin.insightId)!;
};

class FakeStorage {
  values = new Map<string, string>();
  failWrite = false;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failWrite) throw new Error("injected write failure");
    this.values.set(key, value);
  }
}

async function main(): Promise<void> {
  for (const candidateReport of INTERACTION_REPORT_FIXTURES) {
    assert.equal(computeReportHash(candidateReport), candidateReport.deliveryHash);
    for (const finding of candidateReport.findings) for (const evidence of finding.evidence) {
      assert.equal(getEvidenceIssue(evidence), undefined, `${candidateReport.id}: ${evidence.title}`);
      const item = getSourceHubItem(evidence.sourceId, evidence.version);
      assert.ok(item, `Missing readable source for ${evidence.sourceId}`);
      const content = item.sections.flatMap(section => [section.text || "", ...(section.items || [])]).join("\n");
      assert.ok(content.includes(evidence.quote), `Reader projection lost exact quote: ${evidence.sourceId} v${evidence.version}`);
    }
  }
  assert.equal(INTERACTION_DEMO_SELECTIONS.length, 8);
  assert.equal(INTERACTION_HUB_ITEMS.length, 9);
  passed("all new fixed reports have valid hashes, exact quotes and complete readable source projections");

  const storage = new FakeStorage();
  const target = new EventTarget() as EventTarget & { localStorage: FakeStorage };
  target.localStorage = storage;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  const original = () => ensureLedgerSeed(REPORT_FIXTURES, SEED_SELECTIONS, SOURCE_FIXTURES);
  async function act(command: Omit<LedgerCommand, "operationId"> | object): Promise<LedgerState> {
    return success(await executeLedger({ ...command, operationId: `demo-check-${++operation}` } as LedgerCommand)).state;
  }
  try {
    const base = success(await original()).state;
    const baseRecords = JSON.stringify(base.insights);
    const first = success(await ensureInteractionDemo()).state;
    assert.equal(first.insights.length, 12);
    assert.equal(first.insights.filter(item => item.status === "active").length, 6);
    assert.equal(first.insights.filter(item => item.status === "later").length, 3);
    assert.equal(first.insights.filter(item => item.status === "done").length, 3);
    assert.equal(first.insights.filter(item => getInsightValidity(first, item) === "review").length, 2);
    assert.equal(new Set(first.insights.map(item => item.ownerWorkId)).size, 7);
    assert.equal(JSON.stringify(first.insights.filter(item => base.insights.some(old => old.id === item.id))), baseRecords);
    assert.ok(first.insights.filter(item => item.status === "later").every(item => Date.parse(item.snoozeUntil!) > Date.now()));
    assert.ok(first.events.filter(event => event.operationId.startsWith(`seed-pack:${INTERACTION_DEMO_VERSION}:`)).every(event => event.detail?.startsWith("预置互动示例")));
    passed("fresh pack adds eight records atomically with 6/3/3 statuses, two review cases and explicit example history");

    const originalRaw = storage.getItem(LEDGER_KEY);
    assert.equal(await ensureInteractionDemo(), null);
    assert.equal(storage.getItem(LEDGER_KEY), originalRaw);
    const reading = byOrigin(first, "demo-report-reading", 0);
    let state = await act({ type: "status", insightId: reading.id, expectedRowRevision: reading.rowRevision, status: "done" });
    const editedRaw = storage.getItem(LEDGER_KEY);
    await original();
    assert.equal(await ensureInteractionDemo(), null);
    assert.equal(storage.getItem(LEDGER_KEY), editedRaw);
    assert.equal(byOrigin(getLedger(), "demo-report-reading", 0).status, "done");
    assert.equal(byOrigin(getLedger(), "demo-report-reading", 0).id, reading.id);
    passed("reopen and repeated calls preserve identities, user edits and the exact stored snapshot");

    const weekly = byOrigin(state, "demo-report-weekly", 1);
    assert.equal(weekly.feedback[0].text, INTERACTION_WEEKLY_FEEDBACK);
    const unconfirmed = await executeLedger({ type: "update", insightId: weekly.id, expectedRowRevision: weekly.rowRevision, report: report("demo-report-weekly-corrected"), findingPointer: "/report/findings/0", operationId: `demo-check-${++operation}` });
    assert.equal(unconfirmed.ok, false);
    if (!unconfirmed.ok) assert.equal(unconfirmed.code, "feedback-confirmation");
    state = await act({ type: "update", insightId: weekly.id, expectedRowRevision: weekly.rowRevision, report: report("demo-report-weekly-corrected"), findingPointer: "/report/findings/0", acknowledgedFeedbackIds: [weekly.feedback[0].id] });
    const corrected = byOrigin(state, "demo-report-weekly", 1);
    assert.equal(corrected.id, weekly.id);
    assert.equal(corrected.status, "active");
    assert.equal(corrected.headRevision, 2);
    assert.equal(getInsightValidity(state, corrected), "available");
    assert.equal(corrected.feedback[0].resolvedInRevision, 2);
    passed("prefilled weekly feedback is resolvable only with explicit acknowledgement and keeps its original discovery");

    const trip = byOrigin(state, "demo-report-trip", 1);
    assert.equal(trip.status, "done");
    assert.equal(getInsightValidity(state, trip), "review");
    assert.equal(state.sources[INTERACTION_MEETING_SOURCE_ID].version, 2);
    assert.match(headRevision(trip).finding.evidence[0].quote, /09:00/);
    state = await act({ type: "update", insightId: trip.id, expectedRowRevision: trip.rowRevision, report: report("demo-report-trip-updated"), findingPointer: "/report/findings/0" });
    const updatedTrip = byOrigin(state, "demo-report-trip", 1);
    assert.equal(updatedTrip.id, trip.id);
    assert.equal(updatedTrip.status, "done");
    assert.equal(getInsightValidity(state, updatedTrip), "available");
    assert.match(headRevision(updatedTrip).finding.evidence[0].quote, /09:30/);
    assert.equal(byOrigin(state, "demo-report-trip", 0).headRevision, 1);
    passed("changed trip source creates done + review, then explicit v2 update resolves it without touching the other trip finding");

    const removed = byOrigin(state, "demo-report-reading", 1).id;
    state.insights = state.insights.filter(item => item.id !== removed);
    state.origins = Object.fromEntries(Object.entries(state.origins).filter(([, item]) => item.insightId !== removed));
    state.operations = Object.fromEntries(Object.entries(state.operations).filter(([, item]) => item.insightId !== removed));
    state.events = state.events.filter(item => item.insightId !== removed);
    storage.values.set(LEDGER_KEY, JSON.stringify(parseLedger(JSON.stringify(state))));
    assert.equal(await ensureInteractionDemo(), null);
    assert.equal(getLedger().insights.length, 11);
    assert.ok(!getLedger().insights.some(item => item.id === removed));
    passed("pack receipt survives a future record removal and never silently restores a removed example");

    storage.values.clear();
    await original();
    await act({ type: "source", sourceId: SAMPLE_METHOD_SOURCE_ID, available: false });
    await act({ type: "source", sourceId: "demo-reading-method", available: false });
    state = success(await ensureInteractionDemo()).state;
    assert.equal(state.insights.length, 10);
    assert.equal(state.sources[SAMPLE_METHOD_SOURCE_ID].available, false);
    assert.equal(state.sources["demo-reading-method"].available, false);
    assert.equal(state.insights.filter(item => item.ownerWorkId === "demo-work-reading").length, 0);
    await act({ type: "source", sourceId: "demo-reading-method", available: true });
    assert.equal(await ensureInteractionDemo(), null);
    assert.equal(getLedger().insights.length, 10);
    passed("preexisting source revocation stays in force; restoring access does not auto-import previously blocked examples");

    storage.values.clear();
    state = success(await original()).state;
    state = await act({ type: "import", report: report("demo-report-reading"), findingPointer: "/report/findings/0" });
    const preexisting = byOrigin(state, "demo-report-reading", 0);
    state = await act({ type: "status", insightId: preexisting.id, expectedRowRevision: preexisting.rowRevision, status: "done" });
    const owned = JSON.stringify(byOrigin(state, "demo-report-reading", 0));
    state = success(await ensureInteractionDemo()).state;
    assert.equal(state.insights.length, 12);
    assert.equal(JSON.stringify(byOrigin(state, "demo-report-reading", 0)), owned);
    passed("an already selected candidate is never reassigned the pack's initial status or star preference");

    storage.values.clear();
    await original();
    const beforeFailure = storage.getItem(LEDGER_KEY);
    storage.failWrite = true;
    const failed = await ensureInteractionDemo();
    assert.equal(failed?.ok, false);
    assert.equal(storage.getItem(LEDGER_KEY), beforeFailure);
    storage.failWrite = false;
    state = success(await ensureInteractionDemo()).state;
    assert.equal(state.insights.length, 12);
    assert.equal(await ensureInteractionDemo(), null);
    passed("injected storage failure leaves no partial pack or marker; a later retry adds exactly eight records");

    storage.values.set(LEDGER_KEY, "{damaged-example-state");
    const corrupt = await ensureInteractionDemo();
    assert.equal(corrupt?.ok, false);
    assert.equal(storage.getItem(LEDGER_KEY), "{damaged-example-state");
    passed("corrupt existing storage remains intact and cannot be overwritten by fixture loading");
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
  process.stdout.write(`\n${checks} additive demo-data checks passed.\n`);
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
