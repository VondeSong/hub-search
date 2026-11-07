use super::*;
#[test]
fn cn07b_native_schema_is_bounded_and_decode_preserves_script() {
    let specs = tools(None).unwrap();
    let spec = specs
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "hub_compute")
        .unwrap();
    crate::model_runtime::validate_agent_tool(
        &json!({"script":"@{n=1}|ConvertTo-Json"}),
        &spec["inputSchema"],
    )
    .unwrap();
    assert!(crate::model_runtime::validate_agent_tool(
        &json!({"script":"x","cwd":"C:/"}),
        &spec["inputSchema"]
    )
    .is_err());
    assert!(matches!(
        serde_json::from_value::<Tool>(json!({"operation":"compute","script":"{}"})).unwrap(),
        Tool::Compute { .. }
    ));
}
#[test]
#[ignore = "one frozen real model task using synthetic authorized material and MXC, no business writes"]
fn cn07b_live_material_compute_and_report() {
    let path = std::env::var("HUB_CN07B_LIVE_REPORT").expect("explicit report path");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(Path::new(&path).with_extension("started"))
        .unwrap();
    let f = crate::source_evidence::tests::Fixture::new();
    f.note(
        "notes",
        "current",
        "合成测量值（毫秒）：1,2,3,4,100。此数据仅用于验证计算，不代表实测性能。",
    );
    let anchor = json!({"kind":"note","libraryId":"notes","documentId":"current","pageId":null});
    let v=crate::agent_work::ui(&f.root,&json!({"action":"create","anchor":anchor,"grant":{"libraryIds":[],"notes":[anchor],"readingItemKeys":[],"sources":[],"attachmentLibraryIds":[],"images":[],"manifest":null},"goal":"读取授权合成材料，必须调用hub_compute实际运行PowerShell从input.json的content提取数值，计算中位数P50、nearest-rank P95；用工具返回结果写简短报告并引用材料。不要联网、不要业务写入，不要手算冒充执行。","successCriteria":"真实执行并给出P50=3、P95=100，说明nearest-rank；引用已读取材料，保存报告"})).unwrap();
    let id = v["work"]["id"].as_str().unwrap();
    options::configure(&f.root,&json!({"id":id,"options":{"model":crate::model_runtime::Settings::default(),"autoFlashcardInbox":false}})).unwrap();
    crate::agent_work::ui(&f.root,&json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"expectedAuthorizationVersion":1,"limits":{"inputTokens":200000,"uncachedInputTokens":200000,"outputTokens":12000},"perRun":{"inputTokens":200000,"uncachedInputTokens":200000,"outputTokens":12000},"unknownReservations":{}})).unwrap();
    let result =
        crate::agent_work::ui(&f.root, &json!({"action":"respond","id":id,"mode":"quick"}));
    let view = store::view(&f.root, id).unwrap();
    let records = store::records(&f.root, id, "toolResult", 40).unwrap();
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&json!({"result":result,"view":view,"toolResults":records}))
            .unwrap(),
    )
    .unwrap();
    result.unwrap();
    assert!(serde_json::to_string(&records)
        .unwrap()
        .contains("codex-mxc"));
    let report = view["work"]["report"]["prose"]["markdown"]
        .as_str()
        .unwrap();
    assert!(report.contains("100") && report.contains('3'));
    assert_eq!(view["actions"]["items"], json!([]));
}
