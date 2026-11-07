use super::*;
use crate::obsidian_edit::tests::Fixture;
fn setup() -> (Fixture, Value, String) {
    let f = Fixture::new();
    let anchor = f.seed("Entry.md", "专题入口，不属于本期材料。");
    f.seed("daily/2026-10-01.md", "十月原值17。合成资料。");
    let t=crate::agent_work::ui(&f.root,&json!({"action":"topicCreateEmpty","anchor":{"kind":"note","libraryId":"notes","documentId":anchor,"pageId":null},"title":"变化核对","defaultQuestion":"核对本期","period":"2026-10","skill":"hub-research","outputPreference":"有出处","clientRequestId":"changes-empty"})).unwrap();
    let t=crate::agent_work::ui(&f.root,&json!({"action":"topicUpdate","topicId":t["topic"]["id"],"expectedRevision":1,"title":"变化核对","defaultQuestion":"核对本期","period":"2026-10","outputPreference":"有出处","periodDirectory":"daily","clientRequestId":"changes-month-rule"})).unwrap();
    let p=crate::agent_work::ui(&f.root,&json!({"action":"topicWorkPreview","topicId":t["topic"]["id"],"expectedRevision":2,"period":"2026-10"})).unwrap();
    let made=crate::agent_work::ui(&f.root,&json!({"action":"topicCreateWork","topicId":t["topic"]["id"],"expectedRevision":2,"period":"2026-10","expectedPreview":p["fingerprint"],"confirmedScope":true,"clientRequestId":"changes-create-work"})).unwrap();
    let id = made["openedWorkId"].as_str().unwrap().to_owned();
    (f, t, id)
}
fn request(t: &Value, id: &str) -> Value {
    json!({"action":"topicChanges","topicId":t["topic"]["id"],"expectedRevision":t["topic"]["revision"],"workId":id,"expectedWorkRevision":1,"expectedAuthorizationVersion":1})
}
fn records(f: &Fixture) -> Vec<(String, String)> {
    let c = f.c();
    let mut q = c
        .prepare("SELECT id,body_json FROM agent_records ORDER BY rowid")
        .unwrap();
    let rows = q
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    rows
}
fn actual(f: &Fixture, id: &str) {
    let run = "changes-controlled-actual-binding";
    let w = store::claim(&f.root, id, run).unwrap();
    let mut session = Some(
        crate::hub_capabilities::Session::new(&f.root, Some(w.grant.scope().unwrap())).unwrap(),
    );
    attach_runtime(&f.root, &w, run, &mut session).unwrap();
    let settings = crate::model_runtime::selected_settings(&f.root, None).unwrap();
    store::record(&f.root, run, "modelSelection", &json!(settings)).unwrap();
    // Controlled binding qualification only, not a provider or actual model adoption.
    f.c()
        .execute(
            "UPDATE agent_works SET state='ready',active_run=NULL WHERE id=?1",
            [id],
        )
        .unwrap();
}
#[test]
fn v5_topic_changes_no_change_is_read_only_and_selection_is_not_actual_method_use() {
    let (f, t, id) = setup();
    actual(&f, &id);
    let before = records(&f);
    let value = crate::agent_work::ui(&f.root, &request(&t, &id)).unwrap();
    assert_eq!(value["state"], "unchanged");
    assert_eq!(value["sources"]["currentCount"], 1);
    assert_eq!(value["sources"]["changed"], 0);
    assert_eq!(value["baseline"]["origin"], "actualRunBinding");
    assert!(value["baseline"]["methodUse"].is_null());
    assert_eq!(value["actualServedModel"], "unknown");
    assert_eq!(records(&f), before);
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn v5_topic_changes_added_edited_deleted_and_unknown_date_members_do_not_regrant_or_publish() {
    let (f, t, id) = setup();
    let before = records(&f);
    f.seed("daily/2026-10-02.md", "新成员18。");
    f.seed("daily/undated.md", "日期不明不算本期。");
    let value = crate::agent_work::ui(&f.root, &request(&t, &id)).unwrap();
    assert_eq!(value["sources"]["added"], 1);
    assert_eq!(value["sources"]["currentCount"], 2);
    let doc = f.seed("daily/2026-10-01.md", "同一来源已编辑19。");
    let value = crate::agent_work::ui(&f.root, &request(&t, &id)).unwrap();
    assert_eq!(value["sources"]["changed"], 1);
    f.c()
        .execute("DELETE FROM documents WHERE id=?1", [&doc])
        .unwrap();
    let value = crate::agent_work::ui(&f.root, &request(&t, &id)).unwrap();
    assert_eq!(value["sources"]["removed"], 1);
    assert_eq!(value["sources"]["currentCount"], 1);
    assert_eq!(value["state"], "changed");
    assert_eq!(records(&f), before);
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn v5_topic_changes_an_empty_current_month_is_a_complete_removal_not_a_new_work_or_false_success() {
    let (f, t, id) = setup();
    f.c()
        .execute("DELETE FROM documents WHERE path LIKE 'daily/%'", [])
        .unwrap();
    let before = records(&f);
    let value = crate::agent_work::ui(&f.root, &request(&t, &id)).unwrap();
    assert_eq!(value["sources"]["currentCount"], 0);
    assert_eq!(value["sources"]["removed"], 1);
    assert_eq!(value["state"], "changed");
    assert_eq!(records(&f), before);
}
#[test]
fn v5_topic_changes_config_method_and_requested_model_differences_are_not_semantic_or_served_identity_claims(
) {
    let (f, t, id) = setup();
    actual(&f, &id);
    let next=crate::agent_work::ui(&f.root,&json!({"action":"topicUpdate","topicId":t["topic"]["id"],"expectedRevision":2,"title":"新配置","defaultQuestion":"新的本期要求","period":"2026-10","outputPreference":"简短","periodDirectory":"daily","skill":"hub-statistics","clientRequestId":"changes-new-method"})).unwrap();
    let value = crate::agent_work::ui(&f.root, &request(&next, &id)).unwrap();
    assert_eq!(value["methodChanged"], true);
    assert_eq!(value["parametersChanged"], true);
    assert_eq!(value["state"], "changed");
    assert_ne!(value["baseline"]["methodVersion"], value["selectedMethod"]);
    assert_eq!(value["actualServedModel"], "unknown");
    f.c().execute("UPDATE agent_records SET body_json=?1 WHERE kind='modelSelection'",[json!({"provider":"codex","model":"old-requested-model","reasoningEffort":"","fast":false}).to_string()]).unwrap();
    let value = crate::agent_work::ui(&f.root, &request(&next, &id)).unwrap();
    assert_eq!(value["requestedModelChanged"], true);
    assert_eq!(value["actualServedModel"], "unknown");
}
#[test]
fn v5_topic_changes_revoked_disabled_foreign_and_stale_views_fail_closed_without_records() {
    let (f, t, id) = setup();
    let before = records(&f);
    let mut args = request(&t, &id);
    args["expectedRevision"] = json!(1);
    assert!(crate::agent_work::ui(&f.root, &args)
        .unwrap_err()
        .contains("配置已变化"));
    args = request(&t, &id);
    args["expectedWorkRevision"] = json!(2);
    assert!(crate::agent_work::ui(&f.root, &args)
        .unwrap_err()
        .contains("原工作或授权"));
    args = request(&t, &id);
    args["topicId"] = json!("foreign");
    assert!(crate::agent_work::ui(&f.root, &args).is_err());
    f.c()
        .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
        .unwrap();
    assert!(crate::agent_work::ui(&f.root, &request(&t, &id))
        .unwrap_err()
        .contains("资料库不可用"));
    f.c()
        .execute("UPDATE libraries SET enabled=1 WHERE id='notes'", [])
        .unwrap();
    f.c()
        .execute("UPDATE agent_works SET state='revoked' WHERE id=?1", [id])
        .unwrap();
    assert!(
        crate::agent_work::ui(&f.root, &request(&t, &args["workId"].as_str().unwrap()))
            .unwrap_err()
            .contains("撤回")
    );
    assert_eq!(records(&f), before);
}
#[test]
fn v5_topic_changes_version_representations_and_missing_baselines_remain_unknown() {
    let locator = json!({"kind":"note","libraryId":"notes","documentId":"one","pageId":null});
    let old = vec![
        json!({"locator":locator,"version":["hash",null,4],"title":"one","sourcePath":"one.md"}),
    ];
    let now = vec![
        json!({"locator":locator,"version":{"kind":"document","fingerprint":"hash"},"title":"one","sourcePath":"one.md"}),
    ];
    let value = source_changes(Some(&old), &now).unwrap();
    assert_eq!(value["status"], "partlyUnverified");
    assert_eq!(value["changed"], 0);
    assert_eq!(value["uncomparable"], 1);
    assert_eq!(source_changes(None, &now).unwrap()["added"], Value::Null);
    let duplicates = vec![now[0].clone(), now[0].clone()];
    assert!(indexed(&duplicates).is_err());
}
