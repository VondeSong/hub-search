use super::*;
use crate::agent_work::tests::{claim, create, report};
use crate::source_evidence::tests::Fixture;

#[test]
fn periodic_library_watch_retains_unreported_changes_and_rejects_the_same_slot_twice() {
    let fixture = Fixture::new();
    fixture.note("craft", "base", "已经核对的材料");
    let anchor = EvidenceLocator::Note {
        library_id: "craft".into(),
        document_id: "base".into(),
        page_id: None,
    };
    let id = ready_at(
        &fixture,
        anchor,
        Grant {
            library_ids: vec!["craft".into()],
            ..Default::default()
        },
        "已经核对的材料",
    );
    configure(
        &fixture.root,
        &json!({"id":id,"confirmed":true,
        "dueAt":now()+20_000,"repeatDays":7,"scanLibraries":true}),
    )
    .unwrap();
    let mut original = condition(&fixture, &id);
    let slot = now() - 30;
    original.due_at = Some(slot);
    save(&fixture.c(), &id, &original, slot).unwrap();
    fixture.note("craft", "new-note", "本次新增材料");
    let work = store::load(&fixture.c(), &id).unwrap();
    let delta = catalog::delta(&fixture.root, &fixture.c(), &work).unwrap();
    assert_eq!(delta["changes"][0]["kind"], "added");
    assert_eq!(delta["changes"][0]["locator"]["documentId"], "new-note");
    let trigger = json!({"reason":"agreedReview","scheduledAt":slot,"libraryDelta":delta});
    let claimed = store::write(&fixture.root, |c| {
        claim_on(c, &id, "schedule-test", &original, &trigger)
    })
    .unwrap();
    assert!(condition(&fixture, &id).due_at.unwrap() > slot + WEEK - 10);
    assert_eq!(
        store::review_trigger(&fixture.root, "schedule-test")
            .unwrap()
            .unwrap()["scope"],
        "authorizedLibraryDelta"
    );
    // A later revision must survive acknowledgement of this slot.
    fixture.c().execute("UPDATE documents SET content_hash='a-later-version' WHERE space_id='craft' AND id='new-note'", []).unwrap();
    catalog::advance(&fixture.root, &fixture.c(), &claimed, &delta).unwrap();
    assert_eq!(
        catalog::delta(&fixture.root, &fixture.c(), &claimed).unwrap()["changes"][0]["kind"],
        "added"
    );
    let mut after = condition(&fixture, &id);
    after.running = None;
    save(&fixture.c(), &id, &after, now()).unwrap();
    assert!(store::write(&fixture.root, |c| claim_on(
        c,
        &id,
        "duplicate",
        &original,
        &trigger
    ))
    .err()
    .expect("duplicate claim rejected")
    .contains("已处理"));
}

#[test]
fn a_bound_task_change_reads_only_its_known_authorized_peers_and_keeps_other_dependencies() {
    let f = Fixture::new();
    f.note("craft", "doc", "父页");
    f.c().execute_batch("INSERT INTO craft_task_blocks(space_id,document_id,block_id,title,completed,source_hash) VALUES('craft','doc','one','检查配合条件',0,'a');
        INSERT INTO dida_tasks(library_id,task_id,project_id,title,content,raw_json,last_seen_at) VALUES('dida','peer','project','对应任务','已授权说明','{}',1),('dida','other','project','不相关','PRIVATE_PEER_SENTINEL','{}',1);
        INSERT INTO unified_task_bindings(hub_task_id,provider,library_id,source_id,last_seen_at) VALUES('bound-one','craft','craft','one',1),('bound-one','dida365','dida','peer',1);").unwrap();
    let anchor = EvidenceLocator::Task {
        library_id: "craft".into(),
        source_id: "one".into(),
    };
    let id = ready_at(
        &f,
        anchor,
        Grant {
            library_ids: vec!["craft".into(), "dida".into()],
            ..Default::default()
        },
        "检查配合条件",
    );
    let v = condition(&f, &id);
    assert_eq!(v.dependencies.len(), 2);
    let w = store::load(&f.c(), &id).unwrap();
    f.c()
        .execute(
            "UPDATE dida_tasks SET content='新的对应任务说明' WHERE task_id='peer'",
            [],
        )
        .unwrap();
    let sample = sample_on(&f.root, &f.c(), &w, &v.dependencies).unwrap();
    let focused = affected(
        &w,
        &v,
        &json!({"reason":"knownDependencyChanged","sample":sample}),
    );
    assert_eq!(focused.len(), 2);
    let (work, run) = begin(&f, &id);
    runner::investigate(
        &f.root,
        &narrowed(&work, &focused),
        &run,
        &Control::default(),
        |prompt, _| {
            assert!(prompt.contains("新的对应任务说明"));
            assert!(!prompt.contains("PRIVATE_PEER_SENTINEL"));
            Ok(report(prompt, "检查配合条件"))
        },
    )
    .unwrap();
    assert_eq!(condition(&f, &id).dependencies.len(), 2);
    assert_eq!(condition(&f, &id).remaining, 2);
    assert_eq!(
        f.c()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM agent_actions", [], |r| r.get(0))
            .unwrap(),
        0
    );
}

fn ready_at(f: &Fixture, anchor: EvidenceLocator, grant: Grant, quote: &str) -> String {
    let view=super::super::ui(&f.root,&json!({"action":"create","goal":"核查条件变化","successCriteria":"有来源依据","anchor":anchor,"grant":grant})).unwrap();
    let id = view["work"]["id"].as_str().unwrap().to_string();
    let (work, run) = claim(f, &id);
    runner::investigate(&f.root, &work, &run, &Control::default(), |prompt, _| {
        Ok(report(prompt, quote))
    })
    .unwrap();
    configure(&f.root, &json!({"id":id,"confirmed":true,"onChange":true})).unwrap();
    id
}
#[test]
fn task_changes_narrow_to_the_known_task_and_binding_changes_pause_without_a_model() {
    let f = Fixture::new();
    f.note("craft", "doc", "父页");
    f.c().execute_batch("INSERT INTO craft_task_blocks(space_id,document_id,block_id,title,completed,source_hash) VALUES('craft','doc','one','检查配合条件',0,'a'),('craft','doc','other','PRIVATE_SENTINEL',0,'b');").unwrap();
    let locator = EvidenceLocator::Task {
        library_id: "craft".into(),
        source_id: "one".into(),
    };
    let id = ready_at(
        &f,
        locator.clone(),
        Grant {
            library_ids: vec!["craft".into()],
            ..Default::default()
        },
        "检查配合条件",
    );
    let v = condition(&f, &id);
    let w = store::load(&f.c(), &id).unwrap();
    f.c()
        .execute(
            "UPDATE craft_task_blocks SET completed=1 WHERE block_id='one'",
            [],
        )
        .unwrap();
    let sample = sample_on(&f.root, &f.c(), &w, &v.dependencies).unwrap();
    assert_ne!(sample, v.baseline);
    let scope = narrowed(
        &w,
        &affected(
            &w,
            &v,
            &json!({"reason":"knownDependencyChanged","sample":sample}),
        ),
    );
    assert!(scope.grant.library_ids.is_empty());
    assert_eq!(scope.grant.sources, vec![locator]);
    let excerpt = scope
        .grant
        .reader(&f.root)
        .unwrap()
        .read(scope.anchor.as_ref().unwrap(), 0, 20_000, None)
        .unwrap();
    assert!(!excerpt.content.contains("PRIVATE_SENTINEL"));
    f.c().execute_batch("INSERT INTO unified_task_bindings(hub_task_id,provider,library_id,source_id,last_seen_at) VALUES('new-binding','craft','craft','one',1); UPDATE agent_watch_conditions SET next_check_at=0;").unwrap();
    assert!(tick(&f.root).unwrap().is_none());
    assert!(!condition(&f, &id).enabled);
    assert_eq!(condition(&f, &id).remaining, 3);
}
#[test]
fn attachment_reextraction_waits_without_calls_then_original_runner_publishes_current_input() {
    let f = Fixture::new();
    let (job, input) = crate::attachment_evidence::tests::seed(&f, "pdf-watch", "第一版");
    crate::attachment_evidence::tests::produce(&f, &job, &input, "检查配合条件：先测量");
    let chunk: String = f
        .c()
        .query_row(
            "SELECT id FROM content_items WHERE source_item_id='pdf-watch'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let locator = EvidenceLocator::Attachment {
        library_id: "notes".into(),
        document_id: "attachment-doc".into(),
        source_item_id: "pdf-watch".into(),
        chunk_id: chunk,
        page_number: Some(1),
    };
    let id = ready_at(
        &f,
        locator,
        Grant {
            attachment_library_ids: vec!["notes".into()],
            ..Default::default()
        },
        "检查配合条件",
    );
    f.c().execute_batch("UPDATE source_items SET modified_at=2,status='discovered' WHERE id='pdf-watch';UPDATE agent_watch_conditions SET next_check_at=0;").unwrap();
    for _ in 0..2 {
        assert!(tick(&f.root).unwrap().is_none());
        f.c()
            .execute("UPDATE agent_watch_conditions SET next_check_at=0", [])
            .unwrap();
    }
    assert!(condition(&f, &id).enabled);
    assert_eq!(condition(&f, &id).remaining, 3);
    assert_eq!(
        f.c()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM agent_runs", [], |r| r.get(0))
            .unwrap(),
        1
    );
    let current = crate::attachment_evidence::input_on(&f.c(), "notes", "pdf-watch").unwrap();
    crate::attachment_evidence::tests::produce(&f, &job, &current, "检查配合条件：测量后记录结果");
    let (work, run) = begin(&f, &id);
    assert_eq!(condition(&f, &id).message, "正在按约定复查已知来源");
    let deps = condition(&f, &id).dependencies;
    runner::investigate(
        &f.root,
        &narrowed(&work, &deps),
        &run,
        &Control::default(),
        |prompt, _| {
            assert!(prompt.contains("测量后记录结果"));
            assert!(!prompt.contains("检查配合条件：先测量"));
            Ok(report(prompt, "检查配合条件"))
        },
    )
    .unwrap();
    assert_eq!(condition(&f, &id).remaining, 2);
    assert!(condition(&f, &id).running.is_none());
}
#[test]
fn markdown_line_changes_pause_instead_of_rebinding_another_task() {
    let f = Fixture::new();
    f.note("notes", "lines", "- [ ] 检查配合条件");
    let id = ready_at(
        &f,
        EvidenceLocator::Task {
            library_id: "notes".into(),
            source_id: "lines:line:1".into(),
        },
        Grant {
            library_ids: vec!["notes".into()],
            ..Default::default()
        },
        "检查配合条件",
    );
    f.note("notes", "lines", "- [ ] 另一件事\n- [ ] 检查配合条件");
    f.c()
        .execute("UPDATE agent_watch_conditions SET next_check_at=0", [])
        .unwrap();
    assert!(tick(&f.root).unwrap().is_none());
    assert!(!condition(&f, &id).enabled);
    assert_eq!(condition(&f, &id).remaining, 3);
}
fn ready() -> (Fixture, String) {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    let id = create(&f, false);
    let (work, run) = claim(&f, &id);
    runner::investigate(&f.root, &work, &run, &Control::default(), |prompt, _| {
        Ok(report(prompt, "检查配合条件"))
    })
    .unwrap();
    configure(&f.root, &json!({"id":id,"confirmed":true,"onChange":true})).unwrap();
    (f, id)
}
fn condition(f: &Fixture, id: &str) -> Condition {
    load(&f.c(), id).unwrap().unwrap()
}
fn begin(f: &Fixture, id: &str) -> (Work, String) {
    let v = condition(f, id);
    let run = format!("condition-{}", crate::random_url_safe(12));
    let work = store::write(&f.root, |c| {
        claim_on(c, id, &run, &v, &json!({"reason":"knownDependencyChanged"}))
    })
    .unwrap();
    (work, run)
}
#[test]
fn unchanged_or_unrelated_sources_do_not_start_models_or_create_runs() {
    let (f, id) = ready();
    f.note("notes", "unrelated", "PRIVATE_SENTINEL");
    for _ in 0..2 {
        f.c()
            .execute("UPDATE agent_watch_conditions SET next_check_at=0", [])
            .unwrap();
        assert!(tick(&f.root).unwrap().is_none());
    }
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(condition(&f, &id).remaining, 3);
    assert_eq!(
        crate::model_runtime::ui(&f.root, &json!({"action":"status"})).unwrap()["jobs"],
        json!([])
    );
}

#[test]
fn agreed_review_is_explicit_one_time_and_does_not_repeat_after_delivery() {
    let (f, id) = ready();
    assert!(configure(&f.root, &json!({"id":id,"onChange":true})).is_err());
    assert!(configure(&f.root, &json!({"id":id,"confirmed":true,"dueAt":now()-1})).is_err());
    configure(
        &f.root,
        &json!({"id":id,"confirmed":true,"dueAt":now()+20_000,"onChange":false}),
    )
    .unwrap();
    let v = condition(&f, &id);
    let run = "agreed-review";
    let work = store::write(&f.root, |c| {
        claim_on(c, &id, run, &v, &json!({"reason":"agreedReview"}))
    })
    .unwrap();
    assert!(condition(&f, &id).due_at.is_none());
    runner::investigate(&f.root, &work, run, &Control::default(), |prompt, _| {
        Ok(report(prompt, "检查配合条件"))
    })
    .unwrap();
    assert!(!condition(&f, &id).enabled);
    assert_eq!(condition(&f, &id).remaining, 2);
    assert!(tick(&f.root).unwrap().is_none());
}
#[test]
fn finite_claims_publish_through_the_real_runner_and_pause_after_three() {
    let (f, id) = ready();
    for index in 0..3 {
        f.note("notes", "current", &format!("检查配合条件，版本 {index}"));
        let (work, run) = begin(&f, &id);
        let v = condition(&f, &id);
        runner::investigate(
            &f.root,
            &narrowed(&work, &v.dependencies),
            &run,
            &Control::default(),
            |prompt, _| Ok(report(prompt, "检查配合条件")),
        )
        .unwrap();
        let updated = condition(&f, &id);
        assert_eq!(updated.remaining, 2 - index);
        assert!(updated.running.is_none());
        assert_eq!(
            updated.baseline,
            sample_on(&f.root, &f.c(), &work, &updated.dependencies).unwrap()
        );
    }
    assert!(!condition(&f, &id).enabled);
    let v = condition(&f, &id);
    assert!(store::write(&f.root, |c| claim_on(c, &id, "fourth", &v, &json!({}))).is_err());
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        4
    );
}
#[test]
fn pause_during_generation_prevents_late_publication_and_keeps_progress() {
    let (f, id) = ready();
    let (work, run) = begin(&f, &id);
    assert!(
        runner::investigate(&f.root, &work, &run, &Control::default(), |prompt, _| {
            pause(&f.root, &id, "用户已暂停").unwrap();
            Ok(report(prompt, "检查配合条件"))
        })
        .unwrap_err()
        .contains("已暂停")
    );
    assert_eq!(
        f.c()
            .query_row(
                "SELECT COUNT(*) FROM agent_records WHERE kind='delivery'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert!(store::records(&f.root, &id, "evidence", 20).unwrap().len() >= 2);
}
#[test]
fn restart_does_not_replay_claimed_work_and_reconciles_it_as_interrupted() {
    let (f, id) = ready();
    let (_, run) = begin(&f, &id);
    f.c()
        .execute("UPDATE agent_watch_conditions SET next_check_at=0", [])
        .unwrap();
    assert!(tick(&f.root).unwrap().is_none());
    assert!(!condition(&f, &id).enabled);
    let work = store::load(&f.c(), &id).unwrap();
    assert!(work.active_run.is_none());
    assert_eq!(work.state, "interrupted");
    assert_eq!(
        f.c()
            .query_row("SELECT state FROM agent_runs WHERE id=?1", [run], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        "interrupted"
    );
}
#[test]
fn changed_decision_revocation_and_corrupt_watch_cannot_revive_old_authority() {
    let (f, id) = ready();
    let old = condition(&f, &id);
    store::decision(&f.root, &id, "改用新验证条件").unwrap();
    assert!(!condition(&f, &id).enabled);
    assert!(store::write(&f.root, |c| claim_on(c, &id, "stale", &old, &json!({}))).is_err());
    f.c()
        .execute(
            "UPDATE agent_watch_conditions SET body_json='broken',enabled=1",
            [],
        )
        .unwrap();
    store::revoke(&f.root, &id).unwrap();
    assert_eq!(
        store::view(&f.root, &id).unwrap()["work"]["state"],
        "revoked"
    );
    assert_eq!(view_on(&f.c(), &id).unwrap()["enabled"], false);
}
#[test]
fn focused_run_keeps_unchanged_dependencies_watched_and_does_not_acknowledge_later_edits() {
    let (f, id) = ready();
    f.note("notes", "second", "旧决定");
    let extra = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: "second".into(),
        page_id: None,
    };
    // Explicitly extend the fixture's host grant, as a new authorized work would.
    let mut work = store::load(&f.c(), &id).unwrap();
    work.grant.notes.push(extra.clone());
    f.c()
        .execute(
            "UPDATE agent_works SET grant_json=?2 WHERE id=?1",
            params![id, serde_json::to_string(&work.grant).unwrap()],
        )
        .unwrap();
    let mut v = condition(&f, &id);
    v.dependencies.push(extra.clone());
    v.baseline = sample_on(&f.root, &f.c(), &work, &v.dependencies).unwrap();
    save(&f.c(), &id, &v, 0).unwrap();
    f.note("notes", "current", "检查配合条件，来源改变");
    let sample = sample_on(&f.root, &f.c(), &work, &v.dependencies).unwrap();
    let focused = affected(
        &work,
        &v,
        &json!({"reason":"knownDependencyChanged","sample":sample}),
    );
    assert_eq!(focused, vec![work.anchor.clone().unwrap()]);
    let (claimed, run) = begin(&f, &id);
    runner::investigate(
        &f.root,
        &narrowed(&claimed, &focused),
        &run,
        &Control::default(),
        |prompt, _| {
            assert!(!prompt.contains("旧决定"));
            assert!(!prompt.contains("\"documentId\":\"second\""));
            // This change happens during generation, before publication.
            f.note("notes", "second", "新的决定");
            Ok(report(prompt, "检查配合条件"))
        },
    )
    .unwrap();
    let v = condition(&f, &id);
    assert!(v.dependencies.contains(&extra));
    let sample = sample_on(&f.root, &f.c(), &work, &v.dependencies).unwrap();
    assert_ne!(v.baseline, sample);
    let next = affected(
        &work,
        &v,
        &json!({"reason":"knownDependencyChanged","sample":sample}),
    );
    assert!(next.contains(&extra));
    assert_eq!(v.remaining, 2);
}

#[test]
fn a_new_bound_peer_during_generation_blocks_the_narrowed_delivery() {
    let f = Fixture::new();
    f.note("craft", "doc", "父页");
    f.c().execute_batch("INSERT INTO craft_task_blocks(space_id,document_id,block_id,title,completed,source_hash) VALUES('craft','doc','one','检查配合条件',0,'a');
        INSERT INTO dida_tasks(library_id,task_id,project_id,title,content,raw_json,last_seen_at) VALUES('dida','peer','project','对应任务','对应说明','{}',1);
        INSERT INTO unified_task_bindings(hub_task_id,provider,library_id,source_id,last_seen_at) VALUES('bound-one','craft','craft','one',1);").unwrap();
    let anchor = EvidenceLocator::Task {
        library_id: "craft".into(),
        source_id: "one".into(),
    };
    let id = ready_at(
        &f,
        anchor.clone(),
        Grant {
            library_ids: vec!["craft".into(), "dida".into()],
            ..Default::default()
        },
        "检查配合条件",
    );
    let (work, run) = begin(&f, &id);
    let error = runner::investigate(&f.root, &narrowed(&work, &[anchor]), &run, &Control::default(), |prompt, _| {
        f.c().execute_batch("INSERT INTO unified_task_bindings(hub_task_id,provider,library_id,source_id,last_seen_at) VALUES('bound-one','dida365','dida','peer',1);").unwrap();
        Ok(report(prompt, "检查配合条件"))
    }).unwrap_err();
    assert!(error.contains("对应关系"), "{error}");
    assert_eq!(
        f.c()
            .query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM agent_records WHERE run_id=?1 AND kind='delivery'",
                [&run],
                |r| r.get(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn automatic_review_prefetches_only_the_focused_current_attachment_within_budget() {
    let (f, id) = ready();
    let (job, input) = crate::attachment_evidence::tests::seed(&f, "prefetch-pdf", "版本一");
    crate::attachment_evidence::tests::produce(&f, &job, &input, "旧附件依据");
    let chunk: String = f
        .c()
        .query_row(
            "SELECT id FROM content_items WHERE source_item_id='prefetch-pdf'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let attachment = EvidenceLocator::Attachment {
        library_id: "notes".into(),
        document_id: "attachment-doc".into(),
        source_item_id: "prefetch-pdf".into(),
        chunk_id: chunk,
        page_number: Some(1),
    };
    let mut work = store::load(&f.c(), &id).unwrap();
    work.grant.sources.push(attachment.clone());
    f.c()
        .execute(
            "UPDATE agent_works SET grant_json=?2 WHERE id=?1",
            params![id, serde_json::to_string(&work.grant).unwrap()],
        )
        .unwrap();
    let mut v = condition(&f, &id);
    v.dependencies.push(attachment.clone());
    v.baseline = sample_on(&f.root, &f.c(), &work, &v.dependencies).unwrap();
    save(&f.c(), &id, &v, 0).unwrap();
    f.c()
        .execute(
            "UPDATE source_items SET modified_at=2 WHERE id='prefetch-pdf'",
            [],
        )
        .unwrap();
    let current = crate::attachment_evidence::input_on(&f.c(), "notes", "prefetch-pdf").unwrap();
    crate::attachment_evidence::tests::produce(&f, &job, &current, "当前附件依据：8毫米");
    let sample = sample_on(&f.root, &f.c(), &work, &v.dependencies).unwrap();
    let focused = affected(
        &work,
        &v,
        &json!({"reason":"knownDependencyChanged","sample":sample}),
    );
    let (work, run) = begin(&f, &id);
    runner::investigate(
        &f.root,
        &narrowed(&work, &focused),
        &run,
        &Control::default(),
        |prompt, _| {
            assert!(prompt.contains("当前附件依据：8毫米"));
            assert!(!prompt.contains("旧附件依据"));
            let material: Value =
                serde_json::from_str(prompt.split("宿主材料(JSON):\n").nth(1).unwrap()).unwrap();
            assert!(material["continuation"]["currentRunGoal"]
                .as_str()
                .unwrap()
                .contains("本轮变更来源"));
            assert_eq!(material["usage"]["entitiesRead"], 2);
            assert!(material["usage"]["bodyChars"].as_u64().unwrap() <= 5000);
            Ok(report(prompt, "检查配合条件"))
        },
    )
    .unwrap();
    assert_eq!(condition(&f, &id).remaining, 2);
}
#[test]
fn a_global_daily_budget_blocks_reenabling_into_unbounded_runs() {
    let (f, id) = ready();
    for _ in 0..10 {
        store::write(&f.root, |c| {
            store::insert(c, &id, None, "conditionTrigger", &json!({"readOnly":true}))
        })
        .unwrap();
    }
    let v = condition(&f, &id);
    assert!(
        eligible(&f.c(), &store::load(&f.c(), &id).unwrap(), &v, now())
            .unwrap_err()
            .contains("24 小时")
    );
}
#[test]
fn formal_backup_restore_retains_idle_conditions_without_absolute_process_identity() {
    let (f, id) = ready();
    let v = condition(&f, &id);
    let base = std::env::temp_dir().join(format!(
        "hub-condition-backup-{}",
        crate::random_url_safe(12)
    ));
    std::fs::create_dir(&base).unwrap();
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let options = crate::data_backup::BackupOptions {
        destination: base
            .join("conditions.hubbackup")
            .to_string_lossy()
            .into_owned(),
        include_external_sources: false,
    };
    let backup = crate::data_backup::backup(&f.root, &options, &cancel, &mut |_| {}).unwrap();
    let target = base.join("restored");
    crate::data_backup::restore(Path::new(&backup.path), &target, &cancel, &mut |_| {}).unwrap();
    let c = crate::database::open_database(&target.join("craft-search.sqlite3")).unwrap();
    let restored = load(&c, &id).unwrap().unwrap();
    assert_eq!(restored.generation, v.generation);
    assert!(restored.enabled && restored.running.is_none());
    let raw = serde_json::to_string(&restored).unwrap();
    assert!(!raw.contains(&f.root.to_string_lossy().to_string()));
    assert!(tick(&target).unwrap().is_none());
    drop(c);
    assert_eq!(base.parent(), Some(std::env::temp_dir().as_path()));
    std::fs::remove_dir_all(base).unwrap();
}
