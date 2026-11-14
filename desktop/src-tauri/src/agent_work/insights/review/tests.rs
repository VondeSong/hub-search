use super::*;
use crate::source_evidence::tests::Fixture;
fn config(perspective: &str) -> Value {
    json!({"perspective":perspective,"question":"核对经历和支出","themes":[],"focus":"","month":"2026-11","cutoff":"2026-11-09T09:00:00+08:00","dateOnly":true,"extraDiscoveries":true})
}
const NOTES:&str="本人账本，同一人民币账户，两个窗口覆盖完整，去年餐饮500元。本期事件：2026-11-02 餐饮500；2026-11-03 医疗300；2026-11-04 医疗退款100；2026-11-04 内部转账900；2026-11-03 医疗300重复导入。上期事件：2025-11-02 餐饮500。明确支出记录与退款均为实际交易。";
struct Case {
    f: Fixture,
    work: Work,
    run: String,
    input: String,
    notes: String,
}
impl Case {
    fn new(notes: &str, perspective: &str) -> Self {
        let f = Fixture::new();
        let v=ui(&f.root,&json!({"action":"insightReviewPrepare","operationId":crate::random_url_safe(12),"plan":config(perspective),"input":{"text":notes,"nature":"selfReport"}})).unwrap();
        let input = format!("{}:v1", v["inputs"][0]["id"].as_str().unwrap());
        let run = format!("review-test-{}", crate::random_url_safe(12));
        let work = store::claim(&f.root, v["workId"].as_str().unwrap(), &run).unwrap();
        Self {
            f,
            work,
            run,
            input,
            notes: notes.to_owned(),
        }
    }
    fn refs(&self, quote: &str) -> Value {
        json!([{"refId":self.input,"quote":quote}])
    }
    fn row(&self, id: &str, at: &str, kind: &str, amount: Option<&str>) -> Value {
        json!({"id":id,"eventId":id,"entity":id,"eventDate":at,"kind":kind,"category":"账本","account":if amount.is_some(){Some("主账户")}else{None},"currency":if amount.is_some(){Some("CNY")}else{None},"amount":amount,"valueKind":"exact","duplicateOf":null,"reread":false,"reason":"模型按明确事件和实际金额评审，未声称用户确认","refs":self.refs(&self.notes)})
    }
    fn coverage(&self) -> Value {
        json!({"metric":"expense","account":"主账户","currency":"CNY","current":"verified","previous":"verified","comparable":true,"reason":"原文明确两期同账户完整覆盖","refs":self.refs(&self.notes)})
    }
    fn calculate(&self, rows: Vec<Value>, coverage: Value) -> Result<Value, String> {
        execute(
            &self.f.root,
            &self.work,
            &self.run,
            &json!({"action":"calculate","rows":rows,"coverage":[coverage]}),
            &[],
        )
    }
    fn fixture_rows(&self) -> Vec<Value> {
        let first = self.row("medical", "2026-11-03", "expense", Some("300"));
        let mut duplicate = first.clone();
        duplicate["id"] = json!("medical-copy");
        duplicate["duplicateOf"] = json!("medical");
        vec![
            self.row("food", "2026-11-02", "expense", Some("500")),
            first,
            self.row("refund", "2026-11-04", "refund", Some("100")),
            self.row("transfer", "2026-11-04", "transfer", Some("900")),
            duplicate,
            self.row("prior", "2025-11-02", "expense", Some("500")),
        ]
    }
}
#[test]
fn aligns_event_dates_and_common_cutoff() {
    let c = plan(config("year"), 1794196800000).unwrap();
    assert_eq!(c["windows"][0]["end"], "2026-11-09T00:00:00+08:00");
    assert_eq!(c["windows"][1]["end"], "2025-11-09T00:00:00+08:00");
    let open = plan(config("open"), 1794196800000).unwrap();
    assert_eq!(open["windows"], json!([]));
    assert!(open.get("month").is_none());
    assert!(open.get("cutoff").is_none());
    assert_eq!(open["themes"], json!([]));
}
#[test]
fn refund_transfer_duplicate_fixture_is_700_500_200_40() {
    let c = Case::new(NOTES, "year");
    let result = c.calculate(c.fixture_rows(), c.coverage()).unwrap();
    let m = &result["metrics"][0];
    assert_eq!(m["current"], "700.00");
    assert_eq!(m["previous"], "500.00");
    assert_eq!(m["difference"], "200.00");
    assert_eq!(m["percent"], "40.00");
    assert_eq!(result["excluded"], 2);
    assert!(m["contributions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["category"] == "账本" && r["value"] == "-100.00"));
}
#[test]
fn zero_missing_and_incomparable_are_distinct() {
    for state in ["verified", "missing", "recorded"] {
        let notes = if state == "verified" {
            "本期2026-11-02餐饮500元，去年同期覆盖核实为0元。"
        } else {
            "本期2026-11-02餐饮500元，去年同期资料缺失。"
        };
        let c = Case::new(notes, "year");
        let mut coverage = c.coverage();
        coverage["previous"] = json!(state);
        let r = c
            .calculate(
                vec![c.row("food", "2026-11-02", "expense", Some("500"))],
                coverage,
            )
            .unwrap();
        assert_eq!(r["metrics"][0]["percent"], Value::Null);
        assert_eq!(
            r["metrics"][0]["previous"],
            if state == "verified" {
                json!("0.00")
            } else {
                Value::Null
            }
        );
    }
    let c = Case::new(NOTES, "year");
    let mut coverage = c.coverage();
    coverage["comparable"] = json!(false);
    let r = c.calculate(c.fixture_rows(), coverage).unwrap();
    assert!(r["metrics"][0]["difference"].is_null());
}
#[test]
fn invented_provenance_and_date_are_rejected() {
    let c = Case::new(NOTES, "year");
    let mut row = c.row("food", "2026-11-02", "expense", Some("500"));
    row["refs"][0]["refId"] = json!("e1");
    assert!(c.calculate(vec![row], c.coverage()).is_err());
    let row = c.row("food", "2026-11-07", "expense", Some("500"));
    assert!(c.calculate(vec![row], c.coverage()).is_err());
}
#[test]
fn ambiguity_does_not_become_zero_or_an_exact_event() {
    let c = Case::new(NOTES, "year");
    let mut row = c.row("medical", "2026-11-03", "expense", Some("300"));
    row["valueKind"] = json!("ambiguous");
    row["amount"] = Value::Null;
    let mut coverage = c.coverage();
    coverage["current"] = json!("recorded");
    let r = c.calculate(vec![row], coverage).unwrap();
    assert!(r["metrics"][0]["current"].is_null());
    assert_eq!(r["excluded"], 1);
}
#[test]
fn corrections_mark_only_actual_input_dependencies() {
    let c = Case::new(NOTES, "year");
    let b=execute(&c.f.root,&c.work,&c.run,&json!({"action":"bind","text":"这些记录可能共同反映了安排变化。","nature":"inference","refs":c.refs(NOTES),"calculationId":null,"metricIds":[],"collection":false}),&[]).unwrap();
    let connection = c.f.c();
    let bound = binding(&connection, &c.work, b["reviewRef"].as_str().unwrap()).unwrap();
    assert_eq!(bound["nature"], "inference");
    assert!(verify_dependencies(&c.f.root, &connection, &c.work, &bound).is_ok());
    let input = inputs(&connection, &c.work.id).unwrap()[0].clone();
    store::write(&c.f.root, |db| {
        let mut next = input.clone();
        next["version"] = json!(2);
        next["text"] = json!("更正后的原文");
        store::insert(db, &c.work.id, None, "reviewInput", &next)
    })
    .unwrap();
    assert!(verify_dependencies(&c.f.root, &connection, &c.work, &bound).is_err());
    assert!(accessible(&connection, &c.work, &bound));
}
#[test]
fn collection_changes_do_not_invalidate_an_independent_observation() {
    let c = Case::new(NOTES, "year");
    let calc = c.calculate(c.fixture_rows(), c.coverage()).unwrap();
    let mut independent = calc.clone();
    independent["scopeFingerprint"] = Value::Null;
    store::write(&c.f.root, |db| {
        add_input(
            db,
            &c.work,
            &json!({"text":"2026-11-05 补录医疗支出1000元","nature":"selfReport"}),
            None,
            store::stamp(),
        )
    })
    .unwrap();
    let connection = c.f.c();
    assert!(verify_dependencies(&c.f.root, &connection, &c.work, &calc).is_err());
    assert!(verify_dependencies(&c.f.root, &connection, &c.work, &independent).is_ok());
}
#[test]
fn decimal_arithmetic_rejects_invalid_money() {
    for s in ["NaN", "-1", "1.234", "1e6", "1."] {
        assert!(calculation::minor(s).is_err());
    }
    assert_eq!(calculation::minor("0.10").unwrap(), 10);
}

#[test]
fn full_and_incomplete_leap_months_use_common_complete_days() {
    for (month, cutoff, expected, prior) in [
        (
            "2024-02",
            "2024-03-01T09:00:00+08:00",
            "2024-02-29T00:00:00+08:00",
            "2023-03-01T00:00:00+08:00",
        ),
        (
            "2025-02",
            "2025-03-01T09:00:00+08:00",
            "2025-03-01T00:00:00+08:00",
            "2024-02-29T00:00:00+08:00",
        ),
        (
            "2024-02",
            "2024-02-29T09:00:00+08:00",
            "2024-02-29T00:00:00+08:00",
            "2023-03-01T00:00:00+08:00",
        ),
    ] {
        let mut cfg = config("year");
        cfg["month"] = json!(month);
        cfg["cutoff"] = json!(cutoff);
        cfg["dateOnly"] = json!(false);
        let p = plan(cfg, 1794196800000).unwrap();
        assert_eq!(p["windows"][0]["end"], expected);
        assert_eq!(p["windows"][1]["end"], prior);
        assert!(!p["calendarNote"].as_str().unwrap().is_empty());
    }
}
#[test]
fn record_types_do_not_turn_collections_plans_or_episodes_into_finished_movies() {
    let notes="2026-11-02 收藏A；2026-11-03 读完B；2026-11-04 读完B重复记录；2026-11-05 看剧第1集；2026-11-06 看剧第2集；2026-11-07 计划参加活动。健康记录增加不说明症状变化。";
    let c = Case::new(notes, "month");
    let mut rows = vec![
        c.row("collect", "2026-11-02", "readingCollected", None),
        c.row("finish", "2026-11-03", "readingFinished", None),
        c.row("finish2", "2026-11-04", "readingFinished", None),
        c.row("ep1", "2026-11-05", "episode", None),
        c.row("ep2", "2026-11-06", "episode", None),
        c.row("plan", "2026-11-07", "plan", None),
    ];
    rows[1]["entity"] = json!("B");
    rows[2]["entity"] = json!("B");
    let covers=["readingFinished","episode"].map(|kind|json!({"metric":kind,"account":null,"currency":null,"current":"recorded","previous":"missing","comparable":false,"reason":"仅本期明确记录，不推断全部行为","refs":c.refs(notes)}));
    let v = execute(
        &c.f.root,
        &c.work,
        &c.run,
        &json!({"action":"calculate","rows":rows,"coverage":covers}),
        &[],
    )
    .unwrap();
    assert_eq!(v["metrics"][0]["current"], "1");
    assert_eq!(v["metrics"][1]["current"], "2");
    assert!(v["metrics"][1]["label"].as_str().unwrap().contains("剧集"));
    assert_eq!(v["excluded"], 2);
}
#[test]
fn saved_review_findings_keep_identity_status_and_precise_dependencies() {
    let c = Case::new(NOTES, "year");
    execute(&c.f.root, &c.work, &c.run, &json!({"action":"read"}), &[]).unwrap();
    let calc = c.calculate(c.fixture_rows(), c.coverage()).unwrap();
    let metric=execute(&c.f.root,&c.work,&c.run,&json!({"action":"bind","text":"已记录净支出增加200元，40%，差额来自医疗净支出。","nature":"fact","refs":c.refs(NOTES),"calculationId":calc["id"],"metricIds":[calc["metrics"][0]["id"]],"collection":true}),&[]).unwrap();
    let single=execute(&c.f.root,&c.work,&c.run,&json!({"action":"bind","text":"账本明确记录了医疗退款。","nature":"selfReported","refs":c.refs("2026-11-04 医疗退款100"),"calculationId":null,"metricIds":[],"collection":false}),&[]).unwrap();
    let report:runner::Report=serde_json::from_value(json!({"status":"completed","summary":"已记录支出比较","findings":[{"text":metric["text"],"citations":[],"reviewRef":metric["reviewRef"]},{"text":single["text"],"citations":[],"reviewRef":single["reviewRef"]}],"nextSteps":[],"questions":[],"limitations":[],"waitCondition":""})).unwrap();
    runner::validate(&report, &[]).unwrap();
    store::publish(
        &c.f.root,
        &c.work,
        &c.run,
        &report,
        &[],
        &[],
        &json!([]),
        &json!({}),
        &Control::default(),
    )
    .unwrap();
    let db = c.f.c();
    let record: String = db
        .query_row(
            "SELECT id FROM agent_records WHERE run_id=?1 AND kind='delivery'",
            [&c.run],
            |r| r.get(0),
        )
        .unwrap();
    drop(db);
    let candidates = super::super::ui(
        &c.f.root,
        &json!({"action":"insightCandidates","id":c.work.id,"deliveryRecordId":record}),
    )
    .unwrap();
    let mut saved = vec![];
    for index in 0..2 {
        let v=super::super::ui(&c.f.root,&json!({"action":"insightImport","id":c.work.id,"deliveryRecordId":record,"deliveryHash":candidates["origin"]["deliveryHash"],"findingPointer":format!("/report/findings/{index}"),"operationId":crate::random_url_safe(16),"confirmDependencies":true,"contextEvidenceIds":[]})).unwrap();
        saved.push(v["item"].clone());
    }
    let later=super::super::ui(&c.f.root,&json!({"action":"insightStatus","insightId":saved[0]["id"],"expectedRevision":saved[0]["rowRevision"],"operationId":crate::random_url_safe(16),"state":"later","snoozeUntil":store::stamp()+86400000})).unwrap();
    assert_eq!(later["item"]["processingState"], "later");
    let current = store::load(&c.f.c(), &c.work.id).unwrap();
    ui(&c.f.root,&json!({"action":"insightReviewPrepare","id":c.work.id,"expectedRevision":current.revision,"operationId":crate::random_url_safe(16),"plan":config("year"),"input":{"text":"2026-11-05 补录更大的医疗支出1000元","nature":"selfReport"}})).unwrap();
    let aggregate = super::super::ui(
        &c.f.root,
        &json!({"action":"insightDetail","insightId":saved[0]["id"]}),
    )
    .unwrap();
    let independent = super::super::ui(
        &c.f.root,
        &json!({"action":"insightDetail","insightId":saved[1]["id"]}),
    )
    .unwrap();
    assert_eq!(aggregate["validity"], "review");
    assert_eq!(aggregate["processingState"], "later");
    assert_eq!(aggregate["headRevision"], 1);
    assert_eq!(independent["validity"], "available");
    assert_eq!(
        independent["snapshot"]["reviewDependency"]["nature"],
        "selfReported"
    );
}
#[test]
fn withdrawn_user_material_is_absent_from_fresh_conversation_and_native_binding_changes() {
    let c = Case::new(NOTES, "open");
    let input = inputs(&c.f.c(), &c.work.id).unwrap()[0].clone();
    store::write(&c.f.root, |db| {
        let mut withdrawn = input.clone();
        withdrawn["withdrawn"] = json!(true);
        add_input(
            db,
            &c.work,
            &withdrawn,
            input["id"].as_str(),
            store::stamp(),
        )
    })
    .unwrap();
    let db = c.f.c();
    let work = store::load(&db, &c.work.id).unwrap();
    assert!(work.authorization_version > c.work.authorization_version);
    let conversation = store::conversation::read_on(&c.f.root, &db, &work).unwrap();
    assert!(!conversation.to_string().contains(NOTES));
    let required = store::goal::completion::sources_on(&db, &work).unwrap();
    assert!(!required.to_string().contains(NOTES));
}

#[test]
fn natural_chinese_dates_and_decimal_formatting_keep_original_provenance() {
    let c = Case::new(
        "主账户CNY：2026年11月2日，实际餐饮支出1,200元。只有这一条已记录支出。",
        "month",
    );
    let mut coverage = c.coverage();
    coverage["current"] = json!("recorded");
    coverage["previous"] = json!("missing");
    coverage["comparable"] = json!(false);
    let result = c
        .calculate(
            vec![c.row("food", "2026-11-02", "expense", Some("1200.00"))],
            coverage,
        )
        .unwrap();
    assert_eq!(result["metrics"][0]["current"], "1200.00");
    assert!(!calculation::source_has_amount("金额12.345", 1234));
    assert!(!calculation::source_has_day(
        "2026年11月3日",
        date("2026-11-02").unwrap()
    ));
}
