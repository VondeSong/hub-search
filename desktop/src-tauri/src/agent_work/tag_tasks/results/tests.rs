use super::*;
use crate::source_evidence::tests::Fixture;

fn setup() -> (Fixture, Work, String) {
    let f = Fixture::new();
    let id = store::create(
        &f.root,
        "标签结果归档".into(),
        "".into(),
        None,
        Grant {
            library_ids: vec!["notes".into()],
            ..Default::default()
        },
    )
    .unwrap();
    let run = "snapshot-run".to_string();
    let w = store::claim(&f.root, &id, &run).unwrap();
    (f, w, run)
}
fn body(w: &Work, run: &str) -> Value {
    json!({"revision":w.revision,"authorizationVersion":w.authorization_version,"runId":run,
        "libraryIds":w.grant.library_ids,"intent":{"task":"missing","tag":"a"},
        "result":{"candidates":[{"snippet":"中文\\\"🙂".repeat(12000)}],
            "submitted":[{"proposalId":"same-authoritative-proposal","preview":{"quote":"完整审核依据"}}],"processedCount":5}})
}
#[test]
fn full_large_results_are_immutable_and_share_exact_authoritative_ids() {
    let (f, w, run) = setup();
    let input = body(&w, &run);
    assert!(input.to_string().len() > 65536);
    assert!(store::record(&f.root, &run, "tagTaskResult", &input).is_err());
    save(&f.root, &w, &run, &input, "tagTaskCheckpoint").unwrap();
    save(&f.root, &w, &run, &input, "tagTaskResult").unwrap();
    let restored = records(&f.root, &w.id, "tagTaskResult").unwrap();
    assert_eq!(restored[0]["result"], input["result"]);
    assert_eq!(
        restored[0]["result"]["submitted"][0]["proposalId"],
        "same-authoritative-proposal"
    );
    let compact = store::records(&f.root, &w.id, "tagTaskResult", 1).unwrap();
    assert!(compact[0]["result"]["candidates"].is_null());
    assert!(compact[0]["result"]["submitted"][0]["preview"].is_null());
    assert!(model_view(&restored[0])["result"]["candidates"].is_null());
    let max: i64 = f
        .c()
        .query_row(
            "SELECT MAX(length(CAST(body_json AS BLOB))) FROM agent_records",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(max < 65536);
    f.c().execute("UPDATE agent_records SET body_json=json_set(body_json,'$.text','changed') WHERE kind='tagTaskResultPart' AND json_extract(body_json,'$.part')=0",[]).unwrap();
    assert!(records(&f.root, &w.id, "tagTaskResult")
        .unwrap_err()
        .contains("快照"));
}
#[test]
fn quotas_roll_back_all_parts_and_revocation_hides_snapshots() {
    let (f, w, run) = setup();
    let mut input = body(&w, &run);
    input["result"]["candidates"][0]["snippet"] = json!("x".repeat(350000));
    assert!(save(&f.root, &w, &run, &input, "tagTaskResult").is_err());
    assert_eq!(
        f.c()
            .query_row(
                "SELECT COUNT(*) FROM agent_records WHERE kind='tagTaskResultPart'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let input = body(&w, &run);
    save(&f.root, &w, &run, &input, "tagTaskResult").unwrap();
    store::revoke(&f.root, &w.id).unwrap();
    assert!(records(&f.root, &w.id, "tagTaskResult").unwrap().is_empty());
    assert!(save(&f.root, &w, &run, &input, "tagTaskResult").is_err());
}

#[test]
fn replay_uses_saved_results_without_models_and_checks_definition_version() {
    let (f, w, run) = setup();
    let intent = json!({"task":"definition","tag":"a","compareTag":null,"expectedVersion":0,"resume":false,"references":[]});
    store::write(&f.root, |c| {
        store::insert(
            c,
            &w.id,
            None,
            "tagTask",
            &json!({"revision":w.revision,"intent":intent}),
        )
    })
    .unwrap();
    let mut input = body(&w, &run);
    input["intent"] = intent.clone();
    save(&f.root, &w, &run, &input, "tagTaskResult").unwrap();
    let mut used = runner::Usage::default();
    let result = super::super::prepare(
        &f.root,
        &w,
        &run,
        &Control::default(),
        Budget::mode("deep").unwrap(),
        None,
        &mut used,
        &mut |_, _| panic!("saved task must never call a model"),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        result["tagTaskResult"]["result"]["submitted"][0]["proposalId"],
        "same-authoritative-proposal"
    );
    assert_eq!(used.model_calls, 0);
    let mut stale = intent;
    stale["expectedVersion"] = json!(1);
    store::write(&f.root, |c| {
        store::insert(
            c,
            &w.id,
            None,
            "tagTask",
            &json!({"revision":w.revision,"intent":stale}),
        )
    })
    .unwrap();
    assert!(super::super::prepare(
        &f.root,
        &w,
        &run,
        &Control::default(),
        Budget::mode("deep").unwrap(),
        None,
        &mut used,
        &mut |_, _| panic!("stale task must never call a model")
    )
    .unwrap_err()
    .contains("定义已变化"));
}
