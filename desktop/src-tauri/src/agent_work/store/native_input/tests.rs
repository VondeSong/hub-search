use super::*;
use crate::source_evidence::tests::Fixture;

mod blocking;
mod waiting;

#[test]
#[ignore = "one explicitly authorized real-model native question, synthetic answer, no source or business access"]
fn core_input_live_question_answer_continue() {
    let output = std::path::PathBuf::from(
        std::env::var("HUB_LIVE_INPUT_REPORT").expect("explicit report path"),
    );
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output.with_extension("started"))
        .unwrap();
    let f = Fixture::new();
    let created=crate::agent_work::ui(&f.root,&json!({"action":"create","anchor":null,
        "grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]},
        "goal":"帮我安排明天的一小时学习，主题是复习今天学过的内容。我还没告诉你可用的时间段。请先用原生 request_user_input 结构化提问询问时间段，允许自行填写；不要自行假设时间，也不要仅用普通文字提问。只问这个问题。收到回答后，按该时段给出两段各30分钟的简短安排并结束。不要读取资料、联网、创建任务或保存笔记。",
        "successCriteria":"真实结构化提问；使用用户随后提供的时间；同轮交付两段学习安排，无业务动作"})).unwrap();
    let id = created["work"]["id"].as_str().unwrap().to_string();
    crate::agent_work::options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    crate::agent_work::ui(&f.root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"expectedAuthorizationVersion":1,
        "limits":{"inputTokens":200000,"uncachedInputTokens":200000,"outputTokens":12000},
        "perRun":{"inputTokens":200000,"uncachedInputTokens":200000,"outputTokens":12000},"unknownReservations":{}})).unwrap();
    let root = f.root.clone();
    let work_id = id.clone();
    let start = std::time::Instant::now();
    let worker = std::thread::spawn(move || {
        crate::agent_work::ui(
            &root,
            &json!({"action":"respond","id":work_id,"mode":"quick"}),
        )
    });
    let mut pending = Value::Null;
    let mut acknowledgment = Value::Null;
    let mut answer_error: Option<String> = None;
    while !worker.is_finished() && start.elapsed() < std::time::Duration::from_secs(180) {
        let observed = (|| -> Result<(), String> {
            let c = read(&f.root)?;
            let work = load(&c, &id)?;
            let questions = view_on(&c, &work)?;
            drop(c);
            if pending.is_null() {
                if let Some(request) = questions
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|q| q["state"] == "pending")
                {
                    pending = request.clone();
                    std::fs::write(
                        output.with_extension("pending.json"),
                        serde_json::to_vec_pretty(&pending).unwrap(),
                    )
                    .map_err(|e| e.to_string())?;
                    let qs = request["questions"].as_array().ok_or("missing questions")?;
                    if qs.len() != 1 {
                        return Err("expected one time-slot question".into());
                    }
                    let q = &qs[0];
                    let key = q["id"].as_str().ok_or("missing question id")?;
                    let answer = if q["isOther"] == true
                        || q["options"].as_array().is_none_or(|a| a.is_empty())
                    {
                        "19:00–20:00".to_owned()
                    } else {
                        q["options"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter_map(|o| o["label"].as_str())
                            .find(|s| s.contains("19:00") && s.contains("20:00"))
                            .ok_or("model did not allow the synthetic time-slot answer")?
                            .to_owned()
                    };
                    acknowledgment = crate::agent_work::ui(
                        &f.root,
                        &json!({"action":"answerNativeInput","id":id,"runId":request["runId"],"key":request["key"],
                        "expectedRevision":work.revision,"expectedAuthorizationVersion":work.authorization_version,"answers":{(key):answer},"cancel":false}),
                    )?;
                    std::fs::write(
                        output.with_extension("ack.json"),
                        serde_json::to_vec_pretty(&acknowledgment).unwrap(),
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        })();
        if let Err(error) = observed {
            answer_error = Some(error);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if !worker.is_finished() {
        let _ = crate::agent_work::ui(&f.root, &json!({"action":"cancel","id":id}));
    }
    let result = worker
        .join()
        .unwrap_or_else(|_| Err("model worker panicked".into()));
    let view = super::super::view(&f.root, &id);
    let mut evidence = json!({"workId":id,"seconds":start.elapsed().as_secs_f64(),"pending":pending,"acknowledgment":acknowledgment,
        "answerError":answer_error,"result":result,"view":view,"syntheticAnswer":true,"desktopOperations":0});
    for kind in [
        "nativeUserInput",
        "nativeInputState",
        "nativeTurn",
        "steering",
        "steeringAccepted",
        "nativeProtocol",
        "agentStream",
        "toolCall",
        "delivery",
        "modelExecution",
        "nativeMaterialUsage",
    ] {
        evidence[kind] = json!(records(&f.root, &id, kind, 100).unwrap());
    }
    let count: i64 = read(&f.root)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE work_id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    evidence["runCount"] = json!(count);
    std::fs::write(&output, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    result.unwrap();
    assert!(answer_error.is_none(), "{answer_error:?}");
    assert_eq!(count, 1);
    assert_eq!(acknowledgment["saved"], true);
    assert_eq!(pending["state"], "pending");
    let view = view.unwrap();
    assert_eq!(view["work"]["state"], "completed");
    assert_eq!(evidence["nativeUserInput"].as_array().unwrap().len(), 1);
    assert_eq!(evidence["nativeTurn"].as_array().unwrap().len(), 1);
    for state in ["answered", "sent", "resolved"] {
        assert!(
            evidence["nativeInputState"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["state"] == state),
            "missing {state}"
        );
    }
    assert_eq!(evidence["steering"].as_array().unwrap().len(), 1);
    assert_eq!(evidence["steering"][0]["nativeInputKey"], pending["key"]);
    assert_eq!(evidence["steeringAccepted"], json!([]));
    assert_eq!(view["actions"]["items"], json!([]));
    assert_eq!(view["evidence"], json!([]));
    let report = view["work"]["report"].to_string();
    assert!(report.contains("19:00") && report.contains("19:30") && report.contains("20:00"));
    let reopened = super::super::view(&f.root, &id).unwrap();
    assert_eq!(reopened["work"]["report"], view["work"]["report"]);
    assert!(reopened["conversation"].to_string().contains("19:00"));
}

fn setup() -> (Fixture, Work, String, Value) {
    let f = Fixture::new();
    f.note("notes", "current", "# 原文\n仅用于本地验证。");
    let id = crate::agent_work::tests::create(&f, false);
    let (work, run) = crate::agent_work::tests::claim(&f, &id);
    record(&f.root, &run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    record(
        &f.root,
        &run,
        "nativeTurn",
        &json!({"threadId":"thread","turnId":"turn"}),
    )
    .unwrap();
    let request=crate::model_runtime::agent_interaction::question(&json!(23),&json!({"threadId":"thread","turnId":"turn","itemId":"item","isBlocking":true,"questions":[{"id":"q","header":"范围","question":"只处理当前材料吗？","isOther":true,"options":[{"label":"是","description":"只处理当前材料"}]}]}),"thread","turn").unwrap();
    requested(&f.root, &work, &run, &request).unwrap();
    (f, work, run, request)
}
fn args(work: &Work, run: &str, request: &Value) -> Value {
    json!({"id":work.id,"runId":run,"key":request["key"],"expectedRevision":work.revision,"expectedAuthorizationVersion":work.authorization_version,"answers":{"q":"是"},"cancel":false})
}

fn async_setup() -> (Fixture, Work, String, Value) {
    let (f, work, run, _) = setup();
    let request=crate::model_runtime::agent_interaction::async_question(&json!({"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","id":"async-question","delivery":"async","questions":[{"title":"明天可用时段？"}]}}),"thread","turn").unwrap().unwrap();
    requested(&f.root, &work, &run, &request).unwrap();
    (f, work, run, request)
}

#[test]
fn core_async_answer_after_completion_reopens_as_one_durable_followup() {
    let (f, work, run, request) = async_setup();
    write(&f.root, |c| {
        c.execute(
            "UPDATE agent_works SET state='completed',active_run=NULL WHERE id=?1",
            [&work.id],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let before = view(&f.root, &work.id).unwrap();
    assert_eq!(
        before["nativeInputs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["delivery"] == "async")
            .unwrap()["state"],
        "pending"
    );
    let mut command = args(&work, &run, &request);
    command["answers"] = json!({"q0":"19:00–20:00"});
    command["action"] = json!("answerNativeInput");
    let receipt = crate::agent_work::ui(&f.root, &command).unwrap();
    assert_eq!(receipt["startNewTurn"], true);
    assert_eq!(receipt["saved"], true);
    let duplicate = crate::agent_work::ui(&f.root, &command).unwrap();
    assert!(duplicate.get("startNewTurn").is_none());
    let reopened = view(&f.root, &work.id).unwrap();
    assert_eq!(reopened["work"]["state"], "ready");
    assert_eq!(reopened["work"]["revision"], work.revision + 1);
    let messages = records(&f.root, &work.id, "userMessage", 32).unwrap();
    assert_eq!(messages.len(), 1);
    assert!(messages[0]["text"]
        .as_str()
        .unwrap()
        .contains("19:00–20:00"));
    assert_eq!(
        records(&f.root, &work.id, "nativeInputState", 32)
            .unwrap()
            .len(),
        1
    );
    command["answers"] = json!({"q0":"不同答案"});
    assert!(respond(&f.root, &command).is_err());
}

#[test]
fn core_async_running_answer_uses_steering_and_rejects_stale_authorization() {
    let (f, work, run, request) = async_setup();
    let mut command = args(&work, &run, &request);
    command["answers"] = json!({"q0":"19:00–20:00"});
    command["expectedAuthorizationVersion"] = json!(work.authorization_version + 1);
    assert!(respond(&f.root, &command).is_err());
    assert!(records(&f.root, &work.id, "steering", 32)
        .unwrap()
        .is_empty());
    command["expectedAuthorizationVersion"] = json!(work.authorization_version);
    assert!(!respond(&f.root, &command).unwrap());
    let messages = records(&f.root, &work.id, "steering", 32).unwrap();
    assert_eq!(messages.len(), 1);
    assert!(messages[0].get("nativeInputKey").is_none());
    assert!(ready(
        &f.root,
        &work,
        &run,
        &json!({"threadId":"thread","turnId":"turn"})
    )
    .unwrap()
    .as_array()
    .unwrap()
    .is_empty());
    assert!(super::super::goal::ensure_received_on(&read(&f.root).unwrap(), &run).is_err());
    record(&f.root, &run, "steeringAccepted", &messages[0]).unwrap();
    super::super::goal::ensure_received_on(&read(&f.root).unwrap(), &run).unwrap();
}

#[test]
fn core_input_delivery_requires_sent_resolved_and_exact_bound_answer() {
    let (f, work, run, request) = setup();
    respond(&f.root, &args(&work, &run, &request)).unwrap();
    let check = || super::super::goal::ensure_received_on(&read(&f.root).unwrap(), &run);
    assert!(check().is_err());
    update(
        &f.root,
        &work,
        &run,
        &json!({"key":request["key"],"state":"sent"}),
    )
    .unwrap();
    assert!(check().is_err());
    update(
        &f.root,
        &work,
        &run,
        &json!({"key":request["key"],"state":"resolved"}),
    )
    .unwrap();
    check().unwrap();
    let message = records(&f.root, &work.id, "steering", 32)
        .unwrap()
        .remove(0);
    assert!(records(&f.root, &work.id, "steeringAccepted", 32)
        .unwrap()
        .is_empty());
    let mut changed = message.clone();
    changed["text"] = json!("different answer");
    assert!(!resolved_answer_on(&read(&f.root).unwrap(), &work.id, &run, &changed).unwrap());
    let mut ordinary = message;
    ordinary.as_object_mut().unwrap().remove("nativeInputKey");
    ordinary["clientMessageId"] = json!("ordinary-not-yet-accepted");
    record(&f.root, &run, "steering", &ordinary).unwrap();
    assert!(check().is_err());
    record(&f.root, &run, "steeringAccepted", &ordinary).unwrap();
    check().unwrap();
    // A later turn does not erase the earlier question's resolved lifecycle.
    record(
        &f.root,
        &run,
        "nativeTurn",
        &json!({"threadId":"thread","turnId":"later"}),
    )
    .unwrap();
    check().unwrap();
    write(&f.root, |c| {
        c.execute(
            "UPDATE agent_works SET authorization_version=authorization_version+1 WHERE id=?1",
            [&work.id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .unwrap();
    assert!(check().is_err());
}

#[test]
fn core_input_delivery_does_not_treat_local_save_or_foreign_resolution_as_receipt() {
    let (f, work, run, request) = setup();
    respond(&f.root, &args(&work, &run, &request)).unwrap();
    // Resolution without a successful send is not proof that the answer was transmitted.
    update(
        &f.root,
        &work,
        &run,
        &json!({"key":request["key"],"state":"resolved"}),
    )
    .unwrap();
    assert!(super::super::goal::ensure_received_on(&read(&f.root).unwrap(), &run).is_err());
    let (f, work, run, request) = setup();
    respond(&f.root, &args(&work, &run, &request)).unwrap();
    update(
        &f.root,
        &work,
        &run,
        &json!({"key":request["key"],"state":"sent"}),
    )
    .unwrap();
    record(
        &f.root,
        &run,
        "nativeTurn",
        &json!({"threadId":"thread","turnId":"other"}),
    )
    .unwrap();
    assert!(update(
        &f.root,
        &work,
        &run,
        &json!({"key":request["key"],"state":"resolved"})
    )
    .is_err());
    assert!(super::super::goal::ensure_received_on(&read(&f.root).unwrap(), &run).is_err());
}

#[test]
fn core_input_receipt_survives_unrelated_view_failure_without_replaying() {
    let (f, work, run, request) = setup();
    record(&f.root, &run, "sharedMemoryUse", &json!({})).unwrap();
    write(&f.root,|c| {
        c.execute("UPDATE agent_records SET body_json='broken synthetic projection' WHERE run_id=?1 AND kind='sharedMemoryUse'",[&run]).map_err(|e|e.to_string())?;
        Ok(())
    }).unwrap();
    assert!(super::super::view(&f.root, &work.id).is_err());
    let mut command = args(&work, &run, &request);
    command["action"] = json!("answerNativeInput");
    let expected = json!({"workId":work.id,"runId":run,"key":request["key"],"saved":true});
    assert_eq!(crate::agent_work::ui(&f.root, &command).unwrap(), expected);
    assert_eq!(crate::agent_work::ui(&f.root, &command).unwrap(), expected);
    assert_eq!(records(&f.root, &work.id, "steering", 32).unwrap().len(), 1);
    assert_eq!(
        load(&read(&f.root).unwrap(), &work.id).unwrap().state,
        "investigating"
    );
    assert!(super::super::view(&f.root, &work.id).is_err());
}

#[test]
fn core_input_receipt_acknowledges_skip_but_never_rejected_answers() {
    let (f, work, run, request) = setup();
    let mut command = args(&work, &run, &request);
    command["action"] = json!("answerNativeInput");
    command["expectedAuthorizationVersion"] = json!(work.authorization_version + 1);
    assert!(crate::agent_work::ui(&f.root, &command).is_err());
    assert!(records(&f.root, &work.id, "steering", 32)
        .unwrap()
        .is_empty());
    command["expectedAuthorizationVersion"] = json!(work.authorization_version);
    command["cancel"] = json!(true);
    command["answers"] = json!({});
    assert_eq!(
        crate::agent_work::ui(&f.root, &command).unwrap()["saved"],
        true
    );
    let messages = records(&f.root, &work.id, "steering", 32).unwrap();
    assert_eq!(messages.len(), 1);
    assert!(messages[0]["text"].as_str().unwrap().contains("暂不回答"));
    assert_eq!(
        load(&read(&f.root).unwrap(), &work.id)
            .unwrap()
            .authorization_version,
        work.authorization_version
    );
}

#[test]
fn native_interaction_answer_persists_once_and_closes_without_replaying_user_input() {
    let (f, work, run, request) = setup();
    let command = args(&work, &run, &request);
    requested(&f.root, &work, &run, &request).unwrap();
    respond(&f.root, &command).unwrap();
    respond(&f.root, &command).unwrap();
    let c = read(&f.root).unwrap();
    assert_eq!(view_on(&c, &work).unwrap()[0]["state"], "answered");
    drop(c);
    let messages = records(&f.root, &work.id, "steering", 32).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["nativeInputKey"], request["key"]);
    assert!(messages[0]["text"]
        .as_str()
        .unwrap()
        .contains("只处理当前材料吗？"));
    let ready = ready(
        &f.root,
        &work,
        &run,
        &json!({"threadId":"thread","turnId":"turn"}),
    )
    .unwrap();
    assert_eq!(ready.as_array().unwrap().len(), 1);
    assert_eq!(
        ready[0]["response"]["answers"]["q"]["answers"],
        json!(["是"])
    );
    let mut conflict = command.clone();
    conflict["answers"]["q"] = json!("否");
    assert!(respond(&f.root, &conflict).is_err());
    update(
        &f.root,
        &work,
        &run,
        &json!({"key":request["key"],"state":"sent"}),
    )
    .unwrap();
    assert_eq!(
        super::ready(
            &f.root,
            &work,
            &run,
            &json!({"threadId":"thread","turnId":"turn"})
        )
        .unwrap(),
        json!([])
    );
    update(
        &f.root,
        &work,
        &run,
        &json!({"key":request["key"],"state":"resolved"}),
    )
    .unwrap();
    update(
        &f.root,
        &work,
        &run,
        &json!({"key":request["key"],"state":"sent"}),
    )
    .unwrap();
    assert_eq!(
        view_on(&read(&f.root).unwrap(), &work).unwrap()[0]["state"],
        "resolved"
    );
    let conversation = conversation::context(&f.root, &work).unwrap();
    assert!(conversation.to_string().contains("只处理当前材料吗？"));
    assert_eq!(
        load(&read(&f.root).unwrap(), &work.id)
            .unwrap()
            .authorization_version,
        work.authorization_version
    );
}

#[test]
fn native_interaction_late_foreign_and_revoked_answers_are_rejected_and_saved_answers_survive_stop()
{
    let (f, work, run, request) = setup();
    let command = args(&work, &run, &request);
    for (field, value) in [
        ("runId", json!("other-run")),
        ("key", json!("other-key")),
        (
            "expectedAuthorizationVersion",
            json!(work.authorization_version + 1),
        ),
    ] {
        let mut bad = command.clone();
        bad[field] = value;
        assert!(respond(&f.root, &bad).is_err());
    }
    respond(&f.root, &command).unwrap();
    fail(&f.root, &work, &run, "模拟连接中断").unwrap();
    let current = load(&read(&f.root).unwrap(), &work.id).unwrap();
    assert_eq!(
        view_on(&read(&f.root).unwrap(), &current).unwrap()[0]["state"],
        "closed"
    );
    assert!(respond(&f.root, &command).is_err());
    assert_eq!(records(&f.root, &work.id, "steering", 32).unwrap().len(), 1);
    assert!(conversation::context(&f.root, &current)
        .unwrap()
        .to_string()
        .contains("只处理当前材料吗？"));
    let mut revoked = current;
    revoked.state = "revoked".into();
    assert_eq!(
        view_on(&read(&f.root).unwrap(), &revoked).unwrap(),
        json!([])
    );
}

#[test]
fn native_interaction_resolution_and_turn_change_close_unanswered_requests() {
    let (f, work, run, request) = setup();
    update(
        &f.root,
        &work,
        &run,
        &json!({"key":request["key"],"state":"resolved"}),
    )
    .unwrap();
    assert!(respond(&f.root, &args(&work, &run, &request)).is_err());
    assert!(records(&f.root, &work.id, "steering", 32)
        .unwrap()
        .is_empty());
    let (f, work, run, request) = setup();
    record(
        &f.root,
        &run,
        "nativeTurn",
        &json!({"threadId":"thread","turnId":"next-turn"}),
    )
    .unwrap();
    assert_eq!(
        view_on(&read(&f.root).unwrap(), &work).unwrap()[0]["state"],
        "closed"
    );
    assert!(respond(&f.root, &args(&work, &run, &request)).is_err());
}

#[test]
fn native_interaction_cancel_is_explicit_and_plan_snapshot_does_not_create_business_facts() {
    let (f, work, run, request) = setup();
    let mut command = args(&work, &run, &request);
    command["cancel"] = json!(true);
    command["answers"] = json!({});
    respond(&f.root, &command).unwrap();
    assert_eq!(
        ready(
            &f.root,
            &work,
            &run,
            &json!({"threadId":"thread","turnId":"turn"})
        )
        .unwrap()[0]["response"],
        json!({"answers":{}})
    );
    for text in ["读取材料 — 进行中", "读取材料 — 模型标记完成"] {
        stream(
            &f.root,
            &work,
            &run,
            &json!({"id":"plan-this-turn","kind":"plan","state":"completed","text":text}),
            &Control::default(),
        )
        .unwrap();
    }
    let c = read(&f.root).unwrap();
    let activity = crate::agent_work::activity::read_on(&f.root, &c, &work).unwrap();
    let plans: Vec<_> = activity[0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "plan")
        .collect();
    assert_eq!(plans.len(), 1);
    assert!(plans[0]["label"].as_str().unwrap().contains("模型标记完成"));
    assert_eq!(activity[0]["steps"], 0);
    assert!(records_on(&c, &work.id, "delivery", 10).unwrap().is_empty());
}
