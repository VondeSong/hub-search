use super::waiting::{read_json, reopened_fixture, save, snapshot};
use super::*;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

#[test]
#[ignore = "explicit Plan-mode protocol qualification and owned-process fault injection; no user library"]
fn core_blocking_live_scenario() {
    let out = PathBuf::from(
        std::env::var_os("HUB_BLOCKING_OUTPUT").expect("explicit evidence directory"),
    );
    let mode = std::env::var("HUB_BLOCKING_MODE").unwrap();
    assert!(["answer", "crash", "reopen"].contains(&mode.as_str()));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(out.join(format!("{mode}.started")))
        .unwrap();
    if mode == "reopen" {
        let marker = read_json(&out.join("kill-ready.json"));
        let f = reopened_fixture(&marker["root"]);
        let id = marker["workId"].as_str().unwrap();
        let before = snapshot(&f.root, id);
        save(&out.join("reopen-before.json"), &before);
        assert_eq!(before["view"]["Ok"]["work"]["state"], "interrupted");
        assert_eq!(before["view"]["Ok"]["nativeInputs"][0]["state"], "closed");
        assert_eq!(before["steering"].as_array().unwrap().len(), 1);
        let w = load(&read(&f.root).unwrap(), id).unwrap();
        let context = conversation::context(&f.root, &w).unwrap();
        assert!(context.to_string().contains("18:00–19:00"));
        assert!(crate::agent_work::ui(&f.root, &marker["answerCommand"]).is_err());
        assert!(before["view"]["Ok"]["work"]["report"].is_null());
        // No new answer or message: only the already durable reply may supply the time.
        let start = Instant::now();
        let result =
            crate::agent_work::ui(&f.root, &json!({"action":"respond","id":id,"mode":"quick"}));
        let after = snapshot(&f.root, id);
        save(
            &out.join("reopen.json"),
            &json!({"result":result,"before":before,"after":after,"seconds":start.elapsed().as_secs_f64(),"restoredContext":context,"newAnswerSubmitted":false}),
        );
        result.unwrap();
        assert_eq!(after["view"]["Ok"]["work"]["state"], "completed");
        assert_eq!(after["runCount"], 2);
        assert_eq!(after["steering"], before["steering"]);
        assert_eq!(after["nativeUserInput"], before["nativeUserInput"]);
        assert_eq!(after["nativeInputState"], before["nativeInputState"]);
        let report = after["view"]["Ok"]["work"]["report"].to_string();
        for t in ["18:00", "18:30", "19:00"] {
            assert!(report.contains(t));
        }
        assert_eq!(after["view"]["Ok"]["actions"]["items"], json!([]));
        return;
    }
    let f = Fixture::new();
    let created=crate::agent_work::ui(&f.root,&json!({"action":"create","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]},
        "goal":"请规划明天的一小时复习。你还不知道我可用的时间段，先使用原生request_user_input只问这一个缺失信息，允许自行填写。收到回答前不要假设时间。收到后直接给出两段各30分钟的简短安排并结束，不再追问或请求批准实施；本任务仅需计划文本。不要读资料、联网、创建任务或保存笔记。","successCriteria":"只询问缺失时间；采用随后提供的时间交付两段计划，无业务动作"})).unwrap();
    let id = created["work"]["id"].as_str().unwrap().to_owned();
    crate::agent_work::options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    crate::agent_work::ui(&f.root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"expectedAuthorizationVersion":1,
        "limits":{"inputTokens":400000,"uncachedInputTokens":400000,"outputTokens":24000},"perRun":{"inputTokens":200000,"uncachedInputTokens":200000,"outputTokens":12000},"unknownReservations":{}})).unwrap();
    std::env::set_var(
        "HUB_TEST_PLAN_DIRECTORY",
        f.root.join("agent-runtime").join(&id),
    );
    let root = f.root.clone();
    let work_id = id.clone();
    let start = Instant::now();
    let worker = std::thread::spawn(move || {
        crate::agent_work::ui(
            &root,
            &json!({"action":"respond","id":work_id,"mode":"quick"}),
        )
    });
    let mut pending = Value::Null;
    let mut observed = None;
    let mut ack = Value::Null;
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
        if ack.is_null() && observed.is_some_and(|t| t.elapsed() >= Duration::from_secs(2)) {
            assert_eq!(
                pending["isBlocking"], true,
                "official runtime must supply the blocking flag"
            );
            let questions = pending["questions"].as_array().unwrap();
            assert_eq!(questions.len(), 1);
            let q = &questions[0];
            assert_eq!(q["isOther"], true);
            let key = q["id"].as_str().unwrap();
            let answer = if mode == "crash" {
                "18:00–19:00"
            } else {
                "19:00–20:00"
            };
            let command = json!({"action":"answerNativeInput","id":id,"runId":pending["runId"],"key":pending["key"],"expectedRevision":w.revision,"expectedAuthorizationVersion":w.authorization_version,"answers":{(key):answer},"cancel":false});
            ack = crate::agent_work::ui(&f.root, &command).unwrap();
            assert_eq!(ack["saved"], true);
            if mode == "crash" {
                let state = snapshot(&f.root, &id);
                assert_eq!(state["view"]["Ok"]["work"]["state"], "investigating");
                assert!(!worker.is_finished());
                save(
                    &out.join("kill-ready.tmp"),
                    &json!({"root":f.root,"workId":id,"pid":std::process::id(),"pending":pending,"ack":ack,"answerCommand":command,"snapshot":state}),
                );
                std::fs::rename(out.join("kill-ready.tmp"), out.join("kill-ready.json")).unwrap();
                // The controller terminates only this exact spawned test process.
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        worker.is_finished(),
        "bounded scenario did not return; controller owns cleanup"
    );
    let result = worker.join().unwrap();
    let after = snapshot(&f.root, &id);
    save(
        &out.join("answer.json"),
        &json!({"result":result,"pending":pending,"ack":ack,"seconds":start.elapsed().as_secs_f64(),"after":after}),
    );
    result.unwrap();
    assert_eq!(pending["isBlocking"], true);
    assert_eq!(after["runCount"], 1);
    assert_eq!(after["nativeTurn"].as_array().unwrap().len(), 1);
    assert_eq!(after["view"]["Ok"]["work"]["state"], "completed");
    assert_eq!(after["steering"].as_array().unwrap().len(), 1);
    assert_eq!(after["steeringAccepted"], json!([]));
    for state in ["answered", "sent", "resolved"] {
        assert!(after["nativeInputState"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["state"] == state));
    }
    let report = after["view"]["Ok"]["work"]["report"].to_string();
    for t in ["19:00", "19:30", "20:00"] {
        assert!(report.contains(t));
    }
    assert_eq!(after["view"]["Ok"]["actions"]["items"], json!([]));
    assert_eq!(after["view"]["Ok"]["evidence"], json!([]));
}
