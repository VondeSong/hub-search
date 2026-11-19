use super::*;

#[test]
#[ignore = "requires an existing authorized daily schedule conversation"]
fn daily_existing_schedule() {
    let config: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("HUB_ROADMAP_SCHEDULE_ACCEPTANCE").unwrap()).unwrap(),
    )
    .unwrap();
    let root = Path::new(config["root"].as_str().unwrap());
    let id = config["workId"].as_str().unwrap();
    let before = store::view(root, id).unwrap();
    let count = || {
        store::records(root, id, "conditionTrigger", 10)
            .unwrap()
            .len()
    };
    let trigger_count = count();
    let configure = |due| {
        ui(
            root,
            &json!({"action":"configureWatch","id":id,"confirmed":true,
            "onChange":false,"notify":true,"repeatDays":7,"scanLibraries":true,"dueAt":due}),
        )
        .unwrap()
    };
    let result = match config["action"].as_str().unwrap() {
        "configure" => configure(config["dueAt"].as_i64().unwrap()),
        "pause" => ui(root, &json!({"action":"pauseWatch","id":id})).unwrap(),
        "missingCredentials" => {
            assert_eq!(before["watch"]["enabled"], false);
            assert_eq!(
                crate::model_runtime::ui(root, &json!({"action":"credentialStatus"})).unwrap()
                    ["deepseekConfigured"],
                false
            );
            let previous = &before["assistantOptions"];
            let mut unavailable = previous.clone();
            unavailable["model"] = json!({"provider":"deepseek","model":"deepseek-chat","reasoningEffort":"","fast":false,"maxConcurrent":2});
            // A saved selection can outlive its key. Simulate that state on
            // this acceptance conversation without touching the actual keyring.
            store::write(root, |c| {
                store::insert(c, id, None, "assistantOptions", &unavailable)
            })
            .unwrap();
            let due = chrono::Utc::now().timestamp_millis() + 11_000;
            configure(due);
            while chrono::Utc::now().timestamp_millis() < due {
                std::thread::sleep(Duration::from_millis(100));
            }
            condition_tick(root).unwrap();
            let after = store::view(root, id).unwrap();
            options::configure(root, &json!({"id":id,"options":previous})).unwrap();
            assert_eq!(after["watch"]["enabled"], false);
            assert!(after["watch"]["message"].as_str().unwrap().contains("密钥"));
            assert_eq!(after["watch"]["dueAt"], due);
            assert_eq!(after["work"]["report"], before["work"]["report"]);
            assert_eq!(count(), trigger_count);
            after
        }
        action => panic!("Unsupported acceptance step {action}"),
    };
    std::fs::write(
        config["output"].as_str().unwrap(),
        serde_json::to_vec_pretty(&json!({"watch":result["watch"],"triggerCount":count()}))
            .unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "requires exact authorized notes from the daily library and real Codex"]
fn daily_goal_and_review() {
    let config: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("HUB_ROADMAP_ACCEPTANCE").unwrap()).unwrap(),
    )
    .unwrap();
    let root = Path::new(config["root"].as_str().unwrap());
    let output = Path::new(config["output"].as_str().unwrap());
    let mut results = Vec::new();
    for case in config["cases"].as_array().unwrap() {
        let view = ui(
            root,
            &json!({"action":"create","goal":case["goal"],"successCriteria":case["criteria"],"grant":Grant::default()}),
        ).unwrap();
        let id = view["work"]["id"].as_str().unwrap();
        ui(root, &json!({"action":"message","id":id,"text":case["goal"],
            "clientMessageId":crate::random_url_safe(12),"expectedRevision":view["work"]["revision"],
            "addNotes":case["grant"]["notes"],"setLibraryIds":case["grant"]["libraryIds"]})).unwrap();
        options::configure(root, &json!({"id":id,"options":case["options"]})).unwrap();
        let start = std::time::Instant::now();
        let result = ui(
            root,
            &json!({"action":"respond","id":id,"mode":"deep","goalMode":case["options"]["goalMode"] == true}),
        );
        let view = store::view(root, id).unwrap();
        let schedule = if case["schedule"] == true {
            assert!(result.is_ok(), "{:?}", result.as_ref().err());
            run_schedule(root, id)
        } else {
            Value::Null
        };
        results.push(json!({"name":case["name"],"workId":id,"seconds":start.elapsed().as_secs_f64(),"schedule":schedule,
            "view":view,"result":result.as_ref().err(),"review":store::records(root,id,"knowledgeReview",5).unwrap(),
            "rounds":store::records(root,id,"goalModePass",5).unwrap()}));
        std::fs::write(output, serde_json::to_vec_pretty(&results).unwrap()).unwrap();
        assert!(result.is_ok(), "{:?}", result.err());
    }
}

fn run_schedule(root: &Path, id: &str) -> Value {
    let now = || chrono::Utc::now().timestamp_millis();
    let watch_before = store::records(root, id, "conditionTrigger", 5)
        .unwrap()
        .len();
    let set = |due| {
        ui(
            root,
            &json!({"action":"configureWatch","id":id,"confirmed":true,
        "onChange":false,"notify":true,"repeatDays":7,"scanLibraries":true,"dueAt":due}),
        )
        .unwrap()
    };
    set(now() + 60_000);
    let due = now() + 12_000;
    assert_eq!(set(due)["watch"]["dueAt"], due);
    condition_tick(root).unwrap();
    assert_eq!(
        store::records(root, id, "conditionTrigger", 5)
            .unwrap()
            .len(),
        watch_before
    );
    while now() < due {
        std::thread::sleep(Duration::from_millis(150));
    }
    // The scheduler can check at most once per minute when a prior check ran.
    let deadline = std::time::Instant::now() + Duration::from_secs(75);
    while std::time::Instant::now() < deadline {
        condition_tick(root).unwrap();
        if store::records(root, id, "conditionTrigger", 5)
            .unwrap()
            .len()
            > watch_before
        {
            break;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    let view = store::view(root, id).unwrap();
    let triggers = store::records(root, id, "conditionTrigger", 5).unwrap();
    let paused = ui(root, &json!({"action":"pauseWatch","id":id})).unwrap();
    condition_tick(root).unwrap();
    json!({"watch":view["watch"],"run":view["run"],"workState":view["work"]["state"],"triggers":triggers,
        "paused":paused["watch"],"triggersAfterPause":store::records(root,id,"conditionTrigger",5).unwrap().len()})
}
