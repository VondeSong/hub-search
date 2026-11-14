//! Synthetic source setup and result collection, only in the opt-in executable.
//! No Work, Run, model result, grant or save receipt is seeded.
use crate::*;
use sha2::{Digest, Sha256};

fn config() -> Result<Option<Value>, String> {
    let Some(root) = isolated_runtime::root() else {
        return Ok(None);
    };
    let path = root.join("mcp-channel-acceptance.json");
    if !path.exists() {
        return Ok(None);
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 4096 {
        return Err("MCP 验收配置过大".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if value["format"] != "hub-mcp-channel-acceptance-v1"
        || !["settings", "run", "stop", "resume", "narrow", "unknown"]
            .contains(&value["phase"].as_str().unwrap_or(""))
    {
        return Err("MCP 验收配置身份无效".into());
    }
    Ok(Some(value))
}
pub(crate) fn configure_context(context: &mut tauri::Context<tauri::Wry>) -> Result<(), String> {
    if config()?.is_none() {
        return Ok(());
    }
    context.config_mut().build.dev_url = Some(Url::parse("http://localhost:1428").unwrap());
    for window in &mut context.config_mut().app.windows {
        window.url = tauri::WebviewUrl::App("qa/mcp-channel-acceptance.html".into());
        window.title = "Hub · MCP 通道隔离验收".into();
    }
    Ok(())
}
pub(super) fn prepare(app: &AppHandle) -> Result<bool, String> {
    if config()?.is_none() {
        return Ok(false);
    }
    let root = crate::active_data_root(app)?;
    let vault = root.join("vault");
    fs::create_dir_all(&vault).map_err(|e| e.to_string())?;
    let (mut c, _writer) = open_write_database(&root.join("craft-search.sqlite3"))?;
    c.execute("INSERT OR IGNORE INTO libraries(id,provider,name,location,enabled,added_at) VALUES('mcp-fixture','obsidian','MCP 隔离验收',?1,1,1)",[vault.to_string_lossy().as_ref()]).map_err(|e|e.to_string())?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    for (id, body) in [
        (
            "allowed",
            "# 合成资料 A\n本次虚构项目的数量为 7 件，验收条件尚未确认。证据编号 MCP-A-719。\n",
        ),
        (
            "extra",
            "# 合成资料 B\n本次虚构项目负责人为林，截止日期为 2026-11-20。证据编号 MCP-B-283。\n",
        ),
        (
            "excluded",
            "# 未授权对照\nPRIVATE_MCP_SENTINEL_97531，不得出现在未授权读取或答案中。\n",
        ),
    ] {
        let path = vault.join(format!("{id}.md"));
        if !path.exists() {
            fs::write(&path, body).map_err(|e| e.to_string())?;
        }
        let markdown = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let doc = LocalMarkdownDocument {
            id: id.into(),
            title: id.into(),
            relative_path: format!("{id}.md"),
            folder_path: None,
            content_hash: format!("{:x}", Sha256::digest(markdown.as_bytes())),
            markdown,
            modified_at: 1,
            aliases: vec![],
            tags: vec![],
            attachments: vec![],
        };
        upsert_obsidian_document(&tx, "mcp-fixture", &doc, 1).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}
pub(crate) fn ui(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let config = config()?.ok_or("MCP 隔离验收未启用")?;
    if args["action"] == "mcpAcceptanceConfig" {
        return Ok(config);
    }
    if args["action"] == "mcpAcceptanceExit" {
        app.exit(0);
        return Ok(json!({"exiting":true}));
    }
    let result = &args["result"];
    if result["phase"] != config["phase"] || result.to_string().len() > 2_000_000 {
        return Err("MCP 验收结果范围无效".into());
    }
    let root = crate::active_data_root(app)?;
    let dir = root.join("evidence");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let phase = config["phase"].as_str().unwrap();
    fs::write(
        dir.join(format!("{phase}.json")),
        serde_json::to_vec_pretty(result).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({"recorded":true}))
}
