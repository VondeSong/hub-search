//! Frozen synthetic examples: retain every run, including failed deliveries.
use super::*;
use crate::source_evidence::tests::Fixture;
#[test]
#[ignore = "four bounded real-model quality samples in isolated synthetic profiles"]
fn frozen_completion_quality_once() {
    assert_eq!(
        std::env::var("HUB_INSIGHTS_COMPLETION_LIVE").as_deref(),
        Ok("1")
    );
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".local/insights-completion-quality-20261114");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(out.join("attempt-started"))
        .expect("retain each attempt; repairs need separate evidence");
    for id in ["C1", "C2", "C3", "C4"] {
        let f = Fixture::new();
        std::fs::write(
            f.root.join(".hub-isolated-runtime-v1"),
            b"Hub isolated runtime v1\n",
        )
        .unwrap();
        let (work, input) = if id == "C4" {
            let create = json!({"action":"insightEntrySave","operationId":"decision-create","entry":{"kind":"decision","title":"工具选择（合成验收）","body":"这是回忆补记，不是当时的独立日志。","choice":"先试免费工具A","options":"A或B","reasons":"当时认为A可以读取块属性，且免费。","decidedAt":"2026-11-01","assumptions":[{"text":"A可读取图纸块属性"}]}});
            let e = super::super::ui(&f.root, &create).unwrap()["entry"].clone();
            let observed=super::super::ui(&f.root,&json!({"action":"insightEntryObserve","entryId":e["id"],"expectedVersion":1,"operationId":"decision-observe","assumptionId":e["assumptions"][0]["id"],"text":"11月8日同一张样图中，A能读普通文字，读不到块属性；尚未试B。","occurredAt":"2026-11-08"})).unwrap()["entry"].clone();
            let adopt = json!({"action":"insightEntryAdopt","entryId":e["id"],"expectedVersion":2,"operationId":"decision-adopt","observationIds":[observed["observations"][0]["id"]]});
            super::super::ui(&f.root, &adopt).unwrap();
            (
                e["workId"].as_str().unwrap().to_owned(),
                json!({"create":create,"observation":observed["observations"],"rubric":"区分补记和当时理由；精确指出块属性假设受影响，不编造选择动机或宣称B可用"}),
            )
        } else {
            let (a,b,q)=match id{
    "C1"=>("之前用一份最小输入核对输出字段，遇到缺字段就先停下修正，再扩大批次。","批次是仓库货物标识，这篇说明只讲运输标签，没有谈验证方法。","准备批量转换资料，已有记录里有什么可以借用的检验办法？请排除同词但不相关材料。"),
    "C2"=>("记录只列出了周末想去的地点，还没有路线、交通耗时或天气。","这是上周的电影收藏，尚未观看。","明天出门最快的路线和确切耗时是什么？只用已选材料，不能联网补齐或推算。"),
    _=>("11月8日：桌面原型纸面样本检查通过，真实设备验证尚未进行。没有改期历史。","11月9日：计划周末做真实设备检查，当前仍是计划。","核对明确任务与笔记：当前到底完成到哪一步？能否判断任务拖延？不要改任务状态。")};
            f.note("notes", "a", a);
            f.note("notes", "b", b);
            f.note(
                "private",
                "secret",
                "UNSELECTED_SENTINEL_B：直接购买，已经完成全部实机验证。",
            );
            let mut grant = Grant {
                notes: ["a", "b"]
                    .iter()
                    .map(|s| EvidenceLocator::Note {
                        library_id: "notes".into(),
                        document_id: (*s).into(),
                        page_id: None,
                    })
                    .collect(),
                ..Default::default()
            };
            let task = json!({"kind":"task","libraryId":"craft","sourceId":"one"});
            if id == "C3" {
                f.note("craft", "doc", "核对资料");
                f.c().execute_batch("INSERT INTO craft_task_blocks(space_id,document_id,block_id,title,completed,source_hash,content) VALUES('craft','doc','one','真实设备验证',0,'one','当前未勾选；未导入改期历史');").unwrap();
                grant
                    .sources
                    .push(serde_json::from_value(task.clone()).unwrap());
            }
            let work = store::write(&f.root, |c| {
                store::create_on(
                    c,
                    "合成验收：资料关系".into(),
                    "依真实原文回答，资料不足保留未知，不改变来源".into(),
                    None,
                    grant,
                )
            })
            .unwrap();
            let w = work_on(&f.c(), &work).unwrap();
            ui(&f.root,&json!({"action":"insightAnalysisPrepare","id":work,"expectedRevision":w.revision,"operationId":"prepare","mode":if id=="C3"{"status"}else{"semantic"},"task":task,"question":q})).unwrap();
            (
                work,
                json!({"notes":[a,b],"question":q,"unselectedSentinel":"UNSELECTED_SENTINEL_B","rubric":if id=="C1"{"找到近义的先小样检验再扩批方法；排除运输标签，给出引用和适用条件"}else if id=="C2"{"明确资料不足，不编路线/耗时，不把收藏当看过"}else{"并列任务未勾选与纸面通过/实机未做；无改期历史不能判断拖延，不改任务"}}),
            )
        };
        super::super::super::ui(&f.root,&json!({"action":"configureAssistant","id":work,"options":{"model":{"provider":"codex","model":"gpt-6.1-sol","reasoningEffort":"","fast":false,"maxConcurrent":2},"autoFlashcardInbox":false,"externalMcp":false}})).unwrap();
        std::fs::write(
            out.join(format!("{id}-input.json")),
            serde_json::to_vec_pretty(&json!({"input":input,"maximumUserRuns":1})).unwrap(),
        )
        .unwrap();
        let result = super::super::super::run_mode(
            &f.root,
            &work,
            assistant::budget("quick").unwrap(),
            true,
        );
        let status = super::super::super::ui(&f.root, &json!({"action":"status","id":work}));
        let executions = store::records(&f.root, &work, "modelExecution", 50).unwrap();
        std::fs::write(
            out.join(format!("{id}-output.json")),
            serde_json::to_vec_pretty(
                &json!({"result":result,"status":status,"executions":executions}),
            )
            .unwrap(),
        )
        .unwrap();
    }
}
