use super::*;
use crate::agent_work::{store, Grant};
use crate::obsidian_edit::tests::Fixture;
use crate::source_evidence::EvidenceLocator;
use serde_json::{json, Value};
use std::time::Instant;

#[test]
fn native_database_session_preserves_wal_freshness_and_run_guards() {
    let f = Fixture::new();
    let doc = f.seed("Diary.md", DIARY);
    let anchor = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: doc,
        page_id: None,
    };
    let id = store::create(
        &f.root,
        "离线检查主睡眠宿主存储".into(),
        "保持来源与完成校验".into(),
        anchor.clone(),
        Grant {
            notes: vec![anchor],
            ..Default::default()
        },
    )
    .unwrap();
    let run = "offline-storage";
    let work = store::claim(&f.root, &id, run).unwrap();
    let wal = f.root.join("craft-search.sqlite3-wal");
    let mut times = Vec::<Value>::new();
    // Actual production record transactions, not SQL substitutes or a model.
    // A-B-A includes a return to the original lifetime after the warm phase.
    for phase in ["unheld_before", "held", "unheld_after"] {
        let started = Instant::now();
        let session = (phase == "held").then(|| hold(&f.root).unwrap());
        let open_ms = started.elapsed().as_secs_f64() * 1000.0;
        for index in 0..3 {
            let started = Instant::now();
            store::record(
                &f.root,
                run,
                "offlineProbe",
                &json!({"phase":phase,"index":index}),
            )
            .unwrap();
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            let retained = wal.exists();
            assert_eq!(
                retained,
                session.is_some(),
                "last-connection lifecycle changed"
            );
            times.push(json!({"phase":phase,"index":index,"recordMs":ms,"walRetained":retained,"sessionOpenMs":open_ms}));
        }
        if let Some(session) = &session {
            assert!(session.is_autocommit());
            assert_eq!(
                store::records(&f.root, &id, "offlineProbe", 32)
                    .unwrap()
                    .len(),
                6
            );
            // An idle connection must not pin a historical snapshot or block
            // checkpoints/other writers. Keep the normal durability settings.
            let checkpoint: (i64, i64, i64) = session
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .unwrap();
            assert_eq!(checkpoint, (0, 0, 0));
            assert!(session.is_autocommit());
        }
        let started = Instant::now();
        drop(session);
        let close_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert!(!wal.exists(), "turn owner must release its WAL on exit");
        times.push(json!({"phase":phase,"sessionCloseMs":close_ms}));
    }
    let session = hold(&f.root).unwrap();
    let failure: Result<(), String> = (|| {
        let _nested_session = hold(&f.root)?;
        Err("offline injected callback failure".into())
    })();
    assert!(failure.is_err());
    // The outer owner remains usable; the error path owns no writer permit.
    store::write(&f.root, |c| {
        c.execute(
            "UPDATE agent_works SET authorization_version=authorization_version+1 WHERE id=?1",
            [&id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        store::load(&session, &id).unwrap().authorization_version,
        work.authorization_version + 1
    );
    assert!(store::check_run(&f.root, &work, run)
        .unwrap_err()
        .contains("授权"));
    store::write(&f.root, |c| store::reconcile_on(c, &id, run)).unwrap();
    assert!(store::record(&f.root, run, "offlineProbe", &json!({"late":true})).is_err());
    assert_eq!(
        store::records(&f.root, &id, "offlineProbe", 32)
            .unwrap()
            .len(),
        9
    );
    assert!(session.is_autocommit());
    drop(session);
    assert!(!wal.exists());
    assert_eq!(
        std::fs::read_to_string(f.vault.join("Diary.md")).unwrap(),
        DIARY
    );
    let c = f.c();
    assert_eq!(
        c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM agent_actions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    if let Ok(directory) = std::env::var("HUB_AGENT_NATIVE_REPORT") {
        std::fs::write(Path::new(&directory).join("offline-store-timing.json"), serde_json::to_vec_pretty(&json!({
            "kind":"offline production store A-B-A", "realModelCalls":0,"sourceBytes":DIARY.len(),
            "samples":times,"timingAssertions":false,"walLifecycleAssertions":true,
            "freshAuthorizationRead":true,"endedRunRejected":true,"checkpointUnblocked":true
        })).unwrap()).unwrap();
    }
}
const DIARY: &str = "# 2025-01-01\n学习 学习 💤e\u{301}\n昨夜主睡眠实际睡了7小时。复核更正：实际主睡眠6.5小时。午睡半小时。\n# 2025-01-02\n学习\n昨夜主睡眠实际睡了8小时。六个多小时是旧估计。\n# 2025-02-01\n学习\n昨晚两点睡，七点起；中间醒过，实际睡眠时长不清楚。\n";
