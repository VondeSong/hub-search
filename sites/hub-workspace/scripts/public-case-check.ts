import assert from "node:assert/strict";
import {
  ensureInteractionDemo, ensureLedgerSeed, ensurePublicCaseDemo, executeLedger,
  getLedger, headRevision, LEDGER_KEY, originKey, parseLedger,
  type LedgerResult, type LedgerState,
} from "../app/insight-ledger";
import {
  computeReportHash, getEvidenceIssue, getSourceHubItem,
  PUBLIC_CASE_HUB_ITEMS, PUBLIC_CASE_REPORT_FIXTURES, PUBLIC_CASE_SOURCE_FIXTURES,
  PUBLIC_CASE_VERSION, REPORT_FIXTURES, SEED_SELECTIONS, SOURCE_FIXTURES,
} from "../app/insight-reports";

// Focus on new provenance and additive import behavior; the existing ledger
// suite already covers the general status, feedback and revision contracts.
let checks = 0;
const passed = (label: string) => { checks += 1; process.stdout.write(`✓ ${label}\n`); };
const success = (result: LedgerResult | null): Extract<LedgerResult, { ok: true }> => {
  if (!result?.ok) assert.fail(result ? result.message : "Expected a successful case import");
  return result;
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
  assert.equal(PUBLIC_CASE_REPORT_FIXTURES.length, 5);
  assert.equal(PUBLIC_CASE_HUB_ITEMS.length, 6);
  for (const candidate of PUBLIC_CASE_REPORT_FIXTURES) {
    assert.equal(computeReportHash(candidate), candidate.deliveryHash);
    for (const finding of candidate.findings) {
      assert.ok(finding.caseStudy?.scenario && finding.caseStudy?.learning);
      assert.ok(finding.caseStudy.actionSteps.length > 0);
      for (const evidence of finding.evidence) {
        assert.equal(getEvidenceIssue(evidence), undefined);
        assert.equal(evidence.excerptKind, "summary");
        assert.ok(evidence.publisher && evidence.checkedAt);
        assert.equal(new URL(evidence.externalUrl!).protocol, "https:");
        assert.equal(evidence.eventAt, undefined, "A documentation lookup must not become a personal event");
        const source = getSourceHubItem(evidence.sourceId, evidence.version);
        assert.ok(source);
        const body = source.sections.flatMap(section => [section.text || "", ...(section.items || [])]).join("\n");
        assert.ok(body.includes(evidence.quote));
        assert.ok(body.includes(evidence.externalUrl!));
        assert.match(body, /中文摘要/);
        assert.ok(getEvidenceIssue({ ...evidence, excerptKind: undefined }), "Summary labeling is part of source attribution");
        assert.ok(getEvidenceIssue({ ...evidence, externalUrl: "https://example.com/unrelated" }), "A citation cannot swap its official URL");
      }
    }
  }
  passed("five complete cases retain official links, summary labels and readable source snapshots without invented event dates");

  const storage = new FakeStorage();
  const target = new EventTarget() as EventTarget & { localStorage: FakeStorage };
  target.localStorage = storage;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  const base = async (): Promise<LedgerState> => {
    await ensureLedgerSeed(REPORT_FIXTURES, SEED_SELECTIONS, SOURCE_FIXTURES);
    return success(await ensureInteractionDemo()).state;
  };
  try {
    let before = await base();
    // Model the old browser snapshot from before public sources existed.
    for (const source of PUBLIC_CASE_SOURCE_FIXTURES) delete before.sources[source.id];
    storage.values.set(LEDGER_KEY, JSON.stringify(before));
    const originalRecords = JSON.stringify(before.insights);
    let state = success(await ensurePublicCaseDemo()).state;
    assert.equal(state.insights.length, 17);
    const added = state.insights.filter(item => headRevision(item).finding.caseStudy);
    assert.equal(added.length, 5);
    assert.ok(added.every(item => item.status === "active" && item.headRevision === 1));
    assert.equal(JSON.stringify(state.insights.filter(item => before.insights.some(old => old.id === item.id))), originalRecords);
    assert.ok(state.events.filter(item => item.operationId.startsWith(`seed-pack:${PUBLIC_CASE_VERSION}:`)).every(item => item.detail?.includes("不是你的实际操作记录")));
    parseLedger(JSON.stringify(state));
    const record = added[0];
    state = success(await executeLedger({ type: "status", insightId: record.id, expectedRowRevision: record.rowRevision, status: "done", operationId: "public-case-check-status" })).state;
    const edited = storage.getItem(LEDGER_KEY);
    assert.equal(await ensurePublicCaseDemo(), null);
    assert.equal(storage.getItem(LEDGER_KEY), edited);
    assert.equal(getLedger().insights.find(item => item.id === record.id)?.status, "done");
    passed("one additive import preserves all old records; repeat loading preserves the exact edited snapshot");

    storage.values.clear();
    await base();
    const selected = PUBLIC_CASE_REPORT_FIXTURES[0];
    state = success(await executeLedger({ type: "import", report: selected, findingPointer: "/report/findings/0", operationId: "public-case-preselected" })).state;
    const origin = state.origins[originKey(selected, "/report/findings/0")];
    const existing = state.insights.find(item => item.id === origin.insightId)!;
    state = success(await executeLedger({ type: "status", insightId: existing.id, expectedRowRevision: existing.rowRevision, status: "done", operationId: "public-case-preselected-done" })).state;
    const owned = JSON.stringify(state.insights.find(item => item.id === existing.id));
    state = success(await ensurePublicCaseDemo()).state;
    assert.equal(state.insights.length, 17);
    assert.equal(JSON.stringify(state.insights.find(item => item.id === existing.id)), owned);
    passed("an already selected public case retains its identity and user-chosen status");

    storage.values.clear();
    await base();
    await executeLedger({ type: "source", sourceId: "public-obsidian-backlinks", available: false, operationId: "public-case-revoke" });
    state = success(await ensurePublicCaseDemo()).state;
    assert.equal(state.insights.filter(item => headRevision(item).finding.caseStudy).length, 4);
    assert.equal(state.sources["public-obsidian-backlinks"].available, false);
    assert.ok(!state.insights.some(item => item.ownerWorkId === "public-work-reading"));
    await executeLedger({ type: "source", sourceId: "public-obsidian-backlinks", available: true, operationId: "public-case-restore" });
    assert.equal(await ensurePublicCaseDemo(), null);
    assert.equal(getLedger().insights.length, 16);
    passed("existing source restrictions prevent auto-import, and restoring access does not silently add the skipped case");

    storage.values.clear();
    await base();
    const originalRaw = storage.getItem(LEDGER_KEY);
    storage.failWrite = true;
    assert.equal((await ensurePublicCaseDemo())?.ok, false);
    assert.equal(storage.getItem(LEDGER_KEY), originalRaw);
    storage.failWrite = false;
    assert.equal(success(await ensurePublicCaseDemo()).state.insights.length, 17);
    assert.equal(await ensurePublicCaseDemo(), null);
    passed("failed storage writes leave no partial public pack; retry imports exactly five cases");
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
  process.stdout.write(`\n${checks} public-case checks passed.\n`);
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
