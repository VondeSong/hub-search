//! Backup originals reuse the attachment's own revision, never a parent timestamp.
use super::*;

pub(super) fn strong_etag(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(reqwest::header::ETAG)?
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|tag| tag.starts_with('"') && tag.ends_with('"') && tag.len() > 2)
        .map(str::to_owned)
}

pub(super) fn reuse_current(
    store: &BlobStore,
    asset: &SnapshotAttachment,
    current: &[SnapshotAttachment],
) -> Option<(String, u64, Option<String>)> {
    current
        .iter()
        .filter(|old| {
            old.remote_url == asset.remote_url && old.resource_revision == asset.resource_revision
        })
        .find_map(|old| {
            let (hash, size) = old.object_hash.as_ref().zip(old.bytes)?;
            if asset
                .expected_bytes
                .is_some_and(|expected| expected != size)
            {
                return None;
            }
            let path = store.path_for(hash).ok()?;
            if fs::metadata(&path).ok()?.len() != size
                || hash_file(&path).ok()?.as_str() != hash
                || validate_original(&path, asset).is_err()
            {
                return None;
            }
            Some((hash.clone(), size, old.remote_etag.clone()))
        })
}

pub(super) fn previous_assets(
    root: &Path,
    store: &BlobStore,
    library: &str,
) -> Result<Vec<SnapshotAttachment>, String> {
    let Some(snapshot) = history(root, library)?.into_iter().next() else {
        return Ok(Vec::new());
    };
    let mut assets = snapshot.attachments;
    // Older archives retain the original JSON even though their attachment
    // records predate the revision field. Recover evidence from that JSON.
    for document in snapshot.documents {
        if store
            .path_for(&document.structure_hash)
            .ok()
            .and_then(|path| hash_file(&path).ok())
            .as_deref()
            != Some(document.structure_hash.as_str())
        {
            continue;
        }
        let Ok(bytes) = store.read(&document.structure_hash) else {
            continue;
        };
        let Ok(tree) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let mut discovered = BTreeMap::new();
        collect_resources(
            &tree,
            &document.id,
            &mut discovered,
            &mut BTreeSet::new(),
            &mut BTreeSet::new(),
        );
        for asset in assets.iter_mut().filter(|a| a.resource_revision.is_none()) {
            if let Some(old) = discovered
                .get(&asset.id)
                .filter(|a| a.remote_url == asset.remote_url)
            {
                asset.resource_revision = old.resource_revision.clone();
            }
        }
    }
    Ok(assets)
}

pub(super) async fn reuse<'a>(
    client: &Client,
    store: &BlobStore,
    asset: &SnapshotAttachment,
    candidates: impl Iterator<Item = &'a SnapshotAttachment>,
    database: Option<(&PathBuf, &BlobStore)>,
    library: &str,
) -> Result<Option<(String, u64, Option<String>)>, String> {
    for old in candidates {
        if crate::craft_attachment_resource_locator(&old.remote_url)
            != crate::craft_attachment_resource_locator(&asset.remote_url)
        {
            continue;
        }
        let Some((hash, size)) = old.object_hash.as_ref().zip(old.bytes) else {
            continue;
        };
        if asset
            .expected_bytes
            .is_some_and(|expected| expected != size)
        {
            continue;
        }
        let compatible_revision = match (&asset.resource_revision, &old.resource_revision) {
            (Some(current), Some(previous)) => current == previous,
            (None, None) => asset.remote_url.starts_with("data:"),
            _ => false,
        };
        let Ok(path) = store.path_for(hash) else {
            continue;
        };
        if fs::metadata(&path).ok().is_none_or(|m| m.len() != size)
            || hash_file(&path).ok().as_deref() != Some(hash)
            || validate_original(&path, asset).is_err()
        {
            continue;
        }
        if compatible_revision {
            return Ok(Some((hash.clone(), size, old.remote_etag.clone())));
        }
        // No revision proof: a fresh strong ETag and length may prove the old
        // bytes current. Missing/weak validators require a normal download.
        if asset.resource_revision.is_none() && old.resource_revision.is_none() {
            if let Some(tag) = old.remote_etag.as_ref() {
                if let Ok(response) = client.head(&asset.remote_url).send().await {
                    if response.status().is_success()
                        && strong_etag(response.headers()).as_ref() == Some(tag)
                        && response
                            .headers()
                            .get(reqwest::header::CONTENT_LENGTH)
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.parse::<u64>().ok())
                            == Some(size)
                    {
                        return Ok(Some((hash.clone(), size, Some(tag.clone()))));
                    }
                }
            }
        }
    }
    if let Some((database, indexed_store)) = database.filter(|_| asset.resource_revision.is_some())
    {
        let metadata = json!({"remoteUrl":asset.remote_url,"resourceRevision":asset.resource_revision,"size":asset.expected_bytes}).to_string();
        if let Some(cached) = crate::attachment_resource_cache::verified_resource(
            database,
            indexed_store,
            library,
            crate::PROVIDER_CRAFT,
            &metadata,
            None,
        )? {
            let source = indexed_store.path_for(&cached.blob.hash)?;
            if validate_original(&source, asset).is_err() {
                return Ok(None);
            }
            let imported = store.put_file(&source, MAX_ASSET_BYTES)?;
            if imported.hash != cached.blob.hash || imported.size != cached.blob.size {
                return Err("本地附件在备份导入时发生变化".into());
            }
            return Ok(Some((imported.hash, imported.size, None)));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, BlobStore, SnapshotAttachment) {
        let root =
            std::env::temp_dir().join(format!("hub-backup-cache-{}", crate::random_url_safe(12)));
        let store = BlobStore::open(&root).unwrap();
        let blob = store.put(b"original").unwrap();
        let asset = SnapshotAttachment {
            id: "doc:block:original".into(),
            document_id: "doc".into(),
            title: "file.bin".into(),
            mime_type: "application/octet-stream".into(),
            remote_url: "https://r.craft.do/cache-original".into(),
            link_kind: "file".into(),
            expected_bytes: Some(8),
            resource_revision: Some("v1".into()),
            remote_etag: None,
            object_hash: Some(blob.hash),
            bytes: Some(8),
        };
        (root, store, asset)
    }

    #[tokio::test]
    async fn attachment_traffic_backup_invalid_index_original_falls_back_instead_of_aborting() {
        let (root, store, mut asset) = fixture();
        asset.title = "image.png".into();
        asset.link_kind = "image".into();
        asset.mime_type = "image/png".into();
        let db = root.join("index.sqlite3");
        let c = crate::open_database(&db).unwrap();
        c.execute("INSERT INTO spaces(id,name,mcp_url,added_at) VALUES('space','Space','https://example.test/mcp',1)",[]).unwrap();
        c.execute("INSERT INTO libraries(id,provider,name,enabled,added_at) VALUES('space','craft','Space',1,1)",[]).unwrap();
        c.execute("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash) VALUES('space','doc','Doc','Doc','body',1,'body')",[]).unwrap();
        let indexed = BlobStore::open(&root.join("indexed")).unwrap();
        let bad = indexed.put(b"<html>x!").unwrap();
        c.execute("INSERT INTO blobs(hash,size,mime_type,relative_path,created_at,verified_at) VALUES(?1,8,'text/html',?2,1,1)",params![bad.hash,bad.relative_path]).unwrap();
        let metadata=json!({"remoteUrl":asset.remote_url,"resourceRevision":"v1","size":8,"resourceGeneration":0,"cachedResourceGeneration":0}).to_string();
        c.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,blob_hash,metadata_json,status,created_at,updated_at,provider) VALUES('bad','space','doc','bad','craft_attachment','image.png','text/html',?1,?2,'stored',1,1,'craft')",params![bad.hash,metadata]).unwrap();
        drop(c);
        let client = Client::builder().no_proxy().build().unwrap();
        assert!(reuse(
            &client,
            &store,
            &asset,
            std::iter::empty(),
            Some((&db, &indexed)),
            "space"
        )
        .await
        .unwrap()
        .is_none());
        assert!(!store.local_path_for(&bad.hash).unwrap().exists());
        crate::forget_initialized_database(&db);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn attachment_traffic_backup_reuses_only_verified_current_revision() {
        let (root, store, old) = fixture();
        let client = Client::builder().no_proxy().build().unwrap();
        let mut current = old.clone();
        current.remote_url.push_str("?X-Amz-Signature=new");
        assert!(reuse(
            &client,
            &store,
            &current,
            std::iter::once(&old),
            None,
            "space"
        )
        .await
        .unwrap()
        .is_some());
        current.resource_revision = Some("v2".into());
        assert!(reuse(
            &client,
            &store,
            &current,
            std::iter::once(&old),
            None,
            "space"
        )
        .await
        .unwrap()
        .is_none());
        current = old.clone();
        current.expected_bytes = Some(9);
        assert!(reuse(
            &client,
            &store,
            &current,
            std::iter::once(&old),
            None,
            "space"
        )
        .await
        .unwrap()
        .is_none());
        let mut malformed = old.clone();
        malformed.object_hash = Some("invalid-old-hash".into());
        assert!(reuse(
            &client,
            &store,
            &old,
            std::iter::once(&malformed),
            None,
            "space"
        )
        .await
        .unwrap()
        .is_none());
        current = old.clone();
        fs::write(
            store.path_for(old.object_hash.as_ref().unwrap()).unwrap(),
            b"tampered",
        )
        .unwrap();
        assert!(reuse(
            &client,
            &store,
            &current,
            std::iter::once(&old),
            None,
            "space"
        )
        .await
        .unwrap()
        .is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn attachment_traffic_backup_legacy_validator_checks_head_without_get() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (root, store, mut old) = fixture();
        old.resource_revision = None;
        old.remote_etag = Some("\"v1\"".into());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        old.remote_url = format!("http://{}/asset", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for tag in ["v1", "v2"] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let n = stream.read(&mut request).await.unwrap();
                assert!(std::str::from_utf8(&request[..n])
                    .unwrap()
                    .starts_with("HEAD "));
                stream.write_all(format!("HTTP/1.1 200 OK\r\nETag: \"{tag}\"\r\nContent-Length: 8\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            }
        });
        let client = Client::builder().no_proxy().build().unwrap();
        assert!(
            reuse(&client, &store, &old, std::iter::once(&old), None, "space")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            reuse(&client, &store, &old, std::iter::once(&old), None, "space")
                .await
                .unwrap()
                .is_none()
        );
        server.await.unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attachment_traffic_backup_ignores_weak_validators_and_reads_old_revision_evidence() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::ETAG, "W/\"same\"".parse().unwrap());
        assert!(strong_etag(&headers).is_none());
        let mut resources = BTreeMap::new();
        collect_resources(
            &json!({"type":"image","id":"block","url":"https://r.craft.do/a","metadata":{"lastModifiedAt":"r1"}}),
            "doc",
            &mut resources,
            &mut BTreeSet::new(),
            &mut BTreeSet::new(),
        );
        assert_eq!(
            resources["doc:block:original"].resource_revision.as_deref(),
            Some("r1")
        );
    }

    #[test]
    fn attachment_traffic_backup_current_capture_reuses_unknown_revision_but_rechecks_bytes() {
        let (root, store, mut asset) = fixture();
        asset.resource_revision = None;
        assert!(reuse_current(&store, &asset, std::slice::from_ref(&asset)).is_some());
        fs::write(
            store.path_for(asset.object_hash.as_ref().unwrap()).unwrap(),
            b"tampered",
        )
        .unwrap();
        assert!(reuse_current(&store, &asset, std::slice::from_ref(&asset)).is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
