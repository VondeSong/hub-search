// Isolated stdio acceptance. Requires Node 22+; never opens the user's Hub data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const executable = process.argv[2];
if (!executable) throw new Error("Usage: node scripts/hub-tag-audit-smoke.mjs <hub-exe>");
const root = mkdtempSync(join(tmpdir(), "hub-audit-smoke-"));
const database = join(root, "craft-search.sqlite3");
new DatabaseSync(database).close();

// A separate MCP process per call deliberately tests cross-process restoration.
function rpc(method, params) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "isolated-audit-test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method, params },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  const child = spawnSync(resolve(executable), ["--mcp", "--data-dir", root], {
    input, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  const response = child.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((value) => value.id === 2);
  assert.ok(response, child.stdout);
  if (response.error) throw new Error(response.error.message);
  if (response.result.isError) throw new Error(JSON.stringify(response.result.content));
  return response.result.structuredContent ?? response.result;
}
const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
const argsFor = (state, action, extra = {}) => ({ action, runId: state.run.runId, expectedVersion: state.run.version, requestId: `${state.run.version}:${action}`, ...extra });
const start = (current) => call("hub_tag_audit_step", { action: "start", expectedIndexRevision: current.indexRevision, expectedAuditRevision: current.auditRevision, idempotencyKey: `global-tag-audit:${current.auditRevision}` });

try {
  const catalog = rpc("tools/list", {});
  assert.equal(catalog.tools.length, 23);
  assert.equal(catalog.tools.find((t) => t.name === "hub_tag_audit_step").annotations.readOnlyHint, false);
  assert.equal(call("hub_tag_audit_status").run, null); // Initializes only the isolated DB.
  const fixture = new DatabaseSync(database);
  try {
    fixture.exec(`INSERT INTO spaces(id,name,mcp_url,added_at) VALUES ('test','Test','https://example.invalid',1);
      INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES ('test','craft','Test',1,1);
      INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider) VALUES
      ('test','a','A','A','one',1,'a','craft'),('test','b','B','B','two',1,'b','craft');
      INSERT INTO craft_tags(space_id,document_id,page_id,tag,normalized_tag) VALUES
      ('test','a','a','alpha','alpha'),('test','b','b','beta','beta');`);
  } finally { fixture.close(); }
  let current = call("hub_tag_audit_status");
  let state = start(current);
  const runId = state.run.runId;
  assert.equal(start(current).run.runId, runId);
  state = call("hub_tag_audit_step", argsFor(state, "scan"));
  assert.deepEqual(call("hub_tag_audit_status").run.pendingCatalogPage, state.run.pendingCatalogPage);
  state = call("hub_tag_audit_step", argsFor(state, "queue", { candidates: [
    { tagIds: ["alpha"], reason: "singleton" }, { tagIds: ["beta"], reason: "singleton" },
  ], acknowledgePage: true }));
  const proposalIds = [];
  for (const tag of ["alpha", "beta"]) {
    const args = argsFor(state, "record", { itemId: state.run.items[0].itemId, submitForReview: true, proposal: {
      schemaVersion: "hub.tag-governance.v1", indexRevision: state.indexRevision, summary: "Insufficient evidence",
      recommendations: [{ type: "insufficient_evidence", sourceTagIds: [tag], confidence: 0.3, rationale: "One note is not enough", executed: false }],
    } });
    state = call("hub_tag_audit_step", args);
    const replay = call("hub_tag_audit_step", args);
    assert.equal(replay.replayed, true);
    assert.equal(replay.recordedProposalId, state.recordedProposalId);
    proposalIds.push(state.recordedProposalId);
    assert.equal(call("hub_preview_tag_governance_proposal", { proposalId: state.recordedProposalId }).stale, false);
  }
  assert.equal(new Set(proposalIds).size, 2);
  assert.equal(state.run.candidatePending, 0);
  state = call("hub_tag_audit_step", argsFor(state, "finish"));
  assert.equal(call("hub_tag_audit_status").run.status, "completed");
  const inspect = new DatabaseSync(database);
  try {
    assert.equal(inspect.prepare("SELECT COUNT(*) n FROM tag_governance_proposals WHERE status='pending'").get().n, 2);
    assert.equal(inspect.prepare("SELECT COUNT(*) n FROM tag_taxonomy_relations").get().n, 0);
    assert.equal(inspect.prepare("SELECT COUNT(*) n FROM craft_tags").get().n, 2);
    inspect.exec("UPDATE documents SET title='Changed' WHERE id='a'");
  } finally { inspect.close(); }
  current = call("hub_tag_audit_status");
  assert.equal(current.indexRevision, state.indexRevision); // Same size/timestamp, changed evidence.
  assert.equal(current.run.stale, true);
  assert.throws(() => call("hub_tag_audit_step", argsFor(state, "finish")), /索引已经变化/);
  const fresh = start(current);
  assert.notEqual(fresh.run.runId, runId);
  assert.equal(fresh.run.catalogScanned, 0);
  assert.equal(call("hub_tag_audit_status", { runId }).run.stale, true);
  console.log("PASS: 23 MCP tools; cross-process resume; atomic record/retry; independent proposals; finish; stale fingerprint; fresh run; no source tag or taxonomy changes.");
} finally {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("hub-audit-smoke-")) {
    throw new Error("Refusing cleanup outside the isolated test directory");
  }
  rmSync(root, { recursive: true, force: true });
}
