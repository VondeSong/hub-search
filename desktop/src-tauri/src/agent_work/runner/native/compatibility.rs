//! This gate covers provider-context reuse, not migration of Work facts or
//! external actions. A fresh provider session never authorizes replaying a write.
use super::*;

#[cfg(test)]
mod provider_switch_tests;

pub(super) fn latest_provider_run(root: &Path, work_id: &str) -> Result<Option<String>, String> {
    // Direct-provider replies are absent from a previously saved native thread.
    crate::source_evidence::open_read_database(root)?
        .query_row("SELECT run_id FROM agent_records WHERE work_id=?1 AND kind IN ('nativeRuntime','modelExecution') AND run_id IS NOT NULL ORDER BY rowid DESC LIMIT 1", [work_id], |r| r.get(0))
        .optional().map_err(|e| e.to_string())
}

pub(super) fn provider_turn_completed(session: &Value, latest_provider_run: Option<&str>) -> bool {
    session["providerTurnCompleted"] == true
        && latest_provider_run
            .is_some_and(|run| session["executionManifest"]["runId"].as_str() == Some(run))
}

fn runtime_binary_identity() -> Result<String, String> {
    // The supported launch contract freezes this candidate file for the process
    // lifetime. This hashes current_exe on disk, not loaded memory or a provider.
    static IDENTITY: std::sync::OnceLock<Result<String, String>> = std::sync::OnceLock::new();
    IDENTITY
        .get_or_init(|| {
            use std::io::Read;
            let path = std::env::current_exe()
                .map_err(|_| "运行程序身份不可核对；未启动模型".to_string())?;
            let mut file = std::fs::File::open(path)
                .map_err(|_| "运行程序身份不可读取；未启动模型".to_string())?;
            let mut digest = Sha256::new();
            let mut buffer = [0u8; 16384];
            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|_| "运行程序身份读取未完成；未启动模型".to_string())?;
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
            Ok(format!("{:x}", digest.finalize()))
        })
        .clone()
}
fn valid_sha256(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| text.len() == 64 && text.bytes().all(|ch| ch.is_ascii_hexdigit()))
}

pub(super) fn manifest(
    root: &Path,
    work: &Work,
    run: &str,
    tools: &Value,
    authentication_identity: &str,
) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let budget = store::execution_budget::view_on(&c, work)?;
    let provider = store::provider_budget::view_on(&c, work)?;
    let provider_policy = json!({"rootWorkId":provider["rootWorkId"],"limits":provider["limits"],"perRun":provider["perRun"]});
    let goal = store::goal::binding_on(&c, work)?;
    let mut query=c.prepare("SELECT id,kind,state,base_revision FROM agent_actions WHERE work_id=?1 ORDER BY created_at,id").map_err(|e|e.to_string())?;
    let actions=query.query_map([&work.id],|r|Ok(json!({"actionId":r.get::<_,String>(0)?,"kind":r.get::<_,String>(1)?,"state":r.get::<_,String>(2)?,"baseRevision":r.get::<_,i64>(3)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    Ok(
        json!({"checkpointSchemaVersion":1,"runnerContract":"hub-native-runner-11","actionTargetIdentity":work.action_target_identity,
        "runtimeBinarySha256":runtime_binary_identity()?,"runtimeBinaryIdentityScope":"current_exe file of an immutable candidate during process lifetime; not loaded-memory or external provider attestation",
        "providerAuthenticationSha256":authentication_identity,"providerAuthenticationIdentityScope":"exact sanitized temporary credential snapshot; token change may require fresh context; not provider account attestation",
        "runtimeBuild":env!("CARGO_PKG_VERSION"),"providerAdapterContract":"codex-app-server-control-7",
        "toolContractSha256":format!("{:x}",Sha256::digest(tools.to_string().as_bytes())),
        "budgetReference":{"providerPolicySha256":format!("{:x}",Sha256::digest(provider_policy.to_string().as_bytes())),"schemaVersion":budget["schemaVersion"],"rootWorkId":budget["rootWorkId"],"limitsSha256":format!("{:x}",Sha256::digest(budget["limits"].to_string().as_bytes()))},
        "workId":work.id,"runId":run,"workRevision":work.revision,"authorizationVersion":work.authorization_version,
        "goalBinding":goal,"actionRefs":actions,
        "meaning":"provider context only; current host facts, authorization, actions and budget remain authoritative"}),
    )
}

fn disposition(category: &str, reason: &str, can_rebuild: bool) -> Value {
    json!({"category":category,"reason":reason,"canRebuild":can_rebuild,
        "preserve":["Work","commands","artifacts","action identities and receipts","budget root and reservations"],
        "migrationPerformed":false,"externalActionReplayAuthorized":false})
}

pub(super) fn classify(previous: Option<&Value>, current: &Value) -> Value {
    if !valid_sha256(&current["runtimeBinarySha256"]) {
        return disposition("incompatible", "runtimeBinaryIdentityUnavailable", false);
    }
    if !valid_sha256(&current["providerAuthenticationSha256"]) {
        return disposition(
            "incompatible",
            "providerAuthenticationIdentityUnavailable",
            false,
        );
    }
    let Some(old) = previous.filter(|v| !v.is_null()) else {
        return disposition(
            "session_rebuild_required",
            "legacyCheckpointHasNoCompatibilityManifest",
            true,
        );
    };
    if old["checkpointSchemaVersion"] != 1 || current["checkpointSchemaVersion"] != 1 {
        return disposition("incompatible", "unsupportedCheckpointSchema", false);
    }
    if old["workId"] != current["workId"]
        || old["budgetReference"]["rootWorkId"] != current["workId"]
    {
        return disposition(
            "incompatible",
            "checkpointOrBudgetBelongsToAnotherWork",
            false,
        );
    }
    if old["budgetReference"]["schemaVersion"] != 1
        || current["budgetReference"]["schemaVersion"] != 1
    {
        return disposition("incompatible", "unsupportedBudgetReferenceSchema", false);
    }
    if !valid_sha256(&old["runtimeBinarySha256"]) {
        return disposition(
            "session_rebuild_required",
            "legacyCheckpointHasNoVerifiableBinaryIdentity",
            true,
        );
    }
    if !valid_sha256(&old["providerAuthenticationSha256"]) {
        return disposition(
            "session_rebuild_required",
            "legacyCheckpointHasNoAuthenticationIdentity",
            true,
        );
    }
    for (field, reason) in [
        (
            "providerAuthenticationSha256",
            "providerAuthenticationChanged",
        ),
        ("runtimeBuild", "runtimeBuildChanged"),
        ("runtimeBinarySha256", "runtimeBinaryChanged"),
        ("runnerContract", "runnerContractChanged"),
        ("providerAdapterContract", "providerAdapterContractChanged"),
        ("toolContractSha256", "toolContractChanged"),
        ("budgetReference", "budgetPolicyChanged"),
        ("actionRefs", "actionFactsChanged"),
        ("actionTargetIdentity", "actionTargetChanged"),
    ] {
        if old[field] != current[field] {
            return disposition("session_rebuild_required", reason, true);
        }
    }
    disposition("compatible", "sameDeclaredExecutionContract", true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_checkpoint_requires_credential_epoch_and_never_resets_work_facts() {
        let saved: Value =
            serde_json::from_str(include_str!("fixtures/credential-checkpoint-20261031.json"))
                .unwrap();
        let original = saved["manifest"].clone();
        let mut current = original.clone();
        current["providerAuthenticationSha256"] = json!("a".repeat(64));
        let legacy = classify(Some(&original), &current);
        assert_eq!(
            legacy["reason"],
            "legacyCheckpointHasNoAuthenticationIdentity"
        );
        assert_eq!(legacy["externalActionReplayAuthorized"], false);
        let same = current.clone();
        assert_eq!(classify(Some(&same), &current)["category"], "compatible");
        current["providerAuthenticationSha256"] = json!("b".repeat(64));
        let changed = classify(Some(&same), &current);
        assert_eq!(changed["reason"], "providerAuthenticationChanged");
        assert_eq!(changed["externalActionReplayAuthorized"], false);
        for key in [
            "workId",
            "budgetReference",
            "goalBinding",
            "actionRefs",
            "authorizationVersion",
            "actionTargetIdentity",
        ] {
            assert_eq!(current[key], original[key]);
        }
        for value in [Value::Null, json!("bad-identity"), json!(0)] {
            current["providerAuthenticationSha256"] = value;
            let refused = classify(Some(&same), &current);
            assert_eq!(refused["category"], "incompatible");
            assert_eq!(refused["canRebuild"], false);
        }
        assert!(original.get("providerAuthenticationSha256").is_none());
    }
    #[test]
    fn unfinished_or_legacy_provider_context_is_rebuilt_without_losing_checkpoint() {
        let saved = json!({"threadId":"saved-thread","executionManifest":{"workId":"same-work","runId":"completed-run"},"tokenUsage":{"total":{"inputTokens":21}}});
        let before = saved.clone();
        assert!(!provider_turn_completed(&saved, Some("completed-run")));
        for flag in [Value::Null, json!(false), json!("true")] {
            let mut checkpoint = saved.clone();
            checkpoint["providerTurnCompleted"] = flag;
            assert!(!provider_turn_completed(&checkpoint, Some("completed-run")));
        }
        let mut completed = saved.clone();
        completed["providerTurnCompleted"] = json!(true);
        assert!(provider_turn_completed(&completed, Some("completed-run")));
        assert!(!provider_turn_completed(
            &completed,
            Some("later-failed-run")
        ));
        assert!(!provider_turn_completed(&completed, None));
        assert_eq!(saved, before);
    }
    #[test]
    #[ignore = "explicit saved failed-session diagnosis, zero provider requests"]
    fn saved_failed_provider_checkpoint_is_not_resumed() {
        let path = std::env::var("HUB_NATIVE_FAILED_SESSION").unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(saved["threadId"].is_string());
        assert!(!provider_turn_completed(
            &saved,
            saved["executionManifest"]["runId"].as_str()
        ));
    }
    fn current() -> Value {
        json!({"checkpointSchemaVersion":1,"runnerContract":"hub-native-runner-5","runtimeBinarySha256":"a".repeat(64),"providerAuthenticationSha256":"d".repeat(64),"runtimeBuild":env!("CARGO_PKG_VERSION"),"providerAdapterContract":"codex-app-server-control-7","toolContractSha256":"current-tool-hash","budgetReference":{"schemaVersion":1,"rootWorkId":"work-owned","limitsSha256":"policy"},"workId":"work-owned","runId":"run-current","workRevision":3,"goalBinding":{"revision":3},"actionRefs":[{"actionId":"saved-action","state":"unknown"}]})
    }
    #[test]
    fn legacy_checkpoint_rebuilds_without_guessing_or_replaying_actions() {
        let p = classify(None, &current());
        assert_eq!(p["category"], "session_rebuild_required");
        assert_eq!(p["externalActionReplayAuthorized"], false);
        assert_eq!(p["migrationPerformed"], false);
    }
    #[test]
    fn same_version_repackaged_binary_rebuilds_with_no_action_or_budget_reset() {
        let mut old = current();
        old["runtimeBinarySha256"] = json!("b".repeat(64));
        let before = old.clone();
        let p = classify(Some(&old), &current());
        assert_eq!(p["category"], "session_rebuild_required");
        assert_eq!(p["reason"], "runtimeBinaryChanged");
        assert_eq!(p["externalActionReplayAuthorized"], false);
        assert_eq!(old, before);
    }
    #[test]
    fn explicit_write_target_change_rebuilds_context_without_changing_read_authorization() {
        let old = current();
        let mut changed = old.clone();
        changed["actionTargetIdentity"] = json!("explicit-target-2");
        let result = classify(Some(&old), &changed);
        assert_eq!(result["reason"], "actionTargetChanged");
        assert_eq!(result["externalActionReplayAuthorized"], false);
        assert_eq!(changed["goalBinding"], old["goalBinding"]);
        assert_eq!(changed["budgetReference"], old["budgetReference"]);
    }
    #[test]
    fn legacy_missing_binary_rebuilds_but_unknown_current_binary_stops_dispatch() {
        let mut old = current();
        old.as_object_mut().unwrap().remove("runtimeBinarySha256");
        assert_eq!(
            classify(Some(&old), &current())["category"],
            "session_rebuild_required"
        );
        for bad in [Value::Null, json!("not-a-binary-hash")] {
            let mut target = current();
            target["runtimeBinarySha256"] = bad;
            let p = classify(Some(&old), &target);
            assert_eq!(p["category"], "incompatible");
            assert_eq!(p["canRebuild"], false);
        }
    }
    #[test]
    fn identical_contract_allows_reuse_but_run_and_goal_changes_remain_host_facts() {
        let mut old = current();
        old["runId"] = json!("prior-run");
        old["workRevision"] = json!(2);
        old["goalBinding"] = json!({"revision":2});
        assert_eq!(classify(Some(&old), &current())["category"], "compatible");
    }
    #[test]
    fn build_change_and_downgrade_require_fresh_provider_context() {
        for build in ["0.16.318", "99.0.0"] {
            let mut old = current();
            old["runtimeBuild"] = json!(build);
            let p = classify(Some(&old), &current());
            assert_eq!(p["category"], "session_rebuild_required");
            assert_eq!(p["reason"], "runtimeBuildChanged");
        }
    }
    #[test]
    fn changed_tools_or_provider_contract_do_not_reuse_the_old_thread() {
        for field in [
            "toolContractSha256",
            "providerAdapterContract",
            "runnerContract",
        ] {
            let mut old = current();
            old[field] = json!("older-contract");
            assert_eq!(
                classify(Some(&old), &current())["category"],
                "session_rebuild_required"
            );
        }
    }
    #[test]
    fn unknown_schemas_and_other_work_budget_roots_block_dispatch() {
        for (field, value) in [
            ("checkpointSchemaVersion", json!(2)),
            ("workId", json!("other-work")),
        ] {
            let mut old = current();
            old[field] = value;
            let p = classify(Some(&old), &current());
            assert_eq!(p["category"], "incompatible");
            assert_eq!(p["canRebuild"], false);
        }
        let mut old = current();
        old["budgetReference"]["schemaVersion"] = json!(2);
        assert_eq!(classify(Some(&old), &current())["canRebuild"], false);
        old = current();
        old["budgetReference"]["rootWorkId"] = json!("other-work");
        assert_eq!(classify(Some(&old), &current())["canRebuild"], false);
    }
    #[test]
    fn changed_budget_policy_or_action_outcome_rebuilds_without_mutating_saved_facts() {
        for field in ["budgetReference", "actionRefs"] {
            let mut old = current();
            if field == "actionRefs" {
                old[field][0]["state"] = json!("verified");
            } else {
                old[field]["limitsSha256"] = json!("old-policy");
            }
            let before = old.clone();
            let p = classify(Some(&old), &current());
            assert_eq!(p["category"], "session_rebuild_required");
            assert_eq!(old, before);
            assert_eq!(p["externalActionReplayAuthorized"], false);
        }
    }
    #[test]
    fn manifest_uses_real_work_goal_and_budget_identity_without_provider_calls() {
        let f = crate::source_evidence::tests::Fixture::new();
        f.note("notes", "current", "获准原文");
        let id = crate::agent_work::tests::create(&f, true);
        let w = store::claim_with_budget(
            &f.root,
            &id,
            "manifest-only",
            Budget::mode("quick").unwrap(),
        )
        .unwrap();
        let clock = std::time::Instant::now();
        let m = manifest(
            &f.root,
            &w,
            "manifest-only",
            &json!([{"name":"real-contract-name","schema":{"type":"object"}}]),
            &"d".repeat(64),
        )
        .unwrap();
        assert_eq!(m["workId"], id);
        assert_eq!(m["runId"], "manifest-only");
        assert_eq!(m["budgetReference"]["rootWorkId"], id);
        assert_eq!(m["runtimeBuild"], env!("CARGO_PKG_VERSION"));
        assert_eq!(m["providerAdapterContract"], "codex-app-server-control-7");
        let mut old = m.clone();
        old["providerAdapterContract"] = json!("codex-app-server-control-2");
        let saved = old.clone();
        let disposition = classify(Some(&old), &m);
        assert_eq!(disposition["reason"], "providerAdapterContractChanged");
        assert_eq!(disposition["category"], "session_rebuild_required");
        assert_eq!(disposition["canRebuild"], true);
        assert_eq!(disposition["externalActionReplayAuthorized"], false);
        assert_eq!(disposition["migrationPerformed"], false);
        assert_eq!(old, saved);
        for key in [
            "workId",
            "goalBinding",
            "actionRefs",
            "budgetReference",
            "authorizationVersion",
        ] {
            assert_eq!(old[key], m[key]);
        }
        assert!(valid_sha256(&m["runtimeBinarySha256"]));
        assert_eq!(m["providerAuthenticationSha256"], "d".repeat(64));
        assert_eq!(m["actionRefs"], json!([]));
        assert!(m["goalBinding"].is_object());
        assert_eq!(m["toolContractSha256"].as_str().unwrap().len(), 64);
        assert!(store::records(&f.root, &id, "nativeRuntime", 10)
            .unwrap()
            .is_empty());
        if let Ok(path) = std::env::var("HUB_RUNTIME_IDENTITY_OUT") {
            std::fs::write(path,serde_json::to_vec_pretty(&json!({"manifest":m,"firstManifestHostMs":clock.elapsed().as_secs_f64()*1000.0,"scope":"verified test process; includes first executable-file hash and store reads, not native UI/model time","models":0})).unwrap()).unwrap();
        }
    }
}
