use super::*;
use crate::source_evidence::tests::Fixture;

pub(super) fn note(id: &str) -> EvidenceLocator {
    EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: id.into(),
        page_id: None,
    }
}

pub(super) struct Case {
    pub(super) f: Fixture,
    pub(super) work: String,
    pub(super) record: String,
    pub(super) run: String,
}

impl Case {
    pub(super) fn new() -> Self {
        let f = Fixture::new();
        f.note(
            "notes",
            "current",
            "样本编号为蓝湾-731。验证前先固定输入、预期结果和通过条件。",
        );
        f.note(
            "notes",
            "progress",
            "本周已完成原型验证；采用先小样本、再扩大范围的方法。",
        );
        let grant = Grant {
            notes: vec![note("current"), note("progress")],
            ..Default::default()
        };
        let view = super::super::ui(&f.root,&json!({"action":"create","goal":"核对方法和进展","successCriteria":"保留依据","anchor":note("current"),"grant":grant})).unwrap();
        let work = view["work"]["id"].as_str().unwrap().to_owned();
        let run = format!("fixture-{}", crate::random_url_safe(12));
        let w = store::claim(&f.root, &work, &run).unwrap();
        let reader = w.grant.reader(&f.root).unwrap();
        let evidence = ["current", "progress"]
            .into_iter()
            .map(|id| reader.read(&note(id), 0, 6000, None).unwrap())
            .collect::<Vec<_>>();
        let report: runner::Report = serde_json::from_value(json!({"status":"completed","summary":"方法和进展","findings":[
            {"text":"验证前需要固定输入、预期结果和通过条件。","citations":[{"evidenceId":"e1","quote":"验证前先固定输入、预期结果和通过条件。"}]},
            {"text":"本周已完成原型验证。","citations":[{"evidenceId":"e2","quote":"本周已完成原型验证"}]}],
            "nextSteps":[],"questions":[],"limitations":[],"waitCondition":""})).unwrap();
        runner::validate(&report, &evidence).unwrap();
        store::publish(
            &f.root,
            &w,
            &run,
            &report,
            &evidence,
            &[],
            &json!([]),
            &json!({}),
            &Control::default(),
        )
        .unwrap();
        let record = f
            .c()
            .query_row(
                "SELECT id FROM agent_records WHERE run_id=?1 AND kind='delivery'",
                [&run],
                |r| r.get(0),
            )
            .unwrap();
        Self {
            f,
            work,
            record,
            run,
        }
    }
    pub(super) fn read(&self) -> Value {
        ui(
            &self.f.root,
            &json!({"action":"insightCandidates","id":self.work,"deliveryRecordId":self.record}),
        )
        .unwrap()
    }
    pub(super) fn alter(&self, change: impl FnOnce(&mut Value)) {
        let c = self.f.c();
        let raw: String = c
            .query_row(
                "SELECT body_json FROM agent_records WHERE id=?1",
                [&self.record],
                |r| r.get(0),
            )
            .unwrap();
        let mut v: Value = serde_json::from_str(&raw).unwrap();
        change(&mut v);
        c.execute(
            "UPDATE agent_records SET body_json=?2 WHERE id=?1",
            params![self.record, v.to_string()],
        )
        .unwrap();
    }
}

#[test]
fn fixed_delivery_identity_and_selected_dependencies_are_read_without_writes() {
    let c = Case::new();
    let before: i64 =
        c.f.c()
            .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r.get(0))
            .unwrap();
    let first = c.read();
    let second = c.read();
    assert_eq!(first, second);
    assert_eq!(first["origin"]["deliveryRecordId"], c.record);
    assert_eq!(first["origin"]["deliveryHash"].as_str().unwrap().len(), 64);
    let list = ui(
        &c.f.root,
        &json!({"action":"insightDeliveries","id":c.work}),
    )
    .unwrap();
    assert_eq!(
        list["items"][0]["deliveryHash"],
        first["origin"]["deliveryHash"]
    );
    assert_eq!(
        first["candidates"][0]["sourceCitations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        first["candidates"][0]["sourceCitations"][0]["excerpt"]["locator"]["documentId"],
        "current"
    );
    assert_eq!(
        first["candidates"][1]["sourceCitations"][0]["excerpt"]["locator"]["documentId"],
        "progress"
    );
    assert_eq!(
        first["candidates"][0]["requiresDependencyConfirmation"],
        true
    );
    assert_eq!(
        before,
        c.f.c()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM agent_records", [], |r| r.get(0))
            .unwrap()
    );
}

#[test]
fn changing_latest_projection_does_not_change_fixed_delivery() {
    let c = Case::new();
    let before = c.read();
    c.f.c()
        .execute(
            "UPDATE agent_works SET report_json=NULL,revision=revision+1 WHERE id=?1",
            [&c.work],
        )
        .unwrap();
    assert_eq!(before, c.read());
}

#[test]
fn changed_source_hides_only_its_finding() {
    let c = Case::new();
    c.f.note("notes", "current", "验证前还须固定适用版本。");
    let v = c.read();
    assert_eq!(v["candidates"][0]["eligibility"], "unavailable");
    assert!(v["candidates"][0].get("text").is_none());
    assert!(v["candidates"][0].get("sourceCitations").is_none());
    assert_eq!(v["candidates"][1]["eligibility"], "verifiedSources");
}

#[test]
fn per_source_revocation_is_not_whole_report_revocation() {
    let c = Case::new();
    let mut w = store::load(&c.f.c(), &c.work).unwrap();
    w.grant.notes.pop();
    c.f.c().execute("UPDATE agent_works SET grant_json=?2,authorization_version=authorization_version+1 WHERE id=?1",params![c.work,serde_json::to_string(&w.grant).unwrap()]).unwrap();
    let v = c.read();
    assert_eq!(v["candidates"][0]["eligibility"], "verifiedSources");
    assert_eq!(v["candidates"][1]["eligibility"], "unavailable");
    assert!(!v["candidates"][1].to_string().contains("本周已完成"));
}

#[test]
fn deleted_source_does_not_leak_snapshot_or_block_independent_finding() {
    let c = Case::new();
    c.f.c()
        .execute("DELETE FROM documents WHERE id='progress'", [])
        .unwrap();
    let v = c.read();
    assert_eq!(v["candidates"][0]["eligibility"], "verifiedSources");
    assert_eq!(v["candidates"][1]["eligibility"], "unavailable");
    assert!(!v["candidates"][1].to_string().contains("本周已完成"));
}

#[test]
fn whole_work_revocation_blocks_both_endpoints() {
    let c = Case::new();
    store::revoke(&c.f.root, &c.work).unwrap();
    for action in ["insightDeliveries", "insightCandidates"] {
        assert!(ui(
            &c.f.root,
            &json!({"action":action,"id":c.work,"deliveryRecordId":c.record})
        )
        .is_err());
    }
}

#[test]
fn another_work_cannot_read_delivery_even_when_sources_overlap() {
    let c = Case::new();
    let other = super::super::tests::create(&c.f, false);
    assert!(ui(
        &c.f.root,
        &json!({"action":"insightCandidates","id":other,"deliveryRecordId":c.record})
    )
    .is_err());
}

#[test]
fn bad_quote_and_missing_evidence_id_are_rejected_individually() {
    for citation in [
        json!({"evidenceId":"e1","quote":"虚构引文"}),
        json!({"evidenceId":"e99","quote":"验证"}),
        json!({"evidenceId":"e0","quote":"验证"}),
    ] {
        let c = Case::new();
        c.alter(|v| v["report"]["findings"][0]["citations"] = json!([citation]));
        let v = c.read();
        assert_eq!(v["candidates"][0]["eligibility"], "unavailable");
        assert_eq!(v["candidates"][1]["eligibility"], "verifiedSources");
    }
}

#[test]
fn plain_prose_and_insufficient_evidence_never_become_candidates() {
    for status in ["completed", "insufficientEvidence"] {
        let c = Case::new();
        c.alter(|v| {
            v["report"]["status"] = json!(status);
            v["report"]["findings"] = json!([]);
            v["report"]["prose"] = json!({"markdown":"不能拆段变发现"});
        });
        let v = c.read();
        assert_eq!(v["candidates"], json!([]));
        assert!(v["reason"].is_string());
    }
}

#[test]
fn derived_materials_are_not_silently_treated_as_note_evidence() {
    let c = Case::new();
    c.alter(|v| v["materialReads"] = json!({"chart:one":{"snapshot":"version-one"}}));
    assert!(c.read()["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v["eligibility"] == "unavailable"));
}

#[test]
fn memory_and_method_context_require_explicit_dependency_support() {
    for kind in ["sharedMemoryUse", "topicMethodUse", "libraryRules"] {
        let c = Case::new();
        store::write(&c.f.root, |db| {
            store::insert(
                db,
                &c.work,
                Some(&c.run),
                kind,
                &json!({"items":[{"id":"method-v1"}]}),
            )
        })
        .unwrap();
        assert!(c.read()["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["eligibility"] == "unavailable"));
    }
}

#[test]
fn raw_delivery_mutation_changes_content_identity() {
    let c = Case::new();
    let old = c.read()["origin"]["deliveryHash"].clone();
    c.alter(|v| v["report"]["findings"][0]["text"] = json!("改写的方法建议"));
    assert_ne!(old, c.read()["origin"]["deliveryHash"]);
}

#[test]
fn explicit_structured_assistant_findings_keep_quote_identity_and_plain_answers_stay_plain() {
    let catalog = json!([{"quoteId":"e1:q1","evidenceId":"e1","text":"验证前先固定输入。"}]);
    let base = json!({"report":{"status":"completed","markdown":"方法已核对 [1]","citations":[{"quoteId":"e1:q1"}],"questions":[],"limitations":[],"waitCondition":"","completion":null}});
    assert_eq!(
        assistant::normalize(base.clone(), &catalog).unwrap()["report"]["findings"],
        json!([])
    );
    let mut report = base.clone();
    report["report"]["findings"] =
        json!([{"text":"先固定输入。","citations":[{"quoteId":"e1:q1"}]}]);
    let result = assistant::normalize(report, &catalog).unwrap();
    assert_eq!(
        result["report"]["findings"][0]["citations"][0],
        json!({"evidenceId":"e1","quote":"验证前先固定输入。"})
    );
    let mut bad = base;
    bad["report"]["findings"] = json!([{"text":"假发现","citations":[{"quoteId":"e99:q1"}]}]);
    assert!(assistant::normalize(bad, &catalog).is_err());
}

#[test]
fn changed_collection_inventory_keeps_granted_members_independent_without_granting_new_notes() {
    let c = Case::new();
    let selection = json!({"libraryId":"notes"});
    let preview = super::super::ui(
        &c.f.root,
        &json!({"action":"previewSourceScope","selection":selection}),
    )
    .unwrap();
    let mut work = store::load(&c.f.c(), &c.work).unwrap();
    work.grant.manifest=Some(serde_json::from_value(json!({"selection":selection,"snapshot":preview["snapshot"],"members":[note("current"),note("progress")]})).unwrap());
    c.f.c()
        .execute(
            "UPDATE agent_works SET grant_json=?2 WHERE id=?1",
            params![c.work, serde_json::to_string(&work.grant).unwrap()],
        )
        .unwrap();
    c.f.note("notes", "new-outside", "新增材料不自动获得授权。");
    assert!(work.grant.reader(&c.f.root).is_err());
    let value = c.read();
    assert!(value["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v["eligibility"] == "verifiedSources"));
    assert!(current_reader(&c.f.root, &work)
        .unwrap()
        .read(&note("new-outside"), 0, 100, None)
        .is_err());
}

#[test]
fn empty_rule_and_memory_catalogs_do_not_block_plain_source_findings() {
    let c = Case::new();
    for (kind, value) in [
        ("libraryRules", json!([])),
        ("sharedMemoryUse", json!({"items":[]})),
    ] {
        store::write(&c.f.root, |db| {
            store::insert(db, &c.work, Some(&c.run), kind, &value)
        })
        .unwrap();
    }
    assert!(c.read()["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v["eligibility"] == "verifiedSources"));
}
