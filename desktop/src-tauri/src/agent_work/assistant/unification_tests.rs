use super::*;
use crate::obsidian_edit::tests::Fixture;

#[test]
#[ignore = "Opt-in: real Codex chooses statistical tools and rebuilds changed source snapshots"]
fn installed_native_agent_computes_actual_statistics_and_rebuilds_changed_sources() {
    let f = Fixture::new();
    let first = f.seed(
        "January.md",
        "无日期前言\n# 2025-01-01\n学习 学习\n# 2025-01-02\n工作\n",
    );
    let second = f.seed("Duplicate.md", "@2025年1月1日\n学习\n");
    f.seed("Unselected.md", "# 2025-01-09\n学习 SECRET_UNSELECTED\n");
    let a = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: first,
        page_id: None,
    };
    let b = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: second,
        page_id: None,
    };
    let prompt="只分析本次明确选中的两份材料。按独立日期标题统计记录天数，同一天重复标题按一天算；按月给出关键词‘学习’的提及天数和文字次数，说明重复日期和无日期前言的限制。必须实际计算，不凭片段估算。只读，不生成草稿或修改。";
    let id = store::create(
        &f.root,
        prompt.into(),
        "以真实统计回执为准，范围不得扩大".into(),
        a.clone(),
        Grant {
            notes: vec![a, b],
            ..Default::default()
        },
    )
    .unwrap();
    options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    let mut cases = Vec::new();
    let mut previous = Value::Null;
    for(case,text,expected)in [("first",prompt,2),("changed", "重新按相同口径统计当前这两份材料，核对当前来源后给出更新的记录天数与学习提及天数，不沿用旧计数。",3),("simple","只回复收到，不查询、不统计、不调用技能或制作工具。",0)] {
        if case=="changed" {f.seed("January.md","无日期前言\n# 2025-01-01\n学习 学习\n# 2025-01-02\n工作\n# 2025-01-03\n学习\n");}
        ui(&f.root,&json!({"action":"message","id":id,"clientMessageId":format!("statistics-{case}"),"text":text})).unwrap();
        let result=ui(&f.root,&json!({"action":"respond","id":id,"mode":"deep"}));
        let view=store::view(&f.root,&id).unwrap();
        let session=store::records(&f.root,&id,"nativeSession",1).unwrap().first().cloned().unwrap_or(Value::Null);
        let c=f.c();let mut q=c.prepare("SELECT kind,body_json FROM agent_records WHERE run_id=?1 AND kind IN ('toolCall','toolResult') ORDER BY rowid").unwrap();
        let events=q.query_map([view["run"]["id"].as_str().unwrap_or_default()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap().map(|row|{let(kind,body)=row.unwrap();json!({"kind":kind,"body":serde_json::from_str::<Value>(&body).unwrap()})}).collect::<Vec<_>>();drop(q);drop(c);
        cases.push(json!({"case":case,"result":result,"view":view,"session":session,"events":events}));
        if let Ok(report)=std::env::var("HUB_AGENT_STATISTICS_REPORT") {std::fs::write(report,serde_json::to_vec_pretty(&json!({"cases":cases})).unwrap()).unwrap();}
        result.unwrap();
        if case=="simple" {assert_eq!(view["work"]["report"]["prose"]["markdown"].as_str().unwrap().trim(),"收到");assert!(!events.iter().any(|e|e["kind"]=="toolCall"));assert_eq!(previous,session["threadId"]);}else{
            assert!(events.iter().any(|e|e["kind"]=="toolCall" && e["body"]["operation"]=="capability" && e["body"]["name"]=="hub_analyze_notes"),"{events:?}");
            assert!(events.iter().any(|e| e["kind"]=="toolResult" && e["body"]["analysisUnit"]=="uniqueDatePerLibrary" && e["body"]["documentsAnalyzed"]==2 && e["body"]["totals"]["units"]==expected && e["body"]["totals"]["terms"].as_array().is_some_and(|terms| terms.iter().any(|t|t["term"]=="学习" && t["matchingUnits"]==expected-1 && t["occurrences"]==expected+1))),"{events:?}");
            if case=="changed" {assert_ne!(previous,session["threadId"]);}
            assert!(!view["work"]["report"].to_string().contains("SECRET_UNSELECTED"));
            assert!(view["work"]["report"]["prose"]["markdown"].as_str().unwrap().contains(&expected.to_string()));
        }
        assert!(view["actions"]["items"].as_array().unwrap().is_empty());previous=session["threadId"].clone();
    }
}

#[test]
#[ignore = "Opt-in: real Codex shared capabilities and scoped AGENTS.md; isolated synthetic data only"]
fn installed_native_agent_shared_tools_obey_rules_and_rebuild_changed_context() {
    let f = Fixture::new();
    let doc = f.seed(
        "Study.md",
        "---\ntags: [agent-proof]\n---\n# 学习\n通过主动回忆检查理解。\n",
    );
    let anchor = EvidenceLocator::Note {
        library_id: "notes".into(),
        document_id: doc,
        page_id: None,
    };
    let id = store::create(
        &f.root,
        "查询本库已使用的标签目录与实际使用量，只读。".into(),
        "使用真实工具结果并遵守本库工作约定".into(),
        anchor,
        Grant {
            library_ids: vec!["notes".into()],
            ..Default::default()
        },
    )
    .unwrap();
    options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    let path = f.vault.join("AGENTS.md");
    let mut cases = Vec::new();
    let mut thread = Value::Null;
    for (case, marker, prompt) in [
        (
            "first",
            "RULE-A12",
            "查询当前知识库已使用的标签目录，给出实际使用量。只查询，不创建建议、草稿或修改。",
        ),
        (
            "changed",
            "RULE-B34",
            "再次查询当前知识库已使用的标签目录，按当前库约定答复。只查询，不创建或修改。",
        ),
        (
            "simple",
            "RULE-B34",
            "只回复收到两个字，不需要查询、技能、制作或保存。",
        ),
    ] {
        std::fs::write(&path,format!("本库所有标签分析报告末尾单独写一行：规则标记 {marker}。该标记是工作约定，不是来源证据，不要为它生成引用。遵守当前用户明确要求；没有标签分析就不添加标记。\n")).unwrap();
        ui(&f.root,&json!({"action":"message","id":id,"clientMessageId":format!("unification-{case}"),"text":prompt})).unwrap();
        let result = ui(&f.root, &json!({"action":"respond","id":id,"mode":"deep"}));
        let view = store::view(&f.root, &id).unwrap();
        let session = store::records(&f.root, &id, "nativeSession", 1)
            .unwrap()
            .first()
            .cloned()
            .unwrap_or(Value::Null);
        let c = f.c();
        let mut query=c.prepare("SELECT body_json FROM agent_records WHERE run_id=?1 AND kind='toolCall' ORDER BY rowid").unwrap();
        let calls = query
            .query_map([view["run"]["id"].as_str().unwrap_or_default()], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
            .map(|row| serde_json::from_str::<Value>(&row.unwrap()).unwrap())
            .collect::<Vec<_>>();
        drop(query);
        drop(c);
        cases
            .push(json!({"case":case,"result":result,"view":view,"session":session,"calls":calls}));
        if let Ok(report) = std::env::var("HUB_AGENT_UNIFICATION_REPORT") {
            std::fs::write(
                report,
                serde_json::to_vec_pretty(&json!({"cases":cases})).unwrap(),
            )
            .unwrap();
        }
        result.unwrap();
        let markdown = view["work"]["report"]["prose"]["markdown"]
            .as_str()
            .unwrap();
        if case == "simple" {
            assert_eq!(markdown.trim(), "收到");
            assert!(calls.is_empty());
        } else {
            assert!(markdown.contains(marker), "{markdown}");
            assert!(markdown.contains("agent-proof"), "{markdown}");
            assert!(
                calls
                    .iter()
                    .any(|c| c["operation"] == "capability" && c["name"] == "hub_tag_catalog"),
                "{calls:?}"
            );
        }
        if case == "changed" {
            assert_ne!(thread, session["threadId"]);
        }
        if case == "simple" {
            assert_eq!(thread, session["threadId"]);
        }
        thread = session["threadId"].clone();
        assert!(view["actions"]["items"].as_array().unwrap().is_empty());
    }
}
