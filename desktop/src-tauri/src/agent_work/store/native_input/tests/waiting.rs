use super::*;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub(super) fn save(path: &Path, value: &Value) {
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
pub(super) fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
pub(super) fn reopened_fixture(root: &Value) -> Fixture {
    let root = PathBuf::from(root.as_str().unwrap());
    let resolved = root.canonicalize().unwrap();
    assert_eq!(
        resolved.parent(),
        Some(std::env::temp_dir().canonicalize().unwrap().as_path())
    );
    assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("hub-evidence-"));
    Fixture { root }
}
pub(super) fn snapshot(root: &Path, id: &str) -> Value {
    let mut out = json!({"view":crate::agent_work::ui(root,&json!({"action":"status","id":id}))});
    for kind in [
        "nativeFinal",
        "nativeResponseDelivery",
        "nativeUserInput",
        "nativeInputState",
        "nativeTurn",
        "steering",
        "steeringAccepted",
        "modelExecution",
        "nativeMeasurement",
        "providerBudgetReservation",
        "providerBudgetObservation",
        "executionBudgetReservation",
    ] {
        out[kind] = json!(records(root, id, kind, 32).unwrap());
    }
    out["runCount"] = json!(read(root)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap());
    out
}

#[test]
#[ignore = "subprocess fixture writer only; no model or user library"]
fn core_wait_saved_restart_child() {
    let path = PathBuf::from(std::env::var_os("HUB_WAIT_SAVED_RESTART").unwrap());
    let (f, work, run, request) = setup();
    respond(&f.root, &args(&work, &run, &request)).unwrap();
    save(
        &path,
        &json!({"root":f.root,"work":work.id,"run":run,"request":request}),
    );
    // Exit without Drop to exercise durable recovery in a fresh process.
    std::process::exit(77);
}

#[test]
fn core_wait_saved_answer_survives_process_exit_without_replaying_old_request() {
    let output = std::env::temp_dir().join(format!(
        "hub-input-restart-{}.json",
        crate::random_url_safe(10)
    ));
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "core_wait_saved_restart_child",
            "--ignored",
            "--test-threads=1",
        ])
        .env("HUB_WAIT_SAVED_RESTART", &output);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let result = command.output().unwrap();
    assert_eq!(result.status.code(), Some(77));
    let saved = read_json(&output);
    let f = reopened_fixture(&saved["root"]);
    let id = saved["work"].as_str().unwrap();
    let run = saved["run"].as_str().unwrap();
    let before = snapshot(&f.root, id);
    assert_eq!(before["view"]["Ok"]["work"]["state"], "interrupted");
    assert_eq!(before["view"]["Ok"]["nativeInputs"][0]["state"], "closed");
    assert_eq!(before["nativeInputState"].as_array().unwrap().len(), 1);
    let w = load(&read(&f.root).unwrap(), id).unwrap();
    assert!(conversation::context(&f.root, &w)
        .unwrap()
        .to_string()
        .contains("回答：是"));
    assert!(respond(&f.root, &args(&w, run, &saved["request"])).is_err());
    let resumed = claim(&f.root, id, "after-process-restart").unwrap();
    assert_eq!(
        ready(
            &f.root,
            &resumed,
            "after-process-restart",
            &json!({"threadId":"new","turnId":"new"})
        )
        .unwrap(),
        json!([])
    );
    assert!(conversation::context(&f.root, &resumed)
        .unwrap()
        .to_string()
        .contains("回答：是"));
    assert_eq!(records(&f.root, id, "steering", 32).unwrap().len(), 1);
    assert_eq!(
        records(&f.root, id, "nativeInputState", 32).unwrap(),
        before["nativeInputState"].as_array().unwrap().clone()
    );
    if let Some(path) = std::env::var_os("HUB_WAIT_OFFLINE_REPORT") {
        save(
            Path::new(&path),
            &json!({"before":before,"after":snapshot(&f.root,id),"oldReplyRejected":true,"oldRequestNotReplayed":true,"childExit":77}),
        );
    }
    std::fs::remove_file(output).unwrap();
}

#[test]
#[ignore = "explicit isolated real-model waiting/stop/process-exit/reopen scenario; no automatic retries"]
fn core_wait_live_scenario() {
    let out =
        PathBuf::from(std::env::var_os("HUB_WAIT_OUTPUT").expect("explicit output directory"));
    let mode = std::env::var("HUB_WAIT_MODE").unwrap();
    assert!(["timeout", "stop", "crash", "reopen"].contains(&mode.as_str()));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join(format!("{mode}.started")))
        .unwrap();
    if mode == "reopen" {
        let saved = read_json(&out.join("crash.json"));
        let f = reopened_fixture(&saved["root"]);
        let id = saved["workId"].as_str().unwrap();
        let before = snapshot(&f.root, id);
        save(&out.join("reopen-before.json"), &before);
        assert_eq!(before["view"]["Ok"]["work"]["state"], "interrupted");
        assert_eq!(before["view"]["Ok"]["nativeInputs"][0]["state"], "closed");
        let request = &saved["pending"];
        let w = load(&read(&f.root).unwrap(), id).unwrap();
        let old = crate::agent_work::ui(
            &f.root,
            &json!({"action":"answerNativeInput","id":id,"runId":request["runId"],"key":request["key"],"expectedRevision":w.revision,"expectedAuthorizationVersion":w.authorization_version,"answers":{},"cancel":true}),
        );
        assert!(old.is_err());
        crate::agent_work::ui(&f.root,&json!({"action":"message","id":id,"clientMessageId":"explicit-answer-after-restart","expectedRevision":w.revision,"text":"刚才等待回答时程序退出了。我的可用时间是19:00–20:00，请明确继续原来的学习安排，直接给出两段各30分钟的安排，不需要再问时间。"})).unwrap();
        let saved_message = snapshot(&f.root, id);
        assert_eq!(saved_message["runCount"], 1);
        let start = Instant::now();
        let result =
            crate::agent_work::ui(&f.root, &json!({"action":"respond","id":id,"mode":"quick"}));
        let after = snapshot(&f.root, id);
        save(
            &out.join("reopen.json"),
            &json!({"result":result,"seconds":start.elapsed().as_secs_f64(),"before":before,"after":after,"oldReplyRejected":true,"messageAloneDidNotDispatch":true}),
        );
        result.unwrap();
        assert_eq!(after["view"]["Ok"]["work"]["state"], "completed");
        assert_eq!(after["runCount"], 2);
        assert_eq!(after["nativeUserInput"], before["nativeUserInput"]);
        assert_eq!(after["nativeInputState"], before["nativeInputState"]);
        assert_eq!(after["steering"], json!([]));
        assert_eq!(after["steeringAccepted"], json!([]));
        let report = after["view"]["Ok"]["work"]["report"].to_string();
        for t in ["19:00", "19:30", "20:00"] {
            assert!(report.contains(t));
        }
        assert_eq!(after["view"]["Ok"]["actions"]["items"], json!([]));
        return;
    }
    let f = Fixture::new();
    let created=crate::agent_work::ui(&f.root,&json!({"action":"create","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]},
        "goal":"帮我安排明天的一小时学习，主题是复习今天学过的内容。我还没有告诉你可用时间段。请先用原生request_user_input询问时间段，允许自行填写；收到回答前不要假设时间或交付安排。收到回答后给出两段各30分钟的简短安排。不要读取资料、联网、创建任务或保存笔记。","successCriteria":"使用用户明确给出的时间，完成两段学习安排；缺时间先询问"})).unwrap();
    let id = created["work"]["id"].as_str().unwrap().to_owned();
    crate::agent_work::options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    crate::agent_work::ui(&f.root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"expectedAuthorizationVersion":1,
        "limits":{"inputTokens":400000,"uncachedInputTokens":400000,"outputTokens":24000},"perRun":{"inputTokens":200000,"uncachedInputTokens":200000,"outputTokens":12000},"unknownReservations":{}})).unwrap();
    let budget = crate::agent_work::Budget::mode("quick").unwrap();
    let root = f.root.clone();
    let work_id = id.clone();
    let start = Instant::now();
    let worker =
        std::thread::spawn(move || crate::agent_work::run_mode(&root, &work_id, budget, true));
    let mut pending = Value::Null;
    let mut observed = None;
    let mut stop_result = Value::Null;
    let mut stopped = None;
    while !worker.is_finished() && start.elapsed() < Duration::from_secs(100) {
        let c = read(&f.root).unwrap();
        let w = load(&c, &id).unwrap();
        let qs = view_on(&c, &w).unwrap();
        drop(c);
        if pending.is_null() {
            if let Some(q) = qs
                .as_array()
                .into_iter()
                .flatten()
                .find(|q| q["state"] == "pending")
            {
                pending = q.clone();
                observed = Some(Instant::now());
                save(&out.join(format!("{mode}-pending.json")), &pending);
            }
        }
        if observed.is_some_and(|at| at.elapsed() >= Duration::from_secs(3)) {
            if mode == "crash" {
                save(
                    &out.join("crash.json"),
                    &json!({"root":f.root,"workId":id,"pending":pending,"waitingSeconds":observed.unwrap().elapsed().as_secs_f64(),"snapshot":snapshot(&f.root,&id),"pid":std::process::id()}),
                );
                std::process::exit(77);
            }
            if mode == "stop" && stopped.is_none() {
                let view =
                    crate::agent_work::ui(&f.root, &json!({"action":"status","id":id})).unwrap();
                stopped = Some(Instant::now());
                stop_result = json!(crate::agent_work::ui(
                    &f.root,
                    &json!({"action":"cancel","id":id,"commandId":"stop-while-awaiting-answer","expectedWorkRevision":w.revision,"expectedControlRevision":view["lifecycle"]["controlRevision"],"expectedRunId":w.active_run})
                ));
            }
        }
        std::thread::sleep(Duration::from_millis(75));
    }
    if !worker.is_finished() {
        panic!(
            "scenario exceeded bounded observation; external runner must terminate owned process"
        );
    }
    let result = worker.join().unwrap();
    let after = snapshot(&f.root, &id);
    save(
        &out.join(format!("{mode}.json")),
        &json!({"result":result,"pending":pending,"seconds":start.elapsed().as_secs_f64(),"waitingSeconds":observed.map(|v|v.elapsed().as_secs_f64()),"stopSeconds":stopped.map(|v|v.elapsed().as_secs_f64()),"stopResult":stop_result,"after":after}),
    );
    assert!(
        !pending.is_null(),
        "model did not ask before the scenario ended"
    );
    assert!(result.is_err());
    assert_eq!(after["runCount"], 1);
    assert_eq!(after["view"]["Ok"]["nativeInputs"][0]["state"], "closed");
    assert_eq!(after["nativeInputState"], json!([]));
    assert_eq!(after["steering"], json!([]));
    assert_eq!(after["view"]["Ok"]["work"]["report"], Value::Null);
    let w = load(&read(&f.root).unwrap(), &id).unwrap();
    assert!(crate::agent_work::ui(&f.root,&json!({"action":"answerNativeInput","id":id,"runId":pending["runId"],"key":pending["key"],"expectedRevision":w.revision,"expectedAuthorizationVersion":w.authorization_version,"answers":{},"cancel":true})).is_err());
    if mode == "timeout" {
        assert!(result.unwrap_err().contains("超时"));
        assert!(observed.unwrap().elapsed() >= Duration::from_secs(5));
        assert_eq!(w.state, "interrupted");
    } else {
        assert!(stop_result.get("Ok").is_some());
        assert_eq!(w.state, "paused");
        assert!(stopped.unwrap().elapsed() < Duration::from_secs(5));
    }
}
