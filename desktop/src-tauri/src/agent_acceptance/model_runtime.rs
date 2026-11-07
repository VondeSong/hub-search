//! Explicit developer feature only. The normal app-owned AppHandle provides
//! real credentials/source/target context to both original read-only planners.
//! Background jobs and remote execution are never started by this entry.
use crate::*;

fn diagnostic(error: &str) -> String {
    let urls = regex::Regex::new(r#"https?://[^\s\"<>]+"#).unwrap();
    let keys = regex::Regex::new(r"(?i)(?:sk-|Bearer\s+)[A-Za-z0-9._~-]+").unwrap();
    let opaque = regex::Regex::new(r"[A-Za-z0-9_-]{24,}").unwrap();
    let value = urls.replace_all(error, "[URL]");
    let value = keys.replace_all(&value, "[credential]");
    opaque
        .replace_all(&value, "[opaque]")
        .chars()
        .take(320)
        .collect()
}

fn write(dir: &Path, name: &str, value: &Value) -> Result<(), String> {
    fs::write(
        dir.join(name),
        serde_json::to_vec_pretty(value).map_err(|_| "验收结果编码失败")?,
    )
    .map_err(|_| "验收结果保存失败".into())
}
fn counts(root: &Path) -> Result<Value, String> {
    let c = source_evidence::open_read_database(root)?;
    let count = |table: &str| {
        c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| e.to_string())
    };
    Ok(
        json!({"jobs":count("collection_library_jobs")?,"copies":count("collection_remote_copies")?}),
    )
}
pub(crate) fn start(app: &AppHandle) -> Result<bool, String> {
    let Some(path) = std::env::var_os("HUB_NATIVE_MODEL_ACCEPTANCE_CONFIG") else {
        return Ok(false);
    };
    let bytes = fs::read(path).map_err(|_| "原生模型验收配置无法读取")?;
    if bytes.len() > 16_384 {
        return Err("原生模型验收配置过大".into());
    }
    let config: Value = serde_json::from_slice(&bytes).map_err(|_| "原生模型验收配置无效")?;
    if config["format"] != "hub-model-native-planners-v1" {
        return Err("原生模型验收身份无效".into());
    }
    let root = active_data_root(app)?;
    let expected = fs::canonicalize(config["dataRoot"].as_str().ok_or("缺少验收数据根")?)
        .map_err(|_| "验收数据根无效")?;
    if fs::canonicalize(&root).map_err(|_| "活动数据根无效")? != expected {
        return Err("验收未绑定当前正式资料库，已停止".into());
    }
    let dir = PathBuf::from(config["evidenceDir"].as_str().ok_or("缺少验收证据目录")?);
    if !dir.is_dir() {
        return Err("验收证据目录必须预先创建".into());
    }
    write(
        &dir,
        "native-planners-result.json",
        &json!({"status":"running"}),
    )?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = execute(&app, &root, &dir, &config).await;
        if let Ok(after) = counts(&root) {
            let _ = write(&dir, "native-planners-after.json", &after);
        }
        let failure_kind = result.as_ref().err().map(|error| {
            if error.contains("登录") || error.contains("认证") || error.contains("授权") {
                "targetAuthentication"
            } else if error.contains("超时") {
                "timeout"
            } else if error.contains("模型") || error.contains("DeepSeek") {
                "model"
            } else {
                "validationOrTarget"
            }
        });
        let outcome = json!({"status":if result.is_ok(){"passed"}else{"failed"},"failureKind":failure_kind,"diagnostic":result.as_ref().err().map(|e|diagnostic(e)),"remoteExecution":false,"backgroundWorkersStarted":false});
        let _ = write(&dir, "native-planners-result.json", &outcome);
        app.exit(if result.is_ok() { 0 } else { 1 });
    });
    Ok(true)
}
async fn execute(app: &AppHandle, root: &Path, dir: &Path, config: &Value) -> Result<(), String> {
    let before = counts(root)?;
    let op_root = root.to_path_buf();
    let snapshot =
        tokio::task::spawn_blocking(move || model_runtime::ui(&op_root, &json!({"action":"get"})))
            .await
            .map_err(|_| "读取模型设置中断")??;
    if snapshot["settings"]["provider"] != "deepseek" {
        return Err("请先完成 DeepSeek 直连设置验收".into());
    }
    write(dir, "native-planners-before.json", &before)?;
    for (provider, key) in [("craft", "craftTarget"), ("dida365", "didaTarget")] {
        let target = config[key].as_str().ok_or("缺少验收目标")?;
        let item = config["itemKey"].as_str().ok_or("缺少真实阅读条目")?;
        write(
            dir,
            "native-planners-progress.json",
            &json!({"provider":provider,"stage":"readingTargetAndPlanning"}),
        )?;
        let result =
            x_bookmarks::library::conversion::model_acceptance_plan(app, item, target, provider)
                .await?;
        if result["status"] != "planned" {
            return Err(format!("{provider} 未形成可用方案，仍需输入"));
        }
        write(dir, &format!("deepseek-{provider}-plan.json"), &result)?;
    }
    let after = counts(root)?;
    if before != after {
        return Err("验收期间原有归档记录发生变化，请核对并发操作".into());
    }
    write(dir, "native-planners-after.json", &after)?;
    let op_root = root.to_path_buf();
    let snapshot = tokio::task::spawn_blocking(move || {
        model_runtime::ui(&op_root, &json!({"action":"status"}))
    })
    .await
    .map_err(|_| "读取模型回执中断")??;
    if snapshot["jobs"]
        .as_array()
        .ok_or("模型回执缺失")?
        .iter()
        .any(|j| j["provider"] != "deepseek" || j["state"] != "succeeded")
    {
        return Err("验收模型回执未全部完成".into());
    }
    write(dir, "native-planners-model-jobs.json", &snapshot)
}
