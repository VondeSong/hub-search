//! Derive asset roles from the unchanged sanitized body, never from a URL extension.
use super::*;
use std::collections::BTreeSet;

struct References {
    post_hash: String,
    originals: BTreeSet<String>,
    previews: BTreeSet<String>,
}
fn read(c: &Connection, key: &str) -> Result<References, String> {
    if x_bookmarks::library::blocked(c, key)? {
        return Err("阅读条目已删除".into());
    }
    let raw: String = c
        .query_row(
            "SELECT post_json FROM collection_x_items WHERE item_key=?1",
            [key],
            |r| r.get(0),
        )
        .map_err(|_| "阅读条目不存在")?;
    references_from_post(serde_json::from_str(&raw).map_err(|_| "阅读正文损坏")?)
}
fn references_from_post(mut post: Post) -> Result<References, String> {
    sanitize(&mut post);
    fn collect(p: &Post, originals: &mut BTreeSet<String>, previews: &mut BTreeSet<String>) {
        for m in p.media.iter().chain(&p.all_media) {
            if !m.url.is_empty() {
                originals.insert(m.url.clone());
            }
            if !m.preview_url.is_empty() {
                previews.insert(m.preview_url.clone());
            }
        }
        for child in &p.thread {
            collect(child, originals, previews);
        }
        if let Some(quote) = &p.quote {
            collect(quote, originals, previews);
        }
    }
    let mut originals = BTreeSet::new();
    let mut previews = BTreeSet::new();
    collect(&post, &mut originals, &mut previews);
    Ok(References {
        post_hash: hash(&serde_json::to_vec(&post).map_err(|e| e.to_string())?),
        originals,
        previews,
    })
}
pub(super) fn current(c: &Connection, key: &str) -> Result<(String, Vec<String>), String> {
    let r = read(c, key)?;
    Ok((
        r.post_hash,
        r.originals.union(&r.previews).cloned().collect(),
    ))
}
pub(super) fn originals(c: &Connection, key: &str) -> Result<(String, Vec<String>), String> {
    let r = read(c, key)?;
    Ok((r.post_hash, r.originals.into_iter().collect()))
}
pub(super) fn preview_only(c: &Connection, key: &str, url: &str) -> Result<bool, String> {
    let r = read(c, key)?;
    Ok(r.previews.contains(url) && !r.originals.contains(url))
}
// Only a current ready image provides lazy cloud-cover capability. This is not a local-file receipt.
pub(crate) fn ready_previews(c: &Connection, key: &str, ns: &str) -> Result<Vec<String>, String> {
    let r = read(c, key)?;
    let p = match policy(c) {
        Ok(p) => p,
        Err(_) => return Ok(Vec::new()),
    };
    if !p.enabled || cloud_sync::require_reading(c, false).is_err() {
        return Ok(Vec::new());
    }
    let mut urls = Vec::new();
    for url in r.previews.difference(&r.originals) {
        let Ok(Some(m)) = load_manifest(c, ns, key, &r.post_hash, url) else {
            continue;
        };
        if m.validate().is_ok()
            && m.state == "ready"
            && m.mime.starts_with("image/")
            && m.size <= MAX_PREVIEW
            && allowed(&p, &m.mime, m.size, false)
            && !cache::evicted(c, &m.hash)?
        {
            urls.push(url.clone());
        }
    }
    Ok(urls)
}

pub(crate) fn ready_previews_page<'a>(
    c: &Connection,
    posts: impl IntoIterator<Item = (&'a str, &'a str)>,
    ns: &str,
) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let p = match policy(c) {
        Ok(p) => p,
        Err(_) => return Ok(Default::default()),
    };
    if !p.enabled || cloud_sync::require_reading(c, false).is_err() {
        return Ok(Default::default());
    }
    let mut references = std::collections::HashMap::new();
    for (key, raw) in posts {
        references.insert(
            key.to_string(),
            references_from_post(serde_json::from_str(raw).map_err(|_| "阅读正文损坏")?)?,
        );
    }
    let selected = serde_json::to_string(
        &references
            .iter()
            .map(|(key, r)| json!({"key":key,"hash":r.post_hash}))
            .collect::<Vec<_>>(),
    )
    .map_err(|e| e.to_string())?;
    let mut s = c.prepare("SELECT m.item_key,m.url,m.body FROM json_each(?2) selected
        JOIN reading_media_manifests m ON m.namespace=?1 AND m.item_key=json_extract(selected.value,'$.key')
          AND m.post_hash=json_extract(selected.value,'$.hash')").map_err(|e| e.to_string())?;
    let mut manifests = Vec::new();
    for row in s
        .query_map(params![ns, selected], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
    {
        let (key, url, raw) = row.map_err(|e| e.to_string())?;
        let Ok(m) = serde_json::from_str::<Manifest>(&raw) else {
            continue;
        };
        if references
            .get(&key)
            .is_some_and(|r| r.previews.contains(&url) && !r.originals.contains(&url))
            && m.validate().is_ok()
            && m.state == "ready"
            && m.mime.starts_with("image/")
            && m.size <= MAX_PREVIEW
            && allowed(&p, &m.mime, m.size, false)
        {
            manifests.push((key, url, m.hash));
        }
    }
    let hashes = serde_json::to_string(&manifests.iter().map(|m| &m.2).collect::<Vec<_>>())
        .map_err(|e| e.to_string())?;
    let mut s = c.prepare("SELECT hash FROM reading_media_evicted WHERE hash IN (SELECT value FROM json_each(?1))").map_err(|e| e.to_string())?;
    let evicted = s
        .query_map([hashes], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut result = std::collections::HashMap::<String, Vec<String>>::new();
    for (key, url, digest) in manifests {
        if !evicted.contains(&digest) {
            result.entry(key).or_default().push(url);
        }
    }
    for urls in result.values_mut() {
        urls.sort();
    }
    Ok(result)
}
