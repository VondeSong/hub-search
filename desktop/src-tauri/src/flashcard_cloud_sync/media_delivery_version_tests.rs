use super::*;
use crate::flashcard_cloud_sync::tests::{server, store};

const BYTES: &[u8] = b"owned local attachment used for remote version verification";
struct Fixture {
    root: PathBuf,
    db: PathBuf,
    blobs: BlobStore,
    hash: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hub-media-version-{}", random_url_safe(16)));
        fs::create_dir(&root).unwrap();
        let db = root.join("craft-search.sqlite3");
        let blobs = BlobStore::open(&root.join("blobs")).unwrap();
        let hash = blobs.put(BYTES).unwrap().hash;
        let c = open_database(&db).unwrap();
        ensure_journal(&c).unwrap();
        schema(&c).unwrap();
        c.execute("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('fixture','Fixture',1,1)", []).unwrap();
        c.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at,media_json)
            VALUES('card','fixture','Q','A',1,1,1,?1)",
            [json!([{"url":format!("http://craft-media.localhost/{hash}"),"mimeType":"text/plain"}]).to_string()]).unwrap();
        Self {
            root,
            db,
            blobs,
            hash,
        }
    }
    async fn round(&self, remote: &OssStore) -> Result<(), String> {
        self.round_with_force(remote, false).await
    }
    async fn round_with_force(&self, remote: &OssStore, force: bool) -> Result<(), String> {
        deliver(
            remote,
            &self.db,
            &self.blobs,
            "version-fixture",
            false,
            force,
            &mut CloudReport::default(),
        )
        .await
        .map(|_| ())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        forget_initialized_database(&self.db);
        assert_eq!(self.root.parent(), Some(std::env::temp_dir().as_path()));
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[tokio::test]
async fn attachment_traffic_flashcard_legacy_etag_reuses_only_the_current_verified_version() {
    let server = server().await;
    let remote = store(&server);
    let f = Fixture::new();
    let key = remote.key(&format!("media/{}", f.hash));
    {
        let mut s = server.state.lock().unwrap();
        s.files.insert(key.clone(), (BYTES.to_vec(), String::new()));
        s.etags.insert(key.clone(), "\"legacy-one\"".into());
    }
    f.round(&remote).await.unwrap();
    f.round(&remote).await.unwrap();
    assert_eq!(server.state.lock().unwrap().gets[&key], 1);
    server
        .state
        .lock()
        .unwrap()
        .etags
        .insert(key.clone(), "\"legacy-two\"".into());
    f.round(&remote).await.unwrap();
    assert_eq!(server.state.lock().unwrap().gets[&key], 2);
    {
        let mut s = server.state.lock().unwrap();
        s.etags.insert(key.clone(), "\"legacy-three\"".into());
        s.files.get_mut(&key).unwrap().0[0] ^= 1;
    }
    assert!(f.round(&remote).await.is_err());
    let saved: String = open_database(&f.db).unwrap().query_row(
        "SELECT remote_identity FROM flashcard_cloud_media_receipts WHERE namespace='version-fixture' AND hash=?1",
        [&f.hash], |r|r.get(0)).unwrap();
    assert_eq!(
        serde_json::from_str::<crate::flashcard_object_store::Identity>(&saved)
            .unwrap()
            .etag
            .as_deref(),
        Some("\"legacy-two\"")
    );
    assert_eq!(server.state.lock().unwrap().puts, 0);
}

#[tokio::test]
async fn attachment_traffic_flashcard_without_strong_etag_keeps_authoritative_body_checks() {
    let server = server().await;
    let remote = store(&server);
    let f = Fixture::new();
    let key = remote.key(&format!("media/{}", f.hash));
    server
        .state
        .lock()
        .unwrap()
        .files
        .insert(key.clone(), (BYTES.to_vec(), String::new()));
    for _ in 0..2 {
        f.round(&remote).await.unwrap();
    }
    assert_eq!(server.state.lock().unwrap().gets[&key], 2);
    server
        .state
        .lock()
        .unwrap()
        .etags
        .insert(key.clone(), "W/\"weak-version\"".into());
    for _ in 0..2 {
        f.round(&remote).await.unwrap();
    }
    assert_eq!(server.state.lock().unwrap().gets[&key], 4);
    assert_eq!(server.state.lock().unwrap().puts, 0);
}

#[tokio::test]
async fn attachment_traffic_flashcard_force_legacy_reads_bytes_once_per_attempt() {
    let server = server().await;
    let remote = store(&server);
    let f = Fixture::new();
    let key = remote.key(&format!("media/{}", f.hash));
    {
        let mut s = server.state.lock().unwrap();
        s.files.insert(key.clone(), (BYTES.to_vec(), String::new()));
        s.etags.insert(key.clone(), "\"legacy-force\"".into());
    }
    f.round(&remote).await.unwrap();
    assert_eq!(server.state.lock().unwrap().gets[&key], 1);
    f.round_with_force(&remote, true).await.unwrap();
    assert_eq!(server.state.lock().unwrap().gets[&key], 2);
    server.state.lock().unwrap().files.get_mut(&key).unwrap().0[0] ^= 1;
    assert!(f.round_with_force(&remote, true).await.is_err());
    let s = server.state.lock().unwrap();
    assert_eq!(s.gets[&key], 3);
    assert_eq!(s.puts, 0);
}

#[tokio::test]
async fn attachment_traffic_flashcard_force_upload_reuses_its_actual_readback() {
    let server = server().await;
    let remote = store(&server);
    let f = Fixture::new();
    let key = remote.key(&format!("media/{}", f.hash));
    f.round_with_force(&remote, true).await.unwrap();
    {
        let s = server.state.lock().unwrap();
        assert_eq!(s.gets[&key], 1);
        assert_eq!(s.puts, 1);
    }
    // The upload receipt and matching SHA metadata cannot satisfy the next force.
    f.round_with_force(&remote, true).await.unwrap();
    assert_eq!(server.state.lock().unwrap().gets[&key], 2);
    server.state.lock().unwrap().files.get_mut(&key).unwrap().0[0] ^= 1;
    assert!(f.round_with_force(&remote, true).await.is_err());
    let s = server.state.lock().unwrap();
    assert_eq!(s.gets[&key], 3);
    assert_eq!(s.puts, 1);
}

#[test]
fn attachment_traffic_flashcard_schema_preserves_legacy_evidence_without_inventing_a_version() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE flashcard_cloud_media_receipts(namespace TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,verified_sha TEXT NOT NULL,PRIMARY KEY(namespace,hash));
        INSERT INTO flashcard_cloud_media_receipts VALUES('legacy','saved-hash',42,'saved-hash');").unwrap();
    schema(&c).unwrap();
    schema(&c).unwrap();
    let row: (String,u64,String,Option<String>) = c.query_row(
        "SELECT hash,size,verified_sha,remote_identity FROM flashcard_cloud_media_receipts WHERE namespace='legacy'", [],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(row, ("saved-hash".into(), 42, "saved-hash".into(), None));
}
