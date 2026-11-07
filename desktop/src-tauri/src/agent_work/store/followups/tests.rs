use super::*;
use crate::agent_work::tests::{claim, create};
use crate::source_evidence::tests::Fixture;
fn setup() -> (Fixture, String) {
    let f = Fixture::new();
    f.note("notes", "current", "原文");
    f.note("notes", "extra", "追加原文");
    let id = create(&f, false);
    (f, id)
}
fn request(work: &Work, key: &str, mode: &str) -> Value {
    json!({"id":work.id,"text":"补充要求","clientMessageId":key,"expectedAuthorizationVersion":work.authorization_version,"deliveryMode":mode})
}
fn extra() -> Value {
    json!({"kind":"note","libraryId":"notes","documentId":"extra","pageId":null})
}
fn staged_image(f: &Fixture) -> Value {
    use base64::Engine;
    images::stage(&f.root, &json!({"title":"补充截图.png","mime":"image/png","base64":base64::engine::general_purpose::STANDARD.encode(include_bytes!("../../images/fixture.png"))})).unwrap()["grant"].clone()
}

#[test]
fn image_and_note_followup_without_ack_is_never_replayed_after_compaction_or_end() {
    for ending in ["completion", "stop", "compaction"] {
        let (f, id) = setup();
        let (work, run) = claim(&f, &id);
        let mut args = request(&work, "image-note", "steer");
        args["expectedRunId"] = json!(run);
        args["addImages"] = json!([staged_image(&f)]);
        args["addNotes"] = json!([extra()]);
        if ending == "compaction" {
            record(
                &f.root,
                &run,
                "nativeContextLifecycle",
                &json!({"state":"started","threadId":"same-thread"}),
            )
            .unwrap();
        }
        save(&f.root, &args).unwrap();
        save(&f.root, &args).unwrap();
        let (updated, admitted) = admit(&f.root, &work, &run).unwrap();
        assert_eq!(admitted.len(), 1);
        assert_eq!(admitted[0]["addImages"], args["addImages"]);
        assert_eq!(updated.grant.images.len(), 1);
        assert_eq!(
            view_on(&read(&f.root).unwrap(), &updated).unwrap()[0]["state"],
            "sending"
        );
        if ending == "completion" {
            finish_turn(&f, &id, &run);
        } else {
            fail(&f.root, &updated, &run, "运行中断，未收到回执").unwrap();
        }
        let reopened = load(&read(&f.root).unwrap(), &id).unwrap();
        assert_eq!(
            view_on(&read(&f.root).unwrap(), &reopened).unwrap()[0]["state"],
            "unconfirmed"
        );
        save(&f.root, &args).unwrap();
        assert!(!take_explicit(
            &f.root,
            &id,
            &json!({"expectedRunId":null,"selectedMessageId":"image-note"})
        )
        .unwrap());
        assert_eq!(records(&f.root, &id, "steering", 10).unwrap().len(), 1);
        assert!(records(&f.root, &id, "steeringAccepted", 10)
            .unwrap()
            .is_empty());
    }
}

#[test]
fn missing_image_and_revoked_authorization_block_queued_attachments() {
    for revoked in [false, true] {
        let (f, id) = setup();
        let (work, run) = claim(&f, &id);
        let image = staged_image(&f);
        let mut args = request(&work, "attachment", "queue");
        args["addImages"] = json!([image]);
        args["addNotes"] = json!([extra()]);
        save(&f.root, &args).unwrap();
        finish_turn(&f, &id, &run);
        if revoked {
            write(&f.root, |c| { c.execute("UPDATE agent_works SET state='revoked',authorization_version=authorization_version+1 WHERE id=?1", [&id]).unwrap(); Ok(()) }).unwrap();
            assert!(take_explicit(&f.root, &id, &json!({"expectedRunId":null})).is_err());
        } else {
            std::fs::remove_file(
                f.root
                    .join("collection-files/agent-images")
                    .join(format!("{}.image", image["sourceItemId"].as_str().unwrap())),
            )
            .unwrap();
            assert!(!take_explicit(&f.root, &id, &json!({"expectedRunId":null})).unwrap());
            assert_eq!(
                rows(&read(&f.root).unwrap(), &id).unwrap()[0]["state"],
                "failed"
            );
        }
        assert!(load(&read(&f.root).unwrap(), &id)
            .unwrap()
            .grant
            .images
            .is_empty());
        assert!(records(&f.root, &id, "steering", 10).unwrap().is_empty());
        assert!(!records(&f.root, &id, "userMessage", 10)
            .unwrap()
            .iter()
            .any(|m| m["clientMessageId"] == "attachment"));
    }
}
#[test]
fn queue_survives_reopen_deduplicates_and_does_not_change_live_scope() {
    let (f, id) = setup();
    let (work, run) = claim(&f, &id);
    let mut args = request(&work, "q", "queue");
    args["addNotes"] = json!([extra()]);
    save(&f.root, &args).unwrap();
    save(&f.root, &args).unwrap();
    let (same, admitted) = admit(&f.root, &work, &run).unwrap();
    assert!(admitted.is_empty());
    assert_eq!(same.revision, work.revision);
    assert!(!same
        .grant
        .contains(&serde_json::from_value(extra()).unwrap()));
    assert_eq!(rows(&read(&f.root).unwrap(), &id).unwrap().len(), 1);
    args["text"] = json!("different");
    assert!(save(&f.root, &args).is_err());
}
#[test]
fn attachment_steer_rebases_only_exact_running_turn_and_keeps_read_boundary() {
    let (f, id) = setup();
    let (work, run) = claim(&f, &id);
    let mut args = request(&work, "s", "steer");
    args["text"] = json!("");
    args["addNotes"] = json!([extra()]);
    save(&f.root, &args).unwrap();
    let (updated, messages) = admit(&f.root, &work, &run).unwrap();
    assert_eq!(messages.len(), 1);
    assert!(updated.revision > work.revision);
    check_run(&f.root, &updated, &run).unwrap();
    assert!(check_run(&f.root, &work, &run).is_err());
    let locator: EvidenceLocator = serde_json::from_value(extra()).unwrap();
    assert!(updated
        .grant
        .reader(&f.root)
        .unwrap()
        .read(&locator, 0, 100, None)
        .is_ok());
    let other: EvidenceLocator = serde_json::from_value(
        json!({"kind":"note","libraryId":"notes","documentId":"private","pageId":null}),
    )
    .unwrap();
    assert!(!updated.grant.contains(&other));
    assert!(admit(&f.root, &updated, &run).unwrap().1.is_empty());
}
#[test]
fn stopped_queue_is_held_and_never_auto_starts() {
    let (f, id) = setup();
    let (work, run) = claim(&f, &id);
    save(&f.root, &request(&work, "q", "queue")).unwrap();
    hold(&f.root, &id).unwrap();
    fail(&f.root, &work, &run, "中断").unwrap();
    assert!(!take_next(&f.root, &id).unwrap());
    assert_eq!(
        rows(&read(&f.root).unwrap(), &id).unwrap()[0]["state"],
        "held"
    );
}
#[test]
fn queue_edit_cancel_uses_version_and_preserves_attachments() {
    let (f, id) = setup();
    let (work, _) = claim(&f, &id);
    let mut req = request(&work, "q", "queue");
    req["addNotes"] = json!([extra()]);
    save(&f.root, &req).unwrap();
    let edit = json!({"id":id,"clientMessageId":"q","editVersion":1,"operation":"edit","text":"改好的问题","addNotes":[extra()]});
    change(&f.root, &edit).unwrap();
    assert!(change(&f.root, &edit).is_err());
    let saved = rows(&read(&f.root).unwrap(), &id).unwrap();
    assert_eq!(saved[0]["payload"]["addNotes"].as_array().unwrap().len(), 1);
    change(
        &f.root,
        &json!({"id":id,"clientMessageId":"q","editVersion":2,"operation":"cancel"}),
    )
    .unwrap();
    assert_eq!(
        rows(&read(&f.root).unwrap(), &id).unwrap()[0]["state"],
        "cancelled"
    );
}
#[test]
fn queued_messages_dispatch_in_order_only_after_turn_finishes() {
    let (f, id) = setup();
    let (work, run) = claim(&f, &id);
    for key in ["one", "two", "three"] {
        save(&f.root, &request(&work, key, "queue")).unwrap();
    }
    assert!(!take_next(&f.root, &id).unwrap());
    write(&f.root, |c| {
        c.execute(
            "UPDATE agent_works SET active_run=NULL,state='completed' WHERE id=?1",
            [&id],
        )
        .unwrap();
        c.execute(
            "UPDATE agent_runs SET state='completed' WHERE id=?1",
            [&run],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    for key in ["one", "two", "three"] {
        assert!(take_next(&f.root, &id).unwrap());
        assert_eq!(
            records(&f.root, &id, "userMessage", 1).unwrap()[0]["clientMessageId"],
            key
        );
        let (_, next_run) = claim(&f, &id);
        assert!(!take_next(&f.root, &id).unwrap());
        finish_turn(&f, &id, &next_run);
    }
    assert!(!take_next(&f.root, &id).unwrap());
    assert_eq!(
        records(&f.root, &id, "userMessage", 10)
            .unwrap()
            .iter()
            .filter(|m| m["clientMessageId"].is_string())
            .count(),
        3
    );
}

fn finish_turn(f: &Fixture, id: &str, run: &str) {
    write(&f.root, |c| {
        c.execute(
            "UPDATE agent_works SET active_run=NULL,state='completed' WHERE id=?1",
            [id],
        )
        .unwrap();
        c.execute("UPDATE agent_runs SET state='completed' WHERE id=?1", [run])
            .unwrap();
        Ok(())
    })
    .unwrap();
}

#[test]
fn selected_message_runs_first_then_remaining_queue_keeps_fifo() {
    let (f, id) = setup();
    let (work, run) = claim(&f, &id);
    for key in ["one", "two", "three"] {
        save(&f.root, &request(&work, key, "queue")).unwrap();
    }
    finish_turn(&f, &id, &run);
    change(&f.root, &json!({"id":id,"clientMessageId":"two","editVersion":1,"operation":"send","expectedRunId":null})).unwrap();
    assert!(take_explicit(
        &f.root,
        &id,
        &json!({"expectedRunId":null,"selectedMessageId":"two"})
    )
    .unwrap());
    assert_eq!(
        records(&f.root, &id, "userMessage", 1).unwrap()[0]["clientMessageId"],
        "two"
    );
    // Repeated dispatch must never substitute another queued message.
    assert!(!take_explicit(
        &f.root,
        &id,
        &json!({"expectedRunId":null,"selectedMessageId":"two"})
    )
    .unwrap());
    for key in ["one", "three"] {
        let (_, run) = claim(&f, &id);
        finish_turn(&f, &id, &run);
        assert!(take_next(&f.root, &id).unwrap());
        assert_eq!(
            records(&f.root, &id, "userMessage", 1).unwrap()[0]["clientMessageId"],
            key
        );
    }
    assert!(!take_next(&f.root, &id).unwrap());
}

#[test]
fn promotion_requires_live_native_runtime_and_bound_turn_without_mutating_queue() {
    for facts in [vec![], vec!["nativeRuntime"], vec!["nativeTurn"]] {
        let (f, id) = setup();
        let (work, run) = claim(&f, &id);
        save(&f.root, &request(&work, "q", "queue")).unwrap();
        for kind in facts {
            record(&f.root, &run, kind, &json!({})).unwrap();
        }
        let before = rows(&read(&f.root).unwrap(), &id).unwrap();
        let send = json!({"id":id,"clientMessageId":"q","editVersion":1,"operation":"send","expectedRunId":run});
        assert!(change(&f.root, &send)
            .unwrap_err()
            .contains("不支持即时追加"));
        assert_eq!(rows(&read(&f.root).unwrap(), &id).unwrap(), before);
        finish_turn(&f, &id, &run);
        assert!(take_next(&f.root, &id).unwrap());
        assert_eq!(
            records(&f.root, &id, "userMessage", 1).unwrap()[0]["clientMessageId"],
            "q"
        );
    }
    let (f, id) = setup();
    let (work, run) = claim(&f, &id);
    save(&f.root, &request(&work, "q", "queue")).unwrap();
    record(&f.root, &run, "nativeRuntime", &json!({})).unwrap();
    record(&f.root, &run, "nativeTurn", &json!({})).unwrap();
    let c = read(&f.root).unwrap();
    assert!(super::super::super::activity::can_steer_on(&c, &run).unwrap());
    change(&f.root, &json!({"id":id,"clientMessageId":"q","editVersion":1,"operation":"send","expectedRunId":run})).unwrap();
    assert_eq!(admit(&f.root, &work, &run).unwrap().1.len(), 1);
    finish_turn(&f, &id, &run);
    assert!(!super::super::super::activity::can_steer_on(&c, &run).unwrap());
}

#[test]
fn selected_send_rejects_stale_run_and_does_not_release_other_held_messages() {
    let (f, id) = setup();
    let (work, run) = claim(&f, &id);
    for key in ["one", "two"] {
        save(&f.root, &request(&work, key, "queue")).unwrap();
    }
    let mut send = json!({"id":id,"clientMessageId":"two","editVersion":1,"operation":"send"});
    for expected in [None, Some(Value::Null), Some(json!("old-run"))] {
        if let Some(value) = expected {
            send["expectedRunId"] = value;
        }
        assert!(change(&f.root, &send).is_err());
    }
    assert_eq!(
        rows(&read(&f.root).unwrap(), &id).unwrap()[1]["editVersion"],
        1
    );
    finish_turn(&f, &id, &run);
    send["expectedRunId"] = json!(run);
    assert!(change(&f.root, &send).is_err());
    hold(&f.root, &id).unwrap();
    send["expectedRunId"] = Value::Null;
    change(&f.root, &send).unwrap();
    let (_, new_run) = claim(&f, &id);
    assert!(take_explicit(
        &f.root,
        &id,
        &json!({"expectedRunId":null,"selectedMessageId":"two"})
    )
    .is_err());
    finish_turn(&f, &id, &new_run);
    assert!(take_explicit(
        &f.root,
        &id,
        &json!({"expectedRunId":null,"selectedMessageId":"two"})
    )
    .unwrap());
    assert_eq!(
        rows(&read(&f.root).unwrap(), &id).unwrap()[0]["state"],
        "held"
    );
    assert!(!take_next(&f.root, &id).unwrap());
}
#[test]
fn changed_authorization_does_not_admit_pending_material() {
    let (f, id) = setup();
    let (work, run) = claim(&f, &id);
    save(&f.root, &request(&work, "s", "steer")).unwrap();
    write(&f.root, |c| {
        c.execute(
            "UPDATE agent_works SET authorization_version=authorization_version+1 WHERE id=?1",
            [&id],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    assert!(admit(&f.root, &work, &run).is_err());
    assert!(records(&f.root, &id, "steering", 10).unwrap().is_empty());
}

#[test]
fn explicit_queue_resume_uses_lifecycle_checks_and_first_queued_prompt() {
    let (f, id) = setup();
    let (work, _) = claim(&f, &id);
    save(&f.root, &request(&work, "q", "queue")).unwrap();
    let state = view(&f.root, &id).unwrap();
    let command = json!({"commandId":"stop","expectedControlRevision":state["lifecycle"]["controlRevision"],"expectedWorkRevision":work.revision,"expectedRunId":work.active_run});
    lifecycle::stop(&f.root, &id, &command, false).unwrap();
    hold(&f.root, &id).unwrap();
    let state = view(&f.root, &id).unwrap();
    let args = json!({"commandId":"resume","expectedControlRevision":state["lifecycle"]["controlRevision"],"expectedWorkRevision":state["work"]["revision"],"expectedRunId":state["lifecycle"]["activeRunId"],"resumeQueue":true});
    let next = lifecycle::resume_with_budget(
        &f.root,
        &id,
        "resumed",
        &args,
        crate::agent_work::assistant::budget("quick").unwrap(),
    )
    .unwrap()
    .unwrap();
    assert!(next.revision > work.revision);
    assert_eq!(
        records(&f.root, &id, "userMessage", 1).unwrap()[0]["clientMessageId"],
        "q"
    );
    assert_eq!(
        rows(&read(&f.root).unwrap(), &id).unwrap()[0]["state"],
        "saved"
    );
}

#[test]
fn changed_source_is_rejected_before_scope_admission_and_edit_can_revalidate() {
    let (f, id) = setup();
    let (work, run) = claim(&f, &id);
    let mut args = request(&work, "stale", "steer");
    args["addNotes"] = json!([extra()]);
    save(&f.root, &args).unwrap();
    f.note("notes", "extra", "被外部更新的原文");
    let (same, messages) = admit(&f.root, &work, &run).unwrap();
    assert!(messages.is_empty());
    assert_eq!(same.revision, work.revision);
    assert_eq!(
        rows(&read(&f.root).unwrap(), &id).unwrap()[0]["state"],
        "failed"
    );
    change(&f.root,&json!({"id":id,"clientMessageId":"stale","editVersion":1,"operation":"edit","text":"按更新后的资料分析","addNotes":[extra()]})).unwrap();
    record(&f.root, &run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    record(
        &f.root,
        &run,
        "nativeTurn",
        &json!({"threadId":"fixture","turnId":"turn"}),
    )
    .unwrap();
    change(
        &f.root,
        &json!({"id":id,"clientMessageId":"stale","editVersion":2,"operation":"send","expectedRunId":run}),
    )
    .unwrap();
    assert_eq!(admit(&f.root, &work, &run).unwrap().1.len(), 1);
}

#[test]
fn failed_run_requires_explicit_queue_dispatch() {
    let (f, id) = setup();
    let (work, run) = claim(&f, &id);
    save(&f.root, &request(&work, "retry", "queue")).unwrap();
    fail(&f.root, &work, &run, "连接断开").unwrap();
    hold(&f.root, &id).unwrap();
    assert!(!take_next(&f.root, &id).unwrap());
    assert!(take_explicit(&f.root, &id, &json!({"expectedRunId":null})).unwrap());
    assert_eq!(
        records(&f.root, &id, "userMessage", 1).unwrap()[0]["clientMessageId"],
        "retry"
    );
}

#[test]
fn stale_running_turn_does_not_receive_a_new_followup() {
    let (f, id) = setup();
    let (work, _) = claim(&f, &id);
    let mut args = request(&work, "wrong-run", "steer");
    args["expectedRunId"] = json!("older-run");
    assert!(save(&f.root, &args).is_err());
    assert!(rows(&read(&f.root).unwrap(), &id).unwrap().is_empty());
}

#[test]
fn stale_paused_queue_does_not_resume_the_previous_request() {
    let (f, id) = setup();
    let (work, _) = claim(&f, &id);
    let mut args = request(&work, "stale-paused", "queue");
    args["addNotes"] = json!([extra()]);
    save(&f.root, &args).unwrap();
    let state = view(&f.root, &id).unwrap();
    lifecycle::stop(&f.root,&id,&json!({"commandId":"pause-stale","expectedControlRevision":state["lifecycle"]["controlRevision"],"expectedWorkRevision":work.revision,"expectedRunId":work.active_run}),false).unwrap();
    hold(&f.root, &id).unwrap();
    f.note("notes", "extra", "外部更新");
    let state = view(&f.root, &id).unwrap();
    assert!(lifecycle::resume_with_budget(&f.root,&id,"must-not-run",&json!({"commandId":"resume-stale","expectedControlRevision":state["lifecycle"]["controlRevision"],"expectedWorkRevision":state["work"]["revision"],"expectedRunId":state["lifecycle"]["activeRunId"],"resumeQueue":true}),crate::agent_work::assistant::budget("quick").unwrap()).is_err());
    let after = load(&read(&f.root).unwrap(), &id).unwrap();
    assert_eq!(after.state, "paused");
    assert!(after.active_run.is_none());
}

#[test]
#[ignore = "real model and selected current library; requires HUB_FOLLOWUP_LIVE_CONFIG"]
fn live_followup_images_materials_and_queue() {
    let config: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("HUB_FOLLOWUP_LIVE_CONFIG").expect("explicit config"))
            .unwrap(),
    )
    .unwrap();
    let root = PathBuf::from(config["root"].as_str().unwrap());
    let output = PathBuf::from(config["output"].as_str().unwrap());
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output.with_extension("started"))
        .unwrap();
    let created=crate::agent_work::ui(&root,&json!({"action":"create","goal":"详细核对这篇笔记的完整内容，逐项解释目录、模板和附件组织建议，说明哪些是建议、哪些已证实落地。只读，不修改来源。","successCriteria":"","anchor":config["anchor"],"grant":{"libraryIds":[],"notes":[config["anchor"]],"readingItemKeys":[]}})).unwrap();
    let id = created["work"]["id"].as_str().unwrap().to_string();
    crate::agent_work::options::configure(&root, &json!({"id":id,"options":config["options"]}))
        .unwrap();
    let image=crate::agent_work::ui(&root,&json!({"action":"stageImage","title":"追加视觉验证.png","mime":"image/png","base64":config["imageBase64"]})).unwrap();
    let r = root.clone();
    let workid = id.clone();
    let thread = std::thread::spawn(move || {
        crate::agent_work::ui(&r, &json!({"action":"respond","id":workid,"mode":"quick"}))
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let work = loop {
        let c = read(&root).unwrap();
        let w = load(&c, &id).unwrap();
        if w.active_run.is_some() {
            if !records(&root, &id, "nativeTurn", 1).unwrap().is_empty() {
                break w;
            }
        }
        assert!(std::time::Instant::now() < deadline, "native start timeout");
        std::thread::sleep(Duration::from_millis(100));
    };
    let first = work.active_run.clone().unwrap();
    save(&root,&json!({"id":id,"clientMessageId":"live-image-steer","deliveryMode":"steer","expectedAuthorizationVersion":work.authorization_version,"text":"更新要求：只输出两行。第一行以「视觉追加：」开头，说明本次新图片左、右两块分别是什么颜色；第二行以「资料追加：」开头，引用本次新增的第二篇笔记关于目录层级的原文建议。不执行写入。","addNotes":[config["extra"]],"addImages":[image["grant"]]})).unwrap();
    for attempt in 0..3 {
        let current = load(&read(&root).unwrap(), &id).unwrap();
        let saved = save(
            &root,
            &json!({"id":id,"clientMessageId":"live-queued","deliveryMode":"queue","expectedAuthorizationVersion":current.authorization_version,"text":"本条是独立的下一轮：只用一句话，以「队列验收：」开头，概括刚才两篇笔记的共同主张。不修改来源。"}),
        );
        if saved.is_ok() {
            break;
        }
        if attempt == 2 {
            saved.unwrap();
        }
    }
    let result = thread.join().unwrap();
    let final_view = view(&root, &id).unwrap();
    let mut evidence = json!({"workId":id,"firstRunId":first,"result":result,"view":final_view});
    for kind in [
        "followup",
        "followupScope",
        "steeringAccepted",
        "nativeFinal",
        "nativeTurn",
        "nativeMeasurement",
    ] {
        evidence[kind] = json!(records(&root, &id, kind, 32).unwrap());
    }
    std::fs::write(&output, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    assert!(evidence["result"].get("Ok").is_some(), "{evidence}");
    assert_eq!(
        evidence["steeringAccepted"][0]["clientMessageId"],
        "live-image-steer"
    );
    assert!(evidence["nativeFinal"].as_array().unwrap().len() >= 2);
    assert_eq!(evidence["followupScope"].as_array().unwrap().len(), 1);
}
