//! Append one current, verified report to the exact anchor note. No model call,
//! new-note creation, chart embedding or general destination/write framework.
use super::*;

pub(super) fn context_on(root: &Path, c: &Connection, w: &Work) -> Result<Value, String> {
    readable(root, w)?;
    let (library, document) = anchor(w)?;
    let base = files::snapshot(c, library, document)?;
    let delivery = store::report_save_context_on(root, c, w)?;
    let identity =
        json!({"workId":w.id,"runId":delivery["runId"],"reportHash":digest(&delivery["report"])});
    let marker = format!("<!-- hub-report:{} -->", digest(&identity));
    if base.before.contains(&marker) {
        return Err("这份报告已在目标笔记中；请核对已有保存结果，不重复追加".into());
    }
    let markdown = markdown(&delivery)?;
    let (_, body) = files::split(&base.before)?;
    let addition = format!("\n\n{marker}\n## Hub 报告\n\n{markdown}\n");
    let after = files::compose(&base, &format!("{body}{addition}"))?;
    Ok(json!({"snapshot":base,"mode":"reportAppend","reportIdentity":identity,"after":after}))
}

pub(super) fn payload(context: &Value) -> Result<Value, String> {
    let mut result = context.clone();
    result["instruction"] = json!("将这份当前报告追加到所示原笔记，保留已有内容与属性");
    result["linkTargets"] = json!([]);
    result["summary"] = json!(
        "在当前笔记末尾追加这份报告，保留已有正文、属性和引文；不创建新笔记、不覆盖已有段落。"
    );
    result["warnings"] = json!([
        "仅保存报告正文及所引用原句，不嵌入交互图表。",
        "保存会改变来源版本；依赖原版本的分析将显示需要重新核对。"
    ]);
    Ok(result)
}

pub(in crate::agent_work) fn markdown(delivery: &Value) -> Result<String, String> {
    let r = &delivery["report"];
    let mut lines = Vec::new();
    let mut citations = Vec::new();
    if let Some(body) = r["prose"]["markdown"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    {
        lines.push(body.to_owned());
        citations.extend(
            r["prose"]["citations"]
                .as_array()
                .ok_or("报告引文格式无效")?
                .iter(),
        );
    } else {
        lines.push(r["summary"].as_str().ok_or("报告正文缺失")?.to_owned());
        for item in r["findings"].as_array().ok_or("报告发现格式无效")? {
            lines.push(item["text"].as_str().ok_or("报告发现正文缺失")?.to_owned());
            citations.extend(
                item["citations"]
                    .as_array()
                    .ok_or("报告引文格式无效")?
                    .iter(),
            );
        }
        for item in r["nextSteps"].as_array().ok_or("报告后续项格式无效")? {
            lines.push(format!(
                "- {}：{}",
                item["action"].as_str().ok_or("后续项无效")?,
                item["reason"].as_str().ok_or("后续理由无效")?
            ));
            citations.extend(
                item["citations"]
                    .as_array()
                    .ok_or("后续引文格式无效")?
                    .iter(),
            );
        }
    }
    if let Some(sources) = r["prose"]["webSources"]
        .as_array()
        .filter(|v| !v.is_empty())
    {
        lines.push("### 网页来源".into());
        lines.push("以下链接尚未保存为 Hub 原文快照，网页访问记录不代表完整读取。".into());
        for source in sources {
            let url = crate::x_bookmarks::public_web::url(
                source["url"].as_str().ok_or("网页来源链接无效")?,
            )?;
            let title = source["title"]
                .as_str()
                .ok_or("网页来源标题缺失")?
                .replace(['[', ']', '<', '>', '\n', '\r'], " ");
            let state = match source["provenance"].as_str() {
                Some("providerResult") => "联网工具返回的来源",
                Some("providerAccess") => "Codex 有网页访问记录",
                _ => "引用链接（无可匹配的联网记录）",
            };
            lines.push(format!(
                "- {title}：<{}>（{state}）",
                url.as_str().replace('<', "%3C").replace('>', "%3E")
            ));
        }
    }
    for (key, label) in [("questions", "待确认"), ("limitations", "范围与局限")] {
        let values = r[key].as_array().ok_or("报告范围说明格式无效")?;
        if !values.is_empty() {
            lines.push(format!("### {label}"));
            for v in values {
                lines.push(format!("- {}", v.as_str().ok_or("报告范围说明正文无效")?));
            }
        }
    }
    if let Some(wait) = r["waitCondition"].as_str().filter(|s| !s.trim().is_empty()) {
        lines.push(format!("等待条件：{wait}"));
    }
    if !citations.is_empty() {
        lines.push("### 出处（报告生成时的原句）".into());
        let evidence = delivery["evidence"].as_array().ok_or("报告出处缺失")?;
        for (i, citation) in citations.iter().enumerate() {
            let id = citation["evidenceId"].as_str().ok_or("报告引文身份缺失")?;
            let index = id
                .strip_prefix('e')
                .and_then(|s| s.parse::<usize>().ok())
                .and_then(|n| n.checked_sub(1))
                .ok_or("报告引文身份无效")?;
            let source = evidence.get(index).ok_or("报告引文不在授权取证中")?;
            let title = source["title"].as_str().ok_or("报告来源标题缺失")?;
            let path = source["sourcePath"].as_str().unwrap_or(title);
            let quote = citation["quote"].as_str().ok_or("报告引用原句缺失")?;
            if quote.is_empty()
                || !source["content"]
                    .as_str()
                    .ok_or("报告来源正文缺失")?
                    .contains(quote)
            {
                return Err("报告引文与固定原句不一致".into());
            }
            lines.push(format!(
                "{}. {}（{}）\n\n> {}",
                i + 1,
                title,
                path,
                quote.replace('\n', "\n> ")
            ));
        }
    }
    let text = lines.join("\n\n");
    if text.trim().is_empty() {
        return Err("当前报告没有可保存正文".into());
    }
    Ok(text)
}

#[cfg(test)]
#[test]
fn cn04_report_export_keeps_web_provenance_separate_from_quotes() {
    let body=markdown(&json!({"report":{"prose":{"markdown":"参考网页","citations":[],"webSources":[{"url":"https://example.org/a","title":"文章","provenance":"providerAccess"}]},"questions":[],"limitations":[],"waitCondition":""},"evidence":[]})).unwrap();
    assert!(body.contains("https://example.org/a"));
    assert!(body.contains("Codex 有网页访问记录"));
    assert!(body.contains("不代表完整读取"));
}
