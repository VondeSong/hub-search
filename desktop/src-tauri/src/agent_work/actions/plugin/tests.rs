use super::*;
fn fixture(state: &str) -> (crate::source_evidence::tests::Fixture, String, Action) {
    let f = crate::source_evidence::tests::Fixture::new();
    let id = store::create(
        &f.root,
        "整理本项目进度".into(),
        "".into(),
        None::<EvidenceLocator>,
        crate::agent_work::Grant::default(),
    )
    .unwrap();
    let grant = json!({"server":apps::GITHUB,"catalogSha256":"a".repeat(64),"tools":[apps::COMMENT],"appBinding":{"accountScope":"account","connectionSha256":"b".repeat(64),"writeRepository":"VondeSong/hub-search"}});
    let plan = json!({"grant":grant,"tool":apps::COMMENT,"arguments":{"repo_full_name":"VondeSong/hub-search","pr_number":14,"comment":"本轮实际进度"},"targetUrl":"https://github.com/VondeSong/hub-search/issues/14","targetTitle":"进度","accountScope":"account","executed":false});
    let payload = plan.clone();
    store::write(&f.root,|c|{
        store::insert(c,&id,None,"assistantOptions",&json!({"model":null,"autoFlashcardInbox":false,"mcpServices":[grant]}))?;
        let w=store::load(c,&id)?;
        c.execute("INSERT INTO agent_actions(id,work_id,kind,base_revision,authorization_version,state,payload_json,context_hash,receipt_json,created_at,updated_at) VALUES('plugin-action',?1,'pluginWrite',?2,?3,?4,?5,?6,?7,1,1)",params![id,w.revision,w.authorization_version,state,payload.to_string(),digest(&plan),if state=="verified" {Some(json!({"domain":"githubIssueComment","verified":true,"confirmedAt":123,"goalCompleted":false}).to_string())}else{None}]).map_err(|e|e.to_string())?;Ok(())
    }).unwrap();
    let a = load(&f.c(), &id, "plugin-action").unwrap();
    (f, id, a)
}
#[test]
fn orphaned_plugin_write_becomes_unknown_and_cannot_be_replayed() {
    let (f, id, a) = fixture("executing");
    reconcile(&f.root, &id).unwrap();
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "unknown");
    let result = ui(
        &f.root,
        &json!({"action":"submitPluginWrite","id":id,"actionId":a.id,"confirmationToken":token(&a)}),
    );
    assert!(result.unwrap_err().contains("只能核对"));
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "unknown");
}
#[test]
fn plugin_confirmation_is_immutable_and_revocation_blocks_before_transport() {
    let (f, id, a) = fixture("prepared");
    assert!(ui(
        &f.root,
        &json!({"action":"submitPluginWrite","id":id,"actionId":a.id,"confirmationToken":"wrong"})
    )
    .is_err());
    store::write(&f.root, |c| {
        store::insert(
            c,
            &id,
            None,
            "assistantOptions",
            &json!({"model":null,"autoFlashcardInbox":false}),
        )
    })
    .unwrap();
    assert!(ui(
        &f.root,
        &json!({"action":"submitPluginWrite","id":id,"actionId":a.id,"confirmationToken":token(&a)})
    )
    .unwrap_err()
    .contains("撤销"));
    assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "prepared");
}
#[test]
fn verified_plugin_receipt_survives_repeated_confirmation_without_reissuing_write() {
    let (f, id, a) = fixture("verified");
    ui(&f.root,&json!({"action":"submitPluginWrite","id":id,"actionId":a.id,"confirmationToken":token(&a)})).unwrap();
    assert_eq!(
        load(&f.c(), &id, &a.id).unwrap().receipt.unwrap()["confirmedAt"],
        123
    );
}

#[test]
fn revoked_plugin_grant_hides_the_prepared_private_body_and_confirmation() {
    let (f, id, a) = fixture("prepared");
    store::write(&f.root,|c|{c.execute("UPDATE agent_works SET state='revoked',authorization_version=authorization_version+1 WHERE id=?1",[&id]).map_err(|e|e.to_string())?;Ok(())}).unwrap();
    let w = store::load(&f.c(), &id).unwrap();
    let mut value = json!(a);
    view(&f.c(), &w, &a, &mut value).unwrap();
    assert!(value["payload"].is_null());
    assert!(value["confirmationToken"].is_null());
}

#[test]
fn plugin_draft_inspection_and_completion_catalog_do_not_require_a_note_anchor() {
    let (f, id, a) = fixture("prepared");
    let w = store::load(&f.c(), &id).unwrap();
    assert!(w.anchor.is_none());
    let result = super::super::assistant::inspect(&f.root, &w, &a.id).unwrap();
    assert_eq!(result["executed"], false);
    let proofs = super::super::completion_proofs_on(&f.root, &f.c(), &w).unwrap();
    assert!(proofs
        .iter()
        .any(|p| p["kind"] == "draft" && p["reference"]["actionId"] == a.id));
    let (f, id, _) = fixture("verified");
    let facts = super::super::receipts_on(&f.c(), &id).unwrap();
    assert_eq!(facts[0]["receipt"]["confirmedAt"], 123);
}

#[test]
fn new_decision_can_replace_an_unpublished_draft_but_never_replay_an_uncertain_or_verified_write() {
    for state in ["prepared", "unknown", "verified", "executing"] {
        let (f, id, a) = fixture(state);
        let mut w = store::load(&f.c(), &id).unwrap();
        assert_eq!(
            reusable_on(&f.c(), &w, &a.context_hash).unwrap(),
            Some(a.id.clone())
        );
        w.revision += 1;
        let reused = reusable_on(&f.c(), &w, &a.context_hash).unwrap();
        if state == "prepared" {
            assert_eq!(reused, None);
            assert_eq!(load(&f.c(), &id, &a.id).unwrap().state, "expired");
        } else {
            assert_eq!(reused, Some(a.id));
            assert_eq!(load(&f.c(), &id, "plugin-action").unwrap().state, state);
        }
    }
}
