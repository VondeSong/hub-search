use super::*;
use crate::source_evidence::tests::Fixture;
fn note(id: &str) -> EvidenceLocator {
    EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: id.into(),
        page_id: None,
    }
}
fn seed(f: &Fixture) {
    for i in 1..=40 {
        f.note("notes", &format!("daily/n{i}"), "authorized body");
    }
    f.note("notes", "other/secret", "PRIVATE");
}
fn request(f: &Fixture) -> Value {
    let selected = json!({"libraryId":"notes","directory":"daily"});
    let p = ui(
        &f.root,
        &json!({"action":"previewSourceScope","selection":selected}),
    )
    .unwrap();
    json!({"action":"createWithSourceScope","selection":selected,"expectedManifest":p["snapshot"],"anchor":note("daily/n1"),"goal":"核对固定范围","successCriteria":"范围外材料不可读"})
}
#[test]
fn host_manifest_grant_keeps_exact_members_across_reopen_without_model_or_scope_expansion() {
    let f = Fixture::new();
    seed(&f);
    let args = request(&f);
    let v = ui(&f.root, &args).unwrap();
    let id = v["work"]["id"].as_str().unwrap();
    let w = store::load(&f.c(), id).unwrap();
    assert!(w.grant.library_ids.is_empty());
    assert!(w.grant.notes.is_empty());
    assert_eq!(w.grant.manifest.as_ref().unwrap().members.len(), 40);
    assert!(w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(&note("daily/n40"), 0, 50, None)
        .is_ok());
    assert!(w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(&note("other/secret"), 0, 50, None)
        .is_err());
    assert!(EvidenceScope::new(vec![], vec![])
        .unwrap()
        .with_notes(w.grant.manifest.as_ref().unwrap().members.clone())
        .is_err());
    assert_eq!(
        f.c()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM agent_runs", [], |r| r.get(0))
            .unwrap(),
        0
    );
    assert!(ui(&f.root,&json!({"action":"message","id":id,"text":"追加材料","clientMessageId":"scope-append","expectedRevision":1,"addNotes":[note("other/secret")]})).unwrap_err().contains("固定清单"));
    f.note("notes", "daily/new", "new file");
    assert!(!w.grant.contains(&note("daily/new")));
    assert!(w.grant.reader(&f.root).is_err());
    assert!(store::load(&f.c(), id).unwrap().grant.manifest == w.grant.manifest);
}
#[test]
fn host_manifest_confirmation_rejects_stale_preview_forged_members_and_outside_anchor() {
    let f = Fixture::new();
    seed(&f);
    let args = request(&f);
    let mut outside = args.clone();
    outside["anchor"] = json!(note("other/secret"));
    assert!(ui(&f.root, &outside).is_err());
    let mut mixed = args.clone();
    mixed["grant"] = json!({"libraryIds":["notes"]});
    assert!(ui(&f.root, &mixed).is_err());
    f.note("notes", "daily/n2", "changed");
    assert!(ui(&f.root, &args).is_err());
    assert_eq!(
        f.c()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM agent_works", [], |r| r.get(0))
            .unwrap(),
        0
    );
    let args = request(&f);
    let v = ui(&f.root, &args).unwrap();
    let w = store::load(&f.c(), v["work"]["id"].as_str().unwrap()).unwrap();
    let mut plain = args.clone();
    plain["action"] = json!("create");
    plain["grant"] = json!(w.grant);
    assert!(ui(&f.root, &plain).is_err());
    let mut forged = w.grant.clone();
    forged
        .manifest
        .as_mut()
        .unwrap()
        .members
        .push(note("other/secret"));
    assert!(forged.reader(&f.root).is_err());
    f.c()
        .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
        .unwrap();
    assert!(w.grant.reader(&f.root).is_err());
}

fn replacement(f: &Fixture, id: &str, operation: &str) -> Value {
    let work = store::load(&f.c(), id).unwrap();
    let selection = work.grant.manifest.as_ref().unwrap().selection.clone();
    let p = ui(
        &f.root,
        &json!({"action":"previewSourceScope","selection":selection}),
    )
    .unwrap();
    json!({"action":"replaceSourceScope","id":id,"clientMessageId":operation,"text":"重新确认当前固定材料范围，保留同一事项和累计预算","selection":selection,"expectedManifest":p["snapshot"],"expectedPreviousManifest":work.grant.manifest.as_ref().unwrap().snapshot,"expectedRevision":work.revision})
}
#[test]
fn host_scope_refresh_keeps_work_budget_history_and_idempotency_after_source_change() {
    let f = Fixture::new();
    seed(&f);
    let v = ui(&f.root, &request(&f)).unwrap();
    let id = v["work"]["id"].as_str().unwrap();
    ui(&f.root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"limits":{"inputTokens":1000,"uncachedInputTokens":500,"outputTokens":100},"perRun":{"inputTokens":400,"uncachedInputTokens":200,"outputTokens":40},"unknownReservations":{}})).unwrap();
    let budget_before =
        store::provider_budget::view_on(&f.c(), &store::load(&f.c(), id).unwrap()).unwrap();
    let old = store::load(&f.c(), id).unwrap();
    f.note("notes", "daily/new", "added actual source");
    assert!(old.grant.reader(&f.root).is_err());
    let args = replacement(&f, id, "refresh-one");
    ui(&f.root, &args).unwrap();
    let current = store::load(&f.c(), id).unwrap();
    assert_eq!(current.id, old.id);
    assert_eq!(current.revision, 2);
    assert_eq!(current.authorization_version, old.authorization_version);
    assert!(current.grant.reader(&f.root).is_ok());
    assert!(current.grant.contains(&note("daily/new")));
    assert_eq!(
        budget_before,
        store::provider_budget::view_on(&f.c(), &current).unwrap()
    );
    let records: i64 = f
        .c()
        .query_row(
            "SELECT count(*) FROM agent_records WHERE work_id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    ui(&f.root, &args).unwrap();
    assert_eq!(store::load(&f.c(), id).unwrap().revision, 2);
    assert_eq!(
        records,
        f.c()
            .query_row::<i64, _, _>(
                "SELECT count(*) FROM agent_records WHERE work_id=?1",
                [id],
                |r| r.get(0)
            )
            .unwrap()
    );
    let mut collision = args.clone();
    collision["text"] = json!("different");
    assert!(ui(&f.root, &collision).is_err());
    let body: String = f
        .c()
        .query_row(
            "SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='userMessage'",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["scopeBefore"]["manifest"], json!(old.grant.manifest));
    assert_eq!(
        body["scopeAfter"]["manifest"],
        json!(current.grant.manifest)
    );
    assert!(store::materials::grant_at(&f.c(), &current, 1).is_err());
    assert_eq!(
        f.c()
            .query_row::<i64, _, _>("SELECT count(*) FROM agent_works", [], |r| r.get(0))
            .unwrap(),
        1
    );
    assert_eq!(
        f.c()
            .query_row::<i64, _, _>("SELECT count(*) FROM agent_runs", [], |r| r.get(0))
            .unwrap(),
        0
    );
}
#[test]
fn host_scope_refresh_rejects_active_unknown_stale_and_revoked_without_mutation() {
    let f = Fixture::new();
    seed(&f);
    let v = ui(&f.root, &request(&f)).unwrap();
    let id = v["work"]["id"].as_str().unwrap();
    let args = replacement(&f, id, "blocked-refresh");
    let before = serde_json::to_value(store::load(&f.c(), id).unwrap()).unwrap();
    let mut stale = args.clone();
    stale["expectedRevision"] = json!(99);
    assert!(ui(&f.root, &stale).unwrap_err().contains("版本"));
    f.c()
        .execute(
            "UPDATE agent_works SET active_run='active-test' WHERE id=?1",
            [id],
        )
        .unwrap();
    assert!(ui(&f.root, &args).unwrap_err().contains("先停止"));
    f.c()
        .execute("UPDATE agent_works SET active_run=NULL WHERE id=?1", [id])
        .unwrap();
    f.c().execute("INSERT INTO agent_actions(id,work_id,kind,base_revision,authorization_version,state,context_hash,created_at,updated_at) VALUES('unknown-scope',?1,'obsidianEdit',1,1,'unknown','synthetic',1,1)",[id]).unwrap();
    assert!(ui(&f.root, &args).unwrap_err().contains("待核对"));
    f.c()
        .execute(
            "UPDATE agent_actions SET state='verified' WHERE id='unknown-scope'",
            [],
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(store::load(&f.c(), id).unwrap()).unwrap(),
        before
    );
    let mut outside = args.clone();
    outside["selection"]["directory"] = json!("other");
    let p = ui(
        &f.root,
        &json!({"action":"previewSourceScope","selection":outside["selection"]}),
    )
    .unwrap();
    outside["expectedManifest"] = p["snapshot"].clone();
    assert!(ui(&f.root, &outside).unwrap_err().contains("锚点"));
    ui(&f.root, &json!({"action":"revoke","id":id})).unwrap();
    assert!(ui(&f.root, &args).unwrap_err().contains("已撤回"));
}

#[test]
fn host_scope_refresh_preserves_nonzero_unknown_reservations_and_prior_records() {
    let f = Fixture::new();
    seed(&f);
    let v = ui(&f.root, &request(&f)).unwrap();
    let id = v["work"]["id"].as_str().unwrap();
    ui(&f.root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"limits":{"inputTokens":1000,"uncachedInputTokens":500,"outputTokens":100},"perRun":{"inputTokens":400,"uncachedInputTokens":200,"outputTokens":40},"unknownReservations":{}})).unwrap();
    let run = "scope-reservation-only";
    let w = store::claim_with_budget(&f.root, id, run, Budget::mode("quick").unwrap()).unwrap();
    store::provider_budget::observe(&f.root, &w, run, &json!({"inputTokens":3}), true).unwrap();
    store::fail(
        &f.root,
        &w,
        run,
        "合成准入后中断；未调用提供方，不把不完整用量当零",
    )
    .unwrap();
    let w = store::load(&f.c(), id).unwrap();
    let provider = store::provider_budget::view_on(&f.c(), &w).unwrap();
    let execution = store::execution_budget::view_on(&f.c(), &w).unwrap();
    assert_eq!(provider["chargedOrReserved"]["inputTokens"], 400);
    assert_eq!(provider["unmeasuredRunIds"], json!([run]));
    let c = f.c();
    let mut stmt = c
        .prepare("SELECT id,kind,body_json FROM agent_records WHERE work_id=?1 ORDER BY rowid")
        .unwrap();
    let records = stmt
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(stmt);
    drop(c);
    f.note("notes", "daily/n2", "new version");
    let args = replacement(&f, id, "refresh-used-budget");
    ui(&f.root, &args).unwrap();
    let w = store::load(&f.c(), id).unwrap();
    assert_eq!(
        provider,
        store::provider_budget::view_on(&f.c(), &w).unwrap()
    );
    assert_eq!(
        execution,
        store::execution_budget::view_on(&f.c(), &w).unwrap()
    );
    for (record, kind, body) in records {
        let saved: (String, String) = f
            .c()
            .query_row(
                "SELECT kind,body_json FROM agent_records WHERE id=?1",
                [record],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(saved, (kind, body));
    }
    assert_eq!(
        f.c()
            .query_row::<i64, _, _>("SELECT count(*) FROM agent_runs", [], |r| r.get(0))
            .unwrap(),
        1
    );
}
