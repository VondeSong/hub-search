//! Frozen positive-quality samples; one real run each, never retry to select an answer.
use super::*;
#[test]
#[ignore = "five bounded real model evaluations in an isolated synthetic profile"]
fn frozen_quality_samples_once() {
    assert_eq!(std::env::var("HUB_STAGE_REVIEW_LIVE").as_deref(), Ok("1"));
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".local/stage-review-quality-20261114-repair2");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(out.join("attempt-started"))
        .expect("retain actual attempt; a repair requires a separate named attempt");
    for (id,notes,question,extra) in [
  ("Q1","2026-11-02 列出三个方案。2026-11-05 用同一张图纸验证，发现第二个方案无法读取块属性。2026-11-07 补了属性检查，纸面样本已通过，尚未实机验证。","这段记录有哪些具体进展和可复用的经验？",true),
  ("Q2","2026-11-03 明天计划买牛奶。","记录中计划购买什么？只回答这个问题。",false),
  ("Q3","最近消费似乎多了，日期和金额没记清。","本月净支出多少？",true),
  ("Q4","2026-11-02 加班后取消运动，改为看剧。2026-11-03 加班后仍去跑步。2026-11-04 没加班，但也取消运动。","这些记录能否说明加班导致不运动？",true),
  ("Q5","本人记录：2026-11-02 加班后取消运动，改为看剧；2026-11-05 加班后取消运动，改为看剧。转贴内容：2026-11-06 看到文章说“所有加班都会损害健康”。","请围绕这些笔记开放探索，有依据时提出值得核对的线索。",true),
 ]{
  if std::env::var("HUB_STAGE_REVIEW_CASE").ok().is_some_and(|wanted|wanted!=id){continue;}
  let root=out.join(id);std::fs::create_dir_all(&root).unwrap();std::fs::write(root.join(".hub-isolated-runtime-v1"),b"Hub isolated runtime v1\n").unwrap();drop(crate::open_database(&root.join("craft-search.sqlite3")).unwrap());
  let mut p=json!({"perspective":"open","question":question,"themes":[],"focus":"","month":"2026-11","cutoff":"2026-11-14T00:00:00+08:00","dateOnly":true,"extraDiscoveries":extra});
  p["question"]=json!(format!("{} 请用阶段回顾工具核对本次输入。发现可以为空；如确有值得保存的独立发现，先绑定实际出处及性质再通过 hub_finish 交付，不凑数量。",question));
  let v=ui(&root,&json!({"action":"insightReviewPrepare","operationId":crate::random_url_safe(16),"plan":p,"input":{"text":notes,"nature":if id=="Q5"{"unknown"}else{"selfReport"}}})).unwrap();
  let work=v["workId"].as_str().unwrap();
  super::super::super::ui(&root,&json!({"action":"configureAssistant","id":work,"options":{"model":{"provider":"codex","model":"gpt-6.1-sol","reasoningEffort":"","fast":false,"maxConcurrent":2},"autoFlashcardInbox":false,"externalMcp":false}})).unwrap();
  std::fs::write(out.join(format!("{id}-input.json")),serde_json::to_vec_pretty(&json!({"plan":p,"notes":notes,"extraDiscoveries":extra,"rubric":"desktop/docs/INSIGHTS_STAGE_REVIEW.md","maximumUserRuns":1})).unwrap()).unwrap();
  let result=super::super::super::run_mode(&root,work,assistant::budget("quick").unwrap(),true);
  let status=super::super::super::ui(&root,&json!({"action":"status","id":work}));
  let records=store::records(&root,work,"modelExecution",50).unwrap();
  std::fs::write(out.join(format!("{id}-output.json")),serde_json::to_vec_pretty(&json!({"result":result,"status":status,"executions":records})).unwrap()).unwrap();
  // Keep every failure in evidence and continue the frozen sample set.
 }
}

#[test]
#[ignore = "one real extraction and deterministic money calculation from synthetic natural input"]
fn natural_money_fixture_once() {
    assert_eq!(std::env::var("HUB_STAGE_REVIEW_LIVE").as_deref(), Ok("1"));
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".local/stage-review-money-20261114");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(out.join("attempt-started"))
        .unwrap();
    let root = out.join("profile");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join(".hub-isolated-runtime-v1"),
        b"Hub isolated runtime v1\n",
    )
    .unwrap();
    drop(crate::open_database(&root.join("craft-search.sqlite3")).unwrap());
    let notes="这是合成验收账本。两期均为账户A、币种CNY，11月1日至8日的支出和退款覆盖完整。2026-11-02 交易F：餐饮实际支出500元；2026-11-03 交易M：医疗实际支出300元；2026-11-04 交易R：医疗退款100元，按退款发生期抵减；2026-11-04 交易T：内部转账900元，不是消费；另一次导入重复收录了同一交易M（2026-11-03 医疗300元），不是新支出。上期2025-11-02交易P：餐饮实际支出500元，上期没有其他支出或退款。";
    let plan = json!({"perspective":"year","question":"比较这两期已记录净支出，使用阶段回顾工具实际提取候选并计算，解释差额来自哪里，保留重复与排除依据。不要心算代替工具，也不要把合成验收当作我的真实消费。","themes":["消费"],"focus":"","month":"2026-11","cutoff":"2026-11-09T09:00:00+08:00","dateOnly":true,"extraDiscoveries":false});
    let v=ui(&root,&json!({"action":"insightReviewPrepare","operationId":crate::random_url_safe(16),"plan":plan,"input":{"text":notes,"nature":"quotation"}})).unwrap();
    let work = v["workId"].as_str().unwrap();
    super::super::super::ui(&root,&json!({"action":"configureAssistant","id":work,"options":{"model":{"provider":"codex","model":"gpt-6.1-sol","reasoningEffort":"","fast":false,"maxConcurrent":2},"autoFlashcardInbox":false,"externalMcp":false}})).unwrap();
    std::fs::write(out.join("input.json"),serde_json::to_vec_pretty(&json!({"plan":plan,"notes":notes,"expected":{"current":"700.00","previous":"500.00","difference":"200.00","percent":"40.00"},"maximumUserRuns":1})).unwrap()).unwrap();
    let result =
        super::super::super::run_mode(&root, work, assistant::budget("quick").unwrap(), true);
    let status = super::super::super::ui(&root, &json!({"action":"status","id":work}));
    let c = crate::source_evidence::open_read_database(&root).unwrap();
    let calculations = records(&c, work, "reviewCalculation").unwrap();
    std::fs::write(
        out.join("output.json"),
        serde_json::to_vec_pretty(
            &json!({"result":result,"status":status,"calculations":calculations}),
        )
        .unwrap(),
    )
    .unwrap();
    result.unwrap();
    assert!(
        calculations.iter().any(
            |v| v["metrics"]
                .as_array()
                .is_some_and(|a| a.iter().any(|m| m["current"] == "700.00"
                    && m["previous"] == "500.00"
                    && m["difference"] == "200.00"
                    && m["percent"] == "40.00"))
        ),
        "retain actual failed extraction instead of substituting fixture rows"
    );
}
