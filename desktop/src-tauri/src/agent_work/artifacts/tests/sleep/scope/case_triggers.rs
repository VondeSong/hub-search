use super::*;

#[test]
fn v1_formal_trigger_preview_append_rejects_previously_accepted_publication() {
    let (f, id, chart, delivery) = protected();
    let run = "formal-preview-trigger";
    let work = store::claim(&f.root, &id, run).unwrap();
    store::record(&f.root, run, "nativeRuntime", &json!({"protocol":1})).unwrap();
    let current = records(&f.c(), &id, "chartRevision").unwrap()[0].clone();
    call(
        &f,
        &work,
        run,
        &json!({"action":"validate","artifactId":current["artifactId"],"revision":current["revision"]}),
    );
    let report = accepted_report(&f, &work, run, "追加之前已接受的报告");
    let before = store::records(&f.root, &id, "delivery", 32).unwrap();
    // UI status also runs orphan recovery. Register the owned live fixture
    // exactly as the runtime does, rather than presenting an orphaned claim.
    struct LiveFixture((std::path::PathBuf, String));
    impl Drop for LiveFixture {
        fn drop(&mut self) {
            crate::agent_work::active().lock().unwrap().remove(&self.0);
        }
    }
    let key = (crate::agent_work::root_key(&f.root), id.clone());
    crate::agent_work::active().lock().unwrap().insert(
        key.clone(),
        crate::agent_work::Active {
            run_id: run.into(),
            control: Control::default(),
            is_action: false,
        },
    );
    let _live = LiveFixture(key);
    let appended = ui(&f.root, &json!({"action":"steer","id":id,"runId":run,"text":"只预览，不保存到来源；保留当前成果和历史。","clientMessageId":"formal-preview-command"})).unwrap();
    assert_eq!(appended["work"]["state"], "investigating");
    let steering = store::records(&f.root, &id, "steering", 32).unwrap();
    assert!(steering
        .iter()
        .any(|item| item["text"] == "只预览，不保存到来源；保留当前成果和历史。"));
    let error = publish(&f, &work, run, &report).unwrap_err();
    assert!(!error.is_empty());
    assert_eq!(
        store::records(&f.root, &id, "delivery", 32).unwrap(),
        before
    );
    assert_eq!(
        store::records(&f.root, &id, "delivery", 1).unwrap()[0],
        delivery
    );
    assert!(view_on(&f.root, &f.c(), &store::load(&f.c(), &id).unwrap())
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["content"] == chart));
    output(
        "ux10-trigger-qualification.json",
        &json!({"case":"UX-10","track":"deterministic trigger qualification, not autonomous formal score","trigger":"actual chartValidation passed, accepted_report exists, before store::publish","appendEntry":"production ui action=steer, exact work/run/clientMessageId","retainedUserCommand":true,"oldAcceptedReportPublishRejected":true,"error":error,"oldDeliveryAndHistoryIntact":true,"sourceSaveAuthorized":false,"modelCalls":0}),
    );
}
