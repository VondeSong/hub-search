//! Public, explicitly scoped material downloads. Never reuse browser cookies.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
pub(super) const LIBRARY: &str = "__hub_public_files";
const MAX: usize = 10 * 1024 * 1024;
fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn directory(root: &Path) -> PathBuf {
    root.join("collection-files/agent-public-files")
}
fn safe_url(raw: &str, origins: &[String]) -> Result<reqwest::Url, String> {
    let url = crate::x_bookmarks::public_web::url(raw)?;
    if url.query().is_some() || !origins.contains(&url.origin().ascii_serialization()) {
        return Err("资料文件须来自本对话已授权的公开网站，暂不接收查询参数或登录链接".into());
    }
    Ok(url)
}
pub(super) fn schema() -> Value {
    json!({"type":"object","properties":{"url":{"type":"string","minLength":1,"maxLength":4096},"title":{"type":"string","minLength":1,"maxLength":200}},"required":["url","title"],"additionalProperties":false})
}
fn extension(title: &str) -> Result<&str, String> {
    if title.len() > 200 || title.is_empty() || title.contains(['/', '\\', ':', '\0']) {
        return Err("资料文件名无效".into());
    }
    match title.rsplit('.').next().unwrap_or("") {
        e @ ("csv" | "json" | "xlsx" | "pdf" | "png" | "jpg" | "jpeg" | "webp") => Ok(e),
        _ => Err("资料文件支持CSV、JSON、XLSX、PDF、PNG、JPEG、WebP".into()),
    }
}
fn mime_matches(ext: &str, mime: &str) -> bool {
    match ext {
        "csv" => matches!(mime, "text/csv" | "text/plain" | "application/csv"),
        "json" => matches!(mime, "application/json" | "text/plain"),
        "xlsx" => matches!(
            mime,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                | "application/octet-stream"
        ),
        "pdf" => matches!(mime, "application/pdf" | "application/octet-stream"),
        "png" => mime == "image/png",
        "jpg" | "jpeg" => mime == "image/jpeg",
        "webp" => mime == "image/webp",
        _ => false,
    }
}
pub(super) fn fetch(
    root: &Path,
    work: &Work,
    run: &str,
    url: &str,
    title: &str,
    control: &Control,
) -> Result<Value, String> {
    let ext = extension(title)?;
    let options = options::load(root, &work.id)?;
    if options.materials_only() {
        return Err("仅依据材料时不获取公开文件".into());
    }
    if store::material_budget::load_on(
        &crate::source_evidence::open_read_database(root)?,
        &work.id,
    )?
    .is_some()
    {
        return Err("冻结材料额度暂未支持完整文件获取，未下载".into());
    }
    let grant = options
        .mcp_services
        .iter()
        .find(|g| g.server.starts_with("browser:"))
        .ok_or("请先授权资料文件所在的公开网站")?;
    let origins = crate::model_runtime::mcp_services::browser::origins(&grant.server)?;
    let start = safe_url(url, &origins)?;
    let check = || -> Result<(), String> {
        control.check()?;
        store::check_run(root, work, run)?;
        let current = options::load(root, &work.id)?;
        if current.materials_only() || !current.mcp_services.contains(grant) {
            return Err("公开网站授权已变化，停止获取文件".into());
        }
        Ok(())
    };
    check()?;
    let (data, final_url, mime, hops) = tauri::async_runtime::block_on(async {
        let mut current = start.clone();
        let mut hops = Vec::new();
        for _ in 0..4 {
            check()?;
            let host = current.host_str().ok_or("文件链接缺少域名")?;
            let addresses = crate::x_bookmarks::public_web::browser_addresses(host).await?;
            let client = reqwest::Client::builder()
                .no_proxy()
                .resolve_to_addrs(host, &addresses)
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .referer(false)
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| "无法准备公开文件连接")?;
            let response=client.get(current.clone()).header(reqwest::header::ACCEPT,"application/pdf, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, text/csv, application/json, image/png, image/jpeg, image/webp").send().await.map_err(|_|"公开文件HTTPS连接失败")?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or("文件跳转地址缺失")?;
                let next = current.join(location).map_err(|_| "文件跳转地址无效")?;
                hops.push(json!({"from":current,"status":response.status().as_u16(),"to":next}));
                current = safe_url(next.as_str(), &origins)?;
                continue;
            }
            if !response.status().is_success() {
                return Err(format!(
                    "公开文件返回HTTP {}，未接受资料",
                    response.status().as_u16()
                ));
            }
            let mime = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !mime_matches(ext, &mime) {
                return Err("下载响应与文件类型不符，可能是登录页；未接受资料".into());
            }
            let mut response = response;
            let mut data = Vec::new();
            if response.content_length().is_some_and(|n| n > MAX as u64) {
                return Err("公开资料文件超过10 MiB".into());
            }
            while let Some(chunk) = response.chunk().await.map_err(|_| "公开文件下载中断")?
            {
                check()?;
                if data.len() + chunk.len() > MAX {
                    return Err("公开资料文件超过10 MiB".into());
                }
                data.extend_from_slice(&chunk);
            }
            if data.is_empty() {
                return Err("公开资料文件为空".into());
            }
            return Ok((data, current, mime, hops));
        }
        Err("公开文件跳转超过3次，未接受资料".into())
    })?;
    check()?;
    let sha = hash(&data);
    let id = hash(format!("{final_url}:{sha}").as_bytes());
    let dir = directory(root);
    crate::craft_backup::reject_links(&dir)?;
    std::fs::create_dir_all(&dir).map_err(|_| "无法准备资料文件目录")?;
    let path = dir.join(format!("{id}.{ext}"));
    crate::craft_backup::reject_links(&path)?;
    if !path.exists() {
        std::fs::write(&path, &data).map_err(|_| "无法保存公开文件")?;
    }
    // Parse content before registering it. A file extension is not evidence.
    let pages = if ext == "pdf" {
        let doc = lopdf::Document::load_mem(&data).map_err(|_| "公开PDF结构无效")?;
        if doc.is_encrypted() || doc.get_pages().len() > 10000 || doc.get_pages().is_empty() {
            return Err("公开PDF加密、为空或页数过多".into());
        }
        Some(doc.get_pages().len())
    } else if matches!(ext, "png" | "jpg" | "jpeg" | "webp") {
        if data.len() > 4 * 1024 * 1024 {
            return Err("公开图片超过4 MiB，未降低清晰度".into());
        }
        images::decode(&data)?;
        None
    } else {
        // Reuse strict workbook/UTF-8/JSON validation without adding an indexed source.
        analysis::validate_file(&data, ext)?;
        None
    };
    let entry = json!({"id":id,"title":title,"extension":ext,"sha256":sha,"bytes":data.len(),"mime":mime,"requestedUrl":start,"url":final_url,"fetchedAt":chrono::Utc::now().to_rfc3339(),"redirects":hops,"pages":pages});
    let meta = dir.join(format!("{id}.json"));
    crate::craft_backup::reject_links(&meta)?;
    if !meta.exists() {
        std::fs::write(&meta, entry.to_string()).map_err(|_| "无法保存公开文件来源")?;
    }
    let actual = metadata(root, &id)?;
    path_for(root, &actual)?;
    check()?;
    let receipt = json!({"file":actual,"grant":grant,"authorizationVersion":work.authorization_version,"businessWrites":false,"meaning":"Downloaded immutable source snapshot, not proof of reading. Data files can be read by hub_analyzeFiles in this conversation. Images/PDF pages appear under image materials and require explicit selection before pixels are sent."});
    store::record(root, run, "publicFileAcquisition", &receipt)?;
    Ok(receipt)
}
pub(super) fn metadata(root: &Path, id: &str) -> Result<Value, String> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("公开文件身份无效".into());
    }
    let path = directory(root).join(format!("{id}.json"));
    crate::craft_backup::reject_links(&path)?;
    let v: Value = serde_json::from_slice(&std::fs::read(path).map_err(|_| "公开文件记录缺失")?)
        .map_err(|_| "公开文件记录损坏")?;
    if v["id"] != id
        || hash(
            format!(
                "{}:{}",
                v["url"].as_str().ok_or("来源地址缺失")?,
                v["sha256"].as_str().ok_or("来源哈希缺失")?
            )
            .as_bytes(),
        ) != id
        || extension(v["title"].as_str().ok_or("来源标题缺失")?)?
            != v["extension"].as_str().ok_or("来源类型缺失")?
    {
        return Err("公开文件身份不匹配".into());
    }
    Ok(v)
}
pub(super) fn path_for(root: &Path, v: &Value) -> Result<PathBuf, String> {
    let actual = metadata(root, v["id"].as_str().ok_or("公开文件身份缺失")?)?;
    if actual != *v {
        return Err("公开文件元数据已变化".into());
    }
    let path = directory(root).join(format!(
        "{}.{}",
        v["id"].as_str().unwrap(),
        v["extension"].as_str().unwrap()
    ));
    crate::craft_backup::reject_links(&path)?;
    let size = std::fs::metadata(&path)
        .map_err(|_| "公开文件缓存缺失")?
        .len();
    if size > MAX as u64
        || v["bytes"] != size
        || v["sha256"] != crate::craft_backup::hash_file(&path)?
    {
        return Err("公开文件内容已变化".into());
    }
    // StorageFile (PDF rendering) rejects mixed separators even though Rust can
    // read them. Resolve the already verified file before crossing into WinRT;
    // the OCR adapter handles the canonical Windows verbatim prefix.
    std::fs::canonicalize(path).map_err(|_| "公开文件路径无法解析".into())
}
pub(super) fn data_inputs(
    root: &Path,
    work: &Work,
) -> Result<Vec<(String, PathBuf, Value)>, String> {
    data_inputs_selected(root, work, None)
}
pub(super) fn data_inputs_selected(
    root: &Path,
    work: &Work,
    selected: Option<&[String]>,
) -> Result<Vec<(String, PathBuf, Value)>, String> {
    let options = options::load(root, &work.id)?;
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for receipt in store::records(root, &work.id, "publicFileAcquisition", 64)? {
        let v = &receipt["file"];
        if selected.is_some_and(|ids| !ids.iter().any(|id| v["id"] == *id)) {
            continue;
        }
        let ext = v["extension"].as_str().unwrap_or("");
        if !matches!(ext, "csv" | "xlsx" | "json") || !seen.insert(v["id"].clone().to_string()) {
            continue;
        }
        if options.materials_only()
            || receipt["authorizationVersion"] != work.authorization_version
            || !options
                .mcp_services
                .iter()
                .any(|g| json!(g) == receipt["grant"])
        {
            return Err("公开数据文件授权已变化，需重新获取后分析".into());
        }
        result.push((ext.to_owned(), path_for(root, v)?, v.clone()));
    }
    Ok(result)
}
pub(super) fn context(root: &Path, work: &Work) -> Value {
    let options = options::load(root, &work.id).ok();
    let rows = store::records(root, &work.id, "publicFileAcquisition", 32).unwrap_or_default();
    json!(rows.into_iter().take(16).map(|r|json!({"file":r["file"],"available":work.state!="revoked" && r["authorizationVersion"]==work.authorization_version && options.as_ref().is_some_and(|o|!o.materials_only() && o.mcp_services.iter().any(|g|json!(g)==r["grant"]))})).collect::<Vec<_>>())
}
pub(super) fn list_images(root: &Path, query: &str, page: u32) -> Result<Vec<Value>, String> {
    let dir = directory(root);
    if !dir.exists() {
        return Ok(vec![]);
    }
    crate::craft_backup::reject_links(&dir)?;
    let mut items = Vec::new();
    for entry in std::fs::read_dir(dir)
        .map_err(|_| "公开文件目录不可读")?
        .take(2048)
    {
        let entry = entry.map_err(|_| "公开文件记录不可读")?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(v) = metadata(root, id) else {
            continue;
        };
        if !matches!(
            v["extension"].as_str(),
            Some("pdf" | "png" | "jpg" | "jpeg" | "webp")
        ) || !v["title"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .contains(&query.to_lowercase())
        {
            continue;
        }
        let pdf = v["extension"] == "pdf";
        if pdf && v["pages"].as_u64().unwrap_or(0) < page as u64 {
            continue;
        }
        items.push(json!({"libraryId":LIBRARY,"sourceItemId":if pdf{format!("pdf-page:{page}:{id}")}else{id.to_owned()}}));
        if items.len() >= 20 {
            break;
        }
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verified_download_path_normalizes_separators_without_trusting_changed_bytes() {
        let f = crate::source_evidence::tests::Fixture::new();
        let root = PathBuf::from(f.root.to_string_lossy().replace('\\', "/"));
        let data = b"a,b\n1,2\n";
        let sha = hash(data);
        let url = "https://example.com/data.csv";
        let id = hash(format!("{url}:{sha}").as_bytes());
        let v = json!({"id":id,"url":url,"sha256":sha,"bytes":data.len(),"title":"data.csv","extension":"csv"});
        std::fs::create_dir_all(directory(&root)).unwrap();
        let file = directory(&root).join(format!("{id}.csv"));
        std::fs::write(&file, data).unwrap();
        std::fs::write(directory(&root).join(format!("{id}.json")), v.to_string()).unwrap();
        assert_eq!(
            path_for(&root, &v).unwrap(),
            std::fs::canonicalize(&file).unwrap()
        );
        std::fs::write(file, b"changed").unwrap();
        assert!(path_for(&root, &v).is_err());
    }
    #[test]
    fn downloads_validate_scope_type_and_paths() {
        let origins = vec!["https://example.com".to_owned()];
        assert!(safe_url("https://example.com/data.csv", &origins).is_ok());
        for url in [
            "http://example.com/a",
            "https://example.org/a",
            "https://example.com/a?token=x",
            "https://localhost/a",
            "https://127.0.0.1/a",
        ] {
            assert!(safe_url(url, &origins).is_err());
        }
        assert!(!mime_matches("pdf", "text/html"));
        assert!(mime_matches("csv", "text/csv"));
        for name in ["../a.csv", "run.exe", "x.svg", "a.XLSX"] {
            assert!(extension(name).is_err());
        }
    }
    #[test]
    #[ignore = "explicit public source file and daily library; downloads a source snapshot, no source writes"]
    fn live_public_file_acquisition() {
        let config: Value = serde_json::from_slice(
            &std::fs::read(std::env::var("HUB_PUBLIC_FILE_CONFIG").expect("explicit config"))
                .unwrap(),
        )
        .unwrap();
        let root = Path::new(config["root"].as_str().unwrap());
        let control = Control::bounded(Duration::from_secs(300));
        let server = config["server"].as_str().unwrap();
        let catalog =
            crate::model_runtime::mcp_services::discover_for(root, server, &control).unwrap();
        let grant = json!({"server":server,"catalogSha256":catalog["catalogSha256"],"tools":catalog["tools"].as_array().unwrap().iter().map(|t|t["name"].clone()).collect::<Vec<_>>()});
        let view=ui(root,&json!({"action":"create","anchor":null,"goal":config["prompt"],"successCriteria":"取得真实公开文件并验证类型、哈希和可读页面；不修改资料库","grant":{"libraryIds":[],"notes":[],"readingItemKeys":[]}})).unwrap();
        let id = view["work"]["id"].as_str().unwrap();
        options::configure(
            root,
            &json!({"id":id,"options":{"researchPolicy":"open","mcpServices":[grant]}}),
        )
        .unwrap();
        let run = format!("public-file-probe-{}", crate::random_url_safe(12));
        let work = store::claim(root, id, &run).unwrap();
        let result = fetch(
            root,
            &work,
            &run,
            config["url"].as_str().unwrap(),
            config["title"].as_str().unwrap(),
            &control,
        );
        let page_result = (|| -> Result<Value, String> {
            if let Ok(receipt) = &result {
                if receipt["file"]["extension"] == "pdf" {
                    let source = format!("pdf-page:1:{}", receipt["file"]["id"].as_str().unwrap());
                    let candidates =
                        images::list(root, &json!({"query":config["title"],"page":1}))?;
                    let candidate = candidates["images"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|v| {
                            v["grant"]["libraryId"] == LIBRARY
                                && v["grant"]["sourceItemId"] == source
                        })
                        .ok_or("下载页面未出现在可选材料中")?;
                    let g = serde_json::from_value(candidate["grant"].clone())
                        .map_err(|_| "页面授权无法解析")?;
                    let (_, meta, _) = images::prepare(root, &[g])?;
                    return Ok(meta);
                }
            }
            Ok(Value::Null)
        })();
        std::fs::write(
            config["output"].as_str().unwrap(),
            serde_json::to_vec_pretty(
                &json!({"workId":id,"result":result,"pageResult":page_result}),
            )
            .unwrap(),
        )
        .unwrap();
        store::fail(
            root,
            &work,
            &run,
            "公开资料获取探针结束；页面元数据不代表已交给模型读取",
        )
        .unwrap();
        result.unwrap();
        page_result.unwrap();
    }
}
