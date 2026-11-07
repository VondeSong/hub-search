use super::*;
use crate::source_evidence::tests::Fixture;
fn setup() -> (Fixture, String) {
    let f = Fixture::new();
    let v=crate::agent_work::ui(&f.root,&json!({"action":"create","anchor":null,"grant":Grant::default(),"goal":"核对预算入口","successCriteria":"保存答复且保留全部计量"})).unwrap();
    let id = v["work"]["id"].as_str().unwrap().to_owned();
    (f, id)
}
fn tokens(input: u64) -> Value {
    json!({"inputTokens":input,"uncachedInputTokens":input,"outputTokens":input/10})
}
#[test]
fn cn06_budget_preview_keeps_legacy_known_unknown_and_freeze_is_authoritative() {
    let (f, id) = setup();
    let (w, run) = crate::agent_work::tests::claim(&f, &id);
    record(&f.root, &run, "nativeRuntime", &json!({})).unwrap();
    record(&f.root,&run,"nativeMeasurement",&json!({"runId":run,"runtimeSucceeded":false,"turnTokens":{"inputTokens":60,"uncachedInputTokens":50,"outputTokens":6}})).unwrap();
    fail(&f.root, &w, &run, "未知结束").unwrap();
    let (known_work, known_run) = crate::agent_work::tests::claim(&f, &id);
    record(
        &f.root,
        &known_run,
        "nativeMeasurement",
        &json!({"runId":known_run,"runtimeSucceeded":true,"turnTokens":tokens(40)}),
    )
    .unwrap();
    fail(
        &f.root,
        &known_work,
        &known_run,
        "模型完成后交付失败，计量仍完整",
    )
    .unwrap();
    let v = view_on(&f.c(), &load(&f.c(), &id).unwrap()).unwrap();
    assert_eq!(v["legacy"]["unknownRuns"][0]["minimum"]["inputTokens"], 60);
    assert_eq!(v["legacy"]["measured"], tokens(40));
    let args = json!({"id":id,"expectedWorkRevision":1,"expectedAuthorizationVersion":1,"limits":tokens(1000),"perRun":tokens(100),"unknownReservations":{run.clone():tokens(100)}});
    let mut low = args.clone();
    low["unknownReservations"][&run] = tokens(10);
    assert!(freeze(&f.root, &low).is_err());
    let mut stale = args.clone();
    stale["expectedAuthorizationVersion"] = json!(2);
    assert!(freeze(&f.root, &stale).is_err());
    freeze(&f.root, &args).unwrap();
    freeze(&f.root, &args).unwrap();
    let next = view_on(&f.c(), &load(&f.c(), &id).unwrap()).unwrap();
    assert_eq!(next["chargedOrReserved"]["inputTokens"], 140);
    assert_eq!(next["unmeasuredRunIds"], json!([run]));
    let extend_args = json!({"id":id,"expectedWorkRevision":1,"expectedAuthorizationVersion":1,"operationId":"budget-ui-1","reason":"用户明确追加","expectedLimits":tokens(1000),"limits":tokens(2000)});
    extend(&f.root, &extend_args).unwrap();
    extend(&f.root, &extend_args).unwrap();
    let after = view_on(&f.c(), &load(&f.c(), &id).unwrap()).unwrap();
    assert_eq!(after["limits"]["inputTokens"], 2000);
    assert_eq!(after["chargedOrReserved"], next["chargedOrReserved"]);
    assert_eq!(after["perRun"], next["perRun"]);
}
#[test]
fn cn06_budget_ui_freeze_rejects_running_and_revoked_and_never_starts_model() {
    let (f, id) = setup();
    let args = json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"expectedAuthorizationVersion":1,"limits":tokens(1000),"perRun":tokens(100),"unknownReservations":{}});
    let (w, run) = crate::agent_work::tests::claim(&f, &id);
    assert!(crate::agent_work::ui(&f.root, &args).is_err());
    fail(&f.root, &w, &run, "未调用模型").unwrap();
    let v = crate::agent_work::ui(&f.root, &args).unwrap();
    assert_eq!(
        v["lifecycle"]["providerBudget"]["chargedOrReserved"],
        tokens(0)
    );
    assert_eq!(
        f.c()
            .query_row(
                "SELECT count(*) FROM agent_records WHERE kind='nativeRuntime'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let (f, id) = setup();
    revoke(&f.root, &id).unwrap();
    let mut args = args;
    args["id"] = json!(id);
    assert!(crate::agent_work::ui(&f.root, &args).is_err());
}
#[test]
#[ignore = "one bounded native turn checks budget settlement and live context projection; not compaction requalification"]
fn cn06_live_budget_and_context_are_visible_after_native_turn() {
    let path = std::env::var("HUB_CN06_LIVE_REPORT").expect("explicit report path");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(std::path::Path::new(&path).with_extension("started"))
        .unwrap();
    let (f, id) = setup();
    crate::agent_work::ui(&f.root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"expectedAuthorizationVersion":1,"limits":tokens(800000),"perRun":tokens(200000),"unknownReservations":{}})).unwrap();
    crate::agent_work::options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    crate::agent_work::ui(&f.root,&json!({"action":"message","id":id,"expectedRevision":1,"clientMessageId":"budget-question","text":"请用一句自然语言说明：整理上下文后仍应保留已发生的累计用量。不要调用任何工具。"})).unwrap();
    let started = std::time::Instant::now();
    let result =
        crate::agent_work::ui(&f.root, &json!({"action":"respond","id":id,"mode":"quick"}));
    let v = view(&f.root, &id).unwrap();
    std::fs::write(&path,serde_json::to_vec_pretty(&json!({"result":result,"view":v,"durationMs":started.elapsed().as_millis(),"scope":"synthetic prompt, no source reading/web/business actions; no compaction request"})).unwrap()).unwrap();
    result.unwrap();
    assert_eq!(v["nativeContext"]["state"], "reported");
    assert!(v["nativeContext"]["lastTokens"].as_u64().unwrap() > 0);
    assert!(
        v["lifecycle"]["providerBudget"]["chargedOrReserved"]["inputTokens"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(v["lifecycle"]["providerBudget"]["limits"], tokens(800000));
    assert_eq!(v["actions"]["items"], json!([]));
}
