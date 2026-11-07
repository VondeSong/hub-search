use super::*;
use crate::source_evidence::tests::Fixture;

#[test]
fn compaction_queue_survives_interruption_and_reopen_without_false_acceptance() {
    let f = Fixture::new();
    f.note("notes", "current", "压缩期间的来源");
    let id = crate::agent_work::tests::create(&f, false);
    let (work, run) = crate::agent_work::tests::claim(&f, &id);
    store::record(&f.root, &run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    store::record(
        &f.root,
        &run,
        "nativeContextLifecycle",
        &json!({"state":"started","threadId":"same-thread"}),
    )
    .unwrap();
    let message =
        json!({"runId":run,"clientMessageId":"during-compact","text":"只保留有出处的结论"});
    store::conversation::steer(&f.root, &id, &message).unwrap();
    store::conversation::steer(&f.root, &id, &message).unwrap();
    let queued = pending(&f.root, &work, &run, &HashSet::new()).unwrap();
    assert_eq!(queued.len(), 1);
    assert!(store::records(&f.root, &id, "steeringAccepted", 32)
        .unwrap()
        .is_empty());
    store::fail(&f.root, &work, &run, "压缩期间中断").unwrap();
    assert!(pending(&f.root, &work, &run, &HashSet::new()).is_err());
    let c = f.c();
    let reopened = store::load(&c, &id).unwrap();
    assert_eq!(reopened.state, "interrupted");
    let history = store::conversation::read_on(&f.root, &c, &reopened).unwrap();
    assert!(history.to_string().contains("只保留有出处的结论"));
    assert_eq!(
        store::records(&f.root, &id, "steering", 32).unwrap(),
        queued
    );
    assert!(store::records(&f.root, &id, "steeringAccepted", 32)
        .unwrap()
        .is_empty());
}

#[test]
fn late_completion_handoff_keeps_real_user_input_run_identity_and_one_recovery_limit() {
    let f = Fixture::new();
    f.note("notes", "current", "# 记录\n真实来源保持只读。\n");
    let id = crate::agent_work::tests::create(&f, false);
    let (work, run) = crate::agent_work::tests::claim(&f, &id);
    store::record(&f.root, &run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    store::record(
        &f.root,
        &run,
        "nativeFinal",
        &json!({"text":"旧要求下的最终消息"}),
    )
    .unwrap();
    store::conversation::steer(&f.root,&id,&json!({"runId":run,"clientMessageId":"late-user","text":"只预览，不保存到来源；保留当前成果和历史。"})).unwrap();
    let mut delivered = HashSet::new();
    let mut used = false;
    assert!(
        store::goal::for_run(&f.root, &work, &run).is_err(),
        "unreceived real command must block stale publication"
    );
    let messages = next(&f.root, &work, &run, &delivered, &mut used)
        .unwrap()
        .unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(
        messages[0]["text"],
        "只预览，不保存到来源；保留当前成果和历史。"
    );
    assert!(
        next(&f.root, &work, &run, &delivered, &mut used).is_err(),
        "not an unbounded restart loop"
    );
    // The real runtime-start callback is the only production acknowledgement.
    store::record(&f.root, &run, "steeringAccepted", &messages[0]).unwrap();
    delivered.insert("late-user".into());
    let binding = store::goal::for_run(&f.root, &work, &run).unwrap();
    assert_eq!(binding["commandWatermark"], 1);
    assert!(next(&f.root, &work, &run, &delivered, &mut used)
        .unwrap()
        .is_none());
    store::fail(&f.root, &work, &run, "user stopped").unwrap();
    assert!(pending(&f.root, &work, &run, &delivered).is_err());
    assert!(store::records(&f.root, &id, "delivery", 32)
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "explicit copied C8 UX10 failure; no provider/model"]
fn saved_c8_final_then_steer_reproduces_missing_ack_and_retains_the_exact_command() {
    let root = PathBuf::from(std::env::var("HUB_C9_LATE_REPLAY").unwrap());
    assert!(
        root.to_string_lossy().contains(".local") && root.join(".hub-isolated-runtime-v1").exists()
    );
    let c = Connection::open(root.join("craft-search.sqlite3")).unwrap();
    let (id,run):(String,String) = c.query_row("SELECT work_id,id FROM agent_runs WHERE error='追加要求已保存，请继续完成' ORDER BY rowid DESC LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    let records = |kind: &str| store::records(&root, &id, kind, 32).unwrap();
    assert_eq!(records("steering").len(), 1);
    assert!(records("steeringAccepted").is_empty());
    let old_delivery = records("delivery");
    let original = records("steering")[0].clone();
    // Restore only the ended Run's lifecycle in the disposable copy.
    c.execute(
        "UPDATE agent_works SET state='investigating',active_run=?1 WHERE id=?2",
        params![run, id],
    )
    .unwrap();
    c.execute(
        "UPDATE agent_runs SET state='investigating',finished_at=NULL WHERE id=?1",
        [&run],
    )
    .unwrap();
    let work = store::load(&c, &id).unwrap();
    assert!(store::goal::for_run(&root, &work, &run).is_err());
    let mut used = false;
    let actual = next(&root, &work, &run, &HashSet::new(), &mut used)
        .unwrap()
        .unwrap();
    assert_eq!(actual, vec![original]);
    assert_eq!(records("delivery"), old_delivery);
    assert!(
        records("steeringAccepted").is_empty(),
        "planning a continuation is not actual model acceptance"
    );
}
