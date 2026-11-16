//! Website identity is decoration for an already-observed public origin. It is
//! never evidence of a page read, nor permission to fetch an arbitrary URL.
use super::*;
use base64::Engine;
use sha2::{Digest, Sha256};

fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() > 65_536 {
        return None;
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 && &bytes[12..16] == b"IHDR" {
        let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return ((1..=512).contains(&width) && (1..=512).contains(&height)).then_some("image/png");
    }
    if bytes.starts_with(&[0, 0, 1, 0]) && bytes.len() >= 6 {
        let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
        if !(1..=16).contains(&count) || bytes.len() < 6 + count * 16 {
            return None;
        }
        for entry in bytes[6..6 + count * 16].chunks_exact(16) {
            let size = u32::from_le_bytes(entry[8..12].try_into().ok()?) as usize;
            let offset = u32::from_le_bytes(entry[12..16].try_into().ok()?) as usize;
            if size == 0 || offset < 6 + count * 16 || offset.checked_add(size)? > bytes.len() {
                return None;
            }
        }
        return Some("image/x-icon");
    }
    None
}
fn data_url(bytes: &[u8]) -> Option<String> {
    Some(format!(
        "data:{};base64,{}",
        image_type(bytes)?,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
fn declared_icon(origin: &reqwest::Url, html: &str, dark: bool) -> Option<String> {
    let tags = regex::Regex::new(r"(?is)<link\s[^>]{0,4096}>").ok()?;
    let attrs = regex::Regex::new(r#"(?is)(rel|href|media)\s*=\s*["']([^"']{1,2048})["']"#).ok()?;
    for tag in tags.find_iter(html).take(64) {
        let attributes: HashMap<_, _> = attrs
            .captures_iter(tag.as_str())
            .map(|c| (c[1].to_ascii_lowercase(), c[2].to_owned()))
            .collect();
        if !attributes
            .get("rel")
            .is_some_and(|v| v.split_whitespace().any(|s| s.eq_ignore_ascii_case("icon")))
        {
            continue;
        }
        if let Some(media) = attributes.get("media") {
            if media.contains("prefers-color-scheme")
                && media.contains(if dark { "light" } else { "dark" })
            {
                continue;
            }
        }
        let href = attributes.get("href")?.replace("&amp;", "&");
        let candidate = origin.join(&href).ok()?;
        if crate::x_bookmarks::public_web::url(candidate.as_str()).is_ok() {
            return Some(candidate.into());
        }
    }
    None
}

pub(super) async fn load(root: &Path, args: &Value) -> Result<Value, String> {
    let work_id = text(args, "id", 150)?;
    let public = crate::x_bookmarks::public_web::url(&text(args, "url", 4096)?)?;
    let c = crate::source_evidence::open_read_database(root)?;
    let work = store::load(&c, &work_id)?;
    if work.state == "revoked" {
        return Err("对话授权已撤回".into());
    }
    // Reuse the visibility/evidence checks of the real activity projection.
    let runs = activity::read_on(root, &c, &work)?;
    let host = public.host_str().ok_or("图标域名缺失")?;
    let observed = runs
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|r| r["events"].as_array().into_iter().flatten())
        .any(|event| {
            std::iter::once(event["url"].as_str())
                .chain(
                    event["sourceRefs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|s| s["url"].as_str()),
                )
                .flatten()
                .filter_map(|raw| crate::x_bookmarks::public_web::url(raw).ok())
                .any(|url| url.host_str() == Some(host))
        });
    drop(c);
    if !observed {
        return Err("站点未出现在本对话的有效来源记录中".into());
    }
    let dark = args["theme"] == "dark";
    let cache = root.join("agent-icons");
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{host}:{}", if dark { "dark" } else { "light" }).as_bytes())
    );
    let path = cache.join(format!("{key}.icon"));
    if let Ok(metadata) = std::fs::metadata(&path) {
        if metadata.len() <= 65_536
            && metadata
                .modified()
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() < 86400)
        {
            if let Ok(bytes) = std::fs::read(&path) {
                if let Some(data) = data_url(&bytes) {
                    return Ok(json!({"dataUrl":data,"host":host}));
                }
            }
        }
    }
    let origin = reqwest::Url::parse(&format!("https://{host}/")).map_err(|_| "图标来源无效")?;
    let fetched = tokio::time::timeout(Duration::from_secs(8), async {
        if let Ok((page, bytes)) =
            crate::x_bookmarks::public_web::icon_asset(origin.as_str(), "text/html", 65_536).await
        {
            if let Ok(html) = std::str::from_utf8(&bytes) {
                if let Some(candidate) = declared_icon(&page, html, dark) {
                    if let Ok((_, icon)) = crate::x_bookmarks::public_web::icon_asset(
                        &candidate,
                        "image/png,image/x-icon",
                        65_536,
                    )
                    .await
                    {
                        if image_type(&icon).is_some() {
                            return Some(icon);
                        }
                    }
                }
            }
        }
        let fallback = origin.join("favicon.ico").ok()?;
        let (_, bytes) = crate::x_bookmarks::public_web::icon_asset(
            fallback.as_str(),
            "image/png,image/x-icon",
            65_536,
        )
        .await
        .ok()?;
        image_type(&bytes).map(|_| bytes)
    })
    .await
    .ok()
    .flatten();
    if let Some(bytes) = fetched {
        if std::fs::create_dir_all(&cache).is_ok()
            && std::fs::read_dir(&cache)
                .ok()
                .is_some_and(|files| files.take(257).count() < 256 || path.exists())
        {
            let _ = std::fs::write(path, &bytes);
        }
        return Ok(json!({"dataUrl":data_url(&bytes),"host":host}));
    }
    Ok(json!({"dataUrl":null,"host":host}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "explicit public favicon qualification; no model or library writes"]
    async fn actual_public_website_icon() {
        let (_, bytes) = crate::x_bookmarks::public_web::icon_asset(
            "https://github.com/favicon.ico",
            "image/png,image/x-icon",
            65_536,
        )
        .await
        .unwrap();
        assert!(data_url(&bytes).is_some());
        println!(
            "public website icon: {} bytes, {}",
            bytes.len(),
            image_type(&bytes).unwrap()
        );
    }
    #[test]
    fn icon_metadata_is_inert_bounded_and_resolved_against_public_origin() {
        let origin = reqwest::Url::parse("https://example.org/sub/page").unwrap();
        assert_eq!(
            declared_icon(
                &origin,
                r#"<link href="../icon.png" rel="shortcut icon">"#,
                false
            )
            .unwrap(),
            "https://example.org/icon.png"
        );
        assert!(declared_icon(
            &origin,
            r#"<link rel="icon" href="http://127.0.0.1/private">"#,
            false
        )
        .is_none());
        assert!(data_url(b"<svg onload='bad' />").is_none());
        assert!(image_type(&vec![0; 65_537]).is_none());
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend(16u32.to_be_bytes());
        png.extend(16u32.to_be_bytes());
        assert_eq!(image_type(&png), Some("image/png"));
        png[16..20].copy_from_slice(&9000u32.to_be_bytes());
        assert!(image_type(&png).is_none());
    }
}
