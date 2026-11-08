use super::*;
fn setup() -> (Fixture, String, Value) {
    let f = Fixture::new();
    let view=crate::agent_work::ui(&f.root,&json!({"action":"create","goal":"请记住本项目规则；先提出建议，不自动确认","successCriteria":"","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]}})).unwrap();
    let id = view["work"]["id"].as_str().unwrap().to_string();
    f.c()
        .execute(
            "UPDATE agent_works SET active_run='proposal-run' WHERE id=?1",
            [&id],
        )
        .unwrap();
    f.c()
        .execute("INSERT INTO memory_work_scopes VALUES(?1,'',1)", [&id])
        .unwrap();
    let request = json!({"topicKey":"format","title":"报告格式","kind":"rule","body":"本项目报告使用中文。","reason":"用户明确要求在本项目复用","sourceRecordId":format!("{id}-goal")});
    (f, id, request)
}
#[test]
fn model_suggestion_requires_user_confirmation_and_retains_exact_source() {
    let (f, id, req) = setup();
    let proposed = proposals::propose(&f.root, &id, "proposal-run", &req, "deepseek").unwrap();
    assert_eq!(proposed["eligibleForRecall"], false);
    assert_eq!(
        proposals::propose(&f.root, &id, "proposal-run", &req, "deepseek").unwrap()["proposalId"],
        proposed["proposalId"]
    );
    assert_eq!(proposals::list(&f.c(), "").unwrap().len(), 1);
    let mut backend = Local::new(&f);
    assert!(select(&f.root, "", "报告", &mut backend)
        .unwrap()
        .items
        .is_empty());
    let mut approval = req.clone();
    approval["action"] = json!("put");
    approval["confirmed"] = json!(true);
    approval["requestKey"] = json!("approve-once");
    approval["expectedVersion"] = json!(0);
    approval["proposalId"] = proposed["proposalId"].clone();
    approval["changeReason"] = json!("核对并改为只适用此项目");
    approval["body"] = json!("报告用中文，原文引用保留原语言。");
    let item = save(&f, &mut backend, &approval);
    assert_eq!(
        select(&f.root, "", "报告", &mut backend)
            .unwrap()
            .rules
            .len(),
        1
    );
    assert!(proposals::list(&f.c(), "").unwrap().is_empty());
    let status = status(&f.root, Some(&id)).unwrap();
    let source = &status["entries"][0]["source"];
    assert_eq!(source["proposedBy"], "deepseek");
    assert_eq!(source["confirmedBy"], "explicitUser");
    assert_eq!(source["workId"], id);
    assert_eq!(source["sourceRecordId"], format!("{id}-goal"));
    assert_eq!(
        body(&f.root, &item).unwrap(),
        "报告用中文，原文引用保留原语言。"
    );
    assert_eq!(stage(&f.root, &approval).unwrap().version, 1);
    approval["requestKey"] = json!("bad-reapproval");
    assert!(stage(&f.root, &approval).is_err());
}
#[test]
fn proposal_cannot_cross_project_restore_forgotten_memory_or_overwrite_new_version() {
    let (f, id, req) = setup();
    let mut forged = req.clone();
    forged["sourceRecordId"] = json!("another-work-goal");
    assert!(proposals::propose(&f.root, &id, "proposal-run", &forged, "codex").is_err());
    let proposed = proposals::propose(&f.root, &id, "proposal-run", &req, "codex").unwrap();
    let mut approval = req.clone();
    approval["confirmed"] = json!(true);
    approval["requestKey"] = json!("approval");
    approval["expectedVersion"] = json!(0);
    approval["proposalId"] = proposed["proposalId"].clone();
    f.c()
        .execute("INSERT INTO memory_projects VALUES('other','其他项目')", [])
        .unwrap();
    approval["projectId"] = json!("other");
    assert!(stage(&f.root, &approval).is_err());
    approval["projectId"] = json!("");
    let mut newer = approval.clone();
    newer.as_object_mut().unwrap().remove("proposalId");
    newer["requestKey"] = json!("newer");
    let mut backend = Local::new(&f);
    let saved = save(&f, &mut backend, &newer);
    assert!(stage(&f.root, &approval).is_err());
    f.c()
        .execute(
            "UPDATE memory_entries SET state='forgotten' WHERE id=?1",
            [saved.id],
        )
        .unwrap();
    assert!(proposals::propose(&f.root, &id, "proposal-run", &req, "codex").is_err());
    f.c()
        .execute(
            "UPDATE memory_work_scopes SET enabled=0 WHERE work_id=?1",
            [&id],
        )
        .unwrap();
    assert!(proposals::propose(&f.root, &id, "proposal-run", &req, "codex").is_err());
}
#[test]
fn dismissed_proposal_is_not_reopened_by_model_replay() {
    let (f, id, req) = setup();
    let proposed = proposals::propose(&f.root, &id, "proposal-run", &req, "codex").unwrap();
    ui(
        &f.root,
        &json!({"action":"dismissProposal","proposalId":proposed["proposalId"]}),
    )
    .unwrap();
    assert_eq!(
        proposals::propose(&f.root, &id, "proposal-run", &req, "codex").unwrap()["state"],
        "dismissed"
    );
    assert!(proposals::list(&f.c(), "").unwrap().is_empty());
}
#[test]
fn draft_project_selection_can_review_its_proposals_without_creating_a_work() {
    let (f, id, req) = setup();
    f.c()
        .execute("INSERT INTO memory_projects VALUES('alpha','甲项目')", [])
        .unwrap();
    f.c()
        .execute(
            "UPDATE memory_work_scopes SET project_id='alpha' WHERE work_id=?1",
            [&id],
        )
        .unwrap();
    proposals::propose(&f.root, &id, "proposal-run", &req, "codex").unwrap();
    assert_eq!(
        ui(&f.root, &json!({"action":"status","projectId":"alpha"})).unwrap()["proposals"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        ui(&f.root, &json!({"action":"status","projectId":""})).unwrap()["proposals"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(ui(&f.root, &json!({"action":"status","projectId":"unknown"})).is_err());
}
