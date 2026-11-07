use super::*;

#[test]
fn reliability_legacy_rule_bundles_recover_without_losing_identity_checks() {
    let catalog = json!({"skills":[]});
    let entry = json!({"source":"AGENTS.md","scope":{"libraryId":"notes"},"instructions":"规则","version":"v1"});
    let old = json!([{"managedDirectory":"rules","documentId":"a","fingerprint":"a1","entries":[entry.clone()]},{"managedDirectory":"rules","documentId":"b","fingerprint":"b1","entries":[entry]}]);
    let current = crate::knowledge_rules::compact_guidance(old.clone());
    verify_material_identity(&catalog, &old, &catalog, &current).unwrap();
    let mut changed = current;
    changed[1]["fingerprint"] = json!("b2");
    assert!(verify_material_identity(&catalog, &old, &catalog, &changed).is_err());
}
use crate::source_evidence::tests::Fixture;

fn setup() -> (Fixture, Work, String, Value) {
    let f = Fixture::new();
    f.note("notes", "current", "原材料");
    let id = crate::agent_work::tests::create(&f, false);
    let (w, run) = crate::agent_work::tests::claim(&f, &id);
    let report:runner::Report=serde_json::from_value(json!({"status":"completed","summary":"已核对材料","findings":[{"text":"材料已核对","citations":[{"evidenceId":"e1","quote":"原材料"}]}],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":""})).unwrap();
    record(&f.root, &run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    let binding = goal::for_run(&f.root, &w, &run).unwrap();
    goal::accept_report(&f.root, &w, &run, &report, &binding).unwrap();
    record(&f.root, &run, "budget", &json!({"modelCallSeconds":90})).unwrap();
    record(&f.root,&run,"nativeMeasurement",&json!({"tools":[{"tool":"hub_finish","outcome":"returned","hostStartMs":88000,"hostHandlingMs":100}],"materialBytes":{"overrunBytes":0}})).unwrap();
    let skills =
        crate::hub_capabilities::Session::new(&f.root, Some(w.grant.scope().unwrap())).unwrap();
    record(
        &f.root,
        &run,
        "skillCatalog",
        &json!({"catalog":skills.metadata(),"fingerprint":skills.fingerprint()}),
    )
    .unwrap();
    record(&f.root, &run, "libraryRules", &skills.guidance()).unwrap();
    let excerpt = w
        .grant
        .reader(&f.root)
        .unwrap()
        .read(w.anchor.as_ref().unwrap(), 0, 4000, None)
        .unwrap();
    record(
        &f.root,
        &run,
        "evidence",
        &json!({"evidenceId":"e1","excerpt":excerpt}),
    )
    .unwrap();
    record(&f.root,&run,"nativeSession",&json!({"providerTurnCompleted":false,"executionManifest":{"actionRefs":[]},"bindingParts":{"sharedMemory":hash(&Value::Null).unwrap(),"skills":hash(&skills.fingerprint()).unwrap()},"dependencies":[],"skillReads":[],"ruleReads":[],"materialReads":null})).unwrap();
    fail(&f.root, &w, &run, "Codex 生成超时，请重试。").unwrap();
    let args = json!({"action":"recoverAcceptedReport","id":id,"originRunId":run,"expectedWorkRevision":w.revision,"expectedAuthorizationVersion":w.authorization_version,"report":report});
    (f, w, run, args)
}

fn original(c: &Connection, run: &str) -> Value {
    c.query_row(
        "SELECT state,error,usage_json,finished_at FROM agent_runs WHERE id=?1",
        [run],
        |r| {
            Ok(json!([
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<i64>>(3)?
            ]))
        },
    )
    .unwrap()
}

#[test]
fn accepted_recovery_identity_ignores_only_display_directory() {
    let catalog = json!({"skills":[{"name":"method","version":"v1"}]});
    let rules = json!([{"managedDirectory":"old/profile/rules","libraryId":"notes","documentId":"current","fingerprint":"version1","entries":[{"path":"AGENTS.md","instructions":"check source"}]}]);
    let mut relocated = rules.clone();
    relocated[0]["managedDirectory"] = json!("new/profile/rules");
    verify_material_identity(&catalog, &rules, &catalog, &relocated).unwrap();
    for key in ["libraryId", "documentId", "fingerprint", "entries"] {
        let mut changed = relocated.clone();
        changed[0][key] = json!("changed");
        assert!(
            verify_material_identity(&catalog, &rules, &catalog, &changed).is_err(),
            "{key}"
        );
    }
    let mut changed = catalog.clone();
    changed["skills"][0]["version"] = json!("v2");
    assert!(verify_material_identity(&catalog, &rules, &changed, &relocated).is_err());
    assert!(verify_material_identity(&catalog, &rules, &catalog, &Value::Null).is_err());
}

#[test]
fn accepted_recovery_publishes_once_without_regrading_or_provider_reservation() {
    let (f, w, run, args) = setup();
    let before = original(&f.c(), &run);
    let result = crate::agent_work::ui(&f.root, &args).unwrap();
    assert_eq!(result["state"], "published");
    assert_eq!(original(&f.c(), &run), before);
    assert_eq!(load(&f.c(), &w.id).unwrap().state, "completed");
    assert_eq!(
        crate::agent_work::ui(&f.root, &args).unwrap()["state"],
        "alreadyPublished"
    );
    assert_eq!(records(&f.root, &w.id, "delivery", 10).unwrap().len(), 1);
    assert!(records(&f.root, &w.id, "providerBudgetReservation", 10)
        .unwrap()
        .is_empty());
    let reserves = records(&f.root, &w.id, "executionBudgetReservation", 10).unwrap();
    assert_eq!(reserves.len(), 1);
    assert_eq!(reserves[0]["reserved"]["agentSessions"], 0);
}

#[test]
fn accepted_recovery_rejects_mutation_stale_authority_and_changed_source() {
    for case in ["body", "revision", "revoked", "late", "source", "timing"] {
        let (f, w, run, mut args) = setup();
        let before = original(&f.c(), &run);
        match case {
            "body" => args["report"]["summary"] = json!("改写结论"),
            "revision" => args["expectedWorkRevision"] = json!(99),
            "revoked" => {
                f.c()
                    .execute(
                        "UPDATE agent_works SET state='revoked' WHERE id=?1",
                        [&w.id],
                    )
                    .unwrap();
            }
            "late" => {
                f.c()
                    .execute(
                        "UPDATE agent_works SET revision=revision+1 WHERE id=?1",
                        [&w.id],
                    )
                    .unwrap();
            }
            "source" => {
                f.note("notes", "current", "已经改变的材料");
            }
            "timing" => {
                f.c().execute("UPDATE agent_records SET body_json=json_set(body_json,'$.tools[0].hostStartMs',90000) WHERE run_id=?1 AND kind='nativeMeasurement'",[&run]).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(crate::agent_work::ui(&f.root, &args).is_err(), "{case}");
        assert!(
            records(&f.root, &w.id, "delivery", 10).unwrap().is_empty(),
            "{case}"
        );
        assert_eq!(original(&f.c(), &run), before);
        assert!(records(&f.root, &w.id, "providerBudgetReservation", 10)
            .unwrap()
            .is_empty());
    }
}

#[test]
fn accepted_recovery_failed_publication_keeps_attempt_and_stops_retries() {
    let (f, w, run, args) = setup();
    f.c().execute_batch("CREATE TRIGGER reject_recovery_delivery BEFORE INSERT ON agent_records WHEN NEW.kind='delivery' BEGIN SELECT RAISE(ABORT,'injected delivery failure'); END;").unwrap();
    assert!(crate::agent_work::ui(&f.root, &args)
        .unwrap_err()
        .contains("injected delivery failure"));
    assert_eq!(load(&f.c(), &w.id).unwrap().state, "interrupted");
    assert!(records(&f.root, &w.id, "delivery", 10).unwrap().is_empty());
    f.c()
        .execute_batch("DROP TRIGGER reject_recovery_delivery")
        .unwrap();
    assert!(crate::agent_work::ui(&f.root, &args)
        .unwrap_err()
        .contains("恢复尝试已使用"));
    assert_eq!(original(&f.c(), &run)[0], "interrupted");
}

#[test]
#[ignore = "bounded saved-state recovery; explicit isolated root and output required; zero providers"]
fn accepted_recovery_saved_state_formal_entry() {
    let root = PathBuf::from(std::env::var("HUB_ACCEPTED_RECOVERY_ROOT").unwrap());
    let out = PathBuf::from(std::env::var("HUB_ACCEPTED_RECOVERY_OUTPUT").unwrap());
    assert_eq!(
        std::fs::read_to_string(root.join(".hub-isolated-runtime-v1")).unwrap(),
        "Hub isolated runtime v1\n"
    );
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(out.with_extension("started"))
        .unwrap();
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let report:Value=serde_json::from_slice(&std::fs::read(desktop.join("artifacts/architecture-v5-357-verification-20261028/tail-repair/normalized-report.json")).unwrap()).unwrap();
    let run = "run-ZsibjOVBWQuTfH9KvJ1qPbc5";
    let id = "work-GhyxzTl5PEnrrFYwmyw1OBZ8";
    let before = original(&read(&root).unwrap(), run);
    let providers = records(&root, id, "providerBudgetReservation", 100).unwrap();
    let result = crate::agent_work::ui(
        &root,
        &json!({"action":"recoverAcceptedReport","id":id,"originRunId":run,"expectedWorkRevision":2,"expectedAuthorizationVersion":1,"report":report}),
    );
    let after = original(&read(&root).unwrap(), run);
    let unchanged = providers == records(&root, id, "providerBudgetReservation", 100).unwrap()
        && before == after;
    let value = json!({"result":result,"originalRunAndProviderReservationsUnchanged":unchanged,"providerCalls":0});
    std::fs::write(&out, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    assert!(unchanged);
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(
        json!(load(&read(&root).unwrap(), id).unwrap().report),
        report
    );
    let reopened = crate::agent_work::ui(&root, &json!({"action":"status","id":id})).unwrap();
    std::fs::write(
        out.with_extension("reopened.json"),
        serde_json::to_vec_pretty(&reopened).unwrap(),
    )
    .unwrap();
    assert_eq!(reopened["work"]["report"], report);
}
