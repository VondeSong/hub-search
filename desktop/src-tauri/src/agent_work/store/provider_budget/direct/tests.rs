use super::*;
use crate::agent_work::{tests::create, ui};
use crate::source_evidence::tests::Fixture;
mod acceptance;
fn setup(scope: bool) -> (Fixture, String, Work) {
    let f = Fixture::new();
    f.note(
        "notes",
        "current",
        "合成预算资料：数量17件，责任人陈，日期2026-11-04。验收状态未确认。",
    );
    let id = create(&f, false);
    let mut args = json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,
        "limits":tokens(60000,60000,48),"perRun":tokens(20000,20000,16),"unknownReservations":{}});
    if scope {
        args["analysisScope"] = json!(SCOPE);
    }
    ui(&f.root, &args).unwrap();
    let w = super::super::super::claim_with_budget(
        &f.root,
        &id,
        "direct-test",
        crate::agent_work::Budget::mode("quick").unwrap(),
    )
    .unwrap();
    (f, id, w)
}
fn tokens(i: u64, u: u64, o: u64) -> Value {
    json!({"inputTokens":i,"uncachedInputTokens":u,"outputTokens":o})
}
fn body(output: u64) -> Value {
    json!({"model":"deepseek-flash","stream":false,"max_tokens":output,"messages":[{"role":"system","content":"JSON only"},{"role":"user","content":"只读合成材料"}]})
}
fn received(input: u64, hit: Option<u64>, miss: Option<u64>, output: u64) -> Value {
    json!({"provider":"deepseek","inputTokens":input,"cachedInputTokens":hit,
        "uncachedInputTokens":miss,"outputTokens":output,"totalTokens":input+output,
        "usageComplete":hit.zip(miss).is_some_and(|(h,m)|h.checked_add(m)==Some(input)),"outcome":"completedOutput"})
}
#[test]
fn v4_direct_scope_is_prospective_and_old_freeze_cannot_be_upgraded() {
    let (f, id, w) = setup(false);
    assert!(!enabled(&f.root, &w).unwrap());
    assert!(reserve(&f.root, &w, "direct-test", "denied", &body(10), 10000).is_err());
    super::super::super::fail(&f.root, &w, "direct-test", "zero-model scope check").unwrap();
    let mut p = facts(&f.c(), &id, "providerBudgetPolicy").unwrap()[0]["request"].clone();
    p["action"] = json!("freezeProviderBudget");
    p["id"] = json!(id);
    p["expectedWorkRevision"] = json!(1);
    p["analysisScope"] = json!(SCOPE);
    assert!(ui(&f.root, &p).unwrap_err().contains("不能重置或覆盖"));
    assert_eq!(
        facts(&f.c(), &id, "providerBudgetPolicy").unwrap()[0]["scope"],
        "nativeAgentOnly"
    );
}
#[test]
fn v4_direct_serialized_body_reservation_is_durable_unique_and_bounded() {
    let (f, id, w) = setup(true);
    let b = body(16);
    let n = serde_json::to_vec(&b).unwrap().len();
    assert!(reserve(&f.root, &w, "direct-test", "bytes-denied", &b, n - 1).is_err());
    reserve(&f.root, &w, "direct-test", "one", &b, n).unwrap();
    let saved = facts(&f.c(), &id, "providerCallBudget").unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["requestBytes"], n);
    assert_eq!(saved[0]["reserved"], tokens(n as u64, n as u64, 16));
    assert_eq!(
        progress(&f.root, &w, "direct-test").unwrap().request_bytes,
        n
    );
    assert!(reserve(&f.root, &w, "direct-test", "one", &b, 10000).is_err());
    assert!(output_remaining(&f.root, &w, "direct-test").is_err());
    receipt(
        &f.root,
        &w,
        "direct-test",
        "one",
        &received(30, Some(10), Some(20), 5),
    )
    .unwrap();
    assert_eq!(output_remaining(&f.root, &w, "direct-test").unwrap(), 11);
    reserve(&f.root, &w, "direct-test", "two", &body(11), 10000).unwrap();
    assert_eq!(facts(&f.c(), &id, "providerCallBudget").unwrap().len(), 2);
    assert_eq!(
        progress(&f.root, &w, "direct-test").unwrap().request_bytes,
        n + serde_json::to_vec(&body(11)).unwrap().len()
    );
}
#[test]
fn v4_direct_missing_cache_usage_keeps_reservation_and_late_facts_do_not_resume() {
    let (f, id, w) = setup(true);
    reserve(&f.root, &w, "direct-test", "unknown", &body(16), 10000).unwrap();
    super::super::super::fail(&f.root, &w, "direct-test", "stopped synthetic request").unwrap();
    let stopped = load(&f.c(), &id).unwrap();
    receipt(
        &f.root,
        &w,
        "direct-test",
        "unknown",
        &received(30, None, None, 5),
    )
    .unwrap();
    let p = progress(&f.root, &w, "direct-test").unwrap();
    assert!(!p.complete);
    assert!(p.usage["uncachedInputTokens"].is_null());
    observe(&f.root, &w, "direct-test", &p.usage, true).unwrap();
    assert!(facts(&f.c(), &id, "providerBudgetSettlement")
        .unwrap()
        .is_empty());
    assert_eq!(
        view_on(&f.c(), &w).unwrap()["chargedOrReserved"],
        tokens(20000, 20000, 16)
    );
    let after = load(&f.c(), &id).unwrap();
    assert_eq!(after.state, stopped.state);
    assert_eq!(after.active_run, None);
    assert!(receipt(
        &f.root,
        &w,
        "direct-test",
        "unknown",
        &received(30, Some(0), Some(30), 5)
    )
    .is_err());
}
#[test]
fn v4_direct_complete_usage_settles_once_and_same_work_budget_survives_next_run() {
    let (f, id, w) = setup(true);
    reserve(&f.root, &w, "direct-test", "known", &body(16), 10000).unwrap();
    receipt(
        &f.root,
        &w,
        "direct-test",
        "known",
        &received(30, Some(10), Some(20), 5),
    )
    .unwrap();
    let p = progress(&f.root, &w, "direct-test").unwrap();
    assert!(p.complete && !p.invalid_or_exceeded);
    observe(&f.root, &w, "direct-test", &p.usage, true).unwrap();
    observe(&f.root, &w, "direct-test", &p.usage, true).unwrap();
    assert_eq!(
        facts(&f.c(), &id, "providerBudgetSettlement")
            .unwrap()
            .len(),
        1
    );
    super::super::super::fail(
        &f.root,
        &w,
        "direct-test",
        "zero-model completed accounting check",
    )
    .unwrap();
    let next = super::super::super::claim_with_budget(
        &f.root,
        &id,
        "next",
        crate::agent_work::Budget::mode("quick").unwrap(),
    )
    .unwrap();
    assert_eq!(
        view_on(&f.c(), &next).unwrap()["chargedOrReserved"],
        tokens(20030, 20020, 21)
    );
    assert_eq!(facts(&f.c(), &id, "providerBudgetPolicy").unwrap().len(), 1);
}
#[test]
fn v4_direct_bad_or_excess_usage_stops_and_raw_receipt_is_preserved() {
    let (f, id, w) = setup(true);
    reserve(&f.root, &w, "direct-test", "excess", &body(16), 10000).unwrap();
    let raw = received(25000, Some(1), Some(24999), 17);
    receipt(&f.root, &w, "direct-test", "excess", &raw).unwrap();
    let p = progress(&f.root, &w, "direct-test").unwrap();
    assert!(p.invalid_or_exceeded);
    assert!(observe(&f.root, &w, "direct-test", &p.usage, false).is_err());
    assert!(output_remaining(&f.root, &w, "direct-test").is_err());
    assert_eq!(
        facts(&f.c(), &id, "modelExecution").unwrap()[0]["outputTokens"],
        17
    );
    assert!(facts(&f.c(), &id, "providerBudgetSettlement")
        .unwrap()
        .is_empty());
}
#[test]
fn v4_direct_failed_reserve_commit_and_image_payload_cannot_dispatch() {
    let (f, id, w) = setup(true);
    let mut image = body(10);
    image["messages"][1]["content"] =
        json!([{"type":"image_url","image_url":{"url":"data:image/png;base64,invalid"}}]);
    assert!(reserve(&f.root, &w, "direct-test", "image", &image, 10000).is_err());
    f.c().execute_batch("CREATE TRIGGER refuse_direct BEFORE INSERT ON agent_records WHEN NEW.kind='providerCallBudget' BEGIN SELECT RAISE(ABORT,'synthetic admission commit failure'); END;").unwrap();
    assert!(reserve(&f.root, &w, "direct-test", "commit", &body(10), 10000).is_err());
    assert!(facts(&f.c(), &id, "providerCallBudget").unwrap().is_empty());
    assert!(facts(&f.c(), &id, "modelExecution").unwrap().is_empty());
    assert_eq!(
        view_on(&f.c(), &w).unwrap()["chargedOrReserved"],
        tokens(20000, 20000, 16)
    );
}

#[test]
fn v4_direct_terminal_format_failure_settles_known_usage_without_reviving_run() {
    for finish_live in [false, true] {
        let (f, id, w) = setup(true);
        reserve(
            &f.root,
            &w,
            "direct-test",
            "failed-format",
            &body(16),
            10000,
        )
        .unwrap();
        let mut raw = received(30, Some(10), Some(20), 5);
        raw["outcome"] = json!("failed");
        raw["httpStatus"] = json!(200);
        receipt(&f.root, &w, "direct-test", "failed-format", &raw).unwrap();
        if finish_live {
            settle_terminal(&f.root, &w, "direct-test").unwrap();
        }
        super::super::super::fail(&f.root, &w, "direct-test", "saved outputContract failure")
            .unwrap();
        let before = load(&f.c(), &id).unwrap();
        reconcile_terminal(&f.root, &id).unwrap();
        assert_eq!(
            view_on(&f.c(), &before).unwrap()["chargedOrReserved"],
            tokens(30, 20, 5)
        );
        let after = load(&f.c(), &id).unwrap();
        assert_eq!(after.state, before.state);
        assert_eq!(after.active_run, before.active_run);
        reconcile_terminal(&f.root, &id).unwrap();
        assert_eq!(
            facts(&f.c(), &id, "providerBudgetSettlement")
                .unwrap()
                .len(),
            1
        );
        assert!(reserve(
            &f.root,
            &w,
            "direct-test",
            "cannot-revive",
            &body(10),
            10000
        )
        .is_err());
    }
}
#[test]
fn v4_direct_terminal_missing_or_inconsistent_usage_keeps_full_reservation() {
    for raw in [
        received(30, None, None, 5),
        received(30, Some(10), Some(19), 5),
    ] {
        let (f, id, w) = setup(true);
        reserve(&f.root, &w, "direct-test", "incomplete", &body(16), 10000).unwrap();
        receipt(&f.root, &w, "direct-test", "incomplete", &raw).unwrap();
        settle_terminal(&f.root, &w, "direct-test").unwrap();
        super::super::super::fail(&f.root, &w, "direct-test", "saved unknown failure").unwrap();
        reconcile_terminal(&f.root, &id).unwrap();
        assert!(facts(&f.c(), &id, "providerBudgetSettlement")
            .unwrap()
            .is_empty());
        assert_eq!(
            view_on(&f.c(), &w).unwrap()["chargedOrReserved"],
            tokens(20000, 20000, 16)
        );
    }
}

mod draft_acceptance;

mod terminal_acceptance;
