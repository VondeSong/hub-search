//! Device-local policy shared by cloud modules. Provider keys/remote paths remain compatible.
use super::*;
pub(crate) mod attachments;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Policy {
    pub enabled: bool,
    pub auto_sync: bool,
    pub flashcards: bool,
    #[serde(default)]
    pub reading: bool,
}

pub(super) fn policy(c: &Connection) -> Policy {
    Policy {
        // Existing installations retain their behavior until an explicit local choice is saved.
        enabled: metadata_bool(c, "cloud_sync_enabled", flashcard_cloud_sync::configured(c)),
        auto_sync: metadata_bool(
            c,
            "cloud_sync_auto",
            metadata_bool(c, "flashcard_sync_auto", false),
        ),
        flashcards: metadata_bool(c, "cloud_sync_flashcards", true),
        reading: metadata_bool(c, "cloud_sync_reading", false),
    }
}

pub(super) fn initialize(c: &Connection) -> Result<(), String> {
    let previous = policy(c);
    for (key, value) in [
        ("cloud_sync_enabled", previous.enabled),
        ("cloud_sync_auto", previous.auto_sync),
        ("cloud_sync_flashcards", previous.flashcards),
        ("cloud_sync_reading", previous.reading),
    ] {
        c.execute(
            "INSERT OR IGNORE INTO metadata(key,value) VALUES(?1,?2)",
            params![key, if value { "1" } else { "0" }],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn automatic(c: &Connection) -> bool {
    let p = policy(c);
    p.enabled && p.flashcards && p.auto_sync
}

pub(super) fn require_flashcards(c: &Connection, auto: bool) -> Result<(), String> {
    let p = policy(c);
    if !p.enabled {
        return Err("本设备云同步已关闭，请在设置 → 云同步中开启".into());
    }
    if !p.flashcards {
        return Err("本设备闪卡同步已关闭，请在设置 → 云同步中开启闪卡".into());
    }
    if auto && !p.auto_sync {
        return Err("本设备自动同步已关闭".into());
    }
    Ok(())
}

fn save(c: &mut Connection, settings: &Policy) -> Result<(), String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    for (key, value) in [
        ("cloud_sync_enabled", settings.enabled),
        ("cloud_sync_auto", settings.auto_sync),
        ("cloud_sync_flashcards", settings.flashcards),
        ("cloud_sync_reading", settings.reading),
        // Retain the old preference for downgrade compatibility, never read it after migration.
        ("flashcard_sync_auto", settings.auto_sync),
    ] {
        tx.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, if value { "1" } else { "0" }]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub(super) fn get_cloud_sync_policy(app: AppHandle) -> Result<Policy, String> {
    let (c, _writer) = open_write_database(&database_path(&app)?)?;
    initialize(&c)?;
    Ok(policy(&c))
}

#[tauri::command]
pub(super) async fn update_cloud_sync_policy(
    app: AppHandle,
    settings: Policy,
) -> Result<Policy, String> {
    // A successful pause means an active transfer has finished, and no queued transfer can start.
    let _guard = FLASHCARD_SYNC_LOCK.lock().await;
    let _reading_guard = reading_sync::LOCK.lock().await;
    let _quick_guard = quick_journal::LOCK.lock().await;
    let (mut c, _writer) = open_write_database(&database_path(&app)?)?;
    save(&mut c, &settings)?;
    Ok(policy(&c))
}

pub(crate) fn require_reading(c: &Connection, automatic: bool) -> Result<(), String> {
    let p = policy(c);
    if !p.enabled || !p.reading || (automatic && !p.auto_sync) {
        return Err("本设备阅读云同步已暂停，请在设置 → 云同步中开启".into());
    }
    reading_sync::object_store::configuration(c)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);")
            .unwrap();
        c
    }
    fn put(c: &Connection, key: &str, value: &str) {
        c.execute(
            "INSERT OR REPLACE INTO metadata VALUES(?1,?2)",
            params![key, value],
        )
        .unwrap();
    }
    #[test]
    fn migrates_legacy_preferences_once_without_changing_provider_or_identity() {
        let c = database();
        put(
            &c,
            "flashcard_webdav_url",
            "https://dav.example.test/HubFlashcards/",
        );
        put(&c, "flashcard_sync_auto", "1");
        put(&c, "flashcard_sync_device_id", "original-device");
        initialize(&c).unwrap();
        assert!(!automatic(&c));
        assert!(
            policy(&c).auto_sync,
            "keep the saved preference without enabling a retired service"
        );
        put(&c, "flashcard_sync_auto", "0");
        initialize(&c).unwrap();
        assert!(!automatic(&c));
        assert_eq!(
            metadata_string(&c, "flashcard_sync_device_id"),
            "original-device"
        );
        assert_eq!(
            metadata_string(&c, "flashcard_webdav_url"),
            "https://dav.example.test/HubFlashcards/"
        );
    }
    #[test]
    fn new_device_stays_disabled_after_configuring_provider() {
        let c = database();
        initialize(&c).unwrap();
        put(
            &c,
            "flashcard_webdav_url",
            "https://dav.example.test/cards/",
        );
        initialize(&c).unwrap();
        assert!(!policy(&c).enabled);
        assert!(require_flashcards(&c, false).is_err());
    }
    #[test]
    fn master_module_and_auto_gates_are_independent_and_preserve_pending_work() {
        let mut c = database();
        put(&c, "flashcard_sync_dirty", "1");
        for enabled in [false, true] {
            for flashcards in [false, true] {
                for auto_sync in [false, true] {
                    let p = Policy {
                        enabled,
                        flashcards,
                        auto_sync,
                        reading: false,
                    };
                    save(&mut c, &p).unwrap();
                    assert_eq!(policy(&c), p);
                    assert_eq!(require_flashcards(&c, false).is_ok(), enabled && flashcards);
                    assert_eq!(
                        require_flashcards(&c, true).is_ok(),
                        enabled && flashcards && auto_sync
                    );
                    assert_eq!(automatic(&c), enabled && flashcards && auto_sync);
                    assert_eq!(metadata_string(&c, "flashcard_sync_dirty"), "1");
                }
            }
        }
    }

    #[test]
    fn policy_save_rolls_back_all_switches_on_failure() {
        let mut c = database();
        let old = Policy {
            enabled: true,
            auto_sync: true,
            flashcards: true,
            reading: false,
        };
        save(&mut c, &old).unwrap();
        c.execute_batch("CREATE TRIGGER reject_policy BEFORE UPDATE ON metadata WHEN NEW.key='cloud_sync_flashcards' BEGIN SELECT RAISE(ABORT,'disk write failure'); END;").unwrap();
        assert!(save(
            &mut c,
            &Policy {
                enabled: false,
                auto_sync: false,
                flashcards: false,
                reading: false,
            }
        )
        .is_err());
        assert_eq!(policy(&c), old);
    }

    #[test]
    fn oss_migration_preserves_manual_only_and_rejects_unsupported_switches() {
        let c = database();
        put(&c, "flashcard_cloud_provider", "oss");
        put(
            &c,
            "flashcard_oss_config",
            r#"{"bucket":"hub-test","region":"cn-hangzhou","prefix":"HubFlashcards","accessKeyId":"test"}"#,
        );
        initialize(&c).unwrap();
        assert_eq!(
            policy(&c),
            Policy {
                enabled: true,
                auto_sync: false,
                flashcards: true,
                reading: false,
            }
        );
        assert!(require_flashcards(&c, false).is_ok());
        assert!(require_flashcards(&c, true).is_err());
        assert!(serde_json::from_value::<Policy>(
            json!({"enabled":true,"autoSync":false,"flashcards":true,"tasks":true})
        )
        .is_err());
    }

    #[test]
    fn reading_is_opt_in_and_has_independent_module_and_auto_gates() {
        let mut c = database();
        let legacy: Policy =
            serde_json::from_value(json!({"enabled":true,"autoSync":false,"flashcards":true}))
                .unwrap();
        assert!(!legacy.reading);
        let requested = Policy {
            reading: true,
            ..legacy
        };
        save(&mut c, &requested).unwrap();
        put(&c, "flashcard_cloud_provider", "oss");
        put(
            &c,
            "flashcard_oss_config",
            r#"{"bucket":"hub-test","region":"cn-hangzhou","prefix":"HubFlashcards","accessKeyId":"test"}"#,
        );
        for enabled in [false, true] {
            for auto_sync in [false, true] {
                for reading in [false, true] {
                    save(
                        &mut c,
                        &Policy {
                            enabled,
                            auto_sync,
                            reading,
                            flashcards: false,
                        },
                    )
                    .unwrap();
                    assert_eq!(require_reading(&c, false).is_ok(), enabled && reading);
                    assert_eq!(
                        require_reading(&c, true).is_ok(),
                        enabled && reading && auto_sync
                    );
                    assert!(require_flashcards(&c, false).is_err());
                }
            }
        }
    }

    #[test]
    fn legacy_connection_never_enables_reading_and_preserves_preferences() {
        let mut c = database();
        let requested = Policy {
            enabled: true,
            auto_sync: false,
            flashcards: false,
            reading: true,
        };
        put(&c, "flashcard_cloud_provider", "webdav");
        save(&mut c, &requested).unwrap();
        put(
            &c,
            "flashcard_webdav_url",
            "https://dav.example.invalid/Hub/",
        );
        put(&c, "flashcard_webdav_username", "isolated");
        save(&mut c, &requested).unwrap();
        assert!(require_reading(&c, false).is_err());
        assert!(require_reading(&c, true).is_err());
        assert!(flashcard_cloud_sync::legacy_retired(&c));
        assert_eq!(metadata_string(&c, "flashcard_webdav_username"), "isolated");
        assert_eq!(policy(&c), requested);
        put(&c, "flashcard_webdav_url", "");
        assert!(require_reading(&c, false).is_err());
    }
}
