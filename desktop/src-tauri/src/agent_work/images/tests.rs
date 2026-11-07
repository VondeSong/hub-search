use super::*;
use crate::source_evidence::tests::Fixture;
const PNG: &[u8] = include_bytes!("fixture.png");
#[test]
fn local_image_staging_does_not_grant_and_exact_bytes_survive_message_binding() {
    let f=Fixture::new();
    let args=json!({"action":"stageImage","title":"本地截图.png","mime":"image/png","base64":base64::engine::general_purpose::STANDARD.encode(PNG)});
    let staged=ui(&f.root,&args).unwrap();
    let g:ImageGrant=serde_json::from_value(staged["grant"].clone()).unwrap();
    let id=create(&f);
    assert!(store::load(&f.c(),&id).unwrap().grant.images.is_empty());
    let preview=ui(&f.root,&json!({"action":"imagePreview","grant":g})).unwrap();
    assert_eq!(preview["title"],"本地截图.png");
    assert!(preview["url"].as_str().unwrap().starts_with("data:image/png;base64,"));
    ui(&f.root,&message(&f,&id,&g,false,1)).unwrap();
    assert_eq!(prepare(&f.root,&[g.clone()]).unwrap().2,PNG.len());
    let mut forged=g.clone();forged.source_item_id="../secret".into();
    assert!(bytes(&f.root,&f.c(),&forged).is_err());
    let mut wrong=args.clone();wrong["mime"]=json!("image/jpeg");assert!(ui(&f.root,&wrong).is_err());
    assert!(bytes(&f.root,&f.c(),&g).is_ok());
    std::fs::write(f.root.join("collection-files/agent-images").join(format!("{}.image",g.source_item_id)),b"tampered").unwrap();
    assert!(prepare(&f.root,&[g]).is_err());
}

#[test]
fn local_image_rejects_invalid_and_oversized_inputs_before_staging() {
    let f=Fixture::new();
    for (mime,data) in [("text/plain","a".to_string()),("image/png","!".into()),("image/png","A".repeat(400_000))] {
        assert!(ui(&f.root,&json!({"action":"stageImage","title":"invalid","mime":mime,"base64":data})).is_err());
    }
    assert!(!f.root.join("collection-files/agent-images").exists());
}
#[test]
fn local_image_upload_is_not_limited_by_normal_message_envelope() {
    let f=Fixture::new();
    let mut data=PNG.to_vec();data.resize(80_000,0);
    let staged=ui(&f.root,&json!({"action":"stageImage","title":"large.png","mime":"image/png","base64":base64::engine::general_purpose::STANDARD.encode(&data)})).unwrap();
    let g:ImageGrant=serde_json::from_value(staged["grant"].clone()).unwrap();
    assert_eq!(bytes(&f.root,&f.c(),&g).unwrap().0,data);
}
fn seed(f: &Fixture) -> ImageGrant {
    crate::attachment_evidence::tests::seed(f, "image", "synthetic");
    let blob = crate::blob_store::BlobStore::open(&f.root.join("blobs-v1"))
        .unwrap()
        .put(PNG)
        .unwrap();
    f.c().execute("UPDATE source_items SET mime_type='image/png',blob_hash=?1,content_hash=?1,title='合成图形' WHERE id='image'",[blob.hash]).unwrap();
    identity(&f.root, &f.c(), "notes", "image").unwrap().0
}
fn create(f: &Fixture) -> String {
    let v=ui(&f.root,&json!({"action":"create","anchor":null,"grant":Grant::default(),"goal":"查看图片","successCriteria":"按用户问题回答"})).unwrap();
    v["work"]["id"].as_str().unwrap().into()
}
fn message(_f: &Fixture, id: &str, g: &ImageGrant, remove: bool, revision: i64) -> Value {
    json!({"action":"message","id":id,"expectedRevision":revision,"clientMessageId":format!("image-{revision}"),"text":"更新明确原图授权，不启动分析","addImages":if remove{vec![]}else{vec![g]},"removeImages":if remove{vec![g]}else{vec![]}})
}
#[test]
fn cn05b_explicit_grant_is_versioned_idempotent_and_never_inferred_from_ocr() {
    let f = Fixture::new();
    let g = seed(&f);
    let id = create(&f);
    assert!(prepare(&f.root, &[]).unwrap().0.is_empty());
    let legacy: Grant = serde_json::from_value(
        json!({"libraryIds":[],"notes":[],"readingItemKeys":[],"attachmentLibraryIds":["notes"]}),
    )
    .unwrap();
    assert!(legacy.images.is_empty());
    let mut forged = Grant::default();
    forged.images.push(g.clone());
    assert!(ui(&f.root,&json!({"action":"create","anchor":null,"grant":forged,"goal":"测试","successCriteria":"测试"})).is_err());
    let m = message(&f, &id, &g, false, 1);
    let v = ui(&f.root, &m).unwrap();
    assert_eq!(v["work"]["revision"], 2);
    assert_eq!(v["work"]["authorizationVersion"], 2);
    assert!(v["work"]["activeRun"].is_null());
    ui(&f.root, &m).unwrap();
    let mut changed = m;
    changed["removeImages"] = json!([g]);
    assert!(ui(&f.root, &changed).is_err());
    let reopened = store::view(&f.root, &id).unwrap();
    assert_eq!(reopened["work"]["grant"]["images"], json!([g]));
    let current = store::load(&f.c(), &id).unwrap();
    assert!(store::materials::grant_at(&f.c(), &current, 1)
        .unwrap()
        .images
        .is_empty());
}
#[test]
fn cn05b_exact_bytes_decode_transport_and_metadata_do_not_disclose_paths() {
    let f = Fixture::new();
    let g = seed(&f);
    let (input, metadata, n) = prepare(&f.root, &[g]).unwrap();
    assert_eq!(n, PNG.len());
    assert_eq!(metadata[0]["width"], 240);
    assert_eq!(metadata[0]["height"], 120);
    let url = input[0]["url"].as_str().unwrap();
    let data = base64::engine::general_purpose::STANDARD
        .decode(url.strip_prefix("data:image/png;base64,").unwrap())
        .unwrap();
    assert_eq!(data, PNG);
    assert!(input[0].get("path").is_none());
    assert!(!metadata.to_string().contains("base64"));
}
#[test]
fn cn05b_changed_missing_corrupt_disabled_and_oversized_images_fail_closed() {
    for failure in [
        "version",
        "missing",
        "corrupt",
        "disabled",
        "oversized",
        "wrongMime",
        "decode",
    ] {
        let f = Fixture::new();
        let mut g = seed(&f);
        let store = crate::blob_store::BlobStore::open_existing(&f.root.join("blobs-v1")).unwrap();
        let path = store.path_for(&g.blob_hash).unwrap();
        match failure {
            "version" => {
                f.c()
                    .execute("UPDATE source_items SET modified_at=5 WHERE id='image'", [])
                    .unwrap();
            }
            "missing" => {
                std::fs::remove_file(path).unwrap();
            }
            "corrupt" => {
                std::fs::write(path, b"corrupt").unwrap();
            }
            "disabled" => {
                f.c()
                    .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
                    .unwrap();
            }
            "wrongMime" => {
                f.c()
                    .execute(
                        "UPDATE source_items SET mime_type='application/pdf' WHERE id='image'",
                        [],
                    )
                    .unwrap();
            }
            value => {
                let data = if value == "oversized" {
                    vec![0; MAX_BYTES + 1]
                } else {
                    b"\x89PNG\r\n\x1a\ncorrupt payload".to_vec()
                };
                let blob = store.put(&data).unwrap();
                f.c()
                    .execute(
                        "UPDATE source_items SET blob_hash=?1,content_hash=?1 WHERE id='image'",
                        [blob.hash],
                    )
                    .unwrap();
                g = identity(&f.root, &f.c(), "notes", "image").unwrap().0;
            }
        }
        assert!(prepare(&f.root, &[g]).is_err(), "{failure}");
    }
}
#[test]
fn cn05b_withdrawal_remains_available_after_image_changes_and_invalidates_history() {
    let f = Fixture::new();
    let g = seed(&f);
    let id = create(&f);
    ui(&f.root, &message(&f, &id, &g, false, 1)).unwrap();
    let (w, run) = crate::agent_work::tests::claim(&f, &id);
    store::record(&f.root, &run, "agentProtocol", &json!({"version":1})).unwrap();
    store::record(
        &f.root,
        &run,
        "nativeFinal",
        &json!({"text":"图片观察内容"}),
    )
    .unwrap();
    store::fail(&f.root, &w, &run, "测试失败保留").unwrap();
    f.c()
        .execute("UPDATE source_items SET modified_at=2 WHERE id='image'", [])
        .unwrap();
    let v = store::view(&f.root, &id).unwrap();
    assert!(!v["activity"].to_string().contains("图片观察内容"));
    let v = ui(&f.root, &message(&f, &id, &g, true, 2)).unwrap();
    assert!(v["work"]["grant"].get("images").is_none());
    let current = store::load(&f.c(), &id).unwrap();
    assert!(store::materials::grant_at(&f.c(), &current, 2).is_err());
    assert!(v["activity"].as_array().unwrap().is_empty());
}
#[test]
fn cn05b_selection_count_stale_revision_and_running_changes_are_rejected() {
    let f = Fixture::new();
    let g = seed(&f);
    let id = create(&f);
    assert!(selection(&json!({"addImages":[g,g,g]}), "addImages").is_err());
    assert!(ui(&f.root, &message(&f, &id, &g, false, 7)).is_err());
    let (_, run) = crate::agent_work::tests::claim(&f, &id);
    assert!(ui(&f.root, &message(&f, &id, &g, false, 1)).is_err());
    assert!(!run.is_empty());
}
#[test]
fn cn05b_publication_reopen_and_source_change_keep_image_dependency() {
    let f = Fixture::new();
    let g = seed(&f);
    let id = create(&f);
    ui(&f.root, &message(&f, &id, &g, false, 1)).unwrap();
    let (w, run) = crate::agent_work::tests::claim(&f, &id);
    store::record(&f.root, &run, "agentProtocol", &json!({"version":1})).unwrap();
    let normalized=assistant::normalize(json!({"report":{"status":"completed","markdown":"视觉结论哨兵","citations":[],"questions":[],"limitations":[],"waitCondition":"","completion":null}}),&json!([])).unwrap();
    let report: runner::Report = serde_json::from_value(normalized["report"].clone()).unwrap();
    store::goal::accept_report(
        &f.root,
        &w,
        &run,
        &report,
        &store::goal::for_run(&f.root, &w, &run).unwrap(),
    )
    .unwrap();
    f.c()
        .execute("UPDATE source_items SET modified_at=9 WHERE id='image'", [])
        .unwrap();
    assert!(store::publish(
        &f.root,
        &w,
        &run,
        &report,
        &[],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default()
    )
    .is_err());
    f.c()
        .execute(
            "UPDATE source_items SET modified_at=NULL WHERE id='image'",
            [],
        )
        .unwrap();
    store::publish(
        &f.root,
        &w,
        &run,
        &report,
        &[],
        &[],
        &json!([]),
        &Value::Null,
        &Control::default(),
    )
    .unwrap();
    let reopened = store::view(&f.root, &id).unwrap();
    assert_eq!(
        reopened["work"]["report"]["prose"]["markdown"],
        "视觉结论哨兵"
    );
    f.c()
        .execute("UPDATE source_items SET modified_at=9 WHERE id='image'", [])
        .unwrap();
    let invalid = store::view(&f.root, &id).unwrap();
    assert!(invalid["work"]["report"].is_null());
    assert!(!invalid["conversation"].to_string().contains("视觉结论哨兵"));
}
#[test]
#[ignore = "one synthetic image through actual Hub Codex adapter; no personal data, web or business action"]
fn cn05b_live_image_observation_publishes_with_bound_metadata() {
    let path = std::env::var("HUB_CN05B_LIVE_REPORT").expect("explicit report path");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(std::path::Path::new(&path).with_extension("started"))
        .unwrap();
    let f = Fixture::new();
    let g = seed(&f);
    let id = create(&f);
    ui(&f.root, &message(&f, &id, &g, false, 1)).unwrap();
    ui(&f.root,&json!({"action":"message","id":id,"expectedRevision":2,"clientMessageId":"visual-question","text":"请观察本轮实际图片，用一句话描述左右两个形状的颜色。不要调用工具，不要推测图片以外内容。"})).unwrap();
    options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    let started = std::time::Instant::now();
    let result = ui(&f.root, &json!({"action":"respond","id":id,"mode":"quick"}));
    let view = store::view(&f.root, &id).unwrap();
    let metadata = store::records(&f.root, &id, "nativeImages", 10).unwrap();
    let usage = store::records(&f.root, &id, "nativeMaterialUsage", 10).unwrap();
    std::fs::write(&path,serde_json::to_vec_pretty(&json!({"result":result,"view":view,"imageMetadata":metadata,"materialUsage":usage,"durationMs":started.elapsed().as_millis(),"fixture":"synthetic colored rectangles; no OCR/text descriptions of colors in prompt"})).unwrap()).unwrap();
    result.unwrap();
    let text = view["work"]["report"]["prose"]["markdown"]
        .as_str()
        .unwrap();
    assert!(text.contains('红') && text.contains('蓝'));
    assert_eq!(metadata.len(), 1);
    assert_eq!(view["actions"]["items"], json!([]));
}
