//! Explicit frozen deterministic branch only; never a model quality score.
use super::*;

#[test]
#[ignore = "formal frozen UX-03 coverage branch, explicit manifest and output only; no model"]
fn v1_formal_ux03_fixed_coverage_branches() {
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("HUB_V1_FORMAL_MANIFEST").unwrap()).unwrap(),
    )
    .unwrap();
    let out = PathBuf::from(std::env::var("HUB_V1_FORMAL_OUTPUT").unwrap());
    let binary = PathBuf::from(manifest["candidate"]["binary"].as_str().unwrap());
    assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(binary).unwrap())),
        manifest["candidate"]["binarySha256"].as_str().unwrap()
    );
    for item in manifest["initialStates"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| v["caseId"] == "UX-03")
    {
        let root = PathBuf::from(item["profile"].as_str().unwrap());
        assert!(root.to_string_lossy().contains(".local"));
        let f = std::mem::ManuallyDrop::new(Fixture { root });
        let id = item["extra"]["coverageBranchWorkId"].as_str().unwrap();
        let work = store::load(&f.c(), id).unwrap();
        let before: String = f.c().query_row("SELECT markdown FROM documents WHERE space_id='v1-fixtures' AND id='coverage-branches'",[],|r|r.get(0)).unwrap();
        let reader = work.grant.reader(&f.root).unwrap();
        let snapshot =
            analysis::execute(&reader, "hub_create_analysis_snapshot", &json!({})).unwrap();
        let args = json!({"expectedSnapshot":snapshot["snapshot"],"unit":"day","groupBy":"month","terms":["学习"],"dateFrom":"2025-01-01","dateTo":"2025-03-31"});
        let stats = analysis::execute(&reader, "hub_analyze_notes", &args).unwrap();
        assert_eq!(stats["documentsAnalyzed"], 1);
        assert_eq!(stats["datedSections"], 3);
        assert_eq!(stats["duplicateDateSections"], 1);
        assert_eq!(stats["totals"]["units"], 2);
        assert!(stats["unassignedCharacters"].as_u64().unwrap() > 0);
        assert_eq!(stats["groups"].as_array().unwrap().len(), 2);
        for (n, month, occurrences) in [(0, "2025-01", 3), (1, "2025-02", 1)] {
            assert_eq!(stats["groups"][n]["group"], month);
            assert_eq!(
                stats["groups"][n]["counts"]["terms"][0]["occurrences"],
                occurrences
            );
            assert_eq!(stats["groups"][n]["counts"]["terms"][0]["matchingUnits"], 1);
        }
        let mut march_args = args;
        march_args["dateFrom"] = json!("2025-03-01");
        let march = analysis::execute(&reader, "hub_analyze_notes", &march_args).unwrap();
        assert!(march["groups"].as_array().unwrap().is_empty());
        assert_eq!(march["totals"]["units"], 0);
        let after: String=f.c().query_row("SELECT markdown FROM documents WHERE space_id='v1-fixtures' AND id='coverage-branches'",[],|r|r.get(0)).unwrap();
        assert_eq!(before, after);
        let folder = out.join(format!("UX-03-{}", item["attempt"]));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("coverage.json"),serde_json::to_vec_pretty(&json!({"caseId":"UX-03","attempt":item["attempt"],"candidate":manifest["freezeId"],"track":"formal deterministic branch, not autonomous model score","entry":"production analysis::execute with prepared Work grant","modelCalls":0,"sourceUnchanged":true,"stats":stats,"emptyMarch":march,"passed":true})).unwrap()).unwrap();
    }
}
