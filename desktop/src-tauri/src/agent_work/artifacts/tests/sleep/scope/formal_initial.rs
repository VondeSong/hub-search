//! Opt-in fixed-input arrangement only. No model or new runtime framework.
use super::*;

fn prepare_work(f: &Fixture, goal: &str, notes: &[Value]) -> String {
    ui(&f.root,&json!({"action":"create","goal":goal,"successCriteria":"仅使用本用例授权输入；原文只读；出处、版本、完成与预算均按冻结清单","anchor":notes[0],"grant":{"libraryIds":[],"notes":notes,"readingItemKeys":[]}})).unwrap()["work"]["id"].as_str().unwrap().into()
}

fn seed_chart(f: &Fixture, id: &str, numeric: bool) {
    let run = "fixed-initial-state-not-model";
    let work = store::claim(&f.root, id, run).unwrap();
    let snapshot = analysis::execute(
        &work.grant.reader(&f.root).unwrap(),
        "hub_create_analysis_snapshot",
        &json!({}),
    )
    .unwrap();
    let request = if numeric {
        let source = analysis::execute(
            &work.grant.reader(&f.root).unwrap(),
            "hub_read_analysis_snapshot",
            &json!({"expectedSnapshot":snapshot["snapshot"],"itemIndex":0,"start":0,"limit":8000}),
        )
        .unwrap();
        let mut request = json!({"action":"create","operationId":"fixed-reference-dataset","expectedSnapshot":snapshot["snapshot"],"methodRef":"V1-fixed-initial-reference-not-model","inclusionRule":"仅明确实际主睡眠，排除午睡、旧估计、歧义，不补零","dateRule":"ISO记录日，Asia/Shanghai","rows":labeled(&source)});
        // labeled() intentionally starts at7 in correction tests. A formal
        // seed must instead honor the source's already-written correction.
        request["rows"][0] = row(
            &source,
            "jan1",
            "2025-01-01",
            "复核更正：实际主睡眠6.5小时。",
            Some(6.5),
        );
        for row in request["rows"].as_array_mut().unwrap() {
            row["reviewBasis"]["reason"] =
                json!("冻结合成参考初态，由正式生产入口建立；不是本轮模型自主抽取成绩");
        }
        chart_request(&dataset(f, &work, run, &request).unwrap())
    } else {
        json!({"action":"create","operationId":"fixed-keyword-bar","analysis":{"expectedSnapshot":snapshot["snapshot"],"unit":"day","groupBy":"month","terms":["学习"]},"spec":{"title":"学习提及次数","mark":"bar","metric":"occurrences","term":"学习","sort":"groupAsc"}})
    };
    let chart = call(f, &work, run, &request);
    if numeric {
        assert_eq!(chart["content"]["data"]["rows"][0]["value"], 7.25);
        let rows = &chart["content"]["data"]["extractionDataset"]["rows"];
        assert_eq!(rows[0]["normalizedValue"], 6.5);
        assert_eq!(rows[0]["evidenceRefs"][0]["start"], 36);
        assert_eq!(rows[0]["evidenceRefs"][0]["end"], 52);
        assert_eq!(rows[1]["normalizedValue"], 8.0);
        assert!(rows[2]["normalizedValue"].is_null());
    }
    call(
        f,
        &work,
        run,
        &json!({"action":"validate","artifactId":chart["artifactId"],"revision":chart["revision"]}),
    );
    let report = accepted_report(
        f,
        &work,
        run,
        "冻结参考初态（由正式生产入口建立，非模型生成；不计正式成绩）",
    );
    publish(f, &work, run, &report).unwrap();
}

#[test]
#[ignore = "fixed formal initialization only; requires explicit project-owned output and frozen inputs; no model"]
fn v1_prepare_all_formal_initial_states_once() {
    let output_root = PathBuf::from(std::env::var("HUB_V1_FORMAL_ROOT").unwrap());
    let base = PathBuf::from(std::env::var("HUB_V1_FORMAL_BASE").unwrap());
    let case_dir = PathBuf::from(std::env::var("HUB_V1_CASE_INPUTS").unwrap());
    let positive = PathBuf::from(std::env::var("HUB_V1_POSITIVE_INPUTS").unwrap());
    let plan: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("HUB_V1_CASE_MANIFEST").unwrap()).unwrap(),
    )
    .unwrap();
    assert!(
        !output_root.exists(),
        "never replace an existing formal initialization"
    );
    std::fs::create_dir_all(&output_root).unwrap();
    let canonical_root = output_root.canonicalize().unwrap();
    assert!(canonical_root.to_string_lossy().contains(".local"));
    let sleep = std::fs::read_to_string(positive.join("main-sleep.md")).unwrap();
    let keyword = std::fs::read_to_string(positive.join("keyword.md")).unwrap();
    assert_eq!(sleep, DIARY);
    assert_eq!(keyword, ORIGINAL);
    let locator = |library: &str, id: &str| json!({"kind":"note","libraryId":library,"documentId":id,"pageId":null});
    let mut prepared = Vec::new();
    let cases: Vec<usize> = std::env::var("HUB_V1_FORMAL_CASES")
        .map(|value| {
            value
                .split(',')
                .map(|v| v.parse::<usize>().unwrap())
                .collect()
        })
        .unwrap_or_else(|_| (1..=10).collect());
    assert!(!cases.is_empty() && cases.iter().all(|v| (1..=10).contains(v)));
    for case in 1..=10 {
        if !cases.contains(&case) {
            continue;
        }
        for attempt in 1..=3 {
            let root = output_root.join(format!("{case:02}-{attempt}"));
            std::fs::create_dir(&root).unwrap();
            assert!(root.canonicalize().unwrap().starts_with(&canonical_root));
            for name in [
                "craft-search.sqlite3",
                "analysis-snapshots.sqlite3",
                ".hub-isolated-runtime-v1",
                "analysis-snapshot-policy.json",
                "library-controls-v1.json",
            ] {
                std::fs::copy(base.join(name), root.join(name)).unwrap();
            }
            // Keep the fixture at its final owned path, so its index and source
            // locations are never copied from a deleted temporary directory.
            let f = std::mem::ManuallyDrop::new(Fixture { root: root.clone() });
            f.c().execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('v1-fixtures','obsidian','V1 固定夹具',1,1)",[]).unwrap();
            let original = store::load(&f.c(), "work-51jPUBTnFFHQTdgNZoR_5bcK").unwrap();
            let mut notes = vec![serde_json::to_value(&original.anchor).unwrap()];
            let mut extra = Value::Null;
            let goal = plan["cases"][case - 1]["originalGoal"].as_str().unwrap();
            if matches!(case, 2 | 7) {
                notes.clear();
                for (id, name) in [
                    ("comparison-a", "comparison-a.md"),
                    ("comparison-b", "comparison-b.md"),
                ] {
                    f.note(
                        "v1-fixtures",
                        id,
                        &std::fs::read_to_string(case_dir.join(name)).unwrap(),
                    );
                    notes.push(locator("v1-fixtures", id));
                }
            } else if matches!(case, 4 | 5 | 6 | 8 | 10) {
                f.note(
                    "v1-fixtures",
                    "current",
                    if case == 6 { &keyword } else { &sleep },
                );
                notes = vec![locator("v1-fixtures", "current")];
            } else if matches!(case, 3 | 9) {
                notes = serde_json::to_value(&original.grant.notes)
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .clone();
                assert_eq!(notes.len(), 26);
            }
            // UX-01 retains the exact fresh UI create flow, rather than a
            // pre-registered goal that would turn its submission into revision.
            let initial_goal = if case == 6 {
                "根据所选三日期材料，按月生成“学习”次数柱图，在当前事项保留图表、报告及出处。"
            } else if matches!(case, 5 | 8 | 10) {
                "依据冻结合成三日期记录提取主睡眠实际时长并按月平均，在当前事项保留图表和报告供后续修订，不修改来源。"
            } else {
                goal
            };
            let id = if case == 1 {
                None
            } else {
                Some(prepare_work(&f, initial_goal, &notes))
            };
            if matches!(case, 5 | 6 | 8 | 10) {
                seed_chart(&f, id.as_ref().unwrap(), case != 6);
            }
            if case == 3 {
                f.note(
                    "v1-fixtures",
                    "coverage-branches",
                    &std::fs::read_to_string(case_dir.join("coverage-branches.md")).unwrap(),
                );
                let scope = vec![locator("v1-fixtures", "coverage-branches")];
                let coverage_id=prepare_work(&f,"核对2025年1至3月“学习”的次数及提及天数，说明重复日期段、空月和无日期文字；无材料不补零。",&scope);
                extra = json!({"coverageBranchWorkId":coverage_id,"scope":scope});
            }
            if case == 7 {
                let w = store::load(&f.c(), id.as_ref().unwrap()).unwrap();
                let reader = w.grant.reader(&f.root).unwrap();
                let snapshot =
                    analysis::execute(&reader, "hub_create_analysis_snapshot", &json!({})).unwrap();
                let first=analysis::execute(&reader,"hub_read_analysis_snapshot",&json!({"expectedSnapshot":snapshot["snapshot"],"itemIndex":0,"start":0,"limit":8000})).unwrap();
                assert!(first["content"].as_str().unwrap().contains("方案 A"));
                extra = json!({"snapshot":snapshot["snapshot"],"firstActualReadEntry":"production analysis::execute hub_read_analysis_snapshot","firstActualReadIndex":0,"firstActualReadSourceVersion":first["sourceRevision"],"firstActualReadSucceededBeforeAnyInjection":true,"faultNotInjectedYet":true,"modelRecoveryQuestion":"仅用该固定快照核对方案B的范围、验证次数及保存授权；来源暂不可用时有界恢复，不换用当前版本冒充固定输入。","permanentBranch":"reset exact baseline, production UI revoke after initial actual read; confirm current permission denial and no false completion"});
            }
            f.index();
            let current = id.as_ref().map(|id| store::view(&f.root, id).unwrap());
            if let Some(view) = &current {
                assert!(view["work"]["activeRun"].is_null());
                assert_eq!(f.c().query_row("SELECT COUNT(*) FROM agent_works WHERE id=?1 AND active_run IS NOT NULL",[id.as_ref().unwrap()],|r|r.get::<_,i64>(0)).unwrap(),0);
                if matches!(case, 5 | 6 | 8 | 10) {
                    assert_eq!(view["work"]["state"], "completed");
                    assert_eq!(view["analysisArtifacts"][0]["state"], "checked");
                } else {
                    assert_eq!(view["work"]["state"], "ready");
                }
            }
            f.c()
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .unwrap();
            let item = json!({"caseId":format!("UX-{case:02}"),"attempt":attempt,"profile":root,"workId":id,"scope":notes,"state":current.as_ref().map(|v|v["work"]["state"].clone()),"initialArtifactRefs":current.as_ref().map(|v|v["analysisArtifacts"].clone()),"initialDatasetRefs":current.as_ref().map(|v|v["sleepDatasets"].clone()),"extra":extra,"modelCalls":0,"formalScore":null,"seedIsDeterministicReferenceNotAutonomousSuccess":true});
            std::fs::write(
                root.join("initial-state.json"),
                serde_json::to_vec_pretty(&item).unwrap(),
            )
            .unwrap();
            prepared.push(item);
        }
    }
    assert_eq!(prepared.len(), cases.len() * 3);
    std::fs::write(
        output_root.join("initial-states.json"),
        serde_json::to_vec_pretty(&prepared).unwrap(),
    )
    .unwrap();
}
