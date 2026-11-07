//! Fixed final-period verification; uses existing production entries unchanged.
use super::report_resume::saved;
use super::*;

#[test]
#[ignore = "one authorized February cycle, fixed358 production owners, no January retry"]
fn v5_february_closeout_once() {
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let out = desktop.join("artifacts/architecture-v5-final-closeout-20261028");
    let contract = read(out.join("contract.json"));
    assert_eq!(env!("CARGO_PKG_VERSION"), "0.16.358");
    assert_eq!(contract["maximumFebruarySessions"], 1);
    assert!(
        chrono::Utc::now()
            < chrono::DateTime::parse_from_rfc3339(contract["deadline"].as_str().unwrap()).unwrap()
    );
    let root = PathBuf::from(contract["root"].as_str().unwrap());
    assert_eq!(
        std::fs::read(root.join(".hub-isolated-runtime-v1")).unwrap(),
        b"Hub isolated runtime v1\n"
    );
    let january = saved(&root, contract["januaryWork"].as_str().unwrap());
    assert_eq!(january["work"]["state"], "completed");
    assert_eq!(january["dataset"]["revision"], 2);
    let original = desktop.join("artifacts/architecture-v5-package-business-20261028");
    let init = read(original.join("initialization.json"));
    let method = read(original.join("prepared-work.json"))["method"].clone();
    assert_eq!(
        skills::Catalog::discover(&root)
            .unwrap()
            .fixed_version("v5-sleep-review")
            .unwrap(),
        method
    );
    let source = Path::new(contract["sourceFile"].as_str().unwrap());
    assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(source).unwrap())),
        contract["sourceSha256"].as_str().unwrap()
    );
    once(&out, "february-started");
    let binding = read(original.join("topic-binding.json"));
    let topic = binding["topic"]["id"].as_str().unwrap();
    let question = read(original.join("scenario-inputs.json"))["3"].clone();
    let updated = ui(
        &root,
        json!({"action":"topicUpdate","topicId":topic,"expectedRevision":1,"title":"受控睡眠复核","defaultQuestion":question,"period":"2025-02","outputPreference":"无精确值明确未知，不补零，不带入1月","clientRequestId":"v5-final-feb-config-once"}),
    );
    let revision = updated["topic"]["revision"].clone();
    let preview = ui(
        &root,
        json!({"action":"topicWorkPreview","topicId":topic,"expectedRevision":revision,"period":"2025-02"}),
    );
    save(&out, "february-preview.json", &preview);
    let made = ui(
        &root,
        json!({"action":"topicCreateWork","topicId":topic,"expectedRevision":revision,"period":"2025-02","expectedPreview":preview["fingerprint"],"confirmedScope":true,"clientRequestId":"v5-final-feb-create-once"}),
    );
    let id = made["openedWorkId"].as_str().unwrap();
    freeze_tokens(&root, id, 1, 1);
    configure(&root, id, &init, false);
    let old =
        read(desktop.join("artifacts/architecture-v5-report-resume-20261028/model-contract.json"));
    let p = plan(
        &root,
        id,
        278528,
        old["februaryOtherReplyBytes"].as_u64().unwrap() as usize,
        old["februaryPlanBasis"].as_str().unwrap(),
    );
    set_plan(&root, id, &p);
    save(&out, "february-plan.json", &p);
    save(&out, "february-initial.json", &saved(&root, id));
    let started = std::time::Instant::now();
    let result =
        crate::agent_work::run_mode_app(&root, id, report_resume::bounded(), true, None, None);
    save(
        &out,
        "february-state.json",
        &ui(&root, json!({"action":"status","id":id})),
    );
    save(&out, "february-saved.json", &saved(&root, id));
    save(
        &out,
        "january-after.json",
        &saved(&root, contract["januaryWork"].as_str().unwrap()),
    );
    save(
        &out,
        "february-return.json",
        &json!({"ok":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":started.elapsed().as_secs_f64()*1000.0}),
    );
    assert!(result.is_ok(), "{result:?}");
}
