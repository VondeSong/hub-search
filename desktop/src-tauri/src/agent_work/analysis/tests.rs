use super::*;
use crate::source_evidence::tests::Fixture;
#[test]
fn cloud_handoff_exports_only_current_selected_results_and_report() {
    let f = Fixture::new();
    let staged=stage(&f.root,&json!({"title":"input.csv","base64":base64::engine::general_purpose::STANDARD.encode(b"value\n1\n")})).unwrap();
    let created=ui(&f.root,&json!({"action":"create","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]},"goal":"核对表格并交接成果","successCriteria":"版本及文件可核对"})).unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    ui(&f.root,&json!({"action":"message","id":id,"expectedRevision":created["work"]["revision"],"clientMessageId":"select-handoff-source","text":"分析所选文件","addNotes":[staged["locator"]]})).unwrap();
    let work = store::claim(&f.root, id, "handoff-run").unwrap();
    let input = inputs(&f.root, &work).unwrap()[0].2.clone();
    for (revision, execution) in [(1, "analysis-handoff-old"), (2, "analysis-handoff-current")] {
        let dir = f
            .root
            .join("agent-analysis")
            .join(id)
            .join(execution)
            .join("output");
        std::fs::create_dir_all(&dir).unwrap();
        let mut files = Vec::new();
        for (name, raw, kind) in [
            ("report.md", b"# Existing report\n".as_slice(), "md"),
            ("detail.csv", b"value\n1\n".as_slice(), "csv"),
            ("unselected.json", b"{}".as_slice(), "json"),
        ] {
            std::fs::write(dir.join(name), raw).unwrap();
            files.push(json!({"name":name,"bytes":raw.len(),"sha256":digest(raw),"type":kind}));
        }
        store::record(&f.root,"handoff-run","analysisExecution",&json!({"artifactId":"artifact-handoff","executionId":execution,"title":"所选报告","revision":revision,"authorizationVersion":work.authorization_version,"inputs":[input],"files":files})).unwrap();
    }
    let args = json!({"work":id,"execution":"analysis-handoff-current","files":["report.md","detail.csv"],"report":"report.md"});
    let prepared = handoff::prepare(&f.root, &args).unwrap();
    assert_eq!(prepared.files.len(), 2);
    assert_eq!(prepared.manifest["origin"]["revision"], 2);
    assert_eq!(prepared.manifest["report"]["text"], "# Existing report\n");
    assert!(!prepared.manifest.to_string().contains("locator"));
    assert!(!prepared.manifest.to_string().contains("unselected.json"));
    let mut bad = args.clone();
    bad["execution"] = json!("analysis-handoff-old");
    assert!(handoff::prepare(&f.root, &bad).is_err());
    bad = args.clone();
    bad["files"] = json!(["detail.csv"]);
    assert!(handoff::prepare(&f.root, &bad).is_err());
    bad = args.clone();
    bad["files"] = json!(["report.md", "report.md"]);
    assert!(handoff::prepare(&f.root, &bad).is_err());
    std::fs::write(
        f.root
            .join("agent-analysis")
            .join(id)
            .join("analysis-handoff-current/output/report.md"),
        b"changed",
    )
    .unwrap();
    assert!(handoff::prepare(&f.root, &args).is_err());
    f.c()
        .execute("UPDATE agent_works SET state='revoked' WHERE id=?1", [id])
        .unwrap();
    assert!(handoff::prepare(&f.root, &args).is_err());
}

#[test]
fn unrelated_material_change_preserves_only_artifacts_with_current_inputs() {
    let f = Fixture::new();
    let mut notes = Vec::new();
    for (name, data) in [
        ("first.csv", b"value\n1\n".as_slice()),
        ("second.csv", b"value\n2\n".as_slice()),
    ] {
        let staged = stage(
            &f.root,
            &json!({"title":name,"base64":base64::engine::general_purpose::STANDARD.encode(data)}),
        )
        .unwrap();
        notes.push(serde_json::from_value::<EvidenceLocator>(staged["locator"].clone()).unwrap());
    }
    let created = ui(&f.root,&json!({"action":"create","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]},"goal":"分别分析两份表，撤回第一份时保留第二份成果","successCriteria":"成果依赖独立核对"})).unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    ui(&f.root,&json!({"action":"message","id":id,"expectedRevision":created["work"]["revision"],"clientMessageId":"select-analysis-inputs","text":"分别分析所选文件","addNotes":notes})).unwrap();
    let work = store::claim(&f.root, id, "dependency-run").unwrap();
    for (index, (_, _, input)) in inputs(&f.root, &work).unwrap().iter().enumerate() {
        let execution = format!("analysis-dependency-{index}");
        let dir = f
            .root
            .join("agent-analysis")
            .join(id)
            .join(&execution)
            .join("output");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("result.csv"), b"value\n1\n").unwrap();
        store::record(&f.root,"dependency-run","analysisExecution",&json!({"artifactId":format!("artifact-{index}"),"executionId":execution,"revision":1,"authorizationVersion":work.authorization_version,"inputs":[input],"files":[{"name":"result.csv","bytes":8,"sha256":digest(b"value\n1\n")}]})).unwrap();
    }
    store::fail(&f.root, &work, "dependency-run", "测试切换材料").unwrap();
    let before = store::view(&f.root, id).unwrap();
    ui(&f.root,&json!({"action":"message","id":id,"expectedRevision":before["work"]["revision"],"clientMessageId":"withdraw-first-analysis-input","text":"撤回第一份资料，保留第二份成果","removeNotes":[notes[0]]})).unwrap();
    let current = store::load(&f.c(), id).unwrap();
    let values = manifest(&f.root, &current);
    let rows = values.as_array().unwrap();
    assert_eq!(
        rows.iter()
            .find(|v| v["executionId"] == "analysis-dependency-0")
            .unwrap()["available"],
        false
    );
    assert_eq!(
        rows.iter()
            .find(|v| v["executionId"] == "analysis-dependency-1")
            .unwrap()["available"],
        true,
        "unrelated material change invalidated a current artifact"
    );
    let second_id = dependencies::id(&json!({"locator":notes[1]}));
    assert_eq!(
        dependencies::select(&f.root, &current, Some(&[second_id.clone()]))
            .unwrap()
            .len(),
        1
    );
    assert!(dependencies::select(&f.root, &current, Some(&["local:unknown".into()])).is_err());
    assert!(
        dependencies::select(&f.root, &current, Some(&[second_id.clone(), second_id])).is_err()
    );
    let mut damaged = rows
        .iter()
        .find(|v| v["executionId"] == "analysis-dependency-1")
        .unwrap()
        .clone();
    damaged["inputs"][0]["sha256"] = json!("0".repeat(64));
    assert!(dependencies::Verifier::new(&f.root, &current)
        .verify(&damaged)
        .is_err());
    let mut revoked = current.clone();
    revoked.state = "revoked".into();
    assert!(manifest(&f.root, &revoked)
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v["available"] == false));
}

#[test]
#[ignore = "explicit real old/new files and unrelated daily material; actual Python, no source edits"]
fn live_daily_selective_recompute() {
    let config: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("HUB_SELECTIVE_RECOMPUTE_CONFIG").expect("explicit config"))
            .unwrap(),
    )
    .unwrap();
    let root = Path::new(config["root"].as_str().unwrap());
    let stage_file = |item: &Value| {
        let bytes = std::fs::read(item["path"].as_str().unwrap()).unwrap();
        stage(root,&json!({"title":item["title"],"base64":base64::engine::general_purpose::STANDARD.encode(bytes)})).unwrap()["locator"].clone()
    };
    let original = stage_file(&config["original"]);
    let other = stage_file(&config["unrelated"]);
    let created=ui(root,&json!({"action":"create","anchor":null,"grant":Grant::default(),"goal":config["goal"],"successCriteria":"只更新受影响成果，保留不相关结果、来源与版本历史"})).unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    ui(root,&json!({"action":"message","id":id,"expectedRevision":created["work"]["revision"],"clientMessageId":crate::random_url_safe(12),"text":"分别处理两份真实资料","addNotes":[original,other]})).unwrap();
    let mut evidence = Vec::new();
    let mut executions = Vec::new();
    for locator in [&original, &other] {
        let run = format!("selective-{}", crate::random_url_safe(12));
        let work = store::claim(root, id, &run).unwrap();
        let input = dependencies::id(&json!({"locator":locator}));
        let receipt = run_selected(
            root,
            &work,
            &run,
            config["script"].as_str().unwrap(),
            "真实资料独立分析",
            None,
            Some(&[input]),
            &Control::bounded(Duration::from_secs(180)),
        )
        .unwrap();
        executions.push(receipt.clone());
        evidence.push(json!({"step":"originalIndependentAnalysis","receipt":receipt}));
        store::fail(root, &work, &run, "本步实际计算结束，等待下一步材料替换").unwrap();
    }
    let replacement = stage_file(&config["replacement"]);
    let before = store::view(root, id).unwrap();
    ui(root,&json!({"action":"message","id":id,"expectedRevision":before["work"]["revision"],"clientMessageId":crate::random_url_safe(12),"text":"用真实新版替换旧版，只重算受影响成果，保留另一份资料的成果","removeNotes":[original],"addNotes":[replacement]})).unwrap();
    let run = format!("selective-{}", crate::random_url_safe(12));
    let work = store::claim(root, id, &run).unwrap();
    let changed = manifest(root, &work);
    let find = |execution: &Value| {
        changed
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["executionId"] == execution["executionId"])
            .unwrap()
    };
    assert_eq!(find(&executions[0])["available"], false);
    assert_eq!(find(&executions[1])["available"], true);
    let receipt = run_selected(
        root,
        &work,
        &run,
        config["script"].as_str().unwrap(),
        "按真实新版重算",
        executions[0]["executionId"].as_str(),
        Some(&[dependencies::id(&json!({"locator":replacement}))]),
        &Control::bounded(Duration::from_secs(180)),
    )
    .unwrap();
    assert_eq!(receipt["artifactId"], executions[0]["artifactId"]);
    assert_eq!(receipt["revision"], 2);
    let after = manifest(root, &work);
    let untouched = after
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["executionId"] == executions[1]["executionId"])
        .unwrap();
    assert_eq!(untouched["available"], true);
    assert_eq!(untouched["files"], executions[1]["files"]);
    evidence.push(
        json!({"step":"replacement","beforeRecompute":changed,"receipt":receipt,"after":after}),
    );
    std::fs::write(
        config["output"].as_str().unwrap(),
        serde_json::to_vec_pretty(&json!({"workId":id,"steps":evidence})).unwrap(),
    )
    .unwrap();
    store::fail(
        root,
        &work,
        &run,
        "真实版本替换与局部重算验收结束；原始文件未修改",
    )
    .unwrap();
}
#[test]
fn svg_accepts_static_plot_and_rejects_active_or_external_content() {
    let plot = r##"<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"><defs><style>*{stroke-linejoin:round}</style><path id="p" d="M0 0"/></defs><g clip-path="url(#p)"><use href="#p"/></g></svg>"##;
    assert!(!output::svg(plot).unwrap().contains("DOCTYPE"));
    for bad in [
        "<svg><script/></svg>",
        "<svg><x:script xmlns:x='urn:x'/></svg>",
        "<svg><foreignObject/></svg>",
        "<svg onload = 'x'/>",
        "<svg><use href='&#104;ttps://example.com/a'/></svg>",
        "<svg><style>@import 'https://example.com/x';</style></svg>",
        "<svg><style>path{fill:url(data:image/png;base64,A)}</style></svg>",
        "<svg><style>path{fill:url( 'https://example.com/a' )}</style></svg>",
        "<?xml-stylesheet href='https://example.com/x'?><svg/>",
        "<!DOCTYPE svg [<!ENTITY x 'x'>]><svg/>",
        "<svg><style>path{fill:u&#114;l(https://example.com/a)}</style></svg>",
        "<svg><g>",
        "<svg/><svg/>",
        "<html/>",
    ] {
        assert!(output::svg(bad).is_err(), "accepted {bad}");
    }
}
#[test]
fn newest_revision_stays_current_and_old_receipts_remain_inspectable() {
    let f = Fixture::new();
    let created=ui(&f.root,&json!({"action":"create","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]},"goal":"核对文件版本","successCriteria":"新版替代旧版"})).unwrap();
    let id = created["work"]["id"].as_str().unwrap();
    let work = store::claim(&f.root, id, "analysis-version-test").unwrap();
    for (revision, execution) in [(1, "analysis-first"), (2, "analysis-second")] {
        let dir = f
            .root
            .join("agent-analysis")
            .join(id)
            .join(execution)
            .join("output");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("result.csv"), b"a\n1\n").unwrap();
        let report = format!("版本 {revision}：编号记录和参考项分别统计。");
        std::fs::write(dir.join("report.md"), report.as_bytes()).unwrap();
        store::record(&f.root,"analysis-version-test","analysisExecution",&json!({"artifactId":"same","executionId":execution,"revision":revision,"authorizationVersion":work.authorization_version,"files":[{"name":"result.csv","bytes":4,"sha256":digest(b"a\n1\n")},{"name":"report.md","bytes":report.len(),"sha256":digest(report.as_bytes())}]})).unwrap();
    }
    let manifest = manifest(&f.root, &work);
    assert_eq!(manifest[0]["executionId"], "analysis-second");
    assert_eq!(manifest[0]["superseded"], false);
    assert_eq!(manifest[1]["superseded"], true);
    let mut revoked = work.clone();
    revoked.state = "revoked".into();
    assert_eq!(super::manifest(&f.root, &revoked)[0]["available"], false);
    assert_eq!(context(&f.root, &revoked)["currentReports"], json!([]));
    let report_context = context(&f.root, &work);
    assert_eq!(
        report_context["currentReports"].as_array().unwrap().len(),
        1
    );
    assert!(report_context["currentReports"][0]["text"]
        .as_str()
        .unwrap()
        .contains("版本 2"));
    assert_eq!(
        context(&f.root, &work)["items"][0]["executionId"],
        "analysis-second"
    );
    let refs = references(&f.root, &work, None).unwrap();
    assert_eq!(refs.as_array().unwrap().len(), 1);
    let export_path = f.root.join("exported.csv");
    let args = json!({"id":id,"executionId":"analysis-second","file":"result.csv","expectedSha256":digest(b"a\n1\n"),"destination":export_path});
    let first_export = export(&f.root, &args).unwrap();
    assert_eq!(first_export["state"], "verified");
    assert_eq!(export(&f.root, &args).unwrap(), first_export);
    std::fs::write(&export_path, b"user edit").unwrap();
    assert!(export(&f.root, &args).is_err());
    assert_eq!(std::fs::read(&export_path).unwrap(), b"user edit");
    let first = reference(&super::manifest(&f.root, &work)[1]);
    assert_eq!(
        inspect_references(&f.root, &work, &json!([first])).unwrap()["state"],
        "stale"
    );
    std::fs::write(
        f.root
            .join("agent-analysis")
            .join(id)
            .join("analysis-second/output/result.csv"),
        b"changed",
    )
    .unwrap();
    assert!(inspect_references(&f.root, &work, &refs).is_err());
    assert_eq!(context(&f.root, &work)["currentReports"], json!([]));
}
#[test]
fn library_data_file_keeps_attachment_and_parent_identity() {
    let f = Fixture::new();
    crate::attachment_evidence::tests::seed(&f, "data-table", "a,b\n1,2\n");
    f.c()
        .execute(
            "UPDATE source_items SET mime_type='text/csv',title='data.csv' WHERE id='data-table'",
            [],
        )
        .unwrap();
    let staged = stage(
        &f.root,
        &json!({"source":{"libraryId":"notes","sourceItemId":"data-table"}}),
    )
    .unwrap();
    let locator: EvidenceLocator = serde_json::from_value(staged["locator"].clone()).unwrap();
    let grant = Grant {
        library_ids: vec![],
        notes: vec![locator],
        reading_item_keys: vec![],
        ..Default::default()
    };
    assert_eq!(selected_inputs(&f.root, &grant).unwrap().len(), 1);
    f.c()
        .execute(
            "UPDATE documents SET content_hash='changed' WHERE space_id='notes'",
            [],
        )
        .unwrap();
    assert!(selected_inputs(&f.root, &grant).is_err());
}
#[test]
fn file_staging_is_explicit_immutable_and_rejects_unsafe_inputs() {
    let f = Fixture::new();
    for (title, data) in [
        ("../data.csv", b"a,b\n1,2".as_slice()),
        ("macro.xlsm", b"zip"),
        ("fake.xlsx", b"broken"),
    ] {
        assert!(stage(
            &f.root,
            &json!({"title":title,"base64":base64::engine::general_purpose::STANDARD.encode(data)})
        )
        .is_err());
    }
    let staged=stage(&f.root,&json!({"title":"data.csv","base64":base64::engine::general_purpose::STANDARD.encode(b"a,b\n1,2\n")})).unwrap();
    let created=ui(&f.root,&json!({"action":"create","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]},"goal":"核对数据","successCriteria":"依据真实文件"})).unwrap();
    ui(&f.root,&json!({"action":"message","id":created["work"]["id"],"expectedRevision":created["work"]["revision"],"clientMessageId":"grant-analysis-file","text":"处理所选文件","addNotes":[staged["locator"]]})).unwrap();
    let work = store::load(&f.c(), created["work"]["id"].as_str().unwrap()).unwrap();
    let values = inputs(&f.root, &work).unwrap();
    assert_eq!(values.len(), 1);
    std::fs::write(&values[0].1, b"tampered").unwrap();
    assert!(inputs(&f.root, &work).is_err());
}
#[test]
fn original_attachment_needs_a_real_file_grant() {
    let f = crate::source_evidence::tests::Fixture::new();
    let bytes = b"arbitrary original bytes";
    let file = stage(&f.root, &json!({"action":"stageOriginalFile","title":"slides.pptx","sourceFolders":["distribution","example"],"base64":base64::engine::general_purpose::STANDARD.encode(bytes)})).unwrap();
    let locator: EvidenceLocator = serde_json::from_value(file["locator"].clone()).unwrap();
    let body = crate::source_evidence::local_text::selected_body(&f.root, &locator).unwrap();
    let imitation = crate::source_evidence::local_text::stage(
        &f.root,
        &json!({"title":"slides.pptx","text":body}),
    )
    .unwrap();
    let mut grant = Grant::default();
    grant
        .notes
        .push(serde_json::from_value(imitation["locator"].clone()).unwrap());
    assert!(selected_inputs(&f.root, &grant).unwrap().is_empty());
    grant.notes.push(locator.clone());
    let files = selected_inputs(&f.root, &grant).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, "input-1.pptx");
    assert_eq!(std::fs::read(&files[0].1).unwrap(), bytes);
    assert_eq!(files[0].2["locator"], json!(locator));
    assert_eq!(files[0].2["sourceFolder"], "distribution/example");
    assert!(attachment_format(&serde_json::from_str(&body).unwrap()).is_none());
    std::fs::write(&files[0].1, b"different original").unwrap();
    assert!(selected_inputs(&f.root, &grant).is_err());
}

#[test]
fn nine_attachments_keep_the_chat_open_and_only_the_selected_files_are_read() {
    let f = Fixture::new();
    let view = ui(&f.root, &json!({"action":"create","goal":"核对文件","successCriteria":"核对","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]}})).unwrap();
    let mut work = store::load(&f.c(), view["work"]["id"].as_str().unwrap()).unwrap();
    for index in 0..9 {
        let data = format!("attachment {index}");
        let staged = stage_bytes(
            &f.root,
            &format!("{index}.pptx"),
            data.as_bytes(),
            true,
            &Value::Null,
            None,
        )
        .unwrap();
        work.grant
            .notes
            .push(serde_json::from_value(staged["locator"].clone()).unwrap());
    }
    assert!(work.grant.reader(&f.root).is_ok());
    assert!(dependencies::select(&f.root, &work, None).is_err());
    let unavailable = selected_inputs(&f.root, &work.grant).unwrap()[0].1.clone();
    std::fs::remove_file(unavailable).unwrap();
    assert!(work.grant.reader(&f.root).is_ok());
    assert!(dependencies::select(&f.root, &work, None).is_err());
    let requested = attachment_id(&work.grant.notes[8]);
    let files = dependencies::select(&f.root, &work, Some(&[requested])).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].2["title"], "8.pptx");
    assert_eq!(
        dependencies::catalog(&f.root, &work)
            .iter()
            .filter(|file| file["available"] == true)
            .count(),
        8
    );
}

#[test]
fn library_pdf_fallback_only_returns_the_current_cached_pages() {
    let f = Fixture::new();
    let (job, input) = crate::attachment_evidence::tests::seed(&f, "cache-pdf", "PDF first page");
    crate::attachment_evidence::tests::produce(&f, &job, &input, "PDF first page");
    let listed = source::list(&f.root, &json!({"query":"工艺附件"})).unwrap();
    assert_eq!(listed["files"][0]["source"]["sourceItemId"], "cache-pdf");
    let staged = stage(&f.root, &json!({"source":listed["files"][0]["source"]})).unwrap();
    assert_eq!(staged["libraryPdf"], true);
    let locator = serde_json::from_value(staged["locator"].clone()).unwrap();
    let manifest = crate::source_evidence::local_text::selected_file_manifest(&f.root, &locator)
        .unwrap()
        .unwrap();
    let source = &manifest["source"];
    let reading = source::cached_pdf_pages(&f.root, source, 9)
        .unwrap()
        .unwrap();
    assert_eq!(
        reading["pages"][0],
        json!({"page":1,"text":"PDF first","truncated":true})
    );
    f.c()
        .execute(
            "UPDATE content_items SET input_version=NULL WHERE source_item_id='cache-pdf'",
            [],
        )
        .unwrap();
    assert!(source::cached_pdf_pages(&f.root, source, 9)
        .unwrap()
        .is_none());
    f.c()
        .execute(
            "UPDATE documents SET content_hash='changed' WHERE space_id='notes'",
            [],
        )
        .unwrap();
    assert!(source::cached_pdf_pages(&f.root, source, 9).is_err());
}

#[test]
#[ignore = "explicit daily data file and actual MXC Python; no model or source writes"]
fn live_daily_file_analysis_runtime() {
    let config: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("HUB_ANALYSIS_CONFIG").expect("explicit config")).unwrap(),
    )
    .unwrap();
    let root = Path::new(config["root"].as_str().unwrap());
    let mut notes = Vec::new();
    for item in config["files"].as_array().unwrap() {
        let v = if item["source"].is_object() {
            stage(root, &json!({"source":item["source"]})).unwrap()
        } else {
            let data = std::fs::read(item["path"].as_str().unwrap()).unwrap();
            let action = if item["original"] == true {
                "stageOriginalFile"
            } else {
                "stageAnalysisFile"
            };
            stage(root,&json!({"action":action,"title":item["title"],"base64":base64::engine::general_purpose::STANDARD.encode(data)})).unwrap()
        };
        notes.push(v["locator"].clone());
    }
    let view=ui(root,&json!({"action":"create","anchor":null,"grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]},"goal":config["prompt"],"successCriteria":"实际执行、复算和产物可打开"})).unwrap();
    let id = view["work"]["id"].as_str().unwrap();
    ui(root,&json!({"action":"message","id":id,"expectedRevision":view["work"]["revision"],"clientMessageId":crate::random_url_safe(12),"text":config["prompt"],"addNotes":notes})).unwrap();
    if config["options"].is_object() {
        options::configure(root, &json!({"id":id,"options":config["options"]})).unwrap();
        let mut turns = Vec::new();
        for (index, prompt) in config["prompts"].as_array().unwrap().iter().enumerate() {
            if index > 0 {
                let current = store::view(root, id).unwrap();
                ui(root,&json!({"action":"message","id":id,"expectedRevision":current["work"]["revision"],"clientMessageId":crate::random_url_safe(12),"text":prompt})).unwrap();
            }
            let result = ui(root, &json!({"action":"respond","id":id,"mode":"deep"}));
            let view = store::view(root, id).unwrap();
            turns.push(json!({"prompt":prompt,"result":result,"view":view,"analyses":store::records(root,id,"analysisExecution",100).unwrap()}));
            std::fs::write(
                config["output"].as_str().unwrap(),
                serde_json::to_vec_pretty(&json!({"workId":id,"turns":turns})).unwrap(),
            )
            .unwrap();
            result.unwrap();
        }
        return;
    }
    let run = format!("analysis-probe-{}", crate::random_url_safe(12));
    let work = store::claim(root, id, &run).unwrap();
    let script = config["script"].as_str().unwrap();
    let trace_request = (config["verifyLargeTrace"] == true).then(|| {
        let request = json!({"operation":"analyzeFiles","script":script,"stepId":"analysis-probe"});
        store::record(root, &run, "toolCall", &request).unwrap();
        request
    });
    let result = super::run(
        root,
        &work,
        &run,
        script,
        "真实数据分析运行时验收",
        None,
        &Control::bounded(Duration::from_secs(900)),
    );
    let trace = trace_request.map(|request| {
        let value = result.as_ref().unwrap();
        let raw = value.to_string();
        assert!(raw.len() > 65536);
        let reference = store::tool_results::capture(root, id, &run, &request, value).unwrap();
        let mut restored = String::new();
        let mut start = 0;
        loop {
            let page = store::tool_results::read_for_work(
                root,
                &work,
                reference["recordId"].as_str().unwrap(),
                reference["sha256"].as_str().unwrap(),
                start,
                4000,
            )
            .unwrap();
            restored.push_str(page["content"].as_str().unwrap());
            let Some(next) = page["nextStartChar"].as_u64() else {
                break;
            };
            start = next as usize;
        }
        assert_eq!(restored, raw);
        json!({"reference":reference,"utf8Bytes":raw.len(),"roundTripExact":true})
    });
    std::fs::write(
        config["output"].as_str().unwrap(),
        serde_json::to_vec_pretty(&json!({"workId":id,"runId":run,"result":result,"trace":trace}))
            .unwrap(),
    )
    .unwrap();
    store::fail(
        root,
        &work,
        &run,
        "运行时探针已结束；正式模型任务需单独启动",
    )
    .unwrap();
    assert_eq!(result.as_ref().unwrap()["output"]["exitCode"], 0);
}

#[test]
#[ignore = "explicit existing daily conversation; real model continuation and verified local exports"]
fn live_daily_analysis_continuation() {
    let config: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("HUB_ANALYSIS_CONTINUE_CONFIG").expect("explicit config"))
            .unwrap(),
    )
    .unwrap();
    let root = Path::new(config["root"].as_str().unwrap());
    let id = config["workId"].as_str().unwrap();
    let mut steps = Vec::new();
    for step in config["steps"].as_array().unwrap() {
        let before = store::view(root, id).unwrap();
        let goal_mode = step["goalMode"].as_bool().unwrap_or(false);
        if step["options"].is_object() {
            options::configure(root, &json!({"id":id,"options":step["options"]})).unwrap();
        }
        let result = if let Some(prompt) = step["prompt"].as_str() {
            ui(root,&json!({"action":"message","id":id,"expectedRevision":before["work"]["revision"],"clientMessageId":crate::random_url_safe(12),"text":prompt,"addNotes":step.get("addNotes").cloned().unwrap_or(json!([])),"removeNotes":step.get("removeNotes").cloned().unwrap_or(json!([]))})).unwrap();
            if step["compactBeforeResponse"] == true {
                let current = store::view(root, id).unwrap();
                ui(root,&json!({"action":"requestContextCompaction","id":id,"operationId":crate::random_url_safe(12),"expectedWorkRevision":current["work"]["revision"],"expectedAuthorizationVersion":current["work"]["authorizationVersion"]})).unwrap();
            }
            if step["revokeDuringReview"] == true {
                revoke_during_review(root, id)
            } else if step["cancelDuringResponse"] == true {
                let owned_root = root.to_owned();
                let owned_id = id.to_owned();
                let worker = std::thread::spawn(move || {
                    ui(
                        &owned_root,
                        &json!({"action":"respond","id":owned_id,"mode":"deep","goalMode":goal_mode}),
                    )
                });
                let started = std::time::Instant::now();
                loop {
                    let state = store::view(root, id).unwrap();
                    if state["lifecycle"]["activeRunId"].is_string() {
                        std::thread::sleep(Duration::from_secs(5));
                        let state = store::view(root, id).unwrap();
                        let stopped = ui(
                            root,
                            &json!({"action":"cancel","id":id,"commandId":crate::random_url_safe(12),"expectedControlRevision":state["lifecycle"]["controlRevision"],"expectedWorkRevision":state["work"]["revision"],"expectedRunId":state["lifecycle"]["activeRunId"]}),
                        );
                        stopped.unwrap();
                        break;
                    }
                    assert!(
                        started.elapsed() < Duration::from_secs(60),
                        "No active run to cancel"
                    );
                    std::thread::sleep(Duration::from_millis(100));
                }
                let _interrupted = worker.join().unwrap();
                let state = store::view(root, id).unwrap();
                assert_eq!(state["lifecycle"]["requiresExplicitResume"], true);
                Ok(state)
            } else {
                ui(
                    root,
                    &json!({"action":"respond","id":id,"mode":"deep","goalMode":goal_mode}),
                )
            }
        } else if step["resume"] == true {
            ui(
                root,
                &json!({"action":"resume","id":id,"commandId":crate::random_url_safe(12),"expectedControlRevision":before["lifecycle"]["controlRevision"],"expectedWorkRevision":before["work"]["revision"],"expectedRunId":before["lifecycle"]["activeRunId"],"mode":"deep","goalMode":goal_mode}),
            )
        } else if step["revoke"] == true {
            let mut state = ui(root, &json!({"action":"revoke","id":id})).unwrap();
            let revoked = store::load(
                &crate::source_evidence::open_read_database(root).unwrap(),
                id,
            )
            .unwrap();
            assert_eq!(revoked.state, "revoked");
            assert_eq!(context(root, &revoked)["currentReports"], json!([]));
            let mut rejections = Vec::new();
            if let Some(destination) = step["refusedExportDirectory"].as_str() {
                let directory = Path::new(destination);
                assert!(directory.is_absolute() && directory.is_dir());
                for item in before["fileAnalyses"].as_array().into_iter().flatten() {
                    for file in item["files"].as_array().into_iter().flatten() {
                        let target = directory.join(file["name"].as_str().unwrap());
                        assert!(!target.exists());
                        let error = export(root,&json!({"id":id,"executionId":item["executionId"],"file":file["name"],"expectedSha256":file["sha256"],"destination":target})).unwrap_err();
                        assert!(error.contains("未授权"), "{error}");
                        assert!(!target.exists());
                        rejections.push(
                            json!({"file":file["name"],"error":error,"destinationCreated":false}),
                        );
                    }
                }
                assert!(!rejections.is_empty());
            }
            state["revokedFileExportChecks"] = json!(rejections);
            Ok(state)
        } else {
            store::view(root, id)
        };
        let after = store::view(root, id).unwrap();
        if step["assertOneReviewFailed"] == true {
            let records = store::records(root, id, "knowledgeReview", 1).unwrap();
            assert_eq!(records[0]["workers"][0]["state"], "failed");
            assert_eq!(records[0]["workers"][1]["state"], "completed");
            assert!(records[0]["workers"][1]["usage"].is_object());
            assert!(after["work"]["report"].is_object());
        }
        let mut exports = Vec::new();
        if let Some(destination) = step["exportDirectory"].as_str() {
            let destination = Path::new(destination);
            assert!(
                destination.is_dir(),
                "Explicit export directory must already exist"
            );
            for item in after["fileAnalyses"].as_array().into_iter().flatten() {
                if item["available"] != true || item["superseded"] == true {
                    continue;
                }
                for file in item["files"].as_array().unwrap() {
                    let name = file["name"].as_str().unwrap();
                    assert!(valid_name(name));
                    exports.push(export(root,&json!({"id":id,"executionId":item["executionId"],"file":name,"expectedSha256":file["sha256"],"destination":destination.join(name)})));
                }
            }
        }
        steps.push(json!({"label":step["label"],"result":result,"view":after,"exports":exports}));
        std::fs::write(
            config["output"].as_str().unwrap(),
            serde_json::to_vec_pretty(&json!({"workId":id,"steps":steps})).unwrap(),
        )
        .unwrap();
        result.unwrap();
        for export in exports {
            export.unwrap();
        }
    }
}

fn revoke_during_review(root: &Path, id: &str) -> Result<Value, String> {
    std::thread::scope(|scope| {
        let reader = crate::source_evidence::open_read_database(root)?;
        let worker = scope.spawn(|| ui(root, &json!({"action":"respond","id":id,"mode":"deep"})));
        let deadline = std::time::Instant::now() + Duration::from_secs(120);
        let run = loop {
            let started: Option<String> = reader
                .query_row(
                    "SELECT w.active_run FROM agent_works w WHERE w.id=?1 AND
                     (SELECT count(*) FROM agent_records r WHERE r.run_id=w.active_run
                      AND r.kind='agentStream' AND json_extract(r.body_json,'$.origin')='hub-knowledge-review'
                      AND json_extract(r.body_json,'$.state')='running')=2",
                    [id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if let Some(run) = started {
                break run;
            }
            if worker.is_finished() || std::time::Instant::now() >= deadline {
                return Err("未观察到两组同时复核，不能记为运行中撤权通过".into());
            }
            std::thread::sleep(Duration::from_millis(150));
        };
        ui(root, &json!({"action":"revoke","id":id}))?;
        let _ = worker.join().map_err(|_| "复核运行异常退出")?;
        let view = store::view(root, id)?;
        assert_eq!(view["work"]["state"], "revoked");
        assert!(view["evidence"].as_array().is_some_and(Vec::is_empty));
        let publications: i64 = reader
            .query_row(
                "SELECT count(*) FROM agent_records WHERE run_id=?1 AND kind IN ('knowledgeReview','delivery')",
                [&run],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        assert_eq!(publications, 0);
        Ok(view)
    })
}

#[test]
#[ignore = "explicit daily analysis Work; real isolated runtime negative checks, no source edits"]
fn live_daily_analysis_failure_matrix() {
    let config: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("HUB_ANALYSIS_FAILURE_CONFIG").expect("explicit config"))
            .unwrap(),
    )
    .unwrap();
    let root = Path::new(config["root"].as_str().unwrap());
    let id = config["workId"].as_str().unwrap();
    let run = format!("analysis-negative-{}", crate::random_url_safe(12));
    let work = store::claim(root, id, &run).unwrap();
    let before = manifest(root, &work);
    let mut results = Vec::new();
    for case in config["cases"].as_array().unwrap() {
        let started = std::time::Instant::now();
        let result = super::run(
            root,
            &work,
            &run,
            case["script"].as_str().unwrap(),
            "真实输入的受控异常验收",
            None,
            &Control::bounded(Duration::from_secs(180)),
        );
        results.push(json!({"label":case["label"],"result":result,"elapsedMs":started.elapsed().as_millis(),"artifactsUnchanged":manifest(root,&work)==before}));
        std::fs::write(
            config["output"].as_str().unwrap(),
            serde_json::to_vec_pretty(&json!({"workId":id,"cases":results})).unwrap(),
        )
        .unwrap();
        if let Some(expected) = case["errorContains"].as_str() {
            let error = result.expect_err("negative execution must refuse its result");
            assert!(error.contains(expected), "{error}");
        } else {
            let receipt = result.expect("valid computation after failures must recover");
            assert_eq!(receipt["output"]["exitCode"], 0);
            assert_eq!(receipt["files"], json!([]));
        }
        if let Some(minimum) = case["minimumElapsedMs"].as_u64() {
            assert!(started.elapsed().as_millis() >= minimum as u128);
        }
        assert_eq!(
            manifest(root, &work),
            before,
            "failed run published an artifact"
        );
    }
    store::fail(
        root,
        &work,
        &run,
        "受控异常验收结束，没有修改源资料或发布失败产物",
    )
    .unwrap();
}
