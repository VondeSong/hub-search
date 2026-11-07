//! User-authorized continuation of closed9.174; old markers and quota roots stay intact.
use super::*;
mod current_continuation;

pub(super) fn saved(root: &Path, id: &str) -> Value {
    let c = crate::source_evidence::open_read_database(root).unwrap();
    let w = store::load(&c, id).unwrap();
    let latest = |kind: &str| {
        store::records(root, id, kind, 1)
            .unwrap()
            .into_iter()
            .next()
    };
    json!({"work":w,"dataset":latest("sleepDatasetRevision"),"chart":latest("chartRevision"),
        "workingState":latest("workingState"),"providerBudget":store::provider_budget::view_on(&c,&w).unwrap(),
        "plan":store::material_budget::load_on(&c,id).unwrap(),"deliveries":store::records(root,id,"delivery",64).unwrap(),
        "actionCount":c.query_row("SELECT count(*) FROM agent_actions WHERE work_id=?1",[id],|r|r.get::<_,i64>(0)).unwrap()})
}
pub(super) fn bounded() -> Budget {
    let mut b = assistant::budget("quick").unwrap();
    b.model_calls = 1;
    b.output_repair_calls = 0;
    b.request_bytes = 278528;
    b.seconds = 120;
    b.model_call_seconds = 90;
    b
}
fn provider_records(root: &Path, run: &str) -> i64 {
    crate::source_evidence::open_read_database(root).unwrap().query_row(
        "SELECT count(*) FROM agent_records WHERE run_id=?1 AND kind IN ('nativeRuntime','nativeTurn','providerBudgetReservation','modelExecution')",
        [run], |r| r.get(0)).unwrap()
}

#[test]
#[ignore = "next authorized batch: one formal no-provider preflight, at most one MCP recovery and one February session"]
fn v5_report_resume_once() {
    let phase = std::env::var("HUB_V5_REPORT_RESUME_PHASE").unwrap();
    assert!(matches!(
        phase.as_str(),
        "preflight" | "preflight-resume" | "recover" | "february"
    ));
    let (desktop, old, _, root) = paths();
    let out = desktop.join("artifacts/architecture-v5-report-resume-20261028");
    let init = read(out.join("initialization.json"));
    assert_eq!(read(out.join("isolation.json"))["passed"], true);
    assert_eq!(read(out.join("default-audit.json"))["sourceSqlWrites"], 0);
    let preparation = read(out.join("preparation-contract.json"));
    let deadline =
        chrono::DateTime::parse_from_rfc3339(preparation["executionDeadline"].as_str().unwrap())
            .unwrap();
    assert!(chrono::Utc::now() < deadline);
    let original = init["workId"].as_str().unwrap();
    let source = Path::new(init["sourceFile"].as_str().unwrap());
    let mtime = std::fs::metadata(source).unwrap().modified().unwrap();
    assert_eq!(
        skills::Catalog::discover(&root)
            .unwrap()
            .fixed_version("v5-sleep-review")
            .unwrap(),
        read(old.join("prepared-work.json"))["method"]
    );
    let before = saved(&root, original);
    assert_eq!(before["work"]["revision"], 2);
    assert_eq!(before["work"]["authorizationVersion"], 1);
    assert_eq!(before["dataset"], init["currentDataset"]);
    assert_eq!(before["chart"], init["currentChart"]);
    if phase != "february" {
        assert_eq!(before["workingState"], init["currentWorkingState"]);
    }

    if phase == "preflight" || phase == "preflight-resume" {
        assert_eq!(preparation["modelsPermitted"], false);
        once(
            &out,
            if phase == "preflight" {
                "preflight-started"
            } else {
                "preflight-resume-started"
            },
        );
        if phase == "preflight" {
            save(&out, "preflight-before.json", &before);
            assert_eq!(before["plan"], init["oldPlan"]);
        } else {
            save(&out, "preflight-resume-before.json", &before);
        }
        assert_eq!(
            before["providerBudget"]["chargedOrReserved"],
            preparation["limits"]["oldJanuaryChargedOrReserved"]
        );
        configure(&root, original, &init, true);
        let submitted = read(old.join("remaining-plan-replay.json"))["proposedPlan"].clone();
        let typed: store::material_budget::Plan = serde_json::from_value(submitted).unwrap();
        let p = json!(typed);
        assert_eq!(p["requestBytes"], 278528);
        if phase == "preflight" {
            ui(
                &root,
                json!({"action":"freezeMaterialPlan","id":original,"expectedPlan":init["oldPlan"],"plan":p}),
            );
        } else {
            assert_eq!(before["plan"], p);
        }
        let committed = saved(&root, original);
        assert_eq!(committed["plan"], p);
        save(&out, "committed-plan.json", &p);
        save(&out, "plan-commit-state.json", &committed);
        assert!(std::env::var_os("HUB_OS_REPAIR_PREFLIGHT_ONLY").is_none());
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                std::env::remove_var("HUB_OS_REPAIR_PREFLIGHT_ONLY");
            }
        }
        let _reset = Reset;
        std::env::set_var("HUB_OS_REPAIR_PREFLIGHT_ONLY", original);
        let start = std::time::Instant::now();
        let returned = crate::agent_work::run_mode(&root, original, bounded(), true);
        let state = ui(&root, json!({"action":"status","id":original}));
        let after = saved(&root, original);
        let run = state["run"]["id"].as_str().unwrap();
        let account = store::records(&root, original, "nativeMaterialUsage", 1)
            .unwrap()
            .remove(0);
        save(&out, "preflight-state.json", &state);
        save(
            &out,
            "preflight-result.json",
            &json!({"error":returned.as_ref().err(),"elapsedMs":start.elapsed().as_secs_f64()*1000.0,"preflight":account["preflight"],"account":account,"providerInvocationRecords":provider_records(&root,run),"before":before,"after":after,"models":0}),
        );
        assert!(returned.unwrap_err().contains("已保存材料预检诊断"));
        assert_eq!(account["preflight"]["allowed"], true);
        assert_eq!(provider_records(&root, run), 0);
        for k in [
            "dataset",
            "chart",
            "workingState",
            "providerBudget",
            "deliveries",
            "actionCount",
        ] {
            assert_eq!(after[k], before[k], "{k}");
        }
        return;
    }

    let contract = read(out.join("model-contract.json"));
    assert_eq!(contract["modelsPermitted"], true);
    assert_eq!(contract["maximumSessions"], 2);
    assert_eq!(
        read(out.join("preflight-result.json"))["preflight"]["allowed"],
        true
    );
    let label = if phase == "recover" {
        "january"
    } else {
        "february"
    };
    if phase == "february" {
        assert_eq!(read(out.join("january-grade.json"))["passed"], true);
    }
    once(&out, &format!("{label}-started"));
    let mut id = original.to_string();
    if phase == "february" {
        let topic = read(old.join("topic-binding.json"));
        let topic = topic["topic"]["id"].as_str().unwrap();
        let question = read(old.join("scenario-inputs.json"))["3"].clone();
        let updated = ui(
            &root,
            json!({"action":"topicUpdate","topicId":topic,"expectedRevision":1,"title":"受控睡眠复核","defaultQuestion":question,"period":"2025-02","outputPreference":"无精确值明确未知，不补零，不带入1月","clientRequestId":"v5-report-resume-feb-config"}),
        );
        let revision = updated["topic"]["revision"].clone();
        let preview = ui(
            &root,
            json!({"action":"topicWorkPreview","topicId":topic,"expectedRevision":revision,"period":"2025-02"}),
        );
        save(&out, "february-preview.json", &preview);
        let made = ui(
            &root,
            json!({"action":"topicCreateWork","topicId":topic,"expectedRevision":revision,"period":"2025-02","expectedPreview":preview["fingerprint"],"confirmedScope":true,"clientRequestId":"v5-report-resume-feb-create"}),
        );
        id = made["openedWorkId"].as_str().unwrap().to_string();
        freeze_tokens(&root, &id, 1, 1);
        configure(&root, &id, &init, false);
        let p = plan(
            &root,
            &id,
            278528,
            contract["februaryOtherReplyBytes"].as_u64().unwrap() as usize,
            contract["februaryPlanBasis"].as_str().unwrap(),
        );
        set_plan(&root, &id, &p);
        save(&out, "february-plan.json", &p);
    } else {
        assert_eq!(
            before["providerBudget"]["chargedOrReserved"],
            contract["oldJanuaryChargedOrReserved"]
        );
        assert_eq!(
            before["providerBudget"]["unmeasuredRunIds"],
            contract["oldUnknownRunIds"]
        );
        assert_eq!(before["plan"], read(out.join("committed-plan.json")));
        configure(&root, original, &init, true);
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        let w = store::load(&c, original).unwrap();
        assert!(store::goal::chart_current_on(&c, &w, &before["chart"]).unwrap());
        assert!(std::env::var_os("HUB_C3_TEST_PEER").is_none());
        std::env::set_var(
            "HUB_C3_TEST_PEER",
            init["candidate"]["binary"]["path"].as_str().unwrap(),
        );
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            std::env::remove_var("HUB_C3_TEST_PEER");
        }
    }
    let _reset = Reset;
    let admission = ui(&root, json!({"action":"status","id":id}));
    assert_eq!(
        admission["lifecycle"]["providerBudget"]["canAdmitRun"],
        true
    );
    save(
        &out,
        &format!("{label}-admission.json"),
        &json!({"initialState":admission,"budget":bounded(),"candidate":init["candidate"],"task":"saved correction7.0/n2 already valid; verify same method/source/current data/chart/work record and finish missing report only","goalChange":false,"evidenceLevel":"unchanged production run_mode and native callbacks in test host; actual355 Run-owned MCP peer; not GUI or independent standalone-client acceptance"}),
    );
    let start = std::time::Instant::now();
    let returned = crate::agent_work::run_mode(&root, &id, bounded(), true);
    let state = ui(&root, json!({"action":"status","id":id}));
    save(&out, &format!("{label}-state.json"), &state);
    save(
        &out,
        &format!("{label}-return.json"),
        &json!({"ok":returned.is_ok(),"error":returned.as_ref().err(),"elapsedMs":start.elapsed().as_secs_f64()*1000.0,"sourceBytesUnchanged":format!("{:x}",Sha256::digest(std::fs::read(source).unwrap()))==init["sourceHash"].as_str().unwrap(),"sourceMtimeUnchanged":std::fs::metadata(source).unwrap().modified().unwrap()==mtime}),
    );
    save(&out, &format!("{label}-saved.json"), &saved(&root, &id));
    let topic = read(old.join("topic-binding.json"));
    save(
        &out,
        &format!("{label}-topic.json"),
        &ui(
            &root,
            json!({"action":"topicOpen","topicId":topic["topic"]["id"]}),
        ),
    );
    assert!(returned.is_ok(), "{:?}", returned.err());
}
