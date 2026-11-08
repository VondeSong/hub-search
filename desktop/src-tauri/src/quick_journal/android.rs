use super::*;
use jni::{
    objects::{JClass, JString},
    sys::jboolean,
    JNIEnv,
};

// WorkManager can load this library without creating a WebView or Tauri AppHandle.
// Credentials stay in the existing encrypted store; the job persists only the data-root path.
#[no_mangle]
pub extern "system" fn Java_com_craftsearch_desktop_QuickJournalWorker_syncNative(
    mut env: JNIEnv,
    _class: JClass,
    path: JString,
) -> jboolean {
    let outcome =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
            let root = PathBuf::from(
                env.get_string(&path)
                    .map_err(|_| "速记路径读取失败")?
                    .to_str()
                    .map_err(|_| "速记路径编码错误")?,
            );
            let db = root.join("craft-search.sqlite3");
            if !db.is_file() {
                return Err("速记数据库不可用".into());
            }
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            runtime.block_on(async {
                let _lock = LOCK.lock().await;
                let configuration = {
                    let c = open_database(&db)?;
                    schema(&c)?;
                    let Some(configuration) = sync_configuration(&c, true, true)? else {
                        return Ok(());
                    };
                    configuration
                };
                let namespace = configuration.namespace();
                let secret = mobile_secrets::get(
                    &root.join("mobile-secrets-v1"),
                    "hub-flashcard-oss-secret-v1",
                )?
                .unwrap_or_default();
                let store = guarded_store(&db, configuration, secret, true)?;
                let result = tokio::time::timeout(
                    Duration::from_secs(8 * 60),
                    transfer(&db, &store, &namespace),
                )
                .await
                .unwrap_or_else(|_| Err("本轮后台同步已暂停，将继续重试剩余记录".into()));
                let (c, _guard) = open_write_database(&db)?;
                meta(
                    &c,
                    "quick_journal_error",
                    result.as_ref().err().map(String::as_str).unwrap_or(""),
                )?;
                result
            })
        }));
    u8::from(matches!(outcome, Ok(Ok(()))))
}
