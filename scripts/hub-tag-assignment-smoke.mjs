// Production MCP smoke test against a newly created, isolated database only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

if (!process.argv[2]) throw new Error("Pass the Hub executable path");
const executable = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), "hub-assignment-smoke-"));
const database = join(root, "craft-search.sqlite3");
new DatabaseSync(database).close();
function rpc(method, params = {}) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "assignment-smoke", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method, params },
  ].map(v => JSON.stringify(v)).join("\n") + "\n";
  const result = spawnSync(executable, ["--mcp", "--data-dir", root], {
    input, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const response = result.stdout.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)).find(r => r.id === 2);
  assert.ok(response, result.stdout);
  if (response.error || response.result.isError) throw new Error(JSON.stringify(response.error ?? response.result.content));
  return response.result.structuredContent ?? response.result;
}
const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
try {
  const tools = rpc("tools/list").tools;
  assert.equal(tools.length, 32);
  assert.ok(tools.every(t => !t.name.includes("budget")), "Budget writes must remain desktop-only");
  assert.throws(() => call("scan_apply_budget", { runId: "forbidden", addChars: 15000 }));
  assert.throws(() => call("scan_create_new", { tag: "focus" }), "New-round confirmation must remain desktop-only");
  assert.throws(() => call("scan_budget_history", { runId: "test" }), "Budget history is a desktop command, not a new MCP tool");
  assert.throws(() => call("scan_apply_reopen", { runId: "test", ordinal: 1 }), "Reopening requires desktop user confirmation");
  assert.throws(() => call("scan_reopen_history", { runId: "test" }), "Reopen history remains a desktop-only query");
  assert.throws(() => call("scan_check_items", { runId: "test" }), "Batch validity checks remain desktop-only");
  assert.throws(() => call("scan_check_save", { runId: "test", requestId: "forbidden" }), "Checkpoint writes remain desktop-only");
  assert.throws(() => call("scan_check_saved", { runId: "test" }), "Saved checkpoint recovery remains desktop-only");
  assert.throws(() => call("scan_check_history", { runId: "test" }), "Check history remains desktop-only");
  assert.equal(tools.filter(t => t.name.includes("assignment") && !t.annotations.readOnlyHint).length, 2);
  assert.equal(call("hub_tag_assignment_definition", { tag: "focus" }).definition, null);
  const fixture = new DatabaseSync(database);
  try {
    fixture.exec(`INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES ('lib','obsidian','Test',1,1);
      INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider)
      VALUES ('lib','note','Note','Note.md','Pause before acting on impulse.',1,'hash','obsidian');
      INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at)
      VALUES ('focus',1,'{"description":"Impulse awareness","include":"Pause before acting","exclude":"","libraryIds":["lib"]}',1);`);
  } finally { fixture.close(); }
  const source = { provider: "obsidian", libraryId: "lib", documentId: "note", pageId: "" };
  const e = call("hub_read_tag_assignment_evidence", { source });
  const args = {
    schemaVersion: "hub.tag-assignment.v1", tag: "focus", source, sourceHash: e.sourceHash,
    definitionVersion: 1, decision: "recommend_add", quote: e.content,
    rationale: "Explicitly describes pausing.", risks: "Review required", confidence: 0.8,
    generator: { agent: "codex", workflow: "single-tag-assignment" }, executed: false, idempotencyKey: "smoke",
  };
  const stored = call("hub_submit_tag_assignment_proposal", args);
  assert.equal(stored.proposal.status, "pending");
  assert.equal(call("hub_submit_tag_assignment_proposal", args).replayed, true);
  assert.equal(call("hub_list_tag_assignment_proposals").proposals.length, 1);
  const id = stored.proposal.proposalId;
  assert.equal(call("hub_preview_tag_assignment_proposal", { proposalId: id }).reviewBlocked, false);
  assert.throws(() => call("hub_resolve_tag_assignment_proposal", { proposalId: id, resolution: "accept" }));
  const scanStart = { action: "start", tag: "focus", definitionVersion: 1, idempotencyKey: "scan-smoke", maxChars: 60, maxEntities: 1 };
  const scan = call("hub_tag_content_scan_step", scanStart).run;
  const jointFixture = new DatabaseSync(database);
  try {
    jointFixture.exec("INSERT INTO tag_assignment_definitions(tag,version,definition_json,updated_at) SELECT 'second',version,definition_json,updated_at FROM tag_assignment_definitions WHERE tag='focus'");
  } finally { jointFixture.close(); }
  assert.equal(tools.find(t => t.name === "hub_tag_content_scan_step").inputSchema.properties.additionalTags.maxItems, 4);
  assert.ok(tools.find(t => t.name === "hub_submit_tag_assignment_proposal").inputSchema.properties.generator.properties.workflow.enum.includes("multi-tag-assignment"));
  assert.equal(scan.totalEntities, 1);
  assert.equal(call("hub_tag_content_scan_step", scanStart).run.runId, scan.runId);
  assert.equal(call("hub_tag_content_scan_status", { runId: scan.runId }).items[0].source.documentId, "note");
  const readArgs = { action: "read", runId: scan.runId, expectedVersion: scan.version, requestId: "read", ordinal: 1, maxChars: 15, additionalTags: [{tag:"second",definitionVersion:1}] };
  const read = call("hub_tag_content_scan_step", readArgs);
  assert.equal(read.result.evidence.additionalTagContexts[0].status, "eligible");
  assert.equal(read.result.evidence.additionalTagContexts[0].definitionVersion, 1);
  assert.equal(read.result.evidence.additionalTagContexts[0].content, undefined);
  assert.equal(read.run.entitiesRead, 1);
  const replay = call("hub_tag_content_scan_step", readArgs);
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.charsRead, 15);
  const tailRead = call("hub_tag_content_scan_step", { ...readArgs, expectedVersion: read.run.version, requestId: "tail-read", startChar: 15, maxChars: 60 });
  assert.equal(tailRead.run.charsRead, e.content.length);
  const recorded = call("hub_tag_content_scan_step", { action: "record", runId: scan.runId, expectedVersion: tailRead.run.version, requestId: "record", ordinal: 1, proposalId: id });
  assert.equal(recorded.run.decisionCounts.recommend_add, 1);
  assert.throws(()=>call("hub_tag_content_scan_step", { action: "finish", runId: scan.runId, expectedVersion: recorded.run.version, requestId: "premature-finish" }));
  const secondary = call("hub_submit_tag_assignment_proposal", {...args,tag:"second",idempotencyKey:"secondary",quote:"Pause before",generator:{agent:"codex",workflow:"multi-tag-assignment"}});
  assert.equal(call("hub_preview_tag_assignment_proposal",{proposalId:secondary.proposal.proposalId}).reviewBlocked,false);
  const secondaryRecorded=call("hub_tag_content_scan_step",{action:"record_secondary",runId:scan.runId,expectedVersion:recorded.run.version,ordinal:1,tag:"second",proposalId:secondary.proposal.proposalId,requestId:"secondary-record"});
  assert.equal(secondaryRecorded.run.jointCounts.recorded,1);
  assert.equal(secondaryRecorded.run.charsRead,recorded.run.charsRead);
  assert.equal(call("hub_tag_content_scan_status",{runId:scan.runId,filter:"all"}).items[0].jointItems[0].state,"recorded");
  const completed = call("hub_tag_content_scan_step", { action: "finish", runId: scan.runId, expectedVersion: secondaryRecorded.run.version, requestId: "finish" });
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.result.semanticAnalysisComplete, false);
  assert.ok(tools.find(t => t.name === "hub_tag_content_scan_step").inputSchema.properties.action.enum.includes("reuse"));
  const nextScan = call("hub_tag_content_scan_step", { ...scanStart, idempotencyKey: "reuse-smoke" }).run;
  const reuseArgs = { action: "reuse", runId: nextScan.runId, ordinal: 1, expectedVersion: 1, requestId: "reuse" };
  const reused = call("hub_tag_content_scan_step", reuseArgs);
  assert.equal(reused.result.state, "reused");
  assert.equal(reused.result.proposalId, id);
  assert.equal(reused.run.counts.reused, 1);
  assert.equal(reused.run.counts.recorded, 0);
  assert.equal(reused.run.charsRead, 0);
  assert.equal(reused.result.verifiedReadReceiptCount, 2);
  assert.equal(reused.result.coveredChars, e.content.length);
  assert.equal(reused.result.evidence, undefined);
  assert.equal(call("hub_tag_content_scan_step", reuseArgs).replayed, true);
  assert.equal(call("hub_list_tag_assignment_proposals").proposals.length, 2);
  const check = new DatabaseSync(database);
  try {
    assert.equal(check.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, "62");
    assert.equal(check.prepare("SELECT COUNT(*) n FROM hub_content_tags").get().n, 0);
    assert.equal(check.prepare("SELECT COUNT(*) n FROM obsidian_tags").get().n, 0);
    check.exec("UPDATE documents SET markdown='Changed evidence' WHERE id='note'");
  } finally { check.close(); }
  const preview = call("hub_preview_tag_assignment_proposal", { proposalId: id });
  assert.equal(preview.stale, true); assert.equal(preview.reviewBlocked, true);
  assert.equal(call("hub_tag_content_scan_step", reuseArgs).result.state, "stale_reuse");
  const historyFixture = new DatabaseSync(database);
  try {
    historyFixture.exec("UPDATE tag_assignment_proposals SET status='rejected',note='Temporary test rejection'; UPDATE tag_assignment_definitions SET version=2");
  } finally { historyFixture.close(); }
  const fresh=call("hub_read_tag_assignment_evidence",{tag:"focus",source});
  assert.equal(fresh.rejectionHistory.items[0].proposalId,id);
  assert.equal(fresh.rejectionHistory.items[0].sameSourceHash,false);
  const reconsider={...args,definitionVersion:2,sourceHash:fresh.sourceHash,quote:fresh.content,idempotencyKey:"reconsider"};
  assert.throws(()=>call("hub_submit_tag_assignment_proposal",reconsider),/reconsiderationReason/);
  const reconsidered=call("hub_submit_tag_assignment_proposal",{...reconsider,reconsiderationReason:"Changed evidence warrants another human review."});
  assert.equal(reconsidered.proposal.status,"pending");
  assert.equal(call("hub_preview_tag_assignment_proposal",{proposalId:reconsidered.proposal.proposalId}).rejectionHistory.items[0].proposalId,id);
  assert.equal(call("hub_list_tag_assignment_proposals",{status:"rejected"}).proposals.length,2);
  assert.throws(()=>call("apply_exclusion",{proposalId:id,excluded:true}));
  assert.throws(()=>call("list_exclusions",{mode:"history"}));
  assert.throws(()=>call("preview_exclusion_review",{exclusionEventId:1}));
  assert.throws(()=>call("exclusion_review_history",{exclusionEventId:1}));
  assert.throws(()=>call("exclusion_review_due",{tag:"focus"}));
  assert.throws(()=>call("apply_exclusion_review",{exclusionEventId:1,requestId:"forbidden"}));
  assert.throws(()=>call("apply_exclusion",{exclusionEventId:1,excluded:false}),"Event-based recovery must remain desktop-only");
  const exclusionFixture=new DatabaseSync(database);
  try {
    exclusionFixture.prepare("INSERT INTO tag_assignment_exclusion_events(tag,entity_id,proposal_id,excluded,request_key,request_hash,created_at) VALUES ('focus',?, ?,1,'fixture','fixture',1)").run(fresh.entityId,id);
    exclusionFixture.exec("UPDATE tag_assignment_definitions SET version=3");
  } finally { exclusionFixture.close(); }
  assert.equal(call("hub_read_tag_assignment_evidence",{tag:"focus",source}).exclusionPreference.excluded,true);
  assert.equal(call("hub_preview_tag_assignment_proposal",{proposalId:reconsidered.proposal.proposalId}).reviewBlocked,true);
  assert.throws(()=>call("hub_submit_tag_assignment_proposal",{...reconsider,definitionVersion:3,idempotencyKey:"excluded",reconsiderationReason:"Cannot bypass preference"}),/持续排除/);
  assert.ok(tools.find(t => t.name === "hub_tag_content_scan_step").inputSchema.properties.action.enum.includes("skip_excluded"));
  const skipRun=call("hub_tag_content_scan_step",{...scanStart,definitionVersion:3,idempotencyKey:"skip-excluded"}).run;
  const skipArgs={action:"skip_excluded",runId:skipRun.runId,ordinal:1,expectedVersion:skipRun.version,requestId:"skip"};
  const skipped=call("hub_tag_content_scan_step",skipArgs);
  assert.equal(skipped.result.state,"excluded");
  assert.equal(skipped.run.counts.excluded,1);
  assert.equal(skipped.run.charsRead,0);
  assert.equal(skipped.run.entitiesRead,0);
  assert.equal(skipped.result.evidence,undefined);
  assert.equal(call("hub_tag_content_scan_step",skipArgs).replayed,true);
  const skipFinished=call("hub_tag_content_scan_step",{action:"finish",runId:skipRun.runId,expectedVersion:skipped.run.version,requestId:"finish-skipped"});
  assert.equal(skipFinished.run.status,"completed");
  assert.equal(skipFinished.result.semanticAnalysisComplete,false);
  // Seed only this isolated fixture as desktop-confirmed. MCP cannot create union runs.
  assert.throws(()=>call("hub_tag_content_scan_step",{...scanStart,definitionVersion:3,idempotencyKey:"forbidden-union",unionTags:[{tag:"second",definitionVersion:3}]}));
  const unionRun=call("hub_tag_content_scan_step",{...scanStart,definitionVersion:3,idempotencyKey:"union-fixture"}).run;
  const unionFixture=new DatabaseSync(database);
  try {
    const definition=JSON.parse(unionFixture.prepare("SELECT definition_json FROM tag_assignment_definitions WHERE tag='second'").get().definition_json);
    unionFixture.prepare("INSERT INTO tag_content_scan_joint_selections(run_id,contexts_json) VALUES (?,?)").run(unionRun.runId,JSON.stringify([{tag:"second",definitionVersion:3,definition}]));
    unionFixture.prepare("UPDATE tag_content_scan_runs SET manifest_mode='union' WHERE id=?").run(unionRun.runId);
  } finally { unionFixture.close(); }
  const unionReadArgs={action:"read",runId:unionRun.runId,ordinal:1,expectedVersion:unionRun.version,requestId:"union-read",maxChars:60};
  const unionRead=call("hub_tag_content_scan_step",unionReadArgs);
  assert.equal(unionRead.run.manifestMode,"union");
  assert.deepEqual(unionRead.run.manifestScope,["lib"]);
  assert.equal(unionRead.result.evidence.primaryTagStatus,"excluded");
  assert.equal(unionRead.result.evidence.additionalTagContexts[0].status,"eligible");
  assert.equal(unionRead.result.evidence.content,fresh.content);
  assert.equal(unionRead.run.counts.joint_only,1);
  assert.equal(unionRead.run.jointCounts.pending,1);
  assert.equal(unionRead.run.charsRead,fresh.content.length);
  assert.equal(call("hub_tag_content_scan_step",unionReadArgs).replayed,true);
  assert.throws(()=>call("hub_tag_content_scan_step",{action:"skip_excluded",runId:unionRun.runId,ordinal:1,expectedVersion:unionRead.run.version,requestId:"union-skip"}));
  assert.throws(()=>call("hub_tag_content_scan_step",{action:"finish",runId:unionRun.runId,expectedVersion:unionRead.run.version,requestId:"union-premature"}));
  assert.ok(tools.find(t=>t.name==="hub_tag_content_scan_status").inputSchema.properties.mode.enum.includes("new_entities"));
  const discoveryArgs={runId:unionRun.runId,mode:"new_entities",limit:1};
  assert.equal(call("hub_tag_content_scan_status",discoveryArgs).newEntityCount,0);
  const discoveryFixture=new DatabaseSync(database);
  try {
    discoveryFixture.exec("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider) VALUES ('lib','new-1','New 1','New1.md','Private new body',1,'hash','obsidian'),('lib','new-2','New 2','New2.md','Private new body',1,'hash','obsidian')");
  } finally { discoveryFixture.close(); }
  const discovery=call("hub_tag_content_scan_status",discoveryArgs);
  assert.equal(discovery.newEntityCount,2);
  assert.equal(discovery.bodyRead,false);
  assert.equal(discovery.items[0].source.documentId,"new-1");
  assert.ok(!JSON.stringify(discovery).includes("Private new body"));
  const discoveryNext=call("hub_tag_content_scan_status",{...discoveryArgs,cursor:discovery.nextCursor});
  assert.equal(discoveryNext.items[0].source.documentId,"new-2");
  assert.equal(discoveryNext.nextCursor,null);
  const afterDiscovery=call("hub_tag_content_scan_status",{runId:unionRun.runId}).run;
  assert.equal(afterDiscovery.totalEntities,1);
  assert.equal(afterDiscovery.version,unionRead.run.version);
  assert.equal(afterDiscovery.charsRead,unionRead.run.charsRead);
  assert.throws(()=>call("hub_tag_content_scan_step",{...scanStart,definitionVersion:3,idempotencyKey:"forbidden-delta",incrementalFromRunId:unionRun.runId}));
  // Only isolated fixture seeding: desktop preview/create is covered by Rust and UI tests.
  const delta=call("hub_tag_content_scan_step",{...scanStart,definitionVersion:3,idempotencyKey:"delta-fixture",maxEntities:3}).run;
  const deltaFixture=new DatabaseSync(database);
  try {
    deltaFixture.prepare("DELETE FROM tag_content_scan_items WHERE run_id=? AND json_extract(source_json,'$.documentId')='note'").run(delta.runId);
    deltaFixture.prepare("INSERT INTO tag_content_scan_incremental(run_id,base_run_id,baseline_hash) VALUES (?,?,'fixture')").run(delta.runId,unionRun.runId);
    deltaFixture.prepare("UPDATE tag_content_scan_runs SET manifest_mode='union' WHERE id=?").run(delta.runId);
    deltaFixture.prepare("INSERT INTO tag_content_scan_joint_selections(run_id,contexts_json) SELECT ?,contexts_json FROM tag_content_scan_joint_selections WHERE run_id=?").run(delta.runId,unionRun.runId);
  } finally { deltaFixture.close(); }
  const deltaStatus=call("hub_tag_content_scan_status",{runId:delta.runId});
  assert.equal(deltaStatus.run.incremental.baseRunId,unionRun.runId);
  assert.equal(deltaStatus.run.totalEntities,2);
  assert.equal(call("hub_tag_content_scan_status",{runId:delta.runId,mode:"new_entities"}).newEntityCount,0);
  const deltaRead=call("hub_tag_content_scan_step",{action:"read",runId:delta.runId,ordinal:deltaStatus.items[0].ordinal,expectedVersion:delta.version,requestId:"delta-read",maxChars:30});
  assert.equal(deltaRead.result.evidence.content,"Private new body");
  assert.equal(deltaRead.result.evidence.additionalTagContexts[0].status,"eligible");
  const draftFixture = new DatabaseSync(database);
  try {
    draftFixture.exec("INSERT OR IGNORE INTO obsidian_tags(space_id,document_id,tag,normalized_tag) VALUES ('lib','note','draft-tag','draft-tag')");
  } finally { draftFixture.close(); }
  const draftArgs = { tag: "draft-tag", expectedVersion: 0, definition: { description: "Impulse", include: "Acting without reflection", exclude: "Considered decisions" }, idempotencyKey: "definition-draft-smoke" };
  const draftResult = call("hub_submit_tag_assignment_definition_draft", draftArgs);
  assert.equal(draftResult.confirmed, false);
  assert.deepEqual(call("hub_submit_tag_assignment_definition_draft", draftArgs), draftResult);
  const draftRead = call("hub_tag_assignment_definition", { tag: "draft-tag" });
  assert.equal(draftRead.definition, null);
  assert.deepEqual(draftRead.draft.definition, draftArgs.definition);
  assert.throws(() => call("hub_submit_tag_assignment_definition_draft", { ...draftArgs, expectedVersion: 1, idempotencyKey: "stale-draft" }));
  console.log("PASS: 32 production MCP tools; assignment review and content scan; definition draft persists across processes without confirmation, idempotent replay and stale-version rejection; existing assignment and scan workflows.");
} finally {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("hub-assignment-smoke-")) throw new Error("Unsafe cleanup path");
  rmSync(root, { recursive: true, force: true });
}
