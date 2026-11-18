//! Export only explicitly selected current results, after rechecking their source grants.
use super::*;

pub(crate) struct Prepared {
    pub manifest: Value,
    pub files: Vec<(Value, Vec<u8>)>,
}

pub(crate) fn prepare(root: &Path, args: &Value) -> Result<Prepared, String> {
    let id = text(args, "work", 150)?;
    let execution = text(args, "execution", 150)?;
    let report = text(args, "report", 200)?;
    let requested = args["files"].as_array().ok_or("请选择交接文件")?;
    if requested.is_empty() || requested.len() > 16 {
        return Err("每次交接请选择 1–16 个成果文件".into());
    }
    let c = crate::source_evidence::open_read_database(root)?;
    let work = store::load(&c, &id)?;
    if work.state == "revoked" {
        return Err("对话授权已撤回，未上传".into());
    }
    let values = manifest(root, &work);
    let record = values
        .as_array()
        .and_then(|a| {
            a.iter().find(|v| {
                v["executionId"] == execution && v["available"] == true && v["superseded"] != true
            })
        })
        .ok_or("成果已失效、被修订或未授权，请重新选择当前版本")?;
    let created: i64 = c.query_row("SELECT created_at FROM agent_records WHERE work_id=?1 AND kind='analysisExecution' AND json_extract(body_json,'$.executionId')=?2 ORDER BY rowid LIMIT 1",params![id,execution],|r|r.get(0)).map_err(|_|"成果创建时间缺失")?;
    let generated = chrono::DateTime::from_timestamp_millis(created)
        .ok_or("成果时间无效")?
        .to_rfc3339();
    let all = record["files"].as_array().ok_or("成果清单缺失")?;
    let mut selected = Vec::new();
    let mut files = Vec::new();
    let mut total = 0u64;
    for name in requested {
        let name = name
            .as_str()
            .filter(|v| valid_name(v))
            .ok_or("交接文件名无效")?;
        if selected.iter().any(|f: &Value| {
            f["name"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        }) {
            return Err("交接文件不能重复".into());
        }
        let file = all
            .iter()
            .find(|f| f["name"] == name)
            .ok_or("所选文件不属于此成果")?;
        let bytes = file["bytes"].as_u64().ok_or("成果大小缺失")?;
        total = total.saturating_add(bytes);
        if bytes == 0 || bytes > 10 * 1024 * 1024 || total > 50 * 1024 * 1024 {
            return Err("云端交接单文件最多 10 MiB，合计最多 50 MiB；请选择较小成果".into());
        }
        let checked = path(root, &json!({"id":id,"executionId":execution,"file":name}))?;
        let data = std::fs::read(checked["path"].as_str().ok_or("成果路径缺失")?)
            .map_err(|_| "无法读取所选成果")?;
        if data.len() as u64 != bytes || file["sha256"] != digest(&data) {
            return Err("所选成果内容已变化，未上传".into());
        }
        selected.push(file.clone());
        files.push((file.clone(), data));
    }
    let (meta, raw) = files
        .iter()
        .find(|(f, _)| f["name"] == report && f["type"] == "md")
        .ok_or("请选择交接清单中的 Markdown 报告供手机阅读和续聊")?;
    if raw.len() > 48000 {
        return Err("续聊报告最多 48 KB，请先在原分析中生成精简报告".into());
    }
    let report_text = std::str::from_utf8(raw).map_err(|_| "报告不是有效的 UTF-8 文本")?;
    let inputs: Vec<Value> = record["inputs"]
        .as_array()
        .ok_or("成果输入记录缺失")?
        .iter()
        .map(|v| json!({"title":v["title"],"sha256":v["sha256"]}))
        .collect();
    let title: String = record["title"]
        .as_str()
        .unwrap_or("桌面分析")
        .chars()
        .take(80)
        .collect();
    let payload = json!({"version":1,"title":title,"origin":{"workId":id,"artifactId":record["artifactId"],"executionId":execution,"revision":record["revision"],"generatedAt":generated,"inputs":inputs},"files":selected,"report":{"name":report,"text":report_text,"sha256":meta["sha256"]}});
    Ok(Prepared {
        manifest: payload,
        files,
    })
}
