//! Resolve existing authorized identities only; a URL is not read evidence.
use super::*;
use url::Url;

#[cfg(test)]
mod tests;

fn parameters(url: &Url, names: [&str; 2]) -> Result<[String; 2], String> {
    if url.host_str() != Some("open")
        || !url.path().is_empty()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("只支持明确的 open 对象链接，不忽略路径或片段".into());
    }
    let mut values = [String::new(), String::new()];
    let mut seen = [false; 2];
    for (key, value) in url.query_pairs() {
        let index = names
            .iter()
            .position(|name| *name == key)
            .ok_or("链接含不支持的参数")?;
        if seen[index]
            || value.is_empty()
            || value.len() > 1024
            || value.contains('\u{fffd}')
            || value.chars().any(char::is_control)
        {
            return Err("链接对象参数为空、重复或无效".into());
        }
        seen[index] = true;
        values[index] = value.into_owned();
    }
    if seen != [true, true] {
        return Err("链接缺少对象身份".into());
    }
    Ok(values)
}

fn note_path(value: &str) -> Result<String, String> {
    let normalized = value.replace('\\', "/");
    if normalized.contains(':')
        || normalized
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err("笔记链接必须使用库内相对路径".into());
    }
    Ok(
        if normalized
            .get(normalized.len().saturating_sub(3)..)
            .is_some_and(|s| s.eq_ignore_ascii_case(".md"))
        {
            normalized[..normalized.len() - 3].to_string()
        } else {
            normalized
        },
    )
}

impl EvidenceReader {
    pub(crate) fn resolve_link(&self, original: &str) -> Result<Value, String> {
        self.checkpoint()?;
        if original.len() > 4096
            || original.trim() != original
            || original.chars().any(char::is_control)
        {
            return Err("链接为空、超长或含控制字符".into());
        }
        let url = Url::parse(original).map_err(|_| "链接格式无效")?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err("不接受含账户凭据的链接".into());
        }
        let mut result = json!({"originalUrl":original,"bodyRead":false,"networkRequested":false,
            "policy":"仅解析当前授权内的本地对象身份。链接不是原文或写入授权；后续读取仍核对权限与来源版本。"});
        if matches!(url.scheme(), "http" | "https") {
            let matches = self.in_snapshot(|c, _| {
                let mut matches = Vec::new();
                for (item_key, saved) in
                    x_bookmarks::evidence_link_identities(c, &self.scope.reading_item_keys)?
                {
                    self.checkpoint()?;
                    if saved.len() <= 4096
                        && !saved.chars().any(char::is_control)
                        && Url::parse(&saved).ok().as_ref() == Some(&url)
                    {
                        matches.push(EvidenceLocator::Reading { item_key });
                        if matches.len() > 1 {
                            break;
                        }
                    }
                }
                Ok(matches)
            })?;
            if !matches.is_empty() {
                result["evidenceOrigin"] = json!("authorizedSavedReading");
                result["remoteVerified"] = json!(false);
                if matches.len() == 1 {
                    result["status"] = json!("resolved");
                    result["locator"] = json!(matches[0]);
                    result["next"] = json!("先检查本轮已取得的原文证据：locator 与返回对象一致、同版本已读范围覆盖所需内容且本轮引用目录中有依据时，直接复用，不因解析链接重复读取。缺少原文、覆盖不足或版本/授权已变化时，使用 operation=read 和返回的 locator 按需读取或重新核对。历史回答、摘要和解析身份不能代替原文证据；宿主的授权及版本校验仍必须通过。仅为保存副本，不是远端页面当前读取。");
                } else {
                    result["status"] = json!("ambiguous");
                    result["message"] = json!(
                        "当前授权内有多个保存条目对应这个地址，请选择具体资料；未自行选取或读取。"
                    );
                }
                return Ok(result);
            }
            let host = url.host_str().ok_or("链接缺少主机")?;
            let notion = ["notion.com", "notion.so", "notion.site"]
                .iter()
                .any(|base| host == *base || host.ends_with(&format!(".{base}")));
            result["status"] = json!("unavailable");
            result["reason"] = json!(if notion {
                "missingHubNotionConnection"
            } else {
                "publicWebReaderUnavailable"
            });
            result["message"] = json!(if notion {
                "Hub 尚未接入可读取该 Notion 对象的连接。桌面 Codex/Notion 的登录与插件权限不会传给 Hub；尚未请求或读取页面。"
            } else {
                "当前 Hub 未提供公网页面读取。尚未发出网络请求；不能按链接或标题推断正文。"
            });
            return Ok(result);
        }
        let (provider, [first, second]) = match url.scheme() {
            "obsidian" => ("obsidian", parameters(&url, ["vault", "file"])?),
            "craftdocs" => ("craft", parameters(&url, ["spaceId", "blockId"])?),
            _ => return Err("不支持该链接协议；未打开文件或发出网络请求".into()),
        };
        let path = if provider == "obsidian" {
            Some(note_path(&second)?)
        } else {
            None
        };
        let matches = self.in_snapshot(|c, libraries| {
            let mut matches = Vec::<EvidenceLocator>::new();
            for library in libraries {
                if provider == "obsidian" {
                    let mut query = c.prepare("SELECT d.id FROM documents d JOIN libraries l ON l.id=d.space_id WHERE d.space_id=?1 AND d.provider='obsidian' AND l.provider='obsidian' AND l.name=?2 AND CASE WHEN lower(substr(replace(d.path,char(92),'/'),-3))='.md' THEN substr(replace(d.path,char(92),'/'),1,length(d.path)-3) ELSE replace(d.path,char(92),'/') END=?3").map_err(|e|e.to_string())?;
                    for row in query.query_map(params![library,first,path.as_ref().unwrap()], |r|r.get::<_,String>(0)).map_err(|e|e.to_string())? {
                        let locator = EvidenceLocator::Note {library_id:library.clone(),document_id:row.map_err(|e|e.to_string())?,page_id:None};
                        if self.scope.permits_note(&locator) { matches.push(locator); }
                        if matches.len() > 1 { return Ok(matches); }
                    }
                } else if library == &first {
                    // Prefer a page's own identity over its card in the parent page.
                    for exact in [true, false] {
                        let mut identity_found = false;
                        let sql = if exact {
                            "SELECT id,id FROM documents WHERE space_id=?1 AND provider='craft' AND id=?2 UNION SELECT DISTINCT i.document_id,i.page_id FROM content_items i JOIN documents d ON d.space_id=i.space_id AND d.id=i.document_id WHERE i.space_id=?1 AND i.provider='craft' AND d.provider='craft' AND i.page_id=?2 AND COALESCE(i.source_item_id,'')=''"
                        } else {
                            "SELECT DISTINCT i.document_id,i.page_id FROM content_items i JOIN documents d ON d.space_id=i.space_id AND d.id=i.document_id WHERE i.space_id=?1 AND i.provider='craft' AND d.provider='craft' AND i.block_id=?2 AND i.content_type!='craft_subpage' AND COALESCE(i.source_item_id,'')=''"
                        };
                        let mut query = c.prepare(sql).map_err(|e|e.to_string())?;
                        for row in query.query_map(params![library,second],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).map_err(|e|e.to_string())? {
                            let (document,page) = row.map_err(|e|e.to_string())?;
                            identity_found = true;
                            let page_id = Some(page.filter(|v| !v.is_empty()).unwrap_or_else(||document.clone()));
                            let locator = EvidenceLocator::Note {library_id:library.clone(),document_id:document,page_id};
                            if self.scope.permits_note(&locator) && !matches.contains(&locator) { matches.push(locator); }
                            if matches.len() > 1 { return Ok(matches); }
                        }
                        if identity_found { break; }
                    }
                }
                if matches.len() > 1 { break; }
            }
            Ok(matches)
        })?;
        match matches.as_slice() {
            [locator] => {
                result["status"] = json!("resolved");
                result["locator"] = json!(locator);
                result["next"] = json!("先检查本轮已取得的原文证据：locator 与返回对象一致、同版本已读范围覆盖所需内容且本轮引用目录中有依据时，直接复用，不因解析链接重复读取。缺少原文、覆盖不足或版本/授权已变化时，使用现有 read/hub_read_note 按需读取或重新核对。历史回答、摘要和解析身份不能代替原文证据；宿主的授权及版本校验仍必须通过。解析身份未读取正文，也未核验远端最新状态。");
            }
            [] => {
                result["status"] = json!("notInAuthorizedScope");
                result["message"] = json!("当前授权内未找到可读取的唯一对象。请在材料中选择目标；不会通过链接扩大授权，也不区分未授权对象是否存在。");
            }
            _ => {
                result["status"] = json!("ambiguous");
                result["message"] =
                    json!("授权内有多个匹配对象，请选择具体材料；未自行选取或读取。");
            }
        }
        Ok(result)
    }
}
