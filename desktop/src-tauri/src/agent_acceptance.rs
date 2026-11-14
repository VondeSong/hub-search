//! Opt-in desktop acceptance fixtures. Absent from ordinary builds.
//! The frontend, IPC, Suite, archive planner/executor and receipts remain real.
use crate::*;
use sha2::{Digest, Sha256};
pub(crate) mod mcp_channel;
mod model_runtime;
mod sources;
pub(crate) use model_runtime::start as start_model_runtime;

const LIBRARY: &str = "agent-acceptance-craft";
const ITEM: &str = "agent-acceptance-reading";

fn fixture() -> Result<Option<Url>, String> {
    let Some(root) = isolated_runtime::root() else {
        return Ok(None);
    };
    let path = root.join("agent-acceptance.json");
    if !path.exists() {
        return Ok(None);
    }
    if fs::metadata(&path).map_err(|_| "无法读取验收夹具")?.len() > 4096 {
        return Err("验收夹具过大".into());
    }
    let config: Value = serde_json::from_slice(&fs::read(path).map_err(|_| "无法读取验收夹具")?)
        .map_err(|_| "验收夹具格式无效")?;
    if config["format"] != "hub-agent-desktop-acceptance-v1" {
        return Err("验收夹具身份无效".into());
    }
    let url = Url::parse(config["apiUrl"].as_str().ok_or("缺少验收服务地址")?)
        .map_err(|_| "验收服务地址无效")?;
    validate_url(&url)?;
    Ok(Some(url))
}
fn validate_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/links/agent-acceptance/api/v1"
    {
        return Err("验收连接仅允许显式隔离目录登记的本机模拟服务".into());
    }
    Ok(())
}
pub(crate) fn allows_url(url: &Url) -> bool {
    fixture().ok().flatten().as_ref() == Some(url)
}
pub(crate) fn prepare(app: &AppHandle) -> Result<(), String> {
    if mcp_channel::prepare(app)? {
        return Ok(());
    }
    if sources::prepare(app)? {
        return Ok(());
    }
    let Some(url) = fixture()? else {
        return Ok(());
    };
    let root = isolated_runtime::root().ok_or("验收必须使用隔离目录")?;
    let (c, _writer) = open_write_database(&root.join("craft-search.sqlite3"))?;
    x_bookmarks::schema(&c)?;
    c.execute("INSERT OR IGNORE INTO libraries(id,provider,name,enabled,added_at) VALUES(?1,'craft','归档验收（本机模拟服务）',1,1)",[LIBRARY]).map_err(|e|e.to_string())?;
    // The synthetic file is input. The original export owner creates the media
    // manifest, and the archive owner uploads and verifies it; no receipt is seeded.
    let media_url = "https://video.twimg.com/hub-agent-acceptance/fixture.mp4";
    let asset = root
        .join("collection-files/99_Meta/assets/X_assets")
        .join(format!(
            "{}.mp4",
            format!("{:x}", Sha256::digest(media_url.as_bytes()))
        ));
    fs::create_dir_all(asset.parent().ok_or("验收附件目录无效")?).map_err(|e| e.to_string())?;
    let bytes = b"Hub synthetic video fixture; do not analyze.";
    if asset.exists() {
        if fs::read(&asset).map_err(|e| e.to_string())? != bytes {
            return Err("验收附件已改变，未覆盖".into());
        }
    } else {
        fs::write(&asset, bytes).map_err(|e| e.to_string())?;
    }
    let post = collection_models::Post {
        id: "900000000000000001".into(), text: "装配验证资料：加工前测量孔距与配合公差，长度单位为毫米。当前没有实测结果，不能判定装配已通过。此条为虚构验收资料。".into(),
        author_name: "Hub 验收".into(), author_handle: "fixture".into(),
        source: "telegram".into(), url: "https://example.com/hub-agent-acceptance".into(),
        media: vec![collection_models::Media { kind: "video".into(), url: media_url.into(), preview_url: String::new() }],
        ..Default::default()
    };
    let raw = serde_json::to_string(&post).map_err(|e| e.to_string())?;
    c.execute("INSERT OR IGNORE INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES(?1,'acceptance',?2,'acceptance-v1',?3,?3)",params![ITEM,raw,now_timestamp()]).map_err(|e|e.to_string())?;
    c.execute("UPDATE collection_x_items SET post_json=?2,content_hash='acceptance-v2',collected_at=?3,captured_at=?3 WHERE item_key=?1 AND account='acceptance' AND content_hash='acceptance-v1'",params![ITEM,raw,chrono::Utc::now().timestamp_millis()]).map_err(|e|e.to_string())?;
    c.execute("UPDATE collection_x_items SET post_json=?2,content_hash='acceptance-v3' WHERE item_key=?1 AND account='acceptance' AND content_hash='acceptance-v2'",params![ITEM,raw]).map_err(|e|e.to_string())?;
    stored_secret_set(app, &craft_api_credential_id(LIBRARY), url.as_str())?;
    stored_secret_set(app, &craft_api_key_credential_id(LIBRARY), "")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acceptance_transport_rejects_external_hosts_credentials_and_unowned_routes() {
        validate_url(&Url::parse("http://127.0.0.1:12345/links/agent-acceptance/api/v1").unwrap())
            .unwrap();
        for input in [
            "http://example.com:12345/links/agent-acceptance/api/v1",
            "http://127.0.0.1:12345/other",
            "http://user@127.0.0.1:12345/links/agent-acceptance/api/v1",
            "http://127.0.0.1:12345/links/agent-acceptance/api/v1?token=x",
        ] {
            assert!(validate_url(&Url::parse(input).unwrap()).is_err());
        }
        // A well-formed loopback URL alone grants nothing in an ordinary test process.
        assert!(!allows_url(
            &Url::parse("http://127.0.0.1:12345/links/agent-acceptance/api/v1").unwrap()
        ));
    }
}
