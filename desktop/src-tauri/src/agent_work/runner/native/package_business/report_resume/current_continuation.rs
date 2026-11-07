//! A bounded test host for the delegated357 closeout; no production entry changes.
use super::*;

#[test]
#[ignore = "frozen357 closeout: prepare once, report once, February only after report passes"]
fn v5_current_continuation_once() {
    let phase = std::env::var("HUB_V5_CURRENT_PHASE").unwrap();
    assert!(matches!(phase.as_str(), "prepare" | "january" | "february"));
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let old = desktop.join("artifacts/architecture-v5-package-business-20261028");
    let out = desktop.join("artifacts/architecture-v5-357-verification-20261028");
    let contract = read(out.join("contract.json"));
    assert_eq!(contract["candidate"]["version"], "0.16.357");
    assert_eq!(contract["maximumNewModelSessions"], 2);
    assert_eq!(contract["productionBuilds"], 0);
    assert!(
        chrono::Utc::now()
            < chrono::DateTime::parse_from_rfc3339(contract["executionDeadline"].as_str().unwrap())
                .unwrap()
    );
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(std::fs::read(out.join("contract.json")).unwrap())
        ),
        std::fs::read_to_string(out.join("contract.sha256"))
            .unwrap()
            .trim()
    );
    let root = PathBuf::from(contract["root"].as_str().unwrap());
    assert_eq!(
        root,
        desktop.join(".local/v5-package-business-20261028/profile")
    );
    assert_eq!(env!("CARGO_PKG_VERSION"), "0.16.357");
    let original = contract["workId"].as_str().unwrap();
    let init = &contract["initialization"];
    let source = Path::new(contract["sourceFile"].as_str().unwrap());
    let mtime = std::fs::metadata(source).unwrap().modified().unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(source).unwrap())),
        contract["sourceHash"].as_str().unwrap()
    );
    assert_eq!(
        mtime
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        contract["sourceMtimeNs"].as_u64().unwrap() as u128
    );
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
    assert_eq!(before["dataset"]["revision"], 2);
    assert_eq!(before["chart"]["revision"], 2);
    assert_eq!(before["workingState"]["revision"], 3);
    assert_eq!(
        before["providerBudget"]["unmeasuredRunIds"],
        contract["oldUnknownRunIds"]
    );

    if phase == "prepare" {
        once(&out, "prepare-started");
        let decision = read(out.join("budget-decision.json"));
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(std::fs::read(out.join("budget-decision.json")).unwrap())
            ),
            contract["budgetDecisionSha256"].as_str().unwrap()
        );
        assert_eq!(
            before["providerBudget"]["chargedOrReserved"],
            decision["chargedOrReservedUnchanged"]
        );
        assert_eq!(
            before["providerBudget"]["limits"],
            decision["expectedLimits"]
        );
        save(&out, "prepare-before.json", &before);
        let mut args = decision.clone();
        args["action"] = json!("extendProviderBudget");
        args["id"] = json!(original);
        ui(&root, args);
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        let w = store::load(&c, original).unwrap();
        let charts = crate::agent_work::artifacts::manifest_on(&root, &c, &w).unwrap();
        let eligible: Vec<_> = charts
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["state"] == "checked")
            .collect();
        assert_eq!(eligible.len(), 1);
        let chart = eligible[0];
        let report = json!({"expectedWorkRevision":2,"expectedAuthorizationVersion":1,"artifactId":chart["artifactId"],"artifactRevision":chart["revision"],"expectedContentHash":chart["contentHash"]});
        store::report_continuation::prepare_on(&root, &c, &w, &report).unwrap();
        drop(c);
        save(
            &out,
            "report-request.json",
            &json!({"action":"respond","id":original,"mode":"quick","reportContinuation":report}),
        );
        let after = saved(&root, original);
        assert_eq!(after["providerBudget"]["limits"], decision["limits"]);
        assert_eq!(
            after["providerBudget"]["chargedOrReserved"],
            before["providerBudget"]["chargedOrReserved"]
        );
        assert_eq!(
            after["providerBudget"]["unmeasuredRunIds"],
            before["providerBudget"]["unmeasuredRunIds"]
        );
        assert_eq!(after["providerBudget"]["canAdmitRun"], true);
        for key in [
            "work",
            "dataset",
            "chart",
            "workingState",
            "deliveries",
            "actionCount",
            "plan",
        ] {
            assert_eq!(after[key], before[key], "{key}");
        }
        save(
            &out,
            "prepare-result.json",
            &json!({"passed":true,"before":before,"after":after,"models":0,"newRuns":0,"unknownReservationsReleased":false,"prospectiveDecision":decision}),
        );
        return;
    }

    assert_eq!(contract["modelsPermitted"], true);
    assert_eq!(read(out.join("prepare-result.json"))["passed"], true);
    if phase == "february" {
        assert_eq!(read(out.join("january-grade.json"))["passed"], true);
    }
    once(&out, &format!("{phase}-started"));
    let mut id = original.to_string();
    if phase == "february" {
        let binding = read(old.join("topic-binding.json"));
        let topic = binding["topic"]["id"].as_str().unwrap();
        let question = read(old.join("scenario-inputs.json"))["3"].clone();
        let updated = ui(
            &root,
            json!({"action":"topicUpdate","topicId":topic,"expectedRevision":1,"title":"受控睡眠复核","defaultQuestion":question,"period":"2025-02","outputPreference":"无精确值明确未知，不补零，不带入1月","clientRequestId":"v5-357-feb-config-once"}),
        );
        let revision = updated["topic"]["revision"].clone();
        let preview = ui(
            &root,
            json!({"action":"topicWorkPreview","topicId":topic,"expectedRevision":revision,"period":"2025-02"}),
        );
        save(&out, "february-preview.json", &preview);
        let made = ui(
            &root,
            json!({"action":"topicCreateWork","topicId":topic,"expectedRevision":revision,"period":"2025-02","expectedPreview":preview["fingerprint"],"confirmedScope":true,"clientRequestId":"v5-357-feb-create-once"}),
        );
        id = made["openedWorkId"].as_str().unwrap().to_string();
        freeze_tokens(&root, &id, 1, 1);
        configure(&root, &id, init, false);
        let previous = read(
            desktop.join("artifacts/architecture-v5-report-resume-20261028/model-contract.json"),
        );
        let p = plan(
            &root,
            &id,
            278528,
            previous["februaryOtherReplyBytes"].as_u64().unwrap() as usize,
            previous["februaryPlanBasis"].as_str().unwrap(),
        );
        set_plan(&root, &id, &p);
        save(&out, "february-plan.json", &p);
    } else {
        configure(&root, original, init, true);
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            std::env::remove_var("HUB_C3_TEST_PEER");
        }
    }
    let _reset = Reset;
    assert!(std::env::var_os("HUB_C3_TEST_PEER").is_none());
    if phase == "january" {
        std::env::set_var(
            "HUB_C3_TEST_PEER",
            contract["candidate"]["binary"]["path"].as_str().unwrap(),
        );
    }
    let admission = ui(&root, json!({"action":"status","id":id}));
    assert_eq!(
        admission["lifecycle"]["providerBudget"]["canAdmitRun"],
        true
    );
    let budget = bounded();
    save(
        &out,
        &format!("{phase}-admission.json"),
        &json!({"initialState":admission,"budget":budget,"candidate":contract["candidate"],"evidenceLevel":"formal production host entry in cfg(test) executable; January actual357 MCP peer; not native click or independent external client"}),
    );
    let args = (phase == "january").then(|| read(out.join("report-request.json")));
    let start = std::time::Instant::now();
    let returned = crate::agent_work::run_mode_app(&root, &id, budget, true, None, args.as_ref());
    let state = ui(&root, json!({"action":"status","id":id}));
    save(&out, &format!("{phase}-state.json"), &state);
    save(&out, &format!("{phase}-saved.json"), &saved(&root, &id));
    save(
        &out,
        &format!("{phase}-return.json"),
        &json!({"ok":returned.is_ok(),"error":returned.as_ref().err(),"elapsedMs":start.elapsed().as_secs_f64()*1000.0,"sourceBytesUnchanged":format!("{:x}",Sha256::digest(std::fs::read(source).unwrap()))==contract["sourceHash"].as_str().unwrap(),"sourceMtimeUnchanged":std::fs::metadata(source).unwrap().modified().unwrap()==mtime}),
    );
    assert!(returned.is_ok(), "{:?}", returned.err());
}
