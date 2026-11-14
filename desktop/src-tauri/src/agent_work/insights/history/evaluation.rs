//! Explicit, once-only production-path evaluation; private inputs/results stay outside Git.
use super::super::*;
#[test]
#[ignore = "explicit real local-data/model evaluation; creates only named analysis Works"]
fn real_p0_comparison_once() {
    assert_eq!(std::env::var("HUB_INSIGHTS_P0_REAL").as_deref(), Ok("1"));
    let plan = PathBuf::from(std::env::var("HUB_INSIGHTS_P0_PLAN").expect("explicit plan"));
    let plan: Value = serde_json::from_slice(&std::fs::read(plan).unwrap()).unwrap();
    let root = PathBuf::from(plan["root"].as_str().unwrap());
    let out = PathBuf::from(plan["output"].as_str().unwrap());
    std::fs::create_dir_all(&out).unwrap();
    for case in plan["cases"].as_array().unwrap() {
        let name = case["id"].as_str().unwrap();
        if std::env::var("HUB_INSIGHTS_P0_CASE")
            .ok()
            .is_some_and(|id| id != name)
        {
            continue;
        }
        let case_dir = out.join(name);
        std::fs::create_dir_all(&case_dir).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(case_dir.join("started"))
            .expect("keep failed attempt, never silently resample");
        let notes: Vec<EvidenceLocator> = serde_json::from_value(case["notes"].clone()).unwrap();
        let reader = Grant {
            notes: notes.clone(),
            ..Default::default()
        }
        .reader(&root)
        .unwrap();
        let excerpts = notes
            .iter()
            .map(|n| reader.read(n, 0, 20000, None).unwrap())
            .collect::<Vec<_>>();
        std::fs::write(
            case_dir.join("sources.json"),
            serde_json::to_vec_pretty(&excerpts).unwrap(),
        )
        .unwrap();
        let lookup = super::ui(
            &root,
            &json!({"action":"insightHistorySearch","notes":[notes[0]],"libraryIds":case["historyLibraries"],"query":case["lookup"]}),
        );
        std::fs::write(
            case_dir.join("lookup.json"),
            serde_json::to_vec_pretty(&lookup).unwrap(),
        )
        .unwrap();
        let prepared=super::super::discovery::ui(&root,&json!({"action":"insightDiscoveryPrepare","operationId":crate::random_url_safe(18),"question":case["question"],"notes":notes})).unwrap();
        let direct = prepared["workId"].as_str().unwrap().to_owned();
        let c = crate::source_evidence::open_read_database(&root).unwrap();
        let raw:String=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='userMessage' ORDER BY rowid DESC LIMIT 1",[&direct],|r|r.get(0)).unwrap();
        let message: Value = serde_json::from_str(&raw).unwrap();
        let baseline=super::super::super::ui(&root,&json!({"action":"create","goal":case["question"],"successCriteria":"按同一问题、相同材料和分析方法核对联系、适用条件与未知","anchor":notes[0],"grant":{"notes":notes,"libraryIds":[],"readingItemKeys":[]}})).unwrap();
        let baseline = baseline["work"]["id"].as_str().unwrap().to_owned();
        let status =
            super::super::super::ui(&root, &json!({"action":"status","id":baseline})).unwrap();
        super::super::super::ui(&root,&json!({"action":"message","id":baseline,"text":message["text"],"clientMessageId":crate::random_url_safe(18),"expectedRevision":status["work"]["revision"]})).unwrap();
        let order = if case["baselineFirst"] == true {
            vec![("skill", baseline), ("direct", direct)]
        } else {
            vec![("direct", direct), ("skill", baseline)]
        };
        for (path, id) in order {
            super::super::super::ui(&root,&json!({"action":"configureAssistant","id":id,"options":{"model":plan["model"],"autoFlashcardInbox":false,"externalMcp":false}})).unwrap();
            let before = std::time::Instant::now();
            let result = super::super::super::run_mode(
                &root,
                &id,
                assistant::budget("quick").unwrap(),
                true,
            );
            let seconds = before.elapsed().as_secs_f64();
            let status = super::super::super::ui(&root, &json!({"action":"status","id":id}));
            let delivery = super::super::ui(&root, &json!({"action":"insightDeliveries","id":id}));
            let candidates=delivery.as_ref().ok().and_then(|v|v["items"].as_array()).and_then(|a|a.first()).map(|v|super::super::ui(&root,&json!({"action":"insightCandidates","id":id,"deliveryRecordId":v["deliveryRecordId"]})));
            let records = store::records(&root, &id, "modelExecution", 50).unwrap();
            let c = crate::source_evidence::open_read_database(&root).unwrap();
            let raw:Option<String>=c.query_row("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind='delivery' ORDER BY rowid DESC LIMIT 1",[&id],|r|r.get(0)).optional().unwrap();
            let delivery = raw.map(|r| serde_json::from_str::<Value>(&r).unwrap());
            std::fs::write(case_dir.join(format!("{path}.json")),serde_json::to_vec_pretty(&json!({"id":id,"elapsedSeconds":seconds,"result":result,"status":status,"candidates":candidates,"executions":records,"delivery":delivery,"inputMessage":message,"plan":case,"model":plan["model"]})).unwrap()).unwrap();
            eprintln!(
                "P0 {name}/{path}: {seconds:.1}s, {:?}",
                result.as_ref().err()
            );
        }
    }
}
