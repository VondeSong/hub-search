use super::*;
use crate::source_evidence::tests::Fixture;
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
    assert!(verify_grant(&f.root, &grant).is_err());
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
            stage(root,&json!({"title":item["title"],"base64":base64::engine::general_purpose::STANDARD.encode(data)})).unwrap()
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
    let result = super::run(
        root,
        &work,
        &run,
        config["script"].as_str().unwrap(),
        "真实数据分析运行时验收",
        None,
        &Control::bounded(Duration::from_secs(900)),
    );
    std::fs::write(
        config["output"].as_str().unwrap(),
        serde_json::to_vec_pretty(&json!({"workId":id,"runId":run,"result":result})).unwrap(),
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
        if step["options"].is_object() {
            options::configure(root, &json!({"id":id,"options":step["options"]})).unwrap();
        }
        let result = if let Some(prompt) = step["prompt"].as_str() {
            ui(root,&json!({"action":"message","id":id,"expectedRevision":before["work"]["revision"],"clientMessageId":crate::random_url_safe(12),"text":prompt})).unwrap();
            if step["cancelDuringResponse"] == true {
                let owned_root = root.to_owned();
                let owned_id = id.to_owned();
                let worker = std::thread::spawn(move || {
                    ui(
                        &owned_root,
                        &json!({"action":"respond","id":owned_id,"mode":"deep"}),
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
                ui(root, &json!({"action":"respond","id":id,"mode":"deep"}))
            }
        } else if step["resume"] == true {
            ui(
                root,
                &json!({"action":"resume","id":id,"commandId":crate::random_url_safe(12),"expectedControlRevision":before["lifecycle"]["controlRevision"],"expectedWorkRevision":before["work"]["revision"],"expectedRunId":before["lifecycle"]["activeRunId"],"mode":"deep"}),
            )
        } else {
            store::view(root, id)
        };
        let after = store::view(root, id).unwrap();
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
