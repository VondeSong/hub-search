//! Explicit read-only preflight; never registers a package or changes cloud policy.
use super::*;
use rusqlite::OpenFlags;

#[tokio::test]
#[ignore = "explicit real skill source and daily config; reads one private OSS skills page, no writes"]
async fn real_skill_source_and_existing_oss_readonly_preflight() {
    let source_path =
        std::env::var("HUB_SKILL_PREFLIGHT_SOURCE").expect("explicit selected source");
    let database_path =
        PathBuf::from(std::env::var_os("HUB_SKILL_PREFLIGHT_DB").expect("explicit daily database"));
    let output =
        PathBuf::from(std::env::var_os("HUB_SKILL_PREFLIGHT_OUT").expect("explicit report path"));
    assert!(database_path.is_absolute() && database_path.is_file());
    assert!(output.is_absolute() && !output.exists());
    let captured =
        inspection::capture(&source_path).expect("selected real skill must pass native inspection");
    let files = captured.files.as_object().unwrap();
    let mut report = json!({"format":"hub-real-skill-readonly-preflight-v1", "name":captured.skill.name,
        "sourceFingerprint":captured.fingerprint,"files":files.iter().map(|(path,file)|json!({"path":path,"bytes":file["bytes"],"sha256":file["sha256"],"readable":file["readable"]})).collect::<Vec<_>>(),
        "rawBytes":files.values().filter_map(|file|file["bytes"].as_u64()).sum::<u64>(),
        "unavailable":captured.skill.unavailable,"requiredTools":captured.skill.required,"warnings":captured.warnings,
        "limits":{"rawBytes":inspection::MAX_BYTES,"versionBytes":MAX_VERSION_BYTES,"files":33,"referenceBytes":MAX_REFERENCE},
        "writesPerformed":false,"scope":"source inspection and one existing skills inventory page; not client transfer or model execution"});
    let c = Connection::open_with_flags(&database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read daily config without migrations");
    report["policy"] = json!(crate::cloud_sync::policy(&c));
    report["registeredVersions"] = json!(c
        .query_row("SELECT count(*) FROM agent_method_versions", [], |r| r
            .get::<_, i64>(0))
        .unwrap());
    let config = object_store::configuration(&c).expect("existing daily OSS configuration");
    let object_store::Configuration::Oss { config } = config;
    let secret = crate::credential_entry("hub-flashcard-oss-secret-v1")
        .ok()
        .and_then(|entry| entry.get_password().ok());
    let inventory = match secret {
        Some(secret) => match crate::flashcard_object_store::OssStore::new(config, secret) {
            Ok(remote) => remote.list_page("skills/v1/", None).await.map(
                |page| json!({"firstPageObjects":page.keys.len(),"hasMore":page.next.is_some()}),
            ),
            Err(_) => Err("OSS configuration validation failed".into()),
        },
        None => Err("Existing Windows OSS credential unavailable".into()),
    };
    report["oss"] = match &inventory {
        Ok(v) => v.clone(),
        Err(error) => json!({"error":error}),
    };
    std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    assert!(
        inventory.is_ok(),
        "read-only OSS preflight failed; see sanitized report"
    );
}
