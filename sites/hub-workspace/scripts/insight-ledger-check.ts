import {recallFixture} from "../app/insight-recall";
import assert from "node:assert/strict";
import {
  candidateAvailability, emptyLedger, ensureLedgerSeed, executeLedger, expireSnoozes,
  getLedger, getVisibleFinding, headRevision, isInsightAccessible, isSourceAccessible,
  LEDGER_KEY, originKey, parseLedger, reduceLedger,
  type LedgerCommand, type LedgerInsight, type LedgerResult, type LedgerState,
} from "../app/insight-ledger";
import {
  computeReportHash, REPORT_FIXTURES, SEED_SELECTIONS, SOURCE_FIXTURES,
  SAMPLE_METHOD_SOURCE_ID, SAMPLE_REVIEW_SOURCE_ID, SAMPLE_U1, SAMPLE_WORK_A,
  type ReportFixture,
} from "../app/insight-reports";

// Deterministic checks for this browser prototype only; not desktop/database/model acceptance.
const NOW = "2026-11-08T06:00:00.000Z";
let operation = 0;
let checks = 0;
const report = (id: string) => REPORT_FIXTURES.find(item => item.id === id)!;
const pointer = (index: number) => `/report/findings/${index}`;
const op = () => `test-operation-${++operation}`;
function passed(label: string): void { checks += 1; process.stdout.write(`✓ ${label}\n`); }
function success(result: LedgerResult): Extract<LedgerResult, { ok: true }> {
  if (!result.ok) assert.fail(result.message);
  return result;
}
function rejected(result: LedgerResult, code?: string): void {
  assert.equal(result.ok, false);
  if (!result.ok && code) assert.equal(result.code, code);
}
function run(state: LedgerState, command: LedgerCommand, now = NOW): LedgerState {
  return success(reduceLedger(state, command, now)).state;
}
function makeState(): LedgerState {
  const state = emptyLedger();
  state.initialized = true;
  for (const source of SOURCE_FIXTURES) state.sources[source.id] = {
    id: source.id, title: source.title, provider: source.provider, sourceItemId: source.sourceItemId,
    version: source.version, available: source.available, updatedAt: NOW, accessRevision: 0,
  };
  return state;
}
function importR1(): LedgerState {
  let state = makeState();
  for (const index of [0, 1]) state = run(state, { type: "import", report: report("sample-r1"), findingPointer: pointer(index), operationId: op() });
  return state;
}
function r1Insight(state: LedgerState, index: number): LedgerInsight {
  const origin = state.origins[originKey(report("sample-r1"), pointer(index))];
  return state.insights.find(item => item.id === origin.insightId)!;
}
function mutate(state: LedgerState, id: string, update: object): LedgerState {
  const insight = state.insights.find(item => item.id === id)!;
  return run(state, { ...update, insightId: id, expectedRowRevision: insight.rowRevision, operationId: op() } as LedgerCommand);
}

async function main(): Promise<void> {
  let state = importR1();
  {
    const state=makeState(),before=JSON.stringify(state),hits=recallFixture(state,SAMPLE_WORK_A,"验证");
    assert.deepEqual(hits.map(h=>h.id).sort(),[SAMPLE_METHOD_SOURCE_ID,SAMPLE_REVIEW_SOURCE_ID].sort());
    assert.deepEqual(recallFixture(state,"missing-work","验证"),[]);
    assert.deepEqual(recallFixture(state,SAMPLE_WORK_A,"没有匹配的耳机"),[]);
    assert.deepEqual(recallFixture(state,SAMPLE_WORK_A," "),[]);
    assert.equal(JSON.stringify(state),before);
    state.sources[SAMPLE_METHOD_SOURCE_ID].available=false;
    assert(!recallFixture(state,SAMPLE_WORK_A,"验证").some(h=>h.id===SAMPLE_METHOD_SOURCE_ID));
    state.sources[SAMPLE_REVIEW_SOURCE_ID].version=999;
    assert.deepEqual(recallFixture(state,SAMPLE_WORK_A,"验证"),[]);
    passed("keyword pilot stays in original Work fixtures, hides unavailable or changed sources and writes nothing");
  }

  {
    const source = importR1(), one=source.insights[0], two=source.insights[1];
    const related=run(source,{type:"relate",insightId:two.id,expectedRowRevision:two.rowRevision,supersedes:[one.id],operationId:op()});
    assert.deepEqual(related.insights[1].supersedes,[one.id]);assert.equal(related.insights[0].headRevision,one.headRevision);assert.equal(related.insights[0].status,one.status);
    rejected(reduceLedger(source,{type:"relate",insightId:two.id,expectedRowRevision:two.rowRevision,supersedes:[two.id],operationId:op()},NOW),"relation");
    assert.deepEqual(parseLedger(JSON.stringify(related)).insights[1].supersedes,[one.id]);
    passed("manual replacement relation preserves old identities and states and survives browser storage");
  }

  const methodId = r1Insight(state, 0).id;
  const progressId = r1Insight(state, 1).id;
  assert.notEqual(methodId, progressId);
  assert.match(methodId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(r1Insight(state, 0).revisions.length, 1);
  passed("stable random identity and bound first revisions");

  state = mutate(state, methodId, { type: "status", status: "done" });
  const beforeDuplicate = state;
  const duplicateCommand: LedgerCommand = { type: "import", report: report("sample-r1"), findingPointer: pointer(0), operationId: op() };
  let result = success(reduceLedger(state, duplicateCommand, NOW));
  state = result.state;
  assert.equal(result.duplicate, true);
  assert.equal(result.insightId, methodId);
  assert.equal(state.insights.length, 2);
  assert.equal(r1Insight(state, 0).revisions.length, 1);
  assert.equal(r1Insight(state, 0).status, "done");
  assert.equal(state.events.length, beforeDuplicate.events.length);
  const retried = success(reduceLedger(state, duplicateCommand, NOW));
  assert.equal(retried.state, state);
  rejected(reduceLedger(state, { ...duplicateCommand, findingPointer: pointer(1) }, NOW), "operation-conflict");
  passed("duplicate origin/request keeps identity, status, event and revision counts; changed request ID rejected");

  const changedReport = JSON.parse(JSON.stringify(report("sample-r1"))) as ReportFixture;
  changedReport.findings[0].summary = "未经保存的新说法";
  rejected(reduceLedger(state, { type: "import", report: changedReport, findingPointer: pointer(0), operationId: op() }, NOW), "delivery-mismatch");
  changedReport.deliveryHash = computeReportHash(changedReport);
  rejected(reduceLedger(state, { type: "import", report: changedReport, findingPointer: pointer(0), operationId: op() }, NOW), "delivery-mismatch");
  passed("mutated delivery cannot overwrite bound historical content");

  state = mutate(state, progressId, { type: "status", status: "later", snoozeUntil: "2026-11-09T06:00:00.000Z" });
  state = mutate(state, methodId, { type: "update", report: report("sample-r2"), findingPointer: pointer(1) });
  state = mutate(state, progressId, { type: "update", report: report("sample-r2"), findingPointer: pointer(0) });
  assert.equal(r1Insight(state, 0).id, methodId);
  assert.equal(r1Insight(state, 1).id, progressId);
  assert.equal(r1Insight(state, 0).status, "done");
  assert.equal(r1Insight(state, 1).status, "later");
  assert.equal(r1Insight(state, 0).headRevision, 2);
  assert.equal(headRevision(r1Insight(state, 0)).pointer, pointer(1));
  assert.equal(headRevision(r1Insight(state, 1)).pointer, pointer(0));
  assert.equal(r1Insight(state, 0).revisions[0].finding.summary, report("sample-r1").findings[0].summary);
  passed("explicit reordered report mapping preserves IDs, independent statuses and old snapshots");

  result = success(reduceLedger(state, { type: "import", report: report("sample-rb"), findingPointer: pointer(0), operationId: op() }, NOW));
  state = result.state;
  assert.notEqual(result.insightId, methodId);
  assert.equal(state.insights.find(item => item.id === result.insightId)!.status, "active");
  rejected(reduceLedger(state, { type: "update", insightId: methodId, expectedRowRevision: r1Insight(state, 0).rowRevision, report: report("sample-rb"), findingPointer: pointer(0), operationId: op() }, NOW), "origin-bound");
  passed("same text in another Work never inherits identity or processed state");

  const noFeedback = candidateAvailability(state, report("sample-r3"), report("sample-r3").findings[0]);
  assert.equal(noFeedback.eligible, false);
  const staleRow = r1Insight(state, 1).rowRevision;
  state = mutate(state, progressId, { type: "feedback", kind: "fact", text: SAMPLE_U1 });
  assert.equal(r1Insight(state, 1).validity, "review");
  assert.equal(r1Insight(state, 1).feedback[0].targetRevision, 2);
  const beforeConflict = JSON.stringify(state);
  rejected(reduceLedger(state, { type: "status", insightId: progressId, expectedRowRevision: staleRow, status: "done", operationId: op() }, NOW), "conflict");
  assert.equal(JSON.stringify(state), beforeConflict);
  passed("feedback is saved against its revision; stale concurrent action cannot overwrite it");

  rejected(reduceLedger(state, { type: "update", insightId: progressId, expectedRowRevision: r1Insight(state, 1).rowRevision, report: report("sample-r3"), findingPointer: pointer(0), operationId: op() }, NOW), "feedback-confirmation");
  const feedbackId = r1Insight(state, 1).feedback[0].id;
  state = mutate(state, progressId, { type: "update", report: report("sample-r3"), findingPointer: pointer(0), acknowledgedFeedbackIds: [feedbackId] });
  const revisedProgress = r1Insight(state, 1);
  assert.equal(revisedProgress.headRevision, 3);
  assert.equal(revisedProgress.status, "later");
  assert.equal(revisedProgress.validity, "available");
  assert.equal(revisedProgress.feedback[0].resolvedInRevision, 3);
  assert.match(headRevision(revisedProgress).finding.summary, /纸面/);
  assert.match(headRevision(revisedProgress).finding.title, /实机/);
  assert.equal(headRevision(revisedProgress).finding.evidence.filter(evidence => evidence.origin === "user").length, 1);
  passed("R3 requires explicit feedback acknowledgement and retains correction/source identities and status");

  let correctionState = importR1();
  const correctionId = r1Insight(correctionState, 1).id;
  correctionState = mutate(correctionState, correctionId, { type: "feedback", kind: "fact", text: SAMPLE_U1 });
  const correctionFeedbackId = r1Insight(correctionState, 1).feedback[0].id;
  correctionState = mutate(correctionState, correctionId, { type: "update", report: report("sample-r3"), findingPointer: pointer(0), acknowledgedFeedbackIds: [correctionFeedbackId] });
  rejected(reduceLedger(correctionState, { type: "update", insightId: correctionId, expectedRowRevision: r1Insight(correctionState, 1).rowRevision, report: report("sample-r2"), findingPointer: pointer(0), operationId: op() }, NOW), "older-delivery");
  const laterOmission = JSON.parse(JSON.stringify(report("sample-r2"))) as ReportFixture;
  laterOmission.id = "test-newer-report-omits-correction";
  laterOmission.publishedAt = "2026-11-08T03:00:00Z";
  laterOmission.deliveryHash = computeReportHash(laterOmission);
  correctionState = mutate(correctionState, correctionId, { type: "update", report: laterOmission, findingPointer: pointer(0) });
  assert.equal(r1Insight(correctionState, 1).validity, "review");
  assert.equal(r1Insight(correctionState, 1).feedback[0].resolvedInRevision, undefined);
  assert.ok(r1Insight(correctionState, 1).revisions[1].acknowledgedFeedbackIds.includes(correctionFeedbackId));
  passed("older reports cannot roll back corrections; later omission reopens feedback while its acknowledgement history survives");

  state = run(state, { type: "source", sourceId: SAMPLE_METHOD_SOURCE_ID, version: 2, operationId: op() });
  assert.equal(r1Insight(state, 0).validity, "review");
  assert.equal(r1Insight(state, 0).status, "done");
  assert.equal(r1Insight(state, 1).validity, "available");
  assert.equal(headRevision(r1Insight(state, 0)).finding.evidence[0].version, 1);
  const revisionBeforeCheck = r1Insight(state, 0).headRevision;
  state = run(state, { type: "check", operationId: op() });
  assert.equal(r1Insight(state, 0).headRevision, revisionBeforeCheck);
  assert.equal(r1Insight(state, 0).validity, "review");
  state = mutate(state, methodId, { type: "update", report: report("sample-r4-method-v2"), findingPointer: pointer(0) });
  assert.equal(r1Insight(state, 0).validity, "available");
  assert.equal(r1Insight(state, 0).status, "done");
  assert.equal(headRevision(r1Insight(state, 0)).finding.evidence[0].version, 2);
  passed("dependency v2 invalidates only affected conclusions; checking cannot relabel v1, explicit current report updates it");

  state = run(state, { type: "source", sourceId: SAMPLE_REVIEW_SOURCE_ID, available: false, operationId: op() });
  const hiddenProgress = r1Insight(state, 1);
  assert.equal(hiddenProgress.validity, "unavailable");
  assert.equal(isInsightAccessible(progressId, state), false);
  assert.equal(getVisibleFinding(state, hiddenProgress), null);
  assert.equal(getVisibleFinding(state, hiddenProgress, 1), null);
  assert.equal(isSourceAccessible(SAMPLE_REVIEW_SOURCE_ID, state), false);
  assert.equal(isSourceAccessible("legacy-document-outside-ledger", state), true);
  assert.equal(isInsightAccessible(methodId, state), true);
  rejected(reduceLedger(state, { type: "receipt", insightId: progressId, targetRevision: 1, kind: "note", title: "旧草稿", createdItemId: "draft-old", operationId: op() }, NOW), "unavailable");
  passed("revocation masks current/historical findings and blocks old derived drafts without hiding unrelated content");

  state = run(state, { type: "source", sourceId: SAMPLE_REVIEW_SOURCE_ID, available: true, operationId: op() });
  assert.equal(r1Insight(state, 1).validity, "review");
  const progressRevisions = r1Insight(state, 1).revisions.length;
  state = run(state, { type: "check", operationId: op() });
  assert.equal(r1Insight(state, 1).validity, "available");
  assert.equal(r1Insight(state, 1).revisions.length, progressRevisions);
  passed("restored access stays pending until an explicit dependency check; unchanged content gains no new revision");

  const roundtrip = parseLedger(JSON.stringify(state));
  assert.equal(r1Insight(roundtrip, 0).id, methodId);
  assert.deepEqual(r1Insight(roundtrip, 1).feedback, r1Insight(state, 1).feedback);
  assert.deepEqual(r1Insight(roundtrip, 1).revisions, r1Insight(state, 1).revisions);
  const malformed = JSON.parse(JSON.stringify(state));
  delete malformed.origins[originKey(report("sample-r1"), pointer(0))];
  assert.throws(() => parseLedger(JSON.stringify(malformed)));
  passed("serialized reload retains revisions, identities and feedback; missing origin relations are rejected");

  let undoState = importR1();
  const undoId = r1Insight(undoState, 0).id;
  undoState = mutate(undoState, undoId, { type: "status", status: "done" });
  const statusEvent = undoState.events.find(event => event.insightId === undoId && event.type === "status")!;
  undoState = run(undoState, { type: "source", sourceId: SAMPLE_METHOD_SOURCE_ID, version: 2, operationId: op() });
  undoState = mutate(undoState, undoId, { type: "undo", eventId: statusEvent.id });
  assert.equal(r1Insight(undoState, 0).status, "active");
  assert.equal(r1Insight(undoState, 0).validity, "review");
  assert.equal(undoState.events[0].undoesEventId, statusEvent.id);
  passed("undo is a compensating event and cannot restore stale evidence");

  const expired = expireSnoozes(state, "2026-11-09T06:00:01.000Z");
  assert.equal(r1Insight(expired, 1).status, "active");
  assert.equal(r1Insight(expired, 1).snoozeUntil, undefined);
  assert.equal(expired.events.filter(event => event.type === "snooze-expired").length, 1);
  assert.equal(expireSnoozes(expired, "2026-11-09T06:10:00.000Z"), expired);
  passed("explicit snooze deadline resumes once and preserves current validity");

  const badState = makeState();
  for (const finding of report("sample-rbad").findings) {
    assert.equal(candidateAvailability(badState, report("sample-rbad"), finding).eligible, false);
    rejected(reduceLedger(badState, { type: "import", report: report("sample-rbad"), findingPointer: finding.pointer, operationId: op() }, NOW));
  }
  for (const candidate of REPORT_FIXTURES.filter(item => item.kind === "native" || item.status === "insufficientEvidence")) rejected(reduceLedger(badState, { type: "import", report: candidate, findingPointer: pointer(0), operationId: op() }, NOW));
  assert.equal(badState.insights.length, 0);
  passed("empty/native/insufficient/unreadable/missing-quote candidates cannot create filler cards");

  const beforeFailureHead = r1Insight(undoState, 0).headRevision;
  undoState = mutate(undoState, undoId, { type: "update-outcome", outcome: "failed" });
  assert.equal(r1Insight(undoState, 0).headRevision, beforeFailureHead);
  assert.equal(r1Insight(undoState, 0).validity, "review");
  assert.equal(r1Insight(undoState, 0).lastUpdateOutcome?.outcome, "failed");
  passed("failed update is visible while old revision and pending validity remain intact");

  class FakeStorage {
    values = new Map<string, string>();
    failWrite = false;
    getItem(key: string): string | null { return this.values.get(key) ?? null; }
    setItem(key: string, value: string): void { if (this.failWrite) throw new Error("injected quota failure"); this.values.set(key, value); }
  }
  const storage = new FakeStorage();
  const windowTarget = new EventTarget() as EventTarget & { localStorage: FakeStorage };
  windowTarget.localStorage = storage;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
  try {
    storage.failWrite = true;
    rejected(await ensureLedgerSeed(REPORT_FIXTURES, SEED_SELECTIONS, SOURCE_FIXTURES), "storage");
    assert.equal(storage.getItem(LEDGER_KEY), null);
    storage.failWrite = false;
    let browser = success(await ensureLedgerSeed(REPORT_FIXTURES, SEED_SELECTIONS, SOURCE_FIXTURES)).state;
    assert.equal(browser.insights.length, 4);
    const firstIds = browser.insights.map(insight => insight.id);
    browser = success(await ensureLedgerSeed(REPORT_FIXTURES, SEED_SELECTIONS, SOURCE_FIXTURES)).state;
    assert.deepEqual(browser.insights.map(insight => insight.id), firstIds);
    const first = browser.insights[0];
    const rawBefore = storage.getItem(LEDGER_KEY);
    const feedbackCommand: LedgerCommand = { type: "feedback", insightId: first.id, expectedRowRevision: first.rowRevision, text: "注入存储故障后仍可重试", kind: "context", operationId: "retry-after-write-fault" };
    storage.failWrite = true;
    rejected(await executeLedger(feedbackCommand), "storage");
    assert.equal(storage.getItem(LEDGER_KEY), rawBefore);
    storage.failWrite = false;
    success(await executeLedger(feedbackCommand));
    success(await executeLedger(feedbackCommand));
    assert.equal(getLedger().insights.find(insight => insight.id === first.id)!.feedback.length, 1);
    passed("single browser snapshot commit rolls back on write failure; retry saves exactly one feedback and seed never resets");

    storage.values.set(LEDGER_KEY, "{broken persistence");
    assert.ok(getLedger().storageError);
    assert.equal(isSourceAccessible(SAMPLE_METHOD_SOURCE_ID), false);
    assert.equal(isInsightAccessible(first.id), false);
    assert.equal(isSourceAccessible("legacy-document-outside-ledger"), true);
    rejected(await ensureLedgerSeed(REPORT_FIXTURES, SEED_SELECTIONS, SOURCE_FIXTURES), "storage");
    assert.equal(storage.getItem(LEDGER_KEY), "{broken persistence");
    passed("corrupt browser storage is preserved, never silently replaced by fresh examples");
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
  process.stdout.write(`\n${checks} browser prototype contract checks passed. Desktop SQLite, permissions, model execution and full backup are outside this check.\n`);
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
