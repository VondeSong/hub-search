//! Thin controlled entry to the existing archive planner and executor.
use super::*;
use std::sync::atomic::AtomicUsize;
pub(super) struct Preparation {
    pub(super) goal: String,
    guard: crate::model_runtime::Control,
    root: PathBuf,
    key: String,
    revision: String,
    calls: AtomicUsize,
    bytes: AtomicUsize,
}
tokio::task_local! { pub(super) static AGENT_PREPARATION: Preparation; }
pub(super) fn planning_detail(app: &AppHandle, key: &str, detail: &str) -> Result<(), String> {
    if let Ok(result) = AGENT_PREPARATION.try_with(|p| p.guard.check()) {
        return result;
    }
    job_detail(app, key, detail)
}
pub(super) fn check_model_request(
    prompt: &str,
    schema: &Value,
    images: &[PathBuf],
) -> Result<(), String> {
    AGENT_PREPARATION
        .try_with(|p| {
            p.guard.check()?;
            let c = crate::source_evidence::open_read_database(&p.root)?;
            if agent_source_revision(&c, &p.key)? != p.revision {
                return Err("归档原文已改变，未把旧材料再次发送给模型".into());
            }
            let bytes = prompt.len() + schema.to_string().len() + 4096;
            if bytes > 65536 {
                return Err(format!(
                    "本次归档单次材料为 {bytes} 字节，超过 65536 字节预算，请缩小原材料或目标范围"
                ));
            }
            if p.bytes.fetch_add(bytes, Ordering::SeqCst) + bytes > 131072 {
                return Err("本次归档累计材料超过 131072 字节预算，请缩小原材料或目标范围".into());
            }
            if p.calls.fetch_add(1, Ordering::SeqCst) >= 2 {
                return Err("本次归档已达到 2 次模型调用预算，未发起额外调用".into());
            }
            let image_bytes = images.iter().try_fold(0u64, |total, path| {
                let size = fs::metadata(path).map_err(|_| "归档图像已不可读取")?.len();
                if size > 8 * 1024 * 1024 {
                    return Err("单张归档图像超过 8 MiB");
                }
                Ok(total + size)
            })?;
            if images.len() > 6 || image_bytes > 24 * 1024 * 1024 {
                return Err("本次归档图像超过准备预算".into());
            }
            Ok(())
        })
        .unwrap_or(Ok(()))
}
pub(crate) fn agent_connection_fingerprint(
    app: &AppHandle,
    target: &str,
) -> Result<String, String> {
    let c = open_database(&database_path(app)?)?;
    let provider: String = c
        .query_row(
            "SELECT provider FROM libraries WHERE id=?1 AND enabled=1",
            [target],
            |r| r.get(0),
        )
        .map_err(|_| "目标资料库不可用")?;
    if provider == "dida365" {
        let state = app.state::<AppState>();
        let session = state
            .sessions
            .lock()
            .map_err(|_| "连接状态不可用")?
            .get(target)
            .cloned()
            .ok_or("请先连接滴答资料库，再准备归档")?;
        let credential = load_credential(target)?;
        // Bind both active and saved authentication; a refresh safely expires this draft.
        return Ok(storage::hash(
            json!([target, session.endpoint, session.access_token, credential])
                .to_string()
                .as_bytes(),
        ));
    }
    if provider != "craft" {
        return Err("此资料库不支持受控归档".into());
    }
    let (url, key) = craft_api_connection(app, target)?;
    // Opaque binding only. Credentials never enter a model, UI or action payload.
    Ok(storage::hash(
        format!("{}\0{}", url.as_str(), key).as_bytes(),
    ))
}
pub(super) fn freeze_plan_assets(root: &Path, plan: &mut Value) -> Result<(), String> {
    let root = fs::canonicalize(root).map_err(|_| "归档材料根目录不可用")?;
    for asset in plan["attachments"]
        .as_array_mut()
        .ok_or("归档附件清单缺失")?
    {
        let path = fs::canonicalize(asset["path"].as_str().ok_or("归档附件路径缺失")?)
            .map_err(|_| "归档附件已不可读取")?;
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| "受控归档仅使用当前资料根内已保存的附件")?;
        if relative
            .components()
            .next()
            .and_then(|p| p.as_os_str().to_str())
            != Some("collection-files")
        {
            return Err("受控归档附件不属于阅读材料保存目录".into());
        }
        let relative = relative.to_string_lossy().replace('\\', "/");
        super::super::owned_path(&root, &relative)?;
        asset["path"] = json!(relative);
    }
    Ok(())
}
pub(super) fn resolve_asset_path(root: &Path, path: &str) -> Result<String, String> {
    if !path.starts_with("collection-files/") {
        return Err("归档附件路径缺少正式阅读目录身份，请重新准备".into());
    }
    let root = fs::canonicalize(root).map_err(|_| "归档材料根目录不可用")?;
    Ok(super::super::owned_path(&root, path)?
        .to_string_lossy()
        .into_owned())
}
pub(crate) fn agent_source_revision(c: &Connection, key: &str) -> Result<String, String> {
    exists(c, key)?;
    Ok(item(c, key)?.1)
}
pub(crate) fn agent_eligible_on(c: &Connection, key: &str, target: &str) -> Result<(), String> {
    exists(c, key)?;
    let target_ok: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND enabled=1 AND provider IN ('craft','dida365'))",
            [target],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !target_ok {
        return Err("请选择启用的 Craft 或滴答资料库".into());
    }
    let conflict:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM collection_library_jobs WHERE item_key=?1) OR EXISTS(SELECT 1 FROM collection_remote_copies WHERE item_key=?1 AND library_id=?2)",params![key,target],|r|r.get(0)).map_err(|e|e.to_string())?;
    if conflict {
        return Err(
            "该材料已有处理记录或目标副本，请先在现有保存流程中核对，未创建另一条写入路径".into(),
        );
    }
    Ok(())
}
pub(crate) async fn prepare_agent_plan(
    app: &AppHandle,
    key: &str,
    target: &str,
    goal: String,
    revision: String,
    operation: Arc<crate::model_runtime::Operation>,
    guard: crate::model_runtime::Control,
) -> Result<Value, String> {
    let _permit = queue::acquire_target(app, key, target, &guard).await?;
    let c = open_database(&database_path(app)?)?;
    agent_eligible_on(&c, key, target)?;
    let provider: String = c
        .query_row(
            "SELECT provider FROM libraries WHERE id=?1",
            [target],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let goal = if provider == "dida365" {
        format!("{goal}\n本入口只保存一条 reference 资料笔记，保留原文，不生成行动任务。")
    } else {
        goal
    };
    drop(c);
    let context = Preparation {
        goal,
        guard: guard.clone(),
        root: active_data_root(app)?,
        key: key.into(),
        revision,
        calls: AtomicUsize::new(0),
        bytes: AtomicUsize::new(0),
    };
    control::agent_scope(
        guard,
        control::scope(
            app,
            target,
            AGENT_PREPARATION.scope(
                context,
                Box::pin(build_plan(app, key, target, &provider, operation)),
            ),
        ),
    )
    .await
    .and_then(|plan| {
        if provider == "dida365"
            && (!direct_reference_save(&plan) || plan["referenceBodyFormat"] != "source-v1")
        {
            return Err("本入口仅支持一条保留原文的滴答参考笔记，请调整方案后重试".into());
        }
        Ok(plan)
    })
}

/// Opt-in QA uses the formal planner and the same target/source/cancellation
/// guards, but never queues an execution or calls run_plan. Absent in releases.
#[cfg(feature = "integration-agent-acceptance")]
pub(crate) async fn model_acceptance_plan(
    app: &AppHandle,
    key: &str,
    target: &str,
    provider: &str,
) -> Result<Value, String> {
    let root = active_data_root(app)?;
    let guard = crate::model_runtime::Control::bounded(std::time::Duration::from_secs(240));
    let _permit = queue::acquire_target(app, key, target, &guard).await?;
    let c = open_database(&database_path(app)?)?;
    exists(&c, key)?;
    let actual: String = c
        .query_row(
            "SELECT provider FROM libraries WHERE id=?1 AND enabled=1",
            [target],
            |r| r.get(0),
        )
        .map_err(|_| "验收目标不可用")?;
    if actual != provider || !matches!(provider, "craft" | "dida365") {
        return Err("验收目标提供方不匹配".into());
    }
    let revision = agent_source_revision(&c, key)?;
    drop(c);
    let op_root = root.clone();
    let op_control = guard.clone();
    let workflow = if provider == "craft" {
        "collection-craft-archive"
    } else {
        "collection-dida-conversion"
    };
    let operation = Arc::new(
        tokio::task::spawn_blocking(move || {
            crate::model_runtime::Operation::start_control(
                &op_root,
                workflow,
                "验收只读方案生成",
                op_control,
            )
        })
        .await
        .map_err(|_| "验收准入中断")??,
    );
    let context = Preparation {
        goal: "仅准备可审核方案；本次验收不执行远端写入，不创建任务或笔记。".into(),
        guard: guard.clone(),
        root,
        key: key.into(),
        revision,
        calls: AtomicUsize::new(0),
        bytes: AtomicUsize::new(0),
    };
    let result = control::agent_scope(
        guard,
        control::scope(
            app,
            target,
            AGENT_PREPARATION.scope(
                context,
                Box::pin(build_plan(app, key, target, provider, operation.clone())),
            ),
        ),
    )
    .await;
    operation.finish(&result);
    result
}
pub(crate) fn agent_claim_on(
    c: &Connection,
    key: &str,
    target: &str,
    plan: &Value,
) -> Result<(), String> {
    if c.is_autocommit() {
        return Err("归档确认必须与事项回执处于同一事务".into());
    }
    let action = plan["agentActionId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("缺少归档动作身份")?;
    let provider: String = c
        .query_row(
            "SELECT provider FROM libraries WHERE id=?1 AND enabled=1",
            [target],
            |r| r.get(0),
        )
        .map_err(|_| "目标资料库已不可用")?;
    if !matches!(provider.as_str(), "craft" | "dida365")
        || plan["provider"] != provider
        || (provider == "dida365"
            && (!direct_reference_save(plan) || plan["referenceBodyFormat"] != "source-v1"))
        || plan["libraryId"] != target
        || plan["itemId"] != key
        || plan["revision"] != agent_source_revision(c, key)?
        || plan["status"] != "planned"
    {
        return Err("归档方案与当前材料或目标不一致".into());
    }
    let old: Option<(String, String)> = c
        .query_row(
            "SELECT plan,phase FROM collection_library_jobs WHERE item_key=?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((old, phase)) = old {
        if phase == "cancelled" {
            return Err("原保存请求已经取消，不能继续旧动作".into());
        }
        let old: Value = serde_json::from_str(&old).map_err(|_| "旧保存方案损坏")?;
        if old["agentActionId"] != action || old != *plan {
            return Err("原保存请求已改变，未覆盖另一项业务操作".into());
        }
        return Ok(());
    }
    agent_eligible_on(c, key, target)?;
    c.execute("INSERT INTO collection_library_destinations(item_key,target,state,selected) VALUES(?1,?2,'queued',1) ON CONFLICT(item_key,target) DO UPDATE SET state='queued',selected=1",params![key,target]).map_err(|e|e.to_string())?;
    c.execute("INSERT INTO collection_library_jobs(item_key,action,target,phase,plan,updated_at) VALUES(?1,'move',?2,'needs_review',?3,?4)",params![key,target,plan.to_string(),now_timestamp()]).map_err(|e|e.to_string())?;
    Ok(())
}
pub(crate) fn agent_checkpoint_on(
    c: &Connection,
    key: &str,
    target: &str,
    plan: &Value,
) -> Result<(), String> {
    let raw:Option<String>=c.query_row("SELECT plan FROM collection_library_jobs WHERE item_key=?1 AND target=?2 AND action='move' AND phase<>'cancelled'",params![key,target],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if raw
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .as_ref()
        != Some(plan)
    {
        return Err("归档请求已取消或被替换，停止后续外部操作".into());
    }
    Ok(())
}
pub(crate) async fn execute_agent_plan(
    app: &AppHandle,
    key: &str,
    plan: &Value,
    guard: crate::model_runtime::Control,
) -> Result<(), String> {
    let target = plan["libraryId"].as_str().ok_or("归档目标缺失")?;
    let _permit = queue::acquire_target(app, key, target, &guard).await?;
    let c = open_database(&database_path(app)?)?;
    let stored:String=c.query_row("SELECT plan FROM collection_library_jobs WHERE item_key=?1 AND target=?2 AND action='move'",params![key,target],|r|r.get(0)).map_err(|_|"保存请求已改变")?;
    if serde_json::from_str::<Value>(&stored).ok().as_ref() != Some(plan) {
        return Err("归档方案已替换，未执行旧动作".into());
    }
    drop(c);
    guard.check()?;
    begin_copy_dispatch(app, key, target)?;
    let result = control::agent_scope(guard, Box::pin(run_plan(app, key, plan))).await;
    let released = finish_copy_dispatch(app, key, target);
    result.and(released)
}
pub(crate) fn agent_receipt_on(
    c: &Connection,
    key: &str,
    target: &str,
    plan: &Value,
) -> Result<Value, String> {
    let operation = plan["operationId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("归档操作身份缺失")?;
    let mut q=c.prepare("SELECT object_id,parent_id,verified FROM collection_remote_copies WHERE item_key=?1 AND library_id=?2 AND source_operation_id=?3 ORDER BY object_id").map_err(|e|e.to_string())?;
    let copies=q.query_map(params![key,target,operation],|r|Ok(json!({"objectId":r.get::<_,String>(0)?,"parentId":r.get::<_,String>(1)?,"verified":r.get::<_,bool>(2)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let job: Option<(String, String, String, Value)> = c
        .query_row(
            "SELECT phase,error,CASE WHEN json_valid(plan) THEN COALESCE(json_extract(plan,'$.operationId'),'') ELSE '' END,CASE WHEN json_valid(plan) THEN json_extract(plan,'$.agentActionId') END FROM collection_library_jobs WHERE item_key=?1 AND target=?2",
            params![key, target],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_,Option<String>>(3)?.map_or(Value::Null,Value::String))),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let owned = job
        .as_ref()
        .is_some_and(|j| j.2 == operation && j.3 == plan["agentActionId"]);
    let main: Vec<_> = copies
        .iter()
        .filter(|p| p["parentId"] != "attachment")
        .collect();
    let saved:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM collection_library_destinations WHERE item_key=?1 AND target=?2 AND state='saved')",params![key,target],|r|r.get(0)).map_err(|e|e.to_string())?;
    let state =
        if job.is_none() && saved && !main.is_empty() && main.iter().all(|p| p["verified"] == true)
        {
            "verified"
        } else if owned && job.as_ref().is_some_and(|j| j.0 == "needs_review") && main.is_empty() {
            "interrupted"
        } else if owned && !main.is_empty() {
            "partial"
        } else {
            "unknown"
        };
    Ok(agent_receipt_verification(
        json!({"state":state,"operationId":operation,"targetLibraryId":target,"copies":copies,
        "phase":if owned {job.as_ref().map(|j|j.0.as_str())} else {None},
        "error":if owned {job.as_ref().map(|j|j.1.as_str())} else {None},"remoteFreshness":"last domain readback; not rechecked now","goalCompleted":false}),
    ))
}

/// A legacy attachment flag of zero means that no individual verification was
/// recorded. It is not evidence of a failed readback. Preserve the stored receipt
/// and normalize only its read projection, including historical Agent receipts.
pub(crate) fn agent_receipt_verification(mut receipt: Value) -> Value {
    if !receipt.is_object() {
        return json!({"available":false});
    }
    receipt["verificationScope"] = json!({
        "document":"body text coverage in the last domain readback",
        "attachments":"recorded attachment block ID presence when requested",
        "remoteAttachmentBytes":"not compared",
        "legacyAttachmentFlag":"null means not recorded individually, not a failed readback"
    });
    if let Some(copies) = receipt["copies"].as_array_mut() {
        for copy in copies {
            if copy["parentId"] == "attachment" {
                if copy["verified"] == true {
                    copy["verification"] = json!("targetBlockIdObserved");
                } else {
                    copy["verified"] = Value::Null;
                    copy["verification"] = json!("notRecordedIndividually");
                }
            }
        }
    }
    receipt
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_attachment_flags_are_unknown_individually_and_never_byte_proof() {
        let stored = json!({"state":"verified","goalCompleted":false,"copies":[
            {"objectId":"old","parentId":"attachment","verified":false},
            {"objectId":"new","parentId":"attachment","verified":true},
            {"objectId":"page","parentId":"document","verified":true}
        ]});
        let projected = agent_receipt_verification(stored.clone());
        assert_eq!(stored["copies"][0]["verified"], false);
        assert!(projected["copies"][0]["verified"].is_null());
        assert_eq!(
            projected["copies"][0]["verification"],
            "notRecordedIndividually"
        );
        assert_eq!(
            projected["copies"][1]["verification"],
            "targetBlockIdObserved"
        );
        assert_eq!(
            projected["verificationScope"]["remoteAttachmentBytes"],
            "not compared"
        );
        assert_eq!(projected["goalCompleted"], false);
        assert_eq!(agent_receipt_verification(projected.clone()), projected);
        assert_eq!(agent_receipt_verification(Value::Null)["available"], false);
    }
    #[test]
    fn controlled_assets_use_portable_owned_paths_and_restore_to_the_new_root() {
        let original = crate::source_evidence::tests::Fixture::new();
        let restored = crate::source_evidence::tests::Fixture::new();
        for root in [&original.root, &restored.root] {
            fs::create_dir_all(root.join("collection-files/images")).unwrap();
            fs::write(
                root.join("collection-files/images/证据.png"),
                b"fixture-image",
            )
            .unwrap();
        }
        let mut plan = json!({"attachments":[{"path":original.root.join("collection-files/images/证据.png").to_string_lossy()}]});
        freeze_plan_assets(&original.root, &mut plan).unwrap();
        assert_eq!(
            plan["attachments"][0]["path"],
            "collection-files/images/证据.png"
        );
        let resolved = resolve_asset_path(
            &restored.root,
            plan["attachments"][0]["path"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(fs::read(&resolved).unwrap(), b"fixture-image");
        assert!(Path::new(&resolved).starts_with(fs::canonicalize(&restored.root).unwrap()));
        for bad in [
            "../outside",
            "collection-files/../../outside",
            "C:/outside.png",
        ] {
            assert!(resolve_asset_path(&restored.root, bad).is_err());
        }
        let mut outside = json!({"attachments":[{"path":restored.root.join("collection-files/images/证据.png").to_string_lossy()}]});
        assert!(freeze_plan_assets(&original.root, &mut outside).is_err());
    }
    #[tokio::test]
    async fn controlled_planning_limits_model_requests_and_rechecks_source_before_each_request() {
        let f = crate::source_evidence::tests::Fixture::new();
        let post = crate::collection_models::Post {
            id: "budget".into(),
            text: "Measure first.".into(),
            source: "telegram".into(),
            ..Default::default()
        };
        f.c().execute("INSERT INTO collection_x_items(item_key,account,post_json,content_hash,collected_at,captured_at) VALUES('budget','fixture',?1,'v1',1,1)",[serde_json::to_string(&post).unwrap()]).unwrap();
        let context = Preparation {
            goal: "archive".into(),
            guard: crate::model_runtime::Control::default(),
            root: f.root.clone(),
            key: "budget".into(),
            revision: "v1".into(),
            calls: AtomicUsize::new(0),
            bytes: AtomicUsize::new(0),
        };
        AGENT_PREPARATION
            .scope(context, async {
                check_model_request("small", &json!({}), &[]).unwrap();
                check_model_request("small", &json!({}), &[]).unwrap();
                assert!(check_model_request("third", &json!({}), &[]).is_err());
                f.c()
                    .execute(
                        "UPDATE collection_x_items SET content_hash='v2' WHERE item_key='budget'",
                        [],
                    )
                    .unwrap();
                assert!(check_model_request("changed", &json!({}), &[])
                    .unwrap_err()
                    .contains("原文已改变"));
            })
            .await;
        // Normal existing planners have no new Agent-only request limit.
        assert!(check_model_request(&"x".repeat(65537), &json!({}), &[]).is_ok());
    }
}
