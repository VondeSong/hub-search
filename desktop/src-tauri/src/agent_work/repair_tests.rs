use super::*;
use crate::source_evidence::tests::Fixture;

fn rejected_format() -> String {
    "模型返回格式不符合要求，未提交结果，请重试。 [$.report.waitCondition: type]".into()
}

#[test]
fn anchor_prefetch_covers_a_normal_page_tail_and_respects_a_smaller_body_budget() {
    for limit in [1000, 15000] {
        let f = Fixture::new();
        let body = format!(
            "检查配合条件\n{}\nTAIL_REQUIRED_FOR_COMPARISON",
            "段".repeat(3500)
        );
        f.note("notes", "current", &body);
        let id = tests::create(&f, false);
        let (work, run) = tests::claim(&f, &id);
        let mut budget = Budget::mode("quick").unwrap();
        budget.body_chars = limit;
        runner::investigate_budget(
            &f.root,
            &work,
            &run,
            &Control::default(),
            budget,
            |prompt, _| {
                assert_eq!(
                    prompt.contains("TAIL_REQUIRED_FOR_COMPARISON"),
                    limit > 1000
                );
                Ok(tests::report(prompt, "检查配合条件"))
            },
        )
        .unwrap();
        let view = store::view(&f.root, &id).unwrap();
        assert!(view["run"]["usage"]["bodyChars"].as_u64().unwrap() <= limit as u64);
        assert_eq!(view["evidence"][0]["truncated"], limit == 1000);
    }
}

fn named_work(f: &Fixture, goal: &str) -> (Work, String) {
    let created=ui(&f.root,&json!({"action":"create","goal":goal,"successCriteria":"引用点名的资料","anchor":{"kind":"note","libraryId":"notes","documentId":"current","pageId":null},"grant":{"libraryIds":["notes"],"notes":[],"sources":[],"readingItemKeys":[],"attachmentLibraryIds":[]}})).unwrap();
    f.index();
    tests::claim(f, created["work"]["id"].as_str().unwrap())
}

#[test]
fn explicit_title_is_read_before_generation_instead_of_a_keyword_neighbor() {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    f.note("notes", "BOM", "采购按独立件号列出");
    f.note(
        "notes",
        "normative",
        "BOM BOM BOM EBOM 采购 MBOM UNRELATED_NORMATIVE_BODY",
    );
    let (work, run) = named_work(&f, "对比《current》和《BOM》，分别引用原文");
    runner::investigate(&f.root, &work, &run, &Control::default(), |prompt, _| {
        assert!(prompt.contains("hostNamedRead"));
        assert!(!prompt.contains("UNRELATED_NORMATIVE_BODY"));
        let mut answer = tests::report(prompt, "采购按独立件号列出");
        answer["report"]["nextSteps"] = json!([]);
        Ok(answer)
    })
    .unwrap();
    let view = store::view(&f.root, &work.id).unwrap();
    assert_eq!(view["run"]["usage"]["modelCalls"], 1);
    assert_eq!(view["run"]["usage"]["toolSteps"], 2);
    assert_eq!(view["evidence"].as_array().unwrap().len(), 2);
    assert_eq!(view["evidence"][1]["locator"]["documentId"], "BOM");
}

#[test]
fn ambiguous_explicit_titles_are_candidates_without_an_arbitrary_body_read() {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    f.note("notes", "a", "BOM 来源 A");
    f.note("notes", "b", "BOM 来源 B");
    f.c()
        .execute("UPDATE documents SET title='BOM' WHERE id IN ('a','b')", [])
        .unwrap();
    let (work, run) = named_work(&f, "查阅《BOM》并核对范围");
    runner::investigate(&f.root, &work, &run, &Control::default(), |prompt, _| {
        let material: Value =
            serde_json::from_str(prompt.split("宿主材料(JSON):\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            material["observations"][1]["exactMatches"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(material["quoteCatalog"]
            .as_array()
            .unwrap()
            .iter()
            .all(|q| q["evidenceId"] == "e1"));
        let mut answer = tests::report(prompt, "检查配合条件");
        answer["report"]["status"] = json!("needsDecision");
        answer["report"]["questions"] = json!(["请指定要查阅的同名笔记"]);
        answer["report"]["nextSteps"] = json!([]);
        Ok(answer)
    })
    .unwrap();
    assert_eq!(
        store::view(&f.root, &work.id).unwrap()["evidence"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn explicit_titles_never_expand_the_grant_to_a_private_library() {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    f.note("private", "BOM", "BOM PRIVATE_NAMED_SOURCE_SENTINEL");
    let (work, run) = named_work(&f, "查阅《BOM》并说明缺失证据");
    runner::investigate(&f.root, &work, &run, &Control::default(), |prompt, _| {
        assert!(!prompt.contains("PRIVATE_NAMED_SOURCE_SENTINEL"));
        let mut answer = tests::report(prompt, "检查配合条件");
        answer["report"]["status"] = json!("insufficientEvidence");
        answer["report"]["nextSteps"] = json!([]);
        Ok(answer)
    })
    .unwrap();
    assert_eq!(
        store::view(&f.root, &work.id).unwrap()["evidence"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn search_reads_one_ranked_unread_source_with_real_versioned_evidence_and_shared_budgets() {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    f.note("notes", "comparison", "信息架构比较：标签应保持克制");
    f.note("private", "secret", "信息架构比较：PRIVATE_OUTSIDE_GRANT");
    let id = tests::create(&f, true);
    f.index();
    let (work, run) = tests::claim(&f, &id);
    let mut calls = 0;
    runner::investigate(&f.root,&work,&run,&Control::default(),|prompt,_| {
        calls+=1;
        assert!(!prompt.contains("PRIVATE_OUTSIDE_GRANT"));
        if calls==1 {
            return Ok(json!({"rationale":"查阅对比材料","requests":[{"operation":"search","sourceKind":"note","query":"信息架构比较","limit":5},{"operation":"search","sourceKind":"note","query":"信息架构比较","limit":5}],"report":null}));
        }
        assert!(prompt.contains("hostSearchRead"));
        assert!(prompt.contains("信息架构比较：标签应保持克制"));
        let mut report=tests::report(prompt, "信息架构比较：标签应保持克制");
        report["report"]["nextSteps"]=json!([]);
        Ok(report)
    }).unwrap();
    let view = store::view(&f.root, &id).unwrap();
    assert_eq!(view["run"]["usage"]["entitiesRead"], 2);
    assert_eq!(view["run"]["usage"]["toolSteps"], 3);
    assert_eq!(view["evidence"].as_array().unwrap().len(), 2);
    assert_eq!(
        store::records(&f.root, &id, "evidence", 10).unwrap().len(),
        2
    );
    assert_eq!(view["evidence"][1]["locator"]["documentId"], "comparison");
}

#[test]
fn search_cannot_auto_read_when_the_tool_or_body_budget_is_exhausted() {
    for bound in ["tools", "body"] {
        let f = Fixture::new();
        f.note("notes", "current", "检查配合条件");
        f.note("notes", "comparison", "信息架构比较：不应进入已用尽的预算");
        let id = tests::create(&f, true);
        f.index();
        let (work, run) = tests::claim(&f, &id);
        let mut budget = Budget::mode("quick").unwrap();
        if bound == "tools" {
            budget.tool_steps = 1;
        } else {
            budget.body_chars = "检查配合条件".chars().count();
        }
        let mut calls = 0;
        runner::investigate_budget(&f.root,&work,&run,&Control::default(),budget,|prompt,_| {
            calls+=1;
            if calls>1 {assert!(prompt.contains("\"reads\":[]"));assert!(!prompt.contains("hostSearchRead"));}
            if calls==1 {Ok(json!({"rationale":"检索","requests":[{"operation":"search","sourceKind":"note","query":"信息架构比较","limit":5}],"report":null}))}
            else {Ok(tests::report(prompt, "检查配合条件"))}
        }).unwrap();
        let view = store::view(&f.root, &id).unwrap();
        assert_eq!(view["run"]["usage"]["entitiesRead"], 1);
        assert_eq!(view["run"]["usage"]["toolSteps"], 1);
    }
}

#[test]
fn rejected_schema_gets_one_same_run_correction_and_no_invalid_dispatch() {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    let id = tests::create(&f, false);
    let (work, run) = tests::claim(&f, &id);
    let mut calls = 0;
    runner::investigate(&f.root, &work, &run, &Control::default(), |prompt, _| {
        calls += 1;
        if calls == 1 {
            return Err(rejected_format());
        }
        assert!(prompt.contains("outputRejected"));
        assert!(prompt.contains("$.report.waitCondition"));
        Ok(tests::report(prompt, "检查配合条件"))
    })
    .unwrap();
    let view = store::view(&f.root, &id).unwrap();
    assert_eq!(calls, 2);
    assert_eq!(view["run"]["id"], run);
    assert_eq!(view["run"]["usage"]["outputRepairs"], 1);
    assert_eq!(view["run"]["usage"]["modelCalls"], 2);
    assert_eq!(view["work"]["state"], "completed");
    assert!(store::records(&f.root, &id, "toolCall", 10)
        .unwrap()
        .is_empty());
}

#[test]
fn final_draft_has_a_bounded_correction_with_exact_quote_path_and_final_schema() {
    for recover in [true, false] {
        let f = Fixture::new();
        f.note("notes", "current", "检查**配合**条件");
        let id = tests::create(&f, false);
        let (work, run) = tests::claim(&f, &id);
        let mut calls = 0;
        let result = runner::investigate(
            &f.root,
            &work,
            &run,
            &Control::default(),
            |prompt, schema| {
                calls += 1;
                if calls <= 2 {
                    return Ok(
                        json!({"rationale":"核对原文","report":null,"requests":[{"operation":"read","locator":{"kind":"note","libraryId":"notes","documentId":"current","pageId":null},"startChar":0,"maxChars":20,"expectedVersion":null}]}),
                    );
                }
                assert_eq!(schema["properties"]["requests"]["maxItems"], 0);
                assert_eq!(schema["properties"]["report"]["type"], "object");
                if calls == 4 {
                    assert!(prompt.contains("findings[0].citations[0].quote"));
                    assert!(prompt.contains("reportRejected"));
                }
                Ok(tests::report(
                    prompt,
                    if calls == 4 && recover {
                        "检查**配合**条件"
                    } else {
                        "检查配合条件"
                    },
                ))
            },
        );
        assert_eq!(result.is_ok(), recover);
        assert_eq!(calls, 4);
        let view = store::view(&f.root, &id).unwrap();
        assert_eq!(view["run"]["usage"]["modelCalls"], 4);
        assert_eq!(view["run"]["usage"]["outputRepairs"], 1);
        assert_eq!(
            store::records(&f.root, &id, "reportRejected", 10)
                .unwrap()
                .len(),
            if recover { 1 } else { 2 }
        );
        assert_eq!(view["work"]["report"].is_null(), !recover);
    }
}

#[test]
fn correction_can_read_missing_evidence_without_spending_another_investigation_call() {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    let id = tests::create(&f, false);
    let (work, run) = tests::claim(&f, &id);
    let mut calls = 0;
    runner::investigate(&f.root, &work, &run, &Control::default(), |prompt, _| {
        calls += 1;
        if calls == 2 { return Ok(tests::report(prompt, "不在实际读取范围")); }
        if calls < 4 {
            return Ok(json!({"rationale":"补读取证","report":null,"requests":[{"operation":"read","locator":{"kind":"note","libraryId":"notes","documentId":"current","pageId":null},"startChar":0,"maxChars":20,"expectedVersion":null}]}));
        }
        Ok(tests::report(prompt, "检查配合条件"))
    }).unwrap();
    assert_eq!(calls, 4);
    assert_eq!(
        store::view(&f.root, &id).unwrap()["run"]["usage"]["outputRepairs"],
        1
    );
}

#[test]
fn invalid_turn_cannot_dispatch_tools_and_only_one_correction_is_allowed() {
    let f = Fixture::new();
    f.note("notes", "current", "检查配合条件");
    let id = tests::create(&f, false);
    let (work, run) = tests::claim(&f, &id);
    let mut calls = 0;
    let result = runner::investigate(&f.root, &work, &run, &Control::default(), |prompt, _| {
        calls += 1;
        let mut response = tests::report(prompt, "检查配合条件");
        response["requests"] = json!([{"operation":"read","locator":{"kind":"note","libraryId":"private","documentId":"secret","pageId":null},"startChar":0,"maxChars":20,"expectedVersion":null}]);
        Ok(response)
    });
    assert!(result.is_err());
    assert_eq!(calls, 2);
    assert!(store::records(&f.root, &id, "toolCall", 10)
        .unwrap()
        .is_empty());
    assert!(store::view(&f.root, &id).unwrap()["work"]["report"].is_null());
}

#[test]
fn output_correction_rechecks_source_cancel_deadline_and_never_retries_authentication() {
    for case in ["source", "cancel", "deadline", "auth"] {
        let f = Fixture::new();
        f.note("notes", "current", "检查配合条件");
        let id = tests::create(&f, false);
        let (work, run) = tests::claim(&f, &id);
        let control =
            Control::bounded(Duration::from_secs(if case == "deadline" { 1 } else { 60 }));
        let mut calls = 0;
        let result = runner::investigate(&f.root, &work, &run, &control, |_prompt, _| {
            calls += 1;
            match case {
                "source" => f.note("notes", "current", "来源已改变，不得重发旧内容"),
                "cancel" => control.cancel(),
                _ => (),
            }
            Err(if case == "auth" {
                "DeepSeek 鉴权失败，请检查模型设置中的密钥。".into()
            } else {
                rejected_format()
            })
        });
        assert!(result.is_err(), "{case}");
        assert_eq!(calls, 1, "{case}");
        assert!(store::view(&f.root, &id).unwrap()["work"]["report"].is_null());
    }
}
