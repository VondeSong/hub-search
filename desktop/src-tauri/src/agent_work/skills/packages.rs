//! Ordinary-folder registration uses the existing immutable method owner.
use super::*;
mod inspection;
mod maintenance;

pub(in crate::agent_work) fn migrate(c: &Connection) -> Result<(), rusqlite::Error> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS agent_skill_source_revisions (
        package_id TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,directory TEXT NOT NULL,
        mode TEXT NOT NULL,method_version TEXT NOT NULL REFERENCES agent_method_versions(id),
        source_fingerprint TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,created_at INTEGER NOT NULL,
        PRIMARY KEY(package_id,revision));")?;
    c.prepare("SELECT package_id,revision,name,directory,mode,method_version,source_fingerprint,client_id,request_hash,created_at FROM agent_skill_source_revisions LIMIT 0")?;
    let pk:String=c.query_row("SELECT COALESCE(group_concat(name,','),'') FROM (SELECT name FROM pragma_table_info('agent_skill_source_revisions') WHERE pk>0 ORDER BY pk)",[],|r|r.get(0))?;
    let unique:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM pragma_index_list('agent_skill_source_revisions') i WHERE i.[unique]=1 AND (SELECT group_concat(name,',') FROM pragma_index_info(i.name))='client_id')",[],|r|r.get(0))?;
    if pk != "package_id,revision" || !unique {
        return Err(rusqlite::Error::InvalidQuery);
    }
    maintenance::migrate(c)
}

fn sources(c: &Connection) -> Result<Vec<Value>, String> {
    let mut q=c.prepare("SELECT package_id,revision,name,directory,mode,method_version,source_fingerprint,created_at FROM agent_skill_source_revisions r WHERE mode!='deleted' AND NOT EXISTS(SELECT 1 FROM agent_skill_source_revisions n WHERE n.package_id=r.package_id AND n.revision>r.revision) ORDER BY package_id LIMIT 33").map_err(|e|e.to_string())?;
    let values=q.query_map([],|r|Ok(json!({"packageId":r.get::<_,String>(0)?,"revision":r.get::<_,i64>(1)?,"name":r.get::<_,String>(2)?,"directory":r.get::<_,String>(3)?,"mode":r.get::<_,String>(4)?,"methodVersion":r.get::<_,String>(5)?,"sourceFingerprint":r.get::<_,String>(6)?,"createdAt":r.get::<_,i64>(7)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    if values.len() > 32 {
        return Err("登记的技能包超过32个，未截断为完整清单".into());
    }
    Ok(values)
}
fn source(c: &Connection, id: &str) -> Result<Value, String> {
    sources(c)?
        .into_iter()
        .find(|v| v["packageId"] == id)
        .ok_or_else(|| "技能包来源登记不存在".into())
}
fn expected(args: &Value, current: &Value) -> Result<(), String> {
    if args["expectedRevision"].as_u64().is_none()
        || args["expectedRevision"] != current["revision"]
    {
        return Err("技能包登记已变化，原版本保留；请刷新后比较".into());
    }
    Ok(())
}
fn client(args: &Value) -> Result<(String, String), String> {
    let key = text(args, "clientRequestId", 80)?;
    if !key
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("技能保存请求身份无效".into());
    }
    Ok((key, hash(&args.to_string())))
}
fn duplicate(c: &Connection, key: &str, fingerprint: &str) -> Result<Option<String>, String> {
    let old: Option<(String, String)> = c
        .query_row(
            "SELECT package_id,request_hash FROM agent_skill_source_revisions WHERE client_id=?1 UNION ALL SELECT package_id,request_hash FROM agent_skill_package_operations WHERE id=?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match old {
        Some((id, hash)) if hash == fingerprint => Ok(Some(id)),
        Some(_) => Err("同一保存请求不能替换为另一份包内容".into()),
        None => Ok(None),
    }
}

pub(super) fn validate(value: &Value) -> Result<Skill, String> {
    let content = &value["content"];
    if value.to_string().len() > 65_536
        || value.as_object().is_none_or(|v| v.len() != 2)
        || content.as_object().is_none_or(|v| v.len() != 7)
        || content["schemaVersion"] != 2
        || content["origin"] != "registered"
        || value["id"] != format!("method-{}", hash(&content.to_string()))
        || content["sourceFingerprint"] != hash(&content["files"].to_string())
    {
        return Err("登记方法完整内容或指纹不匹配".into());
    }
    let package = content["packageId"]
        .as_str()
        .filter(|s| s.starts_with("package-") && s.len() <= 100)
        .ok_or("方法来源身份无效")?;
    inspection::validate_files(&content["files"])?;
    let (mut skill, _) = inspection::assess(&content["files"])?;
    if content["name"] != skill.name {
        return Err("登记方法名称与正文不一致".into());
    }
    skill.package = Some((
        package.into(),
        value["id"].as_str().ok_or("方法版本缺失")?.into(),
    ));
    Ok(skill)
}

pub(super) fn install(catalog: &mut Catalog, root: &Path) -> Result<HashSet<String>, String> {
    let file = root.join("craft-search.sqlite3");
    if !file.is_file() {
        return Ok(HashSet::new());
    }
    let c = crate::source_evidence::open_read_database(root)?;
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_skill_source_revisions')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !exists {
        return Ok(HashSet::new());
    }
    let mut q = c
        .prepare("SELECT DISTINCT name FROM agent_skill_source_revisions WHERE mode='deleted'")
        .map_err(|e| e.to_string())?;
    let removed = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|e| e.to_string())?;
    for src in sources(&c)? {
        let value = super::super::topics::method_on(
            &c,
            src["methodVersion"].as_str().ok_or("登记方法身份缺失")?,
        )?;
        let mut skill = validate(&value)?;
        if !versions::compatible_contract(&value["content"]["toolContractVersion"]) {
            skill
                .unavailable
                .push("固定方法工具合同已变化，需兼容检查后再使用".into());
        }
        if value["content"]["packageId"] != src["packageId"]
            || value["content"]["name"] != src["name"]
            || catalog.skills.contains_key(&skill.name)
        {
            return Err("登记包名称冲突或身份不一致；未覆盖内置方法".into());
        }
        catalog.registered.insert(skill.name.clone(), value);
        catalog.skills.insert(skill.name.clone(), skill);
    }
    Ok(removed)
}

pub(super) fn restore(catalog: &Catalog, value: &Value) -> Result<Skill, String> {
    let skill = validate(value)?;
    let root = catalog.root.parent().ok_or("技能登记位置无效")?;
    let c = crate::source_evidence::open_read_database(root)?;
    let src = source(
        &c,
        value["content"]["packageId"]
            .as_str()
            .ok_or("方法来源身份无效")?,
    )?;
    if src["name"] != value["content"]["name"]
        || super::super::topics::method_on(&c, value["id"].as_str().ok_or("方法身份无效")?)?
            != *value
    {
        return Err("方法不属于已登记包的保存版本".into());
    }
    Ok(skill)
}

pub(super) fn resource_paths(value: &Value) -> Vec<String> {
    value["content"]["files"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(_, v)| v["readable"] == true)
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default()
}
pub(super) fn read_resource(value: &Value, path: &str) -> Result<String, String> {
    if !inspection::text_resource(path) || value["content"]["files"][path]["readable"] != true {
        return Err("只能读取固定包清单内可用的references或assets文字；不执行脚本".into());
    }
    inspection::file_text(&value["content"]["files"], path).map(str::to_string)
}
pub(super) fn instruction_identity(value: &Value) -> Result<(String, String), String> {
    let skill = validate(value)?;
    Ok((skill.version, skill.instructions))
}
fn report(src: Option<Value>, value: &Value) -> Result<Value, String> {
    let mut skill = validate(value)?;
    if !versions::compatible_contract(&value["content"]["toolContractVersion"]) {
        skill
            .unavailable
            .push("固定方法工具合同已改变，当前不可执行；原内容保留".into());
    }
    let (_, warnings) = inspection::assess(&value["content"]["files"])?;
    let files=value["content"]["files"].as_object().unwrap().iter().map(|(path,v)|json!({"path":path,"bytes":v["bytes"],"sha256":v["sha256"],"kind":v["kind"],"readable":v["readable"],"encoding":v["encoding"]})).collect::<Vec<_>>();
    Ok(
        json!({"source":src,"methodVersion":value["id"],"sourceFingerprint":value["content"]["sourceFingerprint"],"skill":skill.metadata(),"files":files,"warnings":warnings,"verifiedByRealRun":false,"policy":"已导入/可用不等于模型已采用或真实验收；脚本与不透明资源只保存、不执行，不增加资料权限。"}),
    )
}
fn detail(root: &Path, id: &str, version: Option<&str>) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let src = source(&c, id)?;
    let method = version.unwrap_or(src["methodVersion"].as_str().ok_or("当前方法身份缺失")?);
    let value = super::super::topics::method_on(&c, method)?;
    if value["content"]["packageId"] != id {
        return Err("该方法版本不属于当前技能包".into());
    }
    let mut report = report(Some(src), &value)?;
    let mut q=c.prepare("SELECT revision,method_version,source_fingerprint,created_at FROM agent_skill_source_revisions WHERE package_id=?1 ORDER BY revision DESC LIMIT 33").map_err(|e|e.to_string())?;
    report["history"]=json!(q.query_map([id],|r|Ok(json!({"revision":r.get::<_,i64>(0)?,"methodVersion":r.get::<_,String>(1)?,"sourceFingerprint":r.get::<_,String>(2)?,"createdAt":r.get::<_,i64>(3)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?);
    Ok(report)
}
fn version(capture: &inspection::Capture, id: &str) -> Result<Value, String> {
    let content = json!({"schemaVersion":2,"origin":"registered","packageId":id,"name":capture.skill.name,"toolContractVersion":versions::tool_contract_version(),"files":capture.files,"sourceFingerprint":capture.fingerprint});
    let value = json!({"id":format!("method-{}",hash(&content.to_string())),"content":content});
    validate(&value)?;
    Ok(value)
}

pub(in crate::agent_work) fn ui(root: &Path, args: &Value) -> Result<Value, String> {
    if args.to_string().len() > 16_384 {
        return Err("技能管理请求超限".into());
    }
    let action = args["action"].as_str().ok_or("技能管理操作缺失")?;
    if action == "skillPackages" {
        let c = crate::source_evidence::open_read_database(root)?;
        return Ok(
            json!({"sources":sources(&c)?,"limits":{"files":33,"rawBytes":49152,"versionBytes":65536,"packages":32,"revisions":32},"scriptExecution":false}),
        );
    }
    if action == "skillPackageDetails" {
        return detail(
            root,
            &text(args, "packageId", 100)?,
            args.get("methodVersion")
                .filter(|v| !v.is_null())
                .map(|_| text(args, "methodVersion", 100))
                .transpose()?
                .as_deref(),
        );
    }
    if action == "skillPackageFile" {
        let id = text(args, "packageId", 100)?;
        let method = text(args, "methodVersion", 100)?;
        let path = text(args, "path", 512)?;
        let report = detail(root, &id, Some(&method))?;
        let c = crate::source_evidence::open_read_database(root)?;
        let value = super::super::topics::method_on(&c, &method)?;
        let file = &value["content"]["files"][&path];
        if file.is_null() {
            return Err("包内文件不存在".into());
        }
        if file["encoding"] != "utf8"
            || !(file["readable"] == true || path == "SKILL.md" || path == "agents/openai.yaml")
        {
            return Err("当前只能预览方法说明、配置与已声明文字资源；不执行主动内容".into());
        }
        return Ok(
            json!({"packageId":id,"methodVersion":report["methodVersion"],"path":path,"content":inspection::file_text(&value["content"]["files"],&path)?,"sha256":file["sha256"],"previewOnly":true}),
        );
    }
    if action == "skillPackageRequest" {
        let key = text(args, "clientRequestId", 80)?;
        let c = crate::source_evidence::open_read_database(root)?;
        if let Some(operation) = maintenance::request(&c, &key)? {
            drop(c);
            return maintenance::reconcile(root, operation)
                .map(|v| json!({"found":true,"operation":v}));
        }
        let id: Option<String> = c
            .query_row(
                "SELECT package_id FROM agent_skill_source_revisions WHERE client_id=?1",
                [key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        return if let Some(id) = id {
            let removed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_skill_source_revisions WHERE package_id=?1 AND mode='deleted')",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
            if removed {
                return Ok(
                    json!({"found":true,"removedPackageId":id,"policy":"原保存已提交，随后被明确删除；不能重发保存来恢复已删除方法"}),
                );
            }
            Ok(json!({"found":true,"detail":detail(root,&id,None)?}))
        } else {
            Ok(
                json!({"found":false,"policy":"尚未发现提交记录；不能由此推定在途请求失败，只能核对或以相同请求身份重试"}),
            )
        };
    }
    if action == "skillPackageCheck" {
        let id = text(args, "packageId", 100)?;
        let c = crate::source_evidence::open_read_database(root)?;
        let src = source(&c, &id)?;
        expected(args, &src)?;
        let capture = inspection::capture(src["directory"].as_str().ok_or("来源目录缺失")?)?;
        let mut value = report(Some(src.clone()), &version(&capture, &id)?)?;
        value["sourceChanged"] =
            json!(capture.fingerprint != src["sourceFingerprint"].as_str().ok_or("来源指纹缺失")?);
        value["methodChanged"] = json!(value["methodVersion"] != src["methodVersion"]);
        value["changed"] = json!(value["sourceChanged"] == true || value["methodChanged"] == true);
        value["checkedAt"] = json!(store::stamp());
        let end = crate::source_evidence::open_read_database(root)?;
        if source(&end, &id)? != src {
            return Err("来源登记在检查期间变化，请刷新".into());
        }
        return Ok(value);
    }
    if action == "skillPackagePreview" {
        let capture = inspection::capture(&text(args, "directory", 4096)?)?;
        let mut value = report(None, &version(&capture, "package-preview")?)?;
        value["directory"] = json!(capture.directory);
        value["checkedAt"] = json!(store::stamp());
        let catalog = Catalog::discover(root)?;
        if let Some(old) = catalog.skills.get(&capture.skill.name) {
            if old.directory.as_ref().is_none_or(|d| {
                d.canonicalize().ok() != Path::new(&capture.directory).canonicalize().ok()
            }) {
                value["nameConflict"] = json!(
                    "同名技能已存在；不能导入覆盖，请从已登记来源更新或使用明确不同名称的自包含包"
                );
            }
        }
        return Ok(value);
    }
    match action {
        "skillPackageDeletePreview" => return maintenance::delete_preview(root, args),
        "skillPackageDelete" => return maintenance::delete(root, args),
        "skillPackageExport" => return maintenance::export(root, args),
        _ => (),
    }
    if ![
        "skillPackageImport",
        "skillPackageUpdate",
        "skillPackageSwitch",
    ]
    .contains(&action)
    {
        return Err("未知技能管理操作".into());
    }
    let (key, fingerprint) = client(args)?;
    let c = crate::source_evidence::open_read_database(root)?;
    if maintenance::request(&c, &key)?.is_some() {
        return Err("该请求身份已属于另一项方法包操作".into());
    }
    if let Some(id) = duplicate(&c, &key, &fingerprint)? {
        drop(c);
        return detail(root, &id, None);
    }
    let current = if action == "skillPackageImport" {
        None
    } else {
        let s = source(&c, &text(args, "packageId", 100)?)?;
        expected(args, &s)?;
        Some(s)
    };
    let id = current
        .as_ref()
        .and_then(|v| v["packageId"].as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("package-{}", crate::random_url_safe(18)));
    let capture = if action == "skillPackageSwitch" {
        None
    } else {
        let directory = if let Some(s) = &current {
            s["directory"].as_str().ok_or("登记来源缺失")?.to_string()
        } else {
            text(args, "directory", 4096)?
        };
        let capture = inspection::capture(&directory)?;
        if args["expectedFingerprint"] != capture.fingerprint {
            return Err("源包与预览指纹不一致，未发布，请重新检查".into());
        }
        Some(capture)
    };
    let value = if let Some(capture) = &capture {
        version(capture, &id)?
    } else {
        super::super::topics::method_on(&c, &text(args, "methodVersion", 100)?)?
    };
    let skill = validate(&value)?;
    if value["content"]["packageId"] != id
        || current.as_ref().is_some_and(|s| s["name"] != skill.name)
    {
        return Err("方法包来源或名称发生分歧，未替换当前版本".into());
    }
    if !versions::compatible_contract(&value["content"]["toolContractVersion"]) {
        return Err("方法工具合同已改变，不能发布为当前可用版本".into());
    }
    if current.is_none() {
        let catalog = Catalog::discover(root)?;
        if let Some(old) = catalog.skills.get(&skill.name) {
            if old.directory.as_ref().is_none_or(|d| {
                capture.as_ref().is_none_or(|s| {
                    d.canonicalize().ok() != Path::new(&s.directory).canonicalize().ok()
                })
            }) {
                return Err("同名技能已存在，未覆盖".into());
            }
        }
    }
    let mode = if let Some(s) = &current {
        s["mode"].as_str().ok_or("登记方式缺失")?.to_string()
    } else {
        text(args, "mode", 20)?
    };
    if !["copy", "source"].contains(&mode.as_str()) {
        return Err("请选择独立导入副本或登记主要来源".into());
    }
    let directory = capture
        .as_ref()
        .map(|s| s.directory.clone())
        .or_else(|| {
            current
                .as_ref()
                .and_then(|s| s["directory"].as_str().map(str::to_string))
        })
        .ok_or("方法来源目录缺失")?;
    drop(c);
    let saved = store::write(root, |c| {
        if let Some(id) = duplicate(c, &key, &fingerprint)? {
            return Ok(id);
        }
        let revision = if let Some(old) = &current {
            let now = source(c, &id)?;
            expected(args, &now)?;
            if &now != old {
                return Err("方法来源登记已在另一处改变，旧版保留".into());
            }
            now["revision"].as_u64().ok_or("方法修订无效")? + 1
        } else {
            let all = sources(c)?;
            if all.len() >= 32 || all.iter().any(|s| s["name"] == skill.name) {
                return Err("同名方法已登记或已达32包上限，未重复导入".into());
            }
            1
        };
        if revision > 32 {
            return Err("方法来源修订已达32版上限，旧版保留".into());
        }
        let raw = value.to_string();
        super::super::topics::admit(
            c,
            raw.len() + directory.len() + skill.name.len() + key.len() + fingerprint.len() + 512,
        )?;
        let old: Option<String> = c
            .query_row(
                "SELECT content_json FROM agent_method_versions WHERE id=?1",
                [value["id"].as_str().unwrap()],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(old) = old {
            if serde_json::from_str::<Value>(&old).map_err(|_| "旧方法损坏")? != value {
                return Err("方法内容身份冲突，旧版保留".into());
            }
        } else {
            c.execute(
                "INSERT INTO agent_method_versions VALUES(?1,?2,?3)",
                params![value["id"].as_str().unwrap(), raw, store::stamp()],
            )
            .map_err(|e| e.to_string())?;
        }
        c.execute(
            "INSERT INTO agent_skill_source_revisions VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                id,
                revision,
                skill.name,
                directory,
                mode,
                value["id"].as_str().unwrap(),
                value["content"]["sourceFingerprint"].as_str().unwrap(),
                key,
                fingerprint,
                store::stamp()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(id.clone())
    })?;
    detail(root, &saved, None)
}

#[cfg(test)]
mod tests;
