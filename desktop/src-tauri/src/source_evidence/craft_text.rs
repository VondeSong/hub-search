//! Text evidence does not read image bytes or treat an image access URL as text.
pub(super) fn project(body: &str) -> (String, usize) {
    let mut result = String::with_capacity(body.len());
    let mut images = 0;
    let mut fence: Option<(char, usize)> = None;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim();
        let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        let run = marker
            .map(|c| trimmed.chars().take_while(|x| *x == c).count())
            .unwrap_or(0);
        if run >= 3 {
            match fence {
                None => fence = Some((marker.unwrap(), run)),
                Some((c, n))
                    if marker == Some(c) && run >= n && trimmed[run..].trim().is_empty() =>
                {
                    fence = None
                }
                _ => (),
            }
            result.push_str(line);
            continue;
        }
        if fence.is_none() && trimmed.starts_with("![") && trimmed.ends_with(')') {
            if let Some(start) = trimmed.find("](") {
                let url = &trimmed[start + 2..trimmed.len() - 1];
                if url.starts_with("https://r.craft.do/")
                    && !url
                        .chars()
                        .any(|c| c.is_whitespace() || c == '(' || c == ')')
                {
                    let offset = line.find(trimmed).unwrap();
                    result.push_str(&line[..offset + start + 2]);
                    result.push_str("#hub-image-not-read");
                    result.push_str(&line[offset + trimmed.len() - 1..]);
                    images += 1;
                    continue;
                }
            }
        }
        result.push_str(line);
    }
    (result, images)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changes_only_standalone_craft_images_and_preserves_code_and_text_links() {
        let raw = "<content>\r\n        ![现场](https://r.craft.do/old)\r\n[文件](https://r.craft.do/old)\n```md\n![例子](https://r.craft.do/old)\n```\n~~~md\n![例子](https://r.craft.do/old)\n~~~\n![外部](https://example.org/image)\n</content>";
        let (text, count) = project(raw);
        assert_eq!(count, 1);
        assert_eq!(
            text,
            raw.replacen(
                "![现场](https://r.craft.do/old)",
                "![现场](#hub-image-not-read)",
                1
            )
        );
        assert_eq!(
            project(&raw.replacen("/old)", "/renewed-longer)", 1)).0,
            text
        );
        assert_ne!(project(&raw.replace("现场", "新图说明")).0, text);
    }
}
