use super::*;
use crate::source_evidence::tests::Fixture;

fn note(id: &str) -> EvidenceLocator {
    EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: id.into(),
        page_id: None,
    }
}
fn setup(whole: bool) -> (Fixture, String) {
    let f = Fixture::new();
    for (id, body) in [
        ("current", "验证前固定输入、预期结果与通过条件。"),
        ("method", "孔位验证：先测量，再用小样本核对接口。"),
        ("distractor", "旧椅子的孔位需要修补，与电气接口无关。"),
        ("other", "上周完成了阅读计划。"),
        ("unselected", "孔位验证 PRIVATE_UNSELECTED"),
    ] {
        f.note("notes", id, body);
    }
    f.note("private", "secret", "孔位验证 PRIVATE_LIBRARY");
    f.index();
    let grant = Grant {
        notes: vec![
            note("current"),
            note("method"),
            note("distractor"),
            note("other"),
        ],
        library_ids: if whole { vec!["notes".into()] } else { vec![] },
        ..Default::default()
    };
    let v=super::super::super::ui(&f.root,&json!({"action":"create","goal":"验证接口时哪些旧知识可复用？","successCriteria":"只报告授权范围内有依据的候选，保留原文与不确定性","anchor":note("current"),"grant":grant})).unwrap();
    (f, v["work"]["id"].as_str().unwrap().to_owned())
}
fn search(f: &Fixture, id: &str, q: &str) -> Value {
    ui(
        &f.root,
        &json!({"action":"insightRecall","id":id,"query":q}),
    )
    .unwrap()
}

#[test]
fn keyword_baseline_records_relevant_ambiguous_no_answer_and_alias_limits_without_writes() {
    let (f, id) = setup(false);
    let before = f
        .c()
        .query_row("SELECT count(*) FROM agent_records", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap();
    let rows = [
        ("验证", vec!["current", "method"]),
        ("输入", vec!["current"]),
        ("接口", vec!["method", "distractor"]),
        ("孔位", vec!["method", "distractor"]),
        ("阅读", vec!["other"]),
        ("降噪耳机", vec![]),
        ("验收门槛", vec![]),
    ];
    let mut observed = Vec::new();
    for (query, expected) in rows {
        let start = std::time::Instant::now();
        let result = search(&f, &id, query);
        let ids: Vec<_> = result["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["locator"]["documentId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, expected);
        assert_eq!(result["scopeCount"], 4);
        assert_eq!(result["exhaustive"], false);
        assert!(!result.to_string().contains("PRIVATE_"));
        observed.push(
            json!({"query":query,"ids":ids,"elapsedMs":start.elapsed().as_secs_f64()*1000.0}),
        );
    }
    assert_eq!(
        f.c()
            .query_row("SELECT count(*) FROM agent_records", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert_eq!(
        f.c()
            .query_row("SELECT count(*) FROM agent_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    if let Ok(path) = std::env::var("HUB_INSIGHTS_RECALL_REPORT") {
        std::fs::write(path,serde_json::to_vec_pretty(&json!({"cases":observed,"noModel":true,"unselectedLeaks":0,"semanticLimit":"同词无关仍可命中，近义改写可漏召；候选不得标成关联成立"})).unwrap()).unwrap();
    }
}

#[test]
fn source_open_rechecks_grant_version_deletion_and_revocation() {
    let (f, id) = setup(false);
    let result = search(&f, &id, "验证");
    let hit = &result["candidates"][0];
    let mut request = json!({"action":"insightRecallSource","id":id,"locator":hit["locator"],"version":hit["version"]});
    let source = ui(&f.root, &request).unwrap();
    assert!(source["content"].as_str().unwrap().contains("通过条件"));
    request["locator"] = serde_json::to_value(note("unselected")).unwrap();
    assert!(ui(&f.root, &request).is_err());
    request["locator"] = hit["locator"].clone();
    f.note("notes", "current", "验证条件已改写");
    assert!(ui(&f.root, &request).unwrap_err().contains("版本"));
    store::revoke(&f.root, &id).unwrap();
    assert!(ui(
        &f.root,
        &json!({"action":"insightRecall","id":id,"query":"验证"})
    )
    .is_err());
}

#[test]
fn whole_library_and_invalid_queries_cannot_expand_the_pilot() {
    let (f, id) = setup(true);
    assert!(ui(
        &f.root,
        &json!({"action":"insightRecall","id":id,"query":"孔位"})
    )
    .unwrap_err()
    .contains("整库"));
    let (f, id) = setup(false);
    for query in ["".to_owned(), " ".to_owned(), "字".repeat(121)] {
        assert!(ui(
            &f.root,
            &json!({"action":"insightRecall","id":id,"query":query})
        )
        .is_err());
    }
}
