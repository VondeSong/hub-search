use super::*;
use crate::source_evidence::tests::Fixture;
fn create(f: &Fixture, kind: &str) -> Value {
    super::super::super::ui(&f.root,&json!({"action":"insightEntrySave","operationId":crate::random_url_safe(15),"entry":{"kind":kind,"title":"保存当时的选择","body":"未做实机验证","choice":"先做小样例","reasons":"先确认可读字段","options":"小样例或直接购买","decidedAt":"2026-11-01","assumptions":[{"text":"工具能读块属性"}]}})).unwrap()["entry"].clone()
}
#[test]
fn decision_history_keeps_assumptions_and_later_observations_separate() {
    let f = Fixture::new();
    let e = create(&f, "decision");
    let request = json!({"action":"insightEntryObserve","entryId":e["id"],"expectedVersion":e["version"],"operationId":"observe-1","assumptionId":e["assumptions"][0]["id"],"occurredAt":"2026-11-02","text":"小样例无法读取块属性"});
    let result = super::super::super::ui(&f.root, &request).unwrap();
    assert_eq!(result["entry"]["reasons"], e["reasons"]);
    assert_eq!(result["entry"]["observations"][0]["assumptionVersion"], 1);
    assert_eq!(result["entry"]["observations"][0]["nature"], "selfReported");
    assert!(
        super::super::super::ui(&f.root, &request).unwrap()["replayed"]
            .as_bool()
            .unwrap()
    );
    let mut stale = request.clone();
    stale["operationId"] = json!("observe-2");
    assert!(super::super::super::ui(&f.root, &stale).is_err());
    let rows: i64 = f
        .c()
        .query_row(
            "SELECT COUNT(*) FROM agent_records WHERE kind='insightEntry'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 2);
}
#[test]
fn adopting_a_draft_uses_original_work_without_running_or_claiming_external_save() {
    let f = Fixture::new();
    let e = create(&f, "draft");
    let v=super::super::super::ui(&f.root,&json!({"action":"insightEntryAdopt","entryId":e["id"],"expectedVersion":1,"operationId":"adopt-1"})).unwrap();
    assert_eq!(v["entry"]["workId"], e["workId"]);
    assert_eq!(v["entry"]["state"], "provided");
    let c = f.c();
    let runs: i64 = c
        .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(runs, 0);
    let material:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_records WHERE kind='userMessage' AND json_extract(body_json,'$.materialOnly')=1)",[],|r|r.get(0)).unwrap();
    assert!(material);
    c.execute(
        "UPDATE agent_works SET state='revoked' WHERE id=?1",
        [e["workId"].as_str().unwrap()],
    )
    .unwrap();
    drop(c);
    assert!(
        super::super::super::ui(&f.root, &json!({"action":"insightWorkspace"})).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(super::super::super::ui(&f.root,&json!({"action":"insightEntryAdopt","entryId":e["id"],"expectedVersion":2,"operationId":"adopt-1"})).is_err());
}
#[test]
fn assumption_edits_do_not_relabel_historical_observation() {
    let f = Fixture::new();
    let e = create(&f, "decision");
    let observed=super::super::super::ui(&f.root,&json!({"action":"insightEntryObserve","entryId":e["id"],"expectedVersion":1,"operationId":"o","assumptionId":e["assumptions"][0]["id"],"text":"未读取到","occurredAt":""})).unwrap()["entry"].clone();
    let mut changed = observed.clone();
    changed["assumptions"][0]["text"] = json!("只能读普通文字");
    let updated=super::super::super::ui(&f.root,&json!({"action":"insightEntrySave","entryId":e["id"],"expectedVersion":2,"operationId":"s","entry":changed})).unwrap()["entry"].clone();
    assert_eq!(updated["assumptions"][0]["version"], 2);
    assert_eq!(updated["observations"][0]["assumptionVersion"], 1);
    assert_eq!(
        updated["observations"][0]["assumptionText"],
        "工具能读块属性"
    );
}

#[test]
fn adopted_material_is_visible_and_changes_withdraw_the_old_context() {
    let f = Fixture::new();
    let e = create(&f, "decision");
    let v=super::super::super::ui(&f.root,&json!({"action":"insightEntryAdopt","entryId":e["id"],"expectedVersion":1,"observationIds":[],"operationId":"provide"})).unwrap()["entry"].clone();
    let c = f.c();
    let w = work_on(&c, e["workId"].as_str().unwrap()).unwrap();
    let raw:String=c.query_row("SELECT body_json FROM agent_records WHERE kind='userMessage' AND json_extract(body_json,'$.materialOnly')=1 ORDER BY rowid DESC LIMIT 1",[],|r|r.get(0)).unwrap();
    let material = decode(&raw).unwrap();
    assert!(super::super::super::review::material_message_visible(&c, &w, &material).unwrap());
    let auth = w.authorization_version;
    drop(c);
    let mut changed = v.clone();
    changed["reasons"] = json!("新增更正，原理由保留于历史");
    super::super::super::ui(&f.root,&json!({"action":"insightEntrySave","entryId":e["id"],"expectedVersion":2,"operationId":"change","entry":changed})).unwrap();
    let c = f.c();
    let w = work_on(&c, e["workId"].as_str().unwrap()).unwrap();
    assert!(w.authorization_version > auth);
    assert!(!super::super::super::review::material_message_visible(&c, &w, &material).unwrap());
    drop(c);
    let history = super::super::super::ui(
        &f.root,
        &json!({"action":"insightEntryHistory","entryId":e["id"]}),
    )
    .unwrap();
    assert_eq!(history["versions"].as_array().unwrap().len(), 3);
    assert_eq!(history["versions"][2]["reasons"], e["reasons"]);
    assert_eq!(
        super::super::super::ui(
            &f.root,
            &json!({"action":"insightEntryOperation","operationId":"provide"})
        )
        .unwrap()["committed"],
        true
    );
    assert_eq!(
        super::super::super::ui(
            &f.root,
            &json!({"action":"insightEntryOperation","operationId":"not-sent"})
        )
        .unwrap()["committed"],
        false
    );
}
