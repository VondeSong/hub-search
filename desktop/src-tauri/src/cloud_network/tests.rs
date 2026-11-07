use super::*;
fn network(kind: &str, metered: Option<bool>) -> Network {
    Network {
        supported: true,
        connected: Some(true),
        kind: kind.into(),
        metered,
        restricted: false,
    }
}
#[test]
fn cloud_network_restrictions_and_unknown_state_are_enforced_without_guessing_transport() {
    assert!(permit(Mode::Any, &Network::unknown(false)).is_ok());
    assert!(permit(Mode::Wifi, &network("wifi", Some(false))).is_ok());
    assert!(permit(Mode::Wifi, &network("wifi", Some(true))).is_err());
    assert!(permit(Mode::Unmetered, &network("ethernet", Some(false))).is_ok());
    assert!(permit(Mode::Wifi, &network("ethernet", Some(false))).is_err());
    assert!(permit(Mode::Wifi, &network("vpn", Some(false))).is_err());
    assert!(permit(Mode::Unmetered, &network("vpn", Some(false))).is_ok());
    for mode in [Mode::Unmetered, Mode::Wifi] {
        assert!(permit(mode, &Network::unknown(true)).is_err());
        assert!(permit(mode, &network("cellular", Some(true))).is_err());
        assert!(permit(mode, &network("wifi", None)).is_err());
    }
    let mut n = network("wifi", Some(false));
    n.restricted = true;
    assert!(permit(Mode::Unmetered, &n).is_err());
    n.connected = Some(false);
    assert!(permit(Mode::Any, &n).is_err());
}
#[test]
fn cloud_network_policy_persists_and_does_not_modify_other_device_preferences() {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO metadata VALUES('cloud_sync_auto','1');").unwrap();
    assert_eq!(policy(&c).unwrap(), Mode::Any);
    save(&c, Mode::Wifi).unwrap();
    assert_eq!(policy(&c).unwrap(), Mode::Wifi);
    assert_eq!(metadata_string(&c, "cloud_sync_auto"), "1");
    assert!(serde_json::from_value::<Mode>(json!("mobile_only")).is_err());
    c.execute("UPDATE metadata SET value='invalid' WHERE key=?1", [KEY])
        .unwrap();
    assert!(policy(&c).is_err());
}
#[tokio::test]
async fn cloud_network_real_oss_requests_recheck_each_scope_and_preserve_rejected_uploads() {
    use crate::flashcard_cloud_sync::tests::{server, store};
    let s = server().await;
    let remote = store(&s);
    let state = std::sync::Arc::new(std::sync::Mutex::new(network("cellular", Some(true))));
    let observed = state.clone();
    let prefix = remote.key("reading/");
    let remote = remote.with_network_guard(
        prefix,
        std::sync::Arc::new(move || permit(Mode::Wifi, &observed.lock().unwrap())),
    );
    let key = remote.key("reading/v1/changes/test.json");
    assert!(remote.put_verified(&key, b"body").await.is_err());
    assert!(remote.get(&key, 20).await.is_err());
    assert!(remote.list("reading/v1/changes/").await.is_err());
    assert!(s.state.lock().unwrap().files.is_empty());
    // Shared credentials/probes and flashcard keys must keep their independent behavior.
    remote
        .put_verified(&remote.key("probes/test"), b"probe")
        .await
        .unwrap();
    *state.lock().unwrap() = network("wifi", Some(false));
    remote.put_verified(&key, b"body").await.unwrap();
    assert_eq!(remote.get(&key, 20).await.unwrap().unwrap(), b"body");
    *state.lock().unwrap() = network("cellular", Some(true));
    assert!(remote.get(&key, 20).await.is_err());
    assert!(remote.list("reading/v1/").await.is_err());
    assert_eq!(s.state.lock().unwrap().files.get(&key).unwrap().0, b"body");
}
#[tokio::test]
async fn cloud_network_route_change_during_upload_blocks_put_or_leaves_unverified_object_retryable()
{
    use crate::flashcard_cloud_sync::tests::{server, store};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let s = server().await;
    // A new upload does HEAD, GET, PUT, then verification GET. Change route at each boundary.
    for allowed_requests in 1..=3 {
        let remote = store(&s);
        let prefix = remote.key("reading/");
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let remote = remote.with_network_guard(
            prefix,
            Arc::new(move || {
                let n = if observed.fetch_add(1, Ordering::SeqCst) < allowed_requests {
                    network("wifi", Some(false))
                } else {
                    network("cellular", Some(true))
                };
                permit(Mode::Wifi, &n)
            }),
        );
        let key = remote.key(&format!(
            "reading/v1/changes/switch-{allowed_requests}.json"
        ));
        assert!(remote.put_verified(&key, b"body").await.is_err());
        assert_eq!(count.load(Ordering::SeqCst), allowed_requests + 1);
        assert_eq!(
            s.state.lock().unwrap().files.contains_key(&key),
            allowed_requests == 3
        );
        // A PUT completed before the switch does not imply acknowledgement. Retrying on Wi-Fi
        // verifies/reuses that object instead of losing the pending payload or overwriting it.
        let healthy = store(&s);
        healthy.put_verified(&key, b"body").await.unwrap();
        assert_eq!(healthy.get(&key, 20).await.unwrap().unwrap(), b"body");
    }
}
#[cfg(windows)]
#[test]
fn cloud_network_windows_native_smoke_reads_only_nonidentifying_fields() {
    let n = native(None);
    let value = serde_json::to_value(&n).unwrap();
    assert!(n.supported);
    assert_eq!(value.as_object().unwrap().len(), 5);
    assert!(matches!(
        n.kind.as_str(),
        "wifi" | "cellular" | "other" | "unknown"
    ));
}
