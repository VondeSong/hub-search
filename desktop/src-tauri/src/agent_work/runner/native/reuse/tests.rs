use super::*;
use crate::agent_work::{actions, artifacts};
use crate::source_evidence::tests::Fixture;

fn frozen() -> Value {
    serde_json::from_str(include_str!("fixtures/charts-boundary-20261024.json")).unwrap()
}
fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn binding(f: &Fixture, work: &Work, environment: &crate::hub_capabilities::Session) -> Value {
    json!({"charts":artifacts::manifest_on(&f.root, &f.c(), work).unwrap(),"protocol":3,
        "skills":environment.fingerprint(),"selection":null,"grant":work.grant,
        "authorizationVersion":work.authorization_version,"tools":super::super::tools(Some(environment)).unwrap(),"sharedMemory":null})
}
fn output(name: &str, value: &Value) {
    if let Ok(directory) = std::env::var("HUB_NATIVE_REUSE_REPORT") {
        std::fs::write(
            Path::new(&directory).join(name),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}

struct Scenario {
    f: Fixture,
    work: Work,
    run: String,
    environment: crate::hub_capabilities::Session,
    initial: Value,
    refs: Value,
    dependency: (EvidenceLocator, EvidenceVersion),
}
impl Scenario {
    fn new() -> Self {
        let saved = frozen();
        let body = saved["source"].as_str().unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(body.as_bytes())),
            saved["sourceHash"]
        );
        assert_eq!((body.chars().count(), body.len()), (141, 317));
        let f = Fixture::new();
        f.note("notes", "current", body);
        let locator =
            json!({"kind":"note","libraryId":"notes","documentId":"current","pageId":null});
        let view = crate::agent_work::ui(
            &f.root,
            &json!({"action":"create","goal":saved["goal"],
            "successCriteria":"核对原文、覆盖、排除与月均；保留图表供纠正，不修改来源",
            "anchor":locator,"grant":{"libraryIds":[],"notes":[locator],"readingItemKeys":[]}}),
        )
        .unwrap();
        let (work, run) = crate::agent_work::tests::claim(&f, view["work"]["id"].as_str().unwrap());
        let mut environment =
            crate::hub_capabilities::Session::new(&f.root, Some(work.grant.scope().unwrap()))
                .unwrap();
        let initial = binding(&f, &work, &environment);
        let snapshot = environment
            .call("hub_create_analysis_snapshot", &json!({}), "")
            .unwrap();
        let source = environment.call("hub_read_analysis_snapshot", &json!({"expectedSnapshot":snapshot["snapshot"],"itemIndex":0,"start":0,"limit":8000}), "").unwrap();
        assert_eq!(source["content"], saved["source"]);
        let arguments: Value = serde_json::from_str(include_str!(
            "../input/fixtures/sleep-arguments-20261024.json"
        ))
        .unwrap();
        let mut request = arguments["accepted"][0]["arguments"]["request"].clone();
        request["expectedSnapshot"] = snapshot["snapshot"].clone();
        // Rebind only the isolated source identity; semantic labels and scalar
        // coordinates remain the saved successful three-day request.
        for row in request["rows"].as_array_mut().unwrap() {
            for evidence in row["evidenceRefs"].as_array_mut().unwrap() {
                evidence["sourceRevision"] = source["sourceRevision"].clone();
                evidence["contentHash"] = source["sourceRevision"]["bodySha256"].clone();
            }
        }
        let dataset =
            artifacts::sleep::execute(&f.root, &work, &run, &request, &Control::default()).unwrap();
        let request = json!({"action":"create","operationId":"reuse-sleep-chart",
            "analysis":{"source":"sleepDataset","expectedSnapshot":snapshot["snapshot"],"datasetId":dataset["datasetId"],"datasetRevision":dataset["revision"],"aggregation":"monthlyMean"},
            "spec":{"title":"主睡眠月均时长","mark":"bar","metric":"sleep_duration_hours","term":null,"sort":"groupAsc"}});
        let chart =
            artifacts::execute(&f.root, &work, &run, &request, &Control::default()).unwrap();
        assert_eq!(
            chart["content"]["data"]["rows"],
            json!([{"group":"2025-01","value":7.25,"sampleCount":2}])
        );
        artifacts::execute(&f.root, &work, &run, &json!({"action":"validate","artifactId":chart["artifactId"],"revision":chart["revision"]}), &Control::default()).unwrap();
        let refs = artifacts::run_references(&f.c(), &work, &run).unwrap();
        assert_eq!(refs.as_array().unwrap().len(), 1);
        let excerpt = work
            .grant
            .reader(&f.root)
            .unwrap()
            .read(work.anchor.as_ref().unwrap(), 0, 8000, None)
            .unwrap();
        let dependency = (excerpt.locator, excerpt.version);
        Self {
            f,
            work,
            run,
            environment,
            initial,
            refs,
            dependency,
        }
    }
    fn publish(&self, work: &Work, run: &str) {
        let context = store::goal::completion::read_context(&self.f.root, work, run).unwrap();
        let proof = context["proofs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["kind"] == "chart")
            .unwrap();
        let items = context["requirements"].as_array().unwrap().iter().map(|r| json!({"requirementId":r["requirementId"],"criterion":r["text"],"requiredResult":"chart","status":"satisfied","explanation":"冻结三日原文复核：6.5、8小时，一月平均7.25；二月歧义不补零，覆盖及排除保留","refs":[proof["proofId"]],"supersededBy":null})).collect::<Vec<_>>();
        let report: Report = serde_json::from_value(json!({"status":"completed","summary":"一月主睡眠平均7.25小时，有效样本2；二月实际时长未知，不由起止时间推算。","findings":[],"nextSteps":[],"questions":[],"limitations":["仅三日合成标注，历史完整性未知"],"waitCondition":"","completion":{"goalBinding":context["goalBinding"],"items":items}})).unwrap();
        assert_eq!(
            store::goal::accept_report(&self.f.root, work, run, &report, &context["goalBinding"])
                .unwrap()["workFulfillment"],
            "fulfilled"
        );
        store::publish(
            &self.f.root,
            work,
            run,
            &report,
            &[],
            &[],
            &actions::receipts(&self.f.root, &work.id).unwrap(),
            &json!({}),
            &Control::default(),
        )
        .unwrap();
    }
    fn reject(&self, work: &Work, refs: &Value) -> Value {
        let diagnostic = chart_context(&self.f.root, work, &json!({"artifactRefs":refs}));
        assert_eq!(diagnostic["state"], "unavailable");
        let before = store::records(&self.f.root, &work.id, "chartContext", 32).unwrap();
        assert!(artifacts::inherit_references(
            &self.f.root,
            work,
            &self.run,
            refs,
            &Control::default()
        )
        .is_err());
        assert_eq!(
            store::records(&self.f.root, &work.id, "chartContext", 32).unwrap(),
            before
        );
        diagnostic
    }
}

#[test]
fn saved_chart_drift_replays_and_success_checkpoint_keeps_protected_bindings() {
    let saved = frozen();
    assert_eq!(
        hash(&saved["initialCharts"]),
        saved["initialSessionParts"]["charts"]
    );
    assert_eq!(
        hash(&saved["correctedRequestCharts"]),
        saved["correctionSessionParts"]["charts"]
    );
    let settled_hash = hash(&saved["settledCharts"]);
    assert_ne!(settled_hash, saved["initialSessionParts"]["charts"]);
    assert_ne!(settled_hash, saved["correctionSessionParts"]["charts"]);
    for (key, value) in saved["initialSessionParts"].as_object().unwrap() {
        if key != "charts" {
            assert_eq!(value, &saved["correctionSessionParts"][key]);
        }
    }
    let s = Scenario::new();
    let settled = checkpoint(&s.f.root, &s.work, &s.initial, true).unwrap();
    let current = binding(&s.f, &s.work, &s.environment);
    assert_eq!(settled["fingerprint"], hash(&current));
    assert_eq!(settled["bindingParts"], measurement::fingerprints(&current));
    assert_eq!(settled["bindingPhase"], "settled");
    assert_ne!(settled["fingerprint"], hash(&s.initial));
    let initial_parts = measurement::fingerprints(&s.initial);
    for (key, value) in initial_parts.as_object().unwrap() {
        if key != "charts" {
            assert_eq!(value, &settled["bindingParts"][key]);
            let mut changed = current.clone();
            changed[key] = json!({"changed":true});
            assert_ne!(
                settled["fingerprint"],
                hash(&changed),
                "{key} remains binding"
            );
        }
    }
    // A normal same-goal artifact revision also settles to its final manifest.
    let revised = artifacts::execute(&s.f.root, &s.work, &s.run, &json!({
        "action":"patch","operationId":"reuse-chart-revision","artifactId":s.refs[0]["artifactId"],
        "expectedRevision":s.refs[0]["revision"],"analysis":null,
        "spec":{"title":"主睡眠月均时长（复核）","mark":"line","metric":"sleep_duration_hours","term":null,"sort":"groupAsc"},
        "reason":"同一用户要求下调整呈现并重新核对"
    }), &Control::default()).unwrap();
    artifacts::execute(&s.f.root, &s.work, &s.run, &json!({"action":"validate","artifactId":revised["artifactId"],"revision":revised["revision"]}), &Control::default()).unwrap();
    let revised_checkpoint = checkpoint(&s.f.root, &s.work, &s.initial, true).unwrap();
    assert_eq!(
        revised_checkpoint["fingerprint"],
        hash(&binding(&s.f, &s.work, &s.environment))
    );
    assert_ne!(revised_checkpoint["fingerprint"], settled["fingerprint"]);
    assert_eq!(revised["revision"], 2);
    let failed = checkpoint(&s.f.root, &s.work, &s.initial, false).unwrap();
    assert_eq!(failed["fingerprint"], hash(&s.initial));
    assert_eq!(failed["bindingParts"], initial_parts);
    assert_eq!(failed["bindingPhase"], "initial");
    output(
        "checkpoint-replay.json",
        &json!({"savedInitialChartsHash":hash(&saved["initialCharts"]),"savedSettledChartsHash":settled_hash,"savedCorrectionChartsHash":hash(&saved["correctedRequestCharts"]),"checkpoint":settled,"revisedCheckpoint":revised_checkpoint,"failedCheckpoint":failed,"protectedPartsUnchanged":true,"sourceSha256":saved["sourceHash"]}),
    );
}

#[test]
fn settled_continuation_matches_but_user_correction_still_requires_revalidation() {
    let s = Scenario::new();
    let settled = checkpoint(&s.f.root, &s.work, &s.initial, true).unwrap();
    s.publish(&s.work, &s.run);
    let old_delivery = store::records(&s.f.root, &s.work.id, "delivery", 1).unwrap()[0].clone();
    let (next, next_run) = crate::agent_work::tests::claim(&s.f, &s.work.id);
    let mut environment =
        crate::hub_capabilities::Session::new(&s.f.root, Some(next.grant.scope().unwrap()))
            .unwrap();
    let current = binding(&s.f, &next, &environment);
    assert_ne!(
        hash(&s.initial),
        hash(&current),
        "old start checkpoint would falsely rebuild"
    );
    assert_eq!(settled["fingerprint"], hash(&current));
    next.grant
        .reader(&s.f.root)
        .unwrap()
        .verify_bundle(&[], &[s.dependency.clone()])
        .unwrap();
    environment.inherit_reads(&s.environment.reads()).unwrap();
    environment
        .inherit_rules(&s.environment.rule_reads())
        .unwrap();
    environment
        .inherit_materials(&s.environment.material_reads())
        .unwrap();
    let current_diagnostic = chart_context(&s.f.root, &next, &json!({"artifactRefs":s.refs}));
    assert_eq!(current_diagnostic["state"], "current");
    artifacts::inherit_references(&s.f.root, &next, &next_run, &s.refs, &Control::default())
        .unwrap();
    assert_eq!(
        artifacts::run_references(&s.f.c(), &next, &next_run).unwrap()[0]["inherited"],
        true
    );
    s.publish(&next, &next_run);
    assert_eq!(
        store::records(&s.f.root, &s.work.id, "delivery", 2).unwrap()[1],
        old_delivery
    );
    let command = frozen();
    crate::agent_work::ui(&s.f.root, &json!({"action":"message","id":s.work.id,"text":command["correction"],"clientMessageId":"reuse-correction"})).unwrap();
    let (corrected, corrected_run) = crate::agent_work::tests::claim(&s.f, &s.work.id);
    corrected
        .grant
        .reader(&s.f.root)
        .unwrap()
        .verify_bundle(&[], &[s.dependency.clone()])
        .unwrap();
    let correction_binding = binding(&s.f, &corrected, &environment);
    assert_ne!(settled["fingerprint"], hash(&correction_binding));
    let corrected_parts = measurement::fingerprints(&correction_binding);
    for (key, value) in settled["bindingParts"].as_object().unwrap() {
        if key != "charts" {
            assert_eq!(value, &corrected_parts[key]);
        }
    }
    let stale = chart_context(&s.f.root, &corrected, &json!({"artifactRefs":s.refs}));
    assert_eq!(stale["state"], "stale");
    assert_eq!(stale["classification"], "artifactRevalidationRequired");
    assert!(stale["reason"].as_str().unwrap().contains("用户要求已更新"));
    assert!(artifacts::inherit_references(
        &s.f.root,
        &corrected,
        &corrected_run,
        &s.refs,
        &Control::default()
    )
    .is_err());
    assert!(
        artifacts::run_references(&s.f.c(), &corrected, &corrected_run)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    let completion =
        store::goal::completion::read_context(&s.f.root, &corrected, &corrected_run).unwrap();
    assert!(!completion["proofs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["kind"] == "chart"));
    let view = store::view(&s.f.root, &s.work.id).unwrap();
    assert!(view["conversation"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["artifactState"] == "stale"));
    output(
        "continuation-boundary.json",
        &json!({"ordinaryContinuationFingerprintMatches":true,"sourceRulesAndMaterialsRevalidated":true,"ordinaryInheritanceAndStrictDeliveryPassed":true,"oldDeliveryPreserved":true,"correctionStillRebuilds":true,"currentDiagnostic":current_diagnostic,"correctionDiagnostic":stale,"staleChartProofExcluded":true}),
    );
}

#[test]
fn invalid_sources_authorization_hash_and_expiry_cannot_become_reusable() {
    let s = Scenario::new();
    let mut bad = s.refs.clone();
    bad[0]["contentHash"] = json!("0".repeat(64));
    let tampered = s.reject(&s.work, &bad);
    s.f.c()
        .execute(
            "UPDATE agent_works SET authorization_version=authorization_version+1 WHERE id=?1",
            [&s.work.id],
        )
        .unwrap();
    let changed = store::load(&s.f.c(), &s.work.id).unwrap();
    let authorization = s.reject(&changed, &s.refs);
    s.f.c()
        .execute(
            "UPDATE agent_works SET authorization_version=?1 WHERE id=?2",
            params![s.work.authorization_version, s.work.id],
        )
        .unwrap();
    s.f.note(
        "notes",
        "current",
        "来源已变化；不能把图表诊断视为完整来源验证",
    );
    let source_error = s
        .work
        .grant
        .reader(&s.f.root)
        .unwrap()
        .verify_bundle(&[], &[s.dependency.clone()])
        .unwrap_err();
    assert!(source_error.contains("检索候选已改变"));
    let mut environment =
        crate::hub_capabilities::Session::new(&s.f.root, Some(s.work.grant.scope().unwrap()))
            .unwrap();
    let frozen_materials = s.environment.material_reads();
    environment.inherit_materials(&frozen_materials).unwrap();
    assert_eq!(environment.material_reads(), frozen_materials);
    let snapshot = &frozen_materials
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()["snapshot"];
    let historical = environment
        .call(
            "hub_read_analysis_snapshot",
            &json!({"expectedSnapshot":snapshot,"itemIndex":0,"start":0,"limit":8000}),
            "",
        )
        .unwrap();
    assert_eq!(historical["content"], frozen()["source"]);
    // Immutable historical material remains readable. Native reuse still fails
    // its earlier, independent current-source check; artifact state alone is
    // deliberately not a full context eligibility decision.
    let changed_source = chart_context(&s.f.root, &s.work, &json!({"artifactRefs":s.refs}));
    assert_eq!(changed_source["state"], "current");
    assert_eq!(changed_source["checks"], "artifactReferencesOnly");
    s.f.c()
        .execute(
            "DELETE FROM documents WHERE space_id='notes' AND id='current'",
            [],
        )
        .unwrap();
    let deleted = s.reject(&s.work, &s.refs);
    s.f.note("notes", "current", frozen()["source"].as_str().unwrap());
    let snapshots = Connection::open(s.f.root.join("analysis-snapshots.sqlite3")).unwrap();
    snapshots
        .execute("UPDATE snapshots SET expires_at=0", [])
        .unwrap();
    drop(snapshots);
    let expired = s.reject(&s.work, &s.refs);
    assert!(expired["reason"]
        .as_str()
        .unwrap()
        .contains("snapshot_expired"));
    output(
        "invalidation-boundary.json",
        &json!({"tampered":tampered,"authorization":authorization,"changedSourceArtifactDiagnostic":changed_source,"changedSourceGuardRejected":source_error,"frozenMaterialStillReadable":true,"deleted":deleted,"expired":expired,"rejectedInheritanceWroteNothing":true}),
    );
}
