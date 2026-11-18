//! Opt-in production-path acceptance against an explicitly selected personal copy.
use super::*;

#[test]
#[ignore = "real provider; requires explicit config and writes only new conversations/drafts in the selected profile"]
fn live_native_flow_acceptance() {
    let config = std::env::var("HUB_NATIVE_FLOW_CONFIG").expect("explicit config required");
    let config: Value = serde_json::from_slice(&std::fs::read(config).unwrap()).unwrap();
    run_native_flow(config);
}

#[test]
#[ignore = "explicit real daily-root batch and fixed candidate configuration; source reads and fresh chats only"]
fn live_native_version_comparison() {
    let path = std::env::var("HUB_COMPARE_CONFIG").expect("explicit comparison configuration");
    let config: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for case in config["cases"]
        .as_array()
        .expect("fixed nonempty case list")
    {
        run_native_flow(case.clone());
    }
}

fn run_native_flow(config: Value) {
    let root = Path::new(config["root"].as_str().unwrap());
    let output = Path::new(config["output"].as_str().unwrap());
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output.with_extension("started"))
        .unwrap();
    assert!(root.join("craft-search.sqlite3").is_file());
    let grant: Grant = serde_json::from_value(config["grant"].clone()).unwrap();
    let prompts = config["prompts"].as_array().unwrap();
    let created = crate::agent_work::ui(
        root,
        &json!({"action":"create",
        "goal":prompts[0],"successCriteria":"","anchor":config["anchor"],"grant":grant}),
    )
    .unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    options::configure(root, &json!({"id":id,"options":config["options"]})).unwrap();
    let mut turns = Vec::new();
    for (index, prompt) in prompts.iter().enumerate() {
        if index > 0 {
            let before = store::view(root, id).unwrap();
            let notes = config["attachmentsByTurn"]
                .get(index)
                .cloned()
                .unwrap_or(json!([]));
            crate::agent_work::ui(root, &json!({"action":"message","id":id,
                "expectedRevision":before["work"]["revision"],
                "addNotes":notes,"clientMessageId":format!("flow-{}-{index}",crate::random_url_safe(8)),"text":prompt})).unwrap();
        }
        let started = std::time::Instant::now();
        let result = crate::agent_work::ui(
            root,
            &json!({"action":"respond","id":id,"mode":config["mode"].as_str().unwrap_or("quick")}),
        );
        let view = store::view(root, id).unwrap();
        let mut records = serde_json::Map::new();
        for kind in [
            "nativeResponseDelivery",
            "nativeCitationBinding",
            "nativeFinal",
            "modelExecution",
            "nativeMaterialUsage",
            "toolCall",
            "reportRejected",
            "agentStream",
            "nativeMeasurement",
            "selectedDataRead",
            "analysisInspection",
        ] {
            records.insert(
                kind.into(),
                json!(store::records(root, id, kind, 200).unwrap()),
            );
        }
        turns.push(
            json!({"prompt":prompt,"elapsedMs":started.elapsed().as_millis(),
            "result":result,"view":view,"records":records}),
        );
        std::fs::write(
            output,
            serde_json::to_vec_pretty(&json!({"workId":id,"turns":turns})).unwrap(),
        )
        .unwrap();
        result.unwrap();
        if let Some(expected) = config["expectedTools"].get(index) {
            let actual: Vec<_> = records["toolCall"]
                .as_array()
                .unwrap()
                .iter()
                .map(|call| json!({"operation":call["operation"],"name":call["name"]}))
                .collect();
            assert_eq!(
                json!(actual),
                *expected,
                "unexpected Hub tool routing on turn {}",
                index + 1
            );
        }
        assert!(view["work"]["report"]["prose"]["markdown"]
            .as_str()
            .is_some_and(|s| !s.is_empty()));
        if config["expectNative"] == true {
            assert_eq!(
                records["nativeResponseDelivery"].as_array().unwrap().len(),
                index + 1
            );
        }
        if config["expectCitations"] == true {
            assert!(!view["work"]["report"]["prose"]["citations"]
                .as_array()
                .unwrap()
                .is_empty());
        }
    }
}

/// Explicit, isolated production-action acceptance; never accepts an original vault.
#[test]
#[ignore = "explicit copied vault, existing Work, real recovery and local save acceptance"]
fn live_native_recovery_and_save_acceptance() {
    let config = std::env::var("HUB_NATIVE_FLOW_CONFIG").unwrap();
    let config: Value = serde_json::from_slice(&std::fs::read(config).unwrap()).unwrap();
    let root = Path::new(config["root"].as_str().unwrap())
        .canonicalize()
        .unwrap();
    let output = Path::new(config["output"].as_str().unwrap());
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output.with_extension("started"))
        .unwrap();
    let id = config["workId"].as_str().unwrap();
    let target = Path::new(config["target"].as_str().unwrap())
        .canonicalize()
        .unwrap();
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let mut q = c
        .prepare("SELECT location FROM libraries WHERE enabled=1")
        .unwrap();
    for location in q.query_map([], |r| r.get::<_, String>(0)).unwrap() {
        assert!(Path::new(&location.unwrap())
            .canonicalize()
            .unwrap()
            .starts_with(root.join("vault")));
    }
    assert!(target.starts_with(root.join("vault")));
    drop(q);
    drop(c);
    let before = std::fs::read(&target).unwrap();
    let mut results = Vec::new();
    let call = |args: Value| crate::agent_work::ui(&root, &args);
    for action in config["actions"].as_array().unwrap() {
        let action = action.as_str().unwrap();
        let view = call(json!({"action":"status","id":id})).unwrap();
        let mut args = json!({"action":action,"id":id});
        match action {
            "cancel" | "resume" => {
                let control = &view["lifecycle"];
                args["commandId"] = json!(format!("closeout-{}", crate::random_url_safe(12)));
                args["expectedControlRevision"] = control["controlRevision"].clone();
                args["expectedWorkRevision"] = control["workRevision"].clone();
                args["expectedRunId"] = control["activeRunId"].clone();
                args["mode"] = json!("quick");
            }
            "prepareObsidianReportSave" | "status" | "respond" => {}
            "submitObsidianEdit" | "inspectObsidianEdit" => {
                let items = view["actions"]["items"].as_array().unwrap();
                let item = items.iter().find(|a| a["kind"] == "obsidianEdit").unwrap();
                args["actionId"] = item["id"].clone();
                args["confirmationToken"] = item["confirmationToken"].clone();
            }
            _ => panic!("unsupported acceptance action"),
        }
        let started = std::time::Instant::now();
        let result = call(args.clone());
        results.push(
            json!({"action":action,"elapsedMs":started.elapsed().as_millis(),"result":result}),
        );
        std::fs::write(
            output,
            serde_json::to_vec_pretty(&json!({"workId":id,"results":results})).unwrap(),
        )
        .unwrap();
        let reply = result.unwrap();
        if action == "submitObsidianEdit" {
            assert_ne!(std::fs::read(&target).unwrap(), before);
            let after = std::fs::read(&target).unwrap();
            // The same confirmed command must be idempotent, including file bytes.
            call(args).unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), after);
            assert!(reply["actions"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["state"] == "verified"));
        } else if matches!(action, "resume" | "respond") {
            assert!(!reply["work"]["report"]["prose"]["markdown"]
                .as_str()
                .unwrap()
                .is_empty());
        }
    }
}
