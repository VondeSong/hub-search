use super::*;
use crate::obsidian_edit::tests::Fixture;

fn empty(f: &Fixture) -> Value {
    let doc = f.seed("Entry.md", "受控合成笔记：值17，未实际执行。\n");
    json!({"action":"topicCreateEmpty","anchor":{"kind":"note","libraryId":"notes","documentId":doc,"pageId":null},"title":"固定笔记复核","defaultQuestion":"核对合成笔记","period":"2026-10","skill":"hub-research","outputPreference":"保留出处","clientRequestId":"empty-once"})
}
fn counts(f: &Fixture) -> Value {
    let c = f.c();
    json!([
        "agent_works",
        "agent_runs",
        "agent_records",
        "agent_actions"
    ]
    .map(|table| c
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
            .get::<_, i64>(0))
        .unwrap()))
}
fn create(f: &Fixture, topic: &Value, month: &str, key: &str) -> Value {
    let p=crate::agent_work::ui(&f.root,&json!({"action":"topicWorkPreview","topicId":topic["topic"]["id"],"expectedRevision":topic["topic"]["revision"],"period":month})).unwrap();
    json!({"action":"topicCreateWork","topicId":topic["topic"]["id"],"expectedRevision":topic["topic"]["revision"],"period":month,"expectedPreview":p["fingerprint"],"confirmedScope":true,"clientRequestId":key})
}
#[test]
fn v5_topic_entry_empty_persists_method_selection_without_work_or_permission() {
    let f = Fixture::new();
    let args = empty(&f);
    let before = counts(&f);
    let file = f.vault.join("Entry.md");
    let bytes = std::fs::read(&file).unwrap();
    let mtime = std::fs::metadata(&file).unwrap().modified().unwrap();
    let t = crate::agent_work::ui(&f.root, &args).unwrap();
    assert_eq!(t["history"], json!([]));
    assert_eq!(t["openedWorkId"], Value::Null);
    assert_eq!(
        t["topic"]["config"]["sourceRule"]["selection"]["notes"],
        json!([args["anchor"]])
    );
    assert!(
        t["method"]["content"]["files"]["SKILL.md"]
            .as_str()
            .unwrap()
            .len()
            > 100
    );
    assert_eq!(crate::agent_work::ui(&f.root, &args).unwrap(), t);
    assert_eq!(counts(&f), before);
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    assert_eq!(std::fs::metadata(file).unwrap().modified().unwrap(), mtime);
}
#[test]
fn v5_topic_entry_creates_ready_original_work_and_method_before_first_claim() {
    let f = Fixture::new();
    let t = crate::agent_work::ui(&f.root, &empty(&f)).unwrap();
    let args = create(&f, &t, "2026-10", "create-first");
    let result = crate::agent_work::ui(&f.root, &args).unwrap();
    let id = result["openedWorkId"].as_str().unwrap();
    let c = f.c();
    let w = store::load(&c, id).unwrap();
    assert_eq!(w.state, "ready");
    assert_eq!(w.revision, 1);
    assert!(w.active_run.is_none());
    assert!(w.report.is_none());
    let (binding, method) = version_on(&c, &w).unwrap().unwrap();
    assert_eq!(method["id"], t["method"]["id"]);
    assert_eq!(binding["period"], "2026-10");
    assert_eq!(
        options::load_on(&c, id).unwrap().model.unwrap().provider,
        "codex"
    );
    assert!(!options::load_on(&c, id).unwrap().auto_flashcard_inbox);
    preflight(&f.root, &c, &w, "codex", true).unwrap();
    assert!(preflight(&f.root, &c, &w, "deepseek", true).is_err());
    // The initial message timestamp is retained as a conversationCreated record.
    assert_eq!(counts(&f), json!([1, 0, 3, 0]));
    let before = counts(&f);
    assert_eq!(
        crate::agent_work::ui(&f.root, &args).unwrap()["openedWorkId"],
        id
    );
    assert_eq!(counts(&f), before);
}
#[test]
fn v5_topic_entry_existing_period_keeps_failures_usage_and_does_not_rebind() {
    let f = Fixture::new();
    let t = crate::agent_work::ui(&f.root, &empty(&f)).unwrap();
    let args = create(&f, &t, "2026-10", "create-original");
    let value = crate::agent_work::ui(&f.root, &args).unwrap();
    let id = value["openedWorkId"].as_str().unwrap();
    store::claim(&f.root, id, "failed-old-run").unwrap();
    f.c().execute("UPDATE agent_runs SET state='failed',usage_json='{\"inputTokens\":17,\"unknown\":true}' WHERE id='failed-old-run'",[]).unwrap();
    f.c()
        .execute(
            "UPDATE agent_works SET state='failed',active_run=NULL WHERE id=?1",
            [id],
        )
        .unwrap();
    let changed=crate::agent_work::ui(&f.root,&json!({"action":"topicUpdate","topicId":t["topic"]["id"],"expectedRevision":1,"title":"下期标题","defaultQuestion":"新默认问题","period":"2026-11","outputPreference":"简短","clientRequestId":"new-default"})).unwrap();
    let before = counts(&f);
    let retry = create(&f, &changed, "2026-10", "same-period-new-nonce");
    let reopened = crate::agent_work::ui(&f.root, &retry).unwrap();
    assert_eq!(reopened["openedWorkId"], id);
    assert_eq!(counts(&f), before);
    let w = store::load(&f.c(), id).unwrap();
    assert_eq!(w.state, "failed");
    assert_eq!(w.goal, "核对合成笔记");
    assert_eq!(
        version_on(&f.c(), &w).unwrap().unwrap().0["configRevision"],
        1
    );
    assert_eq!(
        f.c()
            .query_row(
                "SELECT usage_json FROM agent_runs WHERE id='failed-old-run'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "{\"inputTokens\":17,\"unknown\":true}"
    );
    let next = create(&f, &changed, "2026-11", "genuine-next-period");
    let result = crate::agent_work::ui(&f.root, &next).unwrap();
    let next = result["openedWorkId"].as_str().unwrap();
    assert_ne!(next, id);
    assert_eq!(store::load(&f.c(), next).unwrap().goal, "新默认问题");
}
#[test]
fn v5_topic_entry_requires_fresh_preview_consent_and_current_method_configuration() {
    let f = Fixture::new();
    let t = crate::agent_work::ui(&f.root, &empty(&f)).unwrap();
    let mut args = create(&f, &t, "2026-10", "consent-test");
    args["confirmedScope"] = json!(false);
    assert!(crate::agent_work::ui(&f.root, &args)
        .unwrap_err()
        .contains("授权"));
    assert_eq!(counts(&f), json!([0, 0, 0, 0]));
    args["confirmedScope"] = json!(true);
    f.seed("Entry.md", "来源实际变化18，不是旧17。\n");
    assert!(crate::agent_work::ui(&f.root, &args)
        .unwrap_err()
        .contains("已变化"));
    assert_eq!(counts(&f), json!([0, 0, 0, 0]));
    let args = create(&f, &t, "2026-10", "disabled-source");
    f.c()
        .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
        .unwrap();
    assert!(crate::agent_work::ui(&f.root, &args)
        .unwrap_err()
        .contains("不可用"));
    assert_eq!(counts(&f), json!([0, 0, 0, 0]));
}
#[test]
fn v5_topic_entry_transaction_failure_rolls_back_work_binding_and_options_together() {
    let f = Fixture::new();
    let t = crate::agent_work::ui(&f.root, &empty(&f)).unwrap();
    let args = create(&f, &t, "2026-10", "rollback-once");
    f.c().execute_batch("CREATE TRIGGER abort_topic_link BEFORE INSERT ON agent_topic_works BEGIN SELECT RAISE(ABORT,'controlled link failure'); END;").unwrap();
    assert!(crate::agent_work::ui(&f.root, &args)
        .unwrap_err()
        .contains("controlled link failure"));
    assert_eq!(counts(&f), json!([0, 0, 0, 0]));
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_topic_revisions", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn v5_topic_entry_saved_scope_revocation_and_dynamic_selectors_cannot_grant_new_work() {
    let f = Fixture::new();
    let initial = empty(&f);
    let t = crate::agent_work::ui(&f.root, &initial).unwrap();
    let args = create(&f, &t, "2026-10", "create-scope-origin");
    let made = crate::agent_work::ui(&f.root, &args).unwrap();
    let id = made["openedWorkId"].as_str().unwrap();
    let changed=crate::agent_work::ui(&f.root,&json!({"action":"topicUpdate","topicId":t["topic"]["id"],"expectedRevision":1,"title":"固定范围","period":"2026-11","outputPreference":"","sourceWorkId":id,"clientRequestId":"source-origin"})).unwrap();
    f.c().execute("UPDATE agent_works SET state='revoked',authorization_version=authorization_version+1 WHERE id=?1",[id]).unwrap();
    assert!(crate::agent_work::ui(&f.root,&json!({"action":"topicWorkPreview","topicId":t["topic"]["id"],"expectedRevision":changed["topic"]["revision"],"period":"2026-11"})).unwrap_err().contains("撤回"));
    let grant = Grant {
        library_ids: vec!["notes".into()],
        ..Default::default()
    };
    let anchor: EvidenceLocator = serde_json::from_value(initial["anchor"].clone()).unwrap();
    assert!(fixed_grant(&f.root, &f.c(), &anchor, &grant)
        .unwrap_err()
        .contains("固定笔记"));
}
fn month_topic(f: &Fixture) -> Value {
    let t = crate::agent_work::ui(&f.root, &empty(f)).unwrap();
    crate::agent_work::ui(&f.root,&json!({"action":"topicUpdate","topicId":t["topic"]["id"],"expectedRevision":1,"title":"日记复盘","defaultQuestion":"按本期日记核对事实","period":"2026-11","outputPreference":"完整覆盖与出处","periodDirectory":"daily","clientRequestId":"month-directory-rule"})).unwrap()
}
fn month_preview(f: &Fixture, t: &Value, month: &str) -> Value {
    crate::agent_work::ui(&f.root,&json!({"action":"topicWorkPreview","topicId":t["topic"]["id"],"expectedRevision":t["topic"]["revision"],"period":month})).unwrap()
}
#[test]
fn v5_topic_period_manifest_selects_only_month_members_and_anchors_the_actual_work() {
    let f = Fixture::new();
    let november = f.seed("daily/2026-11-01.md", "11月合成事实17。");
    let october = f.seed("daily/2026-10-31.md", "旧月18，不可偷带。");
    f.seed("daily/untitled.md", "没有文件名日期。");
    f.seed("outside/2026-11-02.md", "目录外。");
    let t = month_topic(&f);
    let p = month_preview(&f, &t, "2026-11");
    assert_eq!(t["topic"]["config"]["schemaVersion"], 2);
    assert_eq!(p["scope"]["kind"], "periodManifest");
    assert_eq!(p["scope"]["totalMembers"], 1);
    assert_eq!(p["scope"]["dateCoverage"]["unknownDateMembers"], 1);
    assert_eq!(p["scope"]["bodyRead"], false);
    assert_eq!(p["anchor"]["documentId"], november);
    assert_eq!(p["notes"][0]["locator"]["documentId"], november);
    assert_eq!(p["selection"]["notes"], json!([]));
    assert_eq!(counts(&f), json!([0, 0, 0, 0]));
    let args = create(&f, &t, "2026-11", "create-month-november");
    let made = crate::agent_work::ui(&f.root, &args).unwrap();
    let id = made["openedWorkId"].as_str().unwrap();
    let w = store::load(&f.c(), id).unwrap();
    assert_eq!(json!(w.anchor)["documentId"], november);
    assert_ne!(
        json!(w.anchor),
        t["topic"]["config"]["sourceRule"]["anchor"]
    );
    assert!(!w.grant.contains(&EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: october,
        page_id: None
    }));
    assert!(!w.grant.contains(
        &serde_json::from_value(t["topic"]["config"]["sourceRule"]["anchor"].clone()).unwrap()
    ));
    assert_eq!(made["history"][0]["anchor"], json!(w.anchor));
    assert_eq!(
        version_on(&f.c(), &w).unwrap().unwrap().0["period"],
        "2026-11"
    );
    let navigation = crate::agent_work::ui(
        &f.root,
        &json!({"action":"topicWorkNavigation","topicId":t["topic"]["id"],"workId":id}),
    )
    .unwrap();
    assert_eq!(navigation["source"]["anchor"], json!(w.anchor));
    assert_eq!(navigation["source"]["path"], "daily/2026-11-01.md");
}
#[test]
fn v5_topic_period_leap_year_and_month_end_do_not_copy_prior_month_members() {
    let f = Fixture::new();
    f.seed("daily/2024-02-29.md", "闰日事实。");
    f.seed("daily/2024-03-01.md", "三月事实。");
    f.seed("daily/2026-12-31.md", "年末事实。");
    f.seed("daily/2027-01-01.md", "下一年。");
    let t = month_topic(&f);
    let feb = month_preview(&f, &t, "2024-02");
    let march = month_preview(&f, &t, "2024-03");
    let dec = month_preview(&f, &t, "2026-12");
    assert_eq!(feb["scope"]["selection"]["dateTo"], "2024-02-29");
    assert_eq!(feb["scope"]["totalMembers"], 1);
    assert_ne!(feb["anchor"], march["anchor"]);
    assert_eq!(dec["scope"]["selection"]["dateTo"], "2026-12-31");
    assert_eq!(dec["scope"]["totalMembers"], 1);
    assert!(crate::agent_work::ui(&f.root,&json!({"action":"topicWorkPreview","topicId":t["topic"]["id"],"expectedRevision":2,"period":"2026-13"})).is_err());
}
#[test]
fn v5_topic_period_preview_retains_all_pages_and_rejects_stale_members_before_creation() {
    let f = Fixture::new();
    for day in 1..=21 {
        f.seed(&format!("daily/2026-11-{day:02}.md"), "分页合成日记。");
    }
    let t = month_topic(&f);
    let p = month_preview(&f, &t, "2026-11");
    assert_eq!(p["notes"].as_array().unwrap().len(), 21);
    assert_eq!(
        p["selection"]["manifest"]["members"]
            .as_array()
            .unwrap()
            .len(),
        21
    );
    let args = create(&f, &t, "2026-11", "stale-month-page");
    f.seed("daily/2026-11-22.md", "新增成员。");
    assert!(crate::agent_work::ui(&f.root, &args)
        .unwrap_err()
        .contains("已变化"));
    assert_eq!(counts(&f), json!([0, 0, 0, 0]));
    let now = month_preview(&f, &t, "2026-11");
    assert_eq!(now["scope"]["totalMembers"], 22);
    assert_ne!(p["fingerprint"], now["fingerprint"]);
}
#[test]
fn v5_topic_period_same_month_preserves_original_and_binding_requires_exact_current_scope() {
    let f = Fixture::new();
    f.seed("daily/2026-11-01.md", "本月事实。");
    let t = month_topic(&f);
    let args = create(&f, &t, "2026-11", "create-month-before-bind");
    let made = crate::agent_work::ui(&f.root, &args).unwrap();
    let id = made["openedWorkId"].as_str().unwrap();
    let before = counts(&f);
    let mut again = args.clone();
    again["clientRequestId"] = json!("same-month-no-reset");
    assert_eq!(
        crate::agent_work::ui(&f.root, &again).unwrap()["openedWorkId"],
        id
    );
    assert_eq!(counts(&f), before);
    crate::agent_work::ui(&f.root,&json!({"action":"topicBind","topicId":t["topic"]["id"],"expectedRevision":2,"workId":id,"expectedWorkRevision":1,"period":"2026-11","clientRequestId":"rebind-real-month-scope"})).unwrap();
    let wrong_anchor: EvidenceLocator =
        serde_json::from_value(t["topic"]["config"]["sourceRule"]["anchor"].clone()).unwrap();
    let wrong = store::create(
        &f.root,
        "错误范围不得标成本期".into(),
        "拒绝".into(),
        wrong_anchor.clone(),
        Grant {
            notes: vec![wrong_anchor],
            ..Default::default()
        },
    )
    .unwrap();
    assert!(crate::agent_work::ui(&f.root,&json!({"action":"topicBind","topicId":t["topic"]["id"],"expectedRevision":2,"workId":wrong,"expectedWorkRevision":1,"period":"2026-11","clientRequestId":"reject-unmatched-scope"})).unwrap_err().contains("本期规则不同"));
    let w = store::load(&f.c(), id).unwrap();
    assert_eq!(w.state, "ready");
    assert_eq!(w.revision, 1);
    assert!(w.active_run.is_none());
}
#[test]
fn v5_topic_period_configuration_and_navigation_fail_closed_without_new_permission() {
    let f = Fixture::new();
    f.seed("daily/2026-11-01.md", "当前日记。");
    let t = month_topic(&f);
    let before = counts(&f);
    assert!(crate::agent_work::ui(&f.root,&json!({"action":"topicUpdate","topicId":t["topic"]["id"],"expectedRevision":2,"title":"不可越界","period":"2026-11","outputPreference":"","periodDirectory":"../outside","clientRequestId":"reject-directory-escape"})).is_err());
    assert_eq!(counts(&f), before);
    let args = create(&f, &t, "2026-11", "month-before-revocation");
    let made = crate::agent_work::ui(&f.root, &args).unwrap();
    let id = made["openedWorkId"].as_str().unwrap();
    assert!(crate::agent_work::ui(
        &f.root,
        &json!({"action":"topicWorkNavigation","topicId":"other-topic","workId":id})
    )
    .is_err());
    f.c().execute("UPDATE agent_works SET state='revoked',authorization_version=authorization_version+1 WHERE id=?1",[id]).unwrap();
    assert!(crate::agent_work::ui(
        &f.root,
        &json!({"action":"topicWorkNavigation","topicId":t["topic"]["id"],"workId":id})
    )
    .unwrap_err()
    .contains("撤回"));
    let existing = month_preview(&f, &t, "2026-11");
    assert_eq!(existing["existingWorkId"], id);
    f.c().execute("UPDATE libraries SET enabled=0", []).unwrap();
    assert!(crate::agent_work::ui(&f.root,&json!({"action":"topicWorkPreview","topicId":t["topic"]["id"],"expectedRevision":2,"period":"2026-12"})).unwrap_err().contains("不可用"));
}
#[test]
fn v5_topic_period_confirmed_scope_refresh_rebinds_same_work_without_new_run() {
    let f = Fixture::new();
    f.seed("daily/2026-11-01.md", "本期原材料。");
    let t = month_topic(&f);
    let args = create(&f, &t, "2026-11", "create-before-month-refresh");
    let made = crate::agent_work::ui(&f.root, &args).unwrap();
    let id = made["openedWorkId"].as_str().unwrap();
    let w = store::load(&f.c(), id).unwrap();
    let original = json!(w.grant);
    f.seed("daily/2026-11-02.md", "本期新增材料。");
    let selected = original["manifest"]["selection"].clone();
    let p = source_scope::preview(&f.root, &json!({"selection":selected})).unwrap();
    crate::agent_work::ui(&f.root,&json!({"action":"replaceSourceScope","id":id,"clientMessageId":"confirmed-new-month-members","text":"明确授权新增本期笔记；只更新本事项范围，不运行模型。","selection":selected,"expectedManifest":p["snapshot"],"expectedPreviousManifest":original["manifest"]["snapshot"],"expectedRevision":1})).unwrap();
    let changed = store::load(&f.c(), id).unwrap();
    assert_eq!(changed.revision, 2);
    assert!(version_on(&f.c(), &changed)
        .unwrap_err()
        .contains("范围或授权已变化"));
    crate::agent_work::ui(&f.root,&json!({"action":"topicBind","topicId":t["topic"]["id"],"expectedRevision":2,"workId":id,"expectedWorkRevision":2,"period":"2026-11","clientRequestId":"bind-confirmed-new-month-scope"})).unwrap();
    let now = store::load(&f.c(), id).unwrap();
    assert_eq!(now.id, w.id);
    assert_eq!(now.revision, 2);
    assert_eq!(
        version_on(&f.c(), &now).unwrap().unwrap().0["methodVersion"],
        t["method"]["id"]
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_works", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn v5_topic_period_unknown_configuration_version_is_not_silently_run() {
    let f = Fixture::new();
    f.seed("daily/2026-11-01.md", "本期材料。");
    let t = month_topic(&f);
    let args = create(&f, &t, "2026-11", "create-before-incompatible-config");
    let made = crate::agent_work::ui(&f.root, &args).unwrap();
    let id = made["openedWorkId"].as_str().unwrap();
    f.c().execute("UPDATE agent_topic_revisions SET config_json=json_set(config_json,'$.schemaVersion',3) WHERE topic_id=?1 AND revision=2",[t["topic"]["id"].as_str().unwrap()]).unwrap();
    assert!(crate::agent_work::ui(
        &f.root,
        &json!({"action":"topicOpen","topicId":t["topic"]["id"]})
    )
    .unwrap_err()
    .contains("配置版本不兼容"));
    assert!(preflight(
        &f.root,
        &f.c(),
        &store::load(&f.c(), id).unwrap(),
        "codex",
        true
    )
    .unwrap_err()
    .contains("配置版本不兼容"));
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn v5_topic_period_legacy_empty_selection_can_rebind_its_exact_work() {
    let f = Fixture::new();
    let t = crate::agent_work::ui(&f.root, &empty(&f)).unwrap();
    let args = create(&f, &t, "2026-10", "create-empty-before-legacy-rebind");
    let made = crate::agent_work::ui(&f.root, &args).unwrap();
    let id = made["openedWorkId"].as_str().unwrap();
    // 349 saved an exact selection without a separate source-rule fingerprint.
    f.c().execute("UPDATE agent_topic_revisions SET config_json=json_remove(config_json,'$.sourceRule.scopeFingerprint') WHERE topic_id=?1",[t["topic"]["id"].as_str().unwrap()]).unwrap();
    crate::agent_work::ui(&f.root,&json!({"action":"topicBind","topicId":t["topic"]["id"],"expectedRevision":1,"workId":id,"expectedWorkRevision":1,"period":"2026-10","clientRequestId":"legacy-empty-exact-rebind"})).unwrap();
    assert_eq!(counts(&f), json!([1, 0, 4, 0]));
    assert!(version_on(&f.c(), &store::load(&f.c(), id).unwrap())
        .unwrap()
        .is_some());
}
