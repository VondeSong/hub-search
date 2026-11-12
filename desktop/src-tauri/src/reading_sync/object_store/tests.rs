use super::*;
pub(crate) use crate::flashcard_cloud_sync::tests::{server, Server};
use crate::x_bookmarks::Post;
pub(crate) fn config(_s: &Server) -> Configuration {
    Configuration::Oss {
        config: OssConfig {
            bucket: "test-bucket".into(),
            region: "cn-hangzhou".into(),
            prefix: "MigrationTarget".into(),
            access_key_id: "EXAMPLE".into(),
        },
    }
}
pub(crate) fn remote(s: &Server) -> OssStore {
    let Configuration::Oss { config } = config(s);
    OssStore::new(config, "synthetic-test-secret".into())
        .unwrap()
        .with_test_endpoint(s.url.clone())
}
pub(crate) const KEY: &str = "telegram:test-account:media";
pub(crate) const URL: &str = "https://example.invalid/picture.png";
pub(crate) struct Device {
    pub(crate) root: PathBuf,
    pub(crate) db: PathBuf,
}
impl Device {
    pub(crate) fn new(s: &Server) -> Self {
        let root =
            std::env::temp_dir().join(format!("hub-reading-store-test-{}", random_url_safe(10)));
        fs::create_dir(&root).unwrap();
        let db = root.join("hub.sqlite3");
        let c = open_database(&db).unwrap();
        x_bookmarks::storage::schema(&c).unwrap();
        for (k, v) in [
            ("flashcard_cloud_provider", "oss"),
            ("cloud_sync_enabled", "1"),
            ("cloud_sync_reading", "1"),
        ] {
            meta(&c, k, v).unwrap();
        }
        let Configuration::Oss { config } = config(s);
        meta(
            &c,
            "flashcard_oss_config",
            &serde_json::to_string(&config).unwrap(),
        )
        .unwrap();
        meta(&c,"reading_media_policy",r#"{"enabled":true,"download":"all","imageMb":10,"documentMb":20,"batchMb":64,"dailyMb":256,"cacheMb":512}"#).unwrap();
        Self { root, db }
    }
    pub(crate) fn c(&self) -> Connection {
        open_database(&self.db).unwrap()
    }
    pub(crate) fn seed(&self) {
        x_bookmarks::reading_sync_test_import_managed(
            &mut self.c(),
            Post {
                id: "media".into(),
                text: "OSS 正式正文".into(),
                content_status: "full".into(),
                media: vec![crate::collection_models::Media {
                    kind: "photo".into(),
                    url: URL.into(),
                    preview_url: String::new(),
                }],
                ..Post::default()
            },
        );
        let path = self.root.join("source.png");
        fs::write(&path, png()).unwrap();
        x_bookmarks::storage::record_saved_media(&self.c(), KEY, URL, &path).unwrap();
    }
    pub(crate) async fn round(&self, remote: &dyn Store, ns: &str, label: &str) {
        crate::reading_sync::sync_database(&self.db, remote, ns, label)
            .await
            .unwrap();
        crate::reading_sync::media::sync(&self.db, remote, ns, label)
            .await
            .unwrap();
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        forget_initialized_database(&self.db);
        assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self
            .root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("hub-reading-store-test-"));
        let _ = fs::remove_dir_all(&self.root);
    }
}
pub(crate) fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE+0AAAAASUVORK5CYII=").unwrap()
}
