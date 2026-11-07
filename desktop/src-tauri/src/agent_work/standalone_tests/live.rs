//! Fixed opt-in adoption of the production native host; no private sources or external writes.
use super::*;
use sha2::{Digest, Sha256};

fn paths() -> (std::path::PathBuf, std::path::PathBuf) {
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    (
        desktop.join(".local/independent-agent-live-20261030/profile"),
        desktop.join("artifacts/independent-agent-live-20261030"),
    )
}
fn read(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
fn save(out: &Path, name: &str, value: Value) {
    std::fs::write(out.join(name), serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}
fn dispatch(root: &Path, args: Value) -> Value {
    ui(root, &args).unwrap()
}
fn once(out: &Path, name: &str) {
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(out.join(name))
        .unwrap();
}

#[test]
#[ignore = "new independent Agent scope: one persistent zero-model initialization, never sealed Work reuse"]
fn independent_initialize_zero_once() {
    assert_eq!(std::env::var("HUB_INDEPENDENT_INITIALIZE").unwrap(), "1");
    let (root, out) = paths();
    let plan = read(out.join("plan.json"));
    assert_eq!(plan["version"], env!("CARGO_PKG_VERSION"));
    assert!(!root.join("craft-search.sqlite3").exists());
    once(&out, "initialization-started");
    std::fs::create_dir_all(root.join("vault")).unwrap();
    std::fs::write(
        root.join(".hub-isolated-runtime-v1"),
        b"Hub isolated runtime v1\n",
    )
    .unwrap();
    let mut c = crate::open_database(&root.join("craft-search.sqlite3")).unwrap();
    c.execute("INSERT INTO libraries(id,provider,name,location,enabled,added_at) VALUES('independent-notes','obsidian','独立助手验收资料',?1,1,1)",[root.join("vault").to_string_lossy().as_ref()]).unwrap();
    let mut notes = Vec::new();
    for note in plan["notes"].as_array().unwrap() {
        let path = root.join("vault").join(note["path"].as_str().unwrap());
        std::fs::write(&path, note["text"].as_str().unwrap()).unwrap();
        let document =
            crate::read_markdown_document_with_exclusions(&root.join("vault"), &path, &[]).unwrap();
        let tx = c.transaction().unwrap();
        crate::upsert_obsidian_document(&tx, "independent-notes", &document, 1).unwrap();
        tx.commit().unwrap();
        notes.push(json!({"kind":"note","libraryId":"independent-notes","documentId":document.id,"pageId":null}));
    }
    drop(c);
    let created = dispatch(
        &root,
        json!({"action":"create","anchor":null,"grant":Grant::default(),"goal":plan["inputs"][0],"successCriteria":"直接回答普通问题；使用授权资料时核对出处，不调用业务写入。"}),
    );
    let id = created["work"]["id"].as_str().unwrap();
    dispatch(
        &root,
        json!({"action":"configureAssistant","id":id,"options":{"model":plan["model"],"autoFlashcardInbox":false,"externalMcp":false}}),
    );
    let frozen = dispatch(
        &root,
        json!({"action":"freezeProviderBudget","id":id,"expectedWorkRevision":1,"limits":plan["workTokens"],"perRun":plan["runTokens"],"unknownReservations":{}}),
    );
    assert_eq!(frozen["lifecycle"]["providerBudget"]["canAdmitRun"], true);
    save(
        &out,
        "initialization.json",
        json!({"workId":id,"root":root,"notes":notes,"state":frozen,"models":0,"scope":"production host with synthetic isolated notes; not GUI or model evidence"}),
    );
}

#[test]
#[ignore = "exactly two ordered native-provider runs under a separately frozen new Work contract; first failure stops dependencies"]
fn independent_native_adoption_once() {
    assert_eq!(std::env::var("HUB_INDEPENDENT_MODEL").unwrap(), "1");
    let (root, out) = paths();
    let plan = read(out.join("plan.json"));
    let frozen = read(out.join("freeze.json"));
    let init = read(out.join("initialization.json"));
    assert_eq!(frozen["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(frozen["maximumRuns"], 2);
    let bytes = std::fs::read(frozen["binary"]["path"].as_str().unwrap()).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(bytes)),
        frozen["binary"]["sha256"].as_str().unwrap()
    );
    assert_eq!(
        std::fs::read(root.join(".hub-isolated-runtime-v1")).unwrap(),
        b"Hub isolated runtime v1\n"
    );
    let id = init["workId"].as_str().unwrap();
    let before = dispatch(&root, json!({"action":"status","id":id}));
    assert!(before["work"]["anchor"].is_null());
    assert_eq!(before["work"]["revision"], 1);
    assert_eq!(
        before["lifecycle"]["providerBudget"]["limits"],
        plan["workTokens"]
    );
    assert_eq!(
        store::records(&root, id, "modelExecution", 20)
            .unwrap()
            .len(),
        0
    );
    once(&out, "model-adoption-started");
    for phase in 0..2 {
        if phase == 1 {
            dispatch(
                &root,
                json!({"action":"message","id":id,"expectedRevision":1,"text":plan["inputs"][1],"clientMessageId":"independent-live-add-two","addNotes":init["notes"]}),
            );
        }
        let state = dispatch(&root, json!({"action":"status","id":id}));
        assert_eq!(state["lifecycle"]["providerBudget"]["canAdmitRun"], true);
        save(&out, &format!("phase-{phase}-before.json"), state);
        let mut budget = assistant::budget("quick").unwrap();
        budget.model_calls = 1;
        budget.output_repair_calls = 0;
        budget.seconds = plan["seconds"][phase].as_u64().unwrap();
        budget.model_call_seconds = budget.seconds;
        budget.request_bytes = plan["materialBytes"].as_u64().unwrap() as usize;
        let began = std::time::Instant::now();
        let result = super::super::run_mode(&root, id, budget, true);
        let state = dispatch(&root, json!({"action":"status","id":id}));
        save(&out, &format!("phase-{phase}-state.json"), state.clone());
        save(
            &out,
            &format!("phase-{phase}-return.json"),
            json!({"ok":result.is_ok(),"error":result.as_ref().err(),"elapsedMs":began.elapsed().as_secs_f64()*1000.0,"budget":budget,"exactServedModel":null,"cost":null,"layer":"real provider via production native host in cfg(test); actual binary GUI adoption is separate"}),
        );
        assert!(result.is_ok(), "{:?}", result.err());
        assert_eq!(state["work"]["state"], "completed");
        assert!(state["work"]["report"]["prose"]["markdown"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty()));
        assert_eq!(state["actions"]["items"], json!([]));
        if phase == 0 {
            assert_eq!(state["evidence"], json!([]));
        }
    }
}
