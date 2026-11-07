use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const MAX_TEXT: usize = 100_000;
pub const MAX_ATTACHMENT: usize = 20 * 1024 * 1024;
pub const MARKER: &str = "<!-- hub-journal:";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attachment {
    pub hash: String,
    pub name: String,
    pub size: usize,
    pub image: bool,
}
impl Attachment {
    pub fn filename(&self) -> String {
        let extension = std::path::Path::new(&self.name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if !extension.is_empty()
            && extension.len() <= 12
            && extension.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            format!("{}.{}", self.hash, extension.to_ascii_lowercase())
        } else {
            self.hash.clone()
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub version: u8,
    pub id: String,
    pub date: String,
    pub text: String,
    pub attachments: Vec<Attachment>,
}
pub fn hex_id(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn valid_date(value: &str) -> bool {
    value.len() == 10
        && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .is_ok_and(|d| d.format("%Y-%m-%d").to_string() == value && !value.starts_with("0000"))
}
impl Record {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || !hex_id(&self.id, 32) || !valid_date(&self.date) {
            return Err("速记版本、ID 或日期无效".into());
        }
        if self.text.len() > MAX_TEXT
            || self.text.contains(MARKER)
            || self.attachments.len() > 9
            || (self.text.trim().is_empty() && self.attachments.is_empty())
        {
            return Err("速记内容为空、超出限制或含保留区块标记".into());
        }
        for a in &self.attachments {
            if !hex_id(&a.hash, 64)
                || a.size > MAX_ATTACHMENT
                || a.name.is_empty()
                || a.name.len() > 255
                || a.name.chars().any(char::is_control)
            {
                return Err("速记附件信息无效".into());
            }
        }
        if blocks(&self.markdown("_hub-assets"))?.len() != 1 {
            return Err("Markdown 区块未闭合，请补全代码围栏或 HTML 注释后保存".into());
        }
        Ok(())
    }
    pub fn markdown(&self, attachment_dir: &str) -> String {
        let mut body = self.text.trim().to_string();
        for a in &self.attachments {
            let name = a.name.replace(['[', ']'], "").replace('\\', "\\\\");
            body.push_str(&format!(
                "\n\n{}[{name}](<{attachment_dir}/{}>)",
                if a.image { "!" } else { "" },
                a.filename()
            ));
        }
        format!(
            "<!-- hub-journal:v1 begin {} -->\n{}\n<!-- hub-journal:v1 end {} -->\n",
            self.id,
            body.trim(),
            self.id
        )
    }
}

/// Only standalone HTML blocks can delimit records; examples in code fences are ordinary text.
pub fn blocks(markdown: &str) -> Result<Vec<(String, String)>, String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut pending: Option<(String, usize)> = None;
    for (event, range) in pulldown_cmark::Parser::new(markdown).into_offset_iter() {
        let pulldown_cmark::Event::Html(html) = event else {
            continue;
        };
        let line = html.trim();
        if !line.starts_with(MARKER) {
            continue;
        }
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() != 5
            || parts[0] != "<!--"
            || parts[1] != "hub-journal:v1"
            || parts[4] != "-->"
            || !hex_id(parts[3], 32)
        {
            return Err("日记含无法识别的速记区块，请检查原文后重试".into());
        }
        match parts[2] {
            "begin" if pending.is_none() => pending = Some((parts[3].into(), range.end)),
            "end" => {
                let (id, start) = pending.take().ok_or("速记区块缺少开始标记")?;
                if id != parts[3] || !seen.insert(id.clone()) {
                    return Err("速记 ID 重复或区块边界不匹配".into());
                }
                result.push((id, markdown[start..range.start].trim().to_string()));
            }
            _ => return Err("速记区块发生嵌套或缺少结束标记".into()),
        }
    }
    if pending.is_some() {
        return Err("速记区块不完整，原日记未修改".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> Record {
        Record {
            version: 1,
            id: "a".repeat(32),
            date: "2026-11-07".into(),
            text: "想法\n\n- 第一项\n- 第二项".into(),
            attachments: vec![],
        }
    }
    #[test]
    fn multiline_blocks_keep_content_without_times_or_titles() {
        let r = record();
        let md = format!(
            "---\ntags: [日记]\n---\n# 当天\n\n{}",
            r.markdown("../attachments")
        );
        assert_eq!(blocks(&md).unwrap(), vec![(r.id, r.text)]);
    }
    #[test]
    fn fences_are_not_records_and_corruption_stops_import() {
        let r = record();
        let md = r.markdown("a");
        assert!(blocks(&format!("```html\n{md}\n```\n")).unwrap().is_empty());
        assert!(blocks(&(md.clone() + &md)).is_err());
        assert!(blocks(&md.replace("v1 end", "v2 end")).is_err());
        assert!(blocks(&md.replace(&format!("<!-- hub-journal:v1 end {} -->", r.id), "")).is_err());
    }
    #[test]
    fn dates_ids_and_reserved_markers_are_validated() {
        let mut r = record();
        assert!(r.validate().is_ok());
        r.date = "2026-02-29".into();
        assert!(r.validate().is_err());
        r.date = "2024-02-29".into();
        r.text = MARKER.into();
        assert!(r.validate().is_err());
    }
}
