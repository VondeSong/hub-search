use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs::{File, OpenOptions},
    io::Read,
};

pub(super) const MAX_BYTES: usize = 128 * 1024;

pub(super) struct Capture {
    pub directory: String,
    pub fingerprint: String,
    pub files: Value,
    pub skill: Skill,
    pub warnings: Vec<String>,
    // Hold all observed directories/files against writes/replacement through publication.
    _locks: Vec<File>,
}

fn relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && !path.contains(['\\', ':', '%', '?', '#'])
        && Path::new(path).components().count() <= 4
        && Path::new(path).components().all(|c| match c {
            Component::Normal(s) => s.to_str().is_some_and(|s| {
                let stem = s.split('.').next().unwrap_or_default().to_ascii_uppercase();
                !s.ends_with([' ', '.'])
                    && !s.chars().any(char::is_control)
                    && ![
                        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
                        "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
                        "LPT7", "LPT8", "LPT9",
                    ]
                    .contains(&stem.as_str())
            }),
            _ => false,
        })
}

pub(super) fn text_resource(path: &str) -> bool {
    relative(path)
        && (path.starts_with("references/") || path.starts_with("assets/"))
        && ["md", "txt", "json", "yaml", "yml", "csv"].contains(
            &Path::new(path)
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or_default(),
        )
}

pub(super) fn locked(path: &Path, directory: bool) -> Result<File, String> {
    let before = std::fs::symlink_metadata(path).map_err(|_| "技能文件或目录不可读")?;
    if is_link(&before) || (directory && !before.is_dir()) || (!directory && !before.is_file()) {
        return Err("技能包只支持普通目录和文件，不支持链接、目录联接或特殊文件".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .share_mode(1)
            .custom_flags(if directory { 0x02200000 } else { 0x00200000 });
    }
    #[cfg(not(windows))]
    if directory {
        return Err("当前包导入仅验证Windows普通目录边界".into());
    }
    let file = options
        .open(path)
        .map_err(|_| "技能文件正被修改或无法锁定，请稍后重试")?;
    let metadata = file.metadata().map_err(|_| "技能文件身份不可读")?;
    if is_link(&metadata)
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err("技能包读取期间被替换或不是普通文件".into());
    }
    crate::obsidian_edit::identity(&file).map_err(|_| "方法包不支持硬链接或无法核对的文件身份")?;
    Ok(file)
}

fn walk(
    base: &Path,
    dir: &Path,
    depth: usize,
    files: &mut serde_json::Map<String, Value>,
    locks: &mut Vec<File>,
    total: &mut usize,
    dirs: &mut usize,
) -> Result<(), String> {
    if depth > 4 || *dirs >= 64 {
        return Err("技能包目录深度或目录数超限，未导入".into());
    }
    *dirs += 1;
    locks.push(locked(dir, true)?);
    let mut entries = std::fs::read_dir(dir)
        .map_err(|_| "无法列出技能包")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "技能包目录项不可读")?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        // Repository metadata belongs to the working copy, never to a method version.
        if depth == 0 && entry.file_name().eq_ignore_ascii_case(".git") {
            continue;
        }
        let path = entry.path();
        let rel = path
            .strip_prefix(base)
            .map_err(|_| "技能文件越界")?
            .to_str()
            .ok_or("技能路径需为有效Unicode")?
            .replace('\\', "/");
        if !relative(&rel) {
            return Err(format!("技能包路径不受支持：{rel}"));
        }
        let meta = std::fs::symlink_metadata(&path).map_err(|_| "技能资源不可读")?;
        if is_link(&meta) {
            return Err(format!("技能包不支持链接或目录联接：{rel}"));
        }
        if meta.is_dir() {
            walk(base, &path, depth + 1, files, locks, total, dirs)?;
            continue;
        }
        if !meta.is_file() || files.len() >= 33 || meta.len() > MAX_BYTES as u64 {
            return Err("技能包文件类型、数量或大小超限，未截断导入".into());
        }
        if files.keys().any(|p| p.to_lowercase() == rel.to_lowercase()) {
            return Err("技能包有大小写冲突路径，未覆盖".into());
        }
        let mut file = locked(&path, false)?;
        let mut bytes = Vec::new();
        file.by_ref()
            .take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "技能文件读取失败")?;
        *total = total.checked_add(bytes.len()).ok_or("技能包大小超限")?;
        if *total > MAX_BYTES {
            return Err("技能包原始字节超过128 KiB，原目录保留；未截断为可用包".into());
        }
        let kind = if rel == "SKILL.md" {
            "instructions"
        } else if rel == "agents/openai.yaml" {
            "policy"
        } else if rel.starts_with("scripts/") {
            "script"
        } else if rel.starts_with("references/") {
            "reference"
        } else if rel.starts_with("assets/") {
            "asset"
        } else {
            "opaque"
        };
        let text = std::str::from_utf8(&bytes).ok();
        let readable = text.is_some() && bytes.len() <= MAX_REFERENCE && text_resource(&rel);
        files.insert(rel,json!({"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"encoding":if text.is_some(){"utf8"}else{"base64"},"content":text.map(str::to_string).unwrap_or_else(||STANDARD.encode(&bytes)),"kind":kind,"readable":readable}));
        locks.push(file);
    }
    Ok(())
}

pub(super) fn decode(file: &Value) -> Result<Vec<u8>, String> {
    let text = file["content"].as_str().ok_or("固定资源内容缺失")?;
    let bytes = match file["encoding"].as_str() {
        Some("utf8") => text.as_bytes().to_vec(),
        Some("base64") => STANDARD.decode(text).map_err(|_| "固定资源编码无效")?,
        _ => return Err("固定资源编码不受支持".into()),
    };
    if bytes.len() > MAX_BYTES
        || file["bytes"] != json!(bytes.len())
        || file["sha256"] != format!("{:x}", Sha256::digest(&bytes))
    {
        return Err("固定资源字节与清单不一致".into());
    }
    Ok(bytes)
}

pub(super) fn file_text<'a>(files: &'a Value, path: &str) -> Result<&'a str, String> {
    let file = &files[path];
    let bytes = decode(file)?;
    let maximum = if path == "SKILL.md" {
        MAX_DOCUMENT
    } else if path == "agents/openai.yaml" {
        16_384
    } else {
        MAX_REFERENCE
    };
    if bytes.len() > maximum {
        return Err(format!("技能文字资源超过当前读取上限：{path}"));
    }
    if file["encoding"] != "utf8" {
        return Err(format!("技能文字不是UTF-8：{path}"));
    }
    file["content"]
        .as_str()
        .ok_or_else(|| "技能文字内容缺失".into())
}

pub(super) fn assess(files: &Value) -> Result<(Skill, Vec<String>), String> {
    let document = file_text(files, "SKILL.md")?;
    let policy = if files.get("agents/openai.yaml").is_some() {
        file_text(files, "agents/openai.yaml")?
    } else {
        ""
    };
    let mut skill = parse(document, policy, None)?;
    let mut warnings = Vec::new();
    let normalized = document
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n");
    let front: Value = serde_yaml::from_str(
        normalized
            .strip_prefix("---\n")
            .unwrap()
            .split_once("\n---\n")
            .unwrap()
            .0,
    )
    .map_err(|_| "方法元信息无效")?;
    if front
        .get("allowed-tools")
        .is_some_and(|value| !value.is_null())
    {
        warnings.push("保留 allowed-tools 声明；Hub 不采用技能声明的工具预授权。".into());
    }
    if let Some(condition) = front.get("compatibility").filter(|value| !value.is_null()) {
        match condition
            .as_str()
            .filter(|text| !text.trim().is_empty() && text.chars().count() <= 500)
        {
            Some(text) => skill
                .unavailable
                .push(format!("此技能声明了尚未验证的运行环境：{text}")),
            None => skill
                .unavailable
                .push("compatibility 需要不超过 500 字符的环境说明".into()),
        }
    }
    let configuration: Value = if policy.is_empty() {
        json!({})
    } else {
        serde_yaml::from_str(policy).map_err(|_| "方法配置无效")?
    };
    for key in configuration
        .as_object()
        .ok_or("技能配置应为对象")?
        .keys()
        .filter(|key| !["interface", "policy", "dependencies"].contains(&key.as_str()))
    {
        skill
            .unavailable
            .push(format!("未适配的配置扩展：{key}；不推定满足所需环境或权限"));
    }
    if let Some(hub) = front["metadata"].get("hub") {
        for key in hub
            .as_object()
            .ok_or("metadata.hub应为对象")?
            .keys()
            .filter(|key| !["title", "required-tools"].contains(&key.as_str()))
        {
            skill
                .unavailable
                .push(format!("未适配的Hub方法声明：{key}"));
        }
    }
    for (section, allowed) in [
        ("policy", vec!["allow_implicit_invocation"]),
        ("dependencies", vec!["tools"]),
    ] {
        if let Some(value) = configuration.get(section) {
            let object = value.as_object().ok_or("技能策略或依赖应为对象")?;
            for key in object.keys().filter(|key| !allowed.contains(&key.as_str())) {
                skill
                    .unavailable
                    .push(format!("未识别的必需{section}字段：{key}"));
            }
        }
    }
    for (path, file) in files.as_object().ok_or("包文件清单无效")? {
        if file["kind"] == "script" {
            warnings.push(format!("仅保存、不执行脚本：{path}"));
        } else if path != "SKILL.md" && path != "agents/openai.yaml" && file["readable"] != true {
            warnings.push(format!("仅保存、不解析资源：{path}"));
        }
        if !path.ends_with(".md") || file["encoding"] != "utf8" {
            continue;
        }
        let text = file["content"].as_str().unwrap();
        for rest in text.split("](").skip(1) {
            let Some((destination, _)) = rest.split_once(')') else {
                continue;
            };
            let destination = destination
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .trim_matches(['<', '>']);
            if destination.is_empty() || destination.starts_with('#') {
                continue;
            }
            if destination.starts_with("https://") || destination.starts_with("http://") {
                warnings.push("包内URL不自动访问，不能当作资料授权".into());
                continue;
            }
            let destination = destination.split('#').next().unwrap();
            let parent = Path::new(path).parent().unwrap_or(Path::new(""));
            let linked = parent
                .join(destination)
                .to_string_lossy()
                .replace('\\', "/");
            if !relative(&linked) || files.get(&linked).is_none() {
                skill
                    .unavailable
                    .push(format!("静态引用缺失或越界：{path} → {destination}"));
            } else if files[&linked]["readable"] != true {
                skill
                    .unavailable
                    .push(format!("静态引用尚不可用：{path} → {destination}"));
            }
        }
    }
    warnings.push("静态检查仅识别Markdown直接链接；动态或自然语言引用仍在实际读取时校验".into());
    warnings.sort();
    warnings.dedup();
    skill.unavailable.sort();
    skill.unavailable.dedup();
    Ok((skill, warnings))
}

pub(super) fn capture(directory: &str) -> Result<Capture, String> {
    if directory.len() > 4096 || !Path::new(directory).is_absolute() {
        return Err("请选择普通技能文件夹的完整路径".into());
    }
    let base = Path::new(directory);
    let mut locks = Vec::new();
    let mut first = serde_json::Map::new();
    let (mut total, mut dirs) = (0, 0);
    walk(base, base, 0, &mut first, &mut locks, &mut total, &mut dirs)?;
    let mut second = serde_json::Map::new();
    let (mut total, mut dirs) = (0, 0);
    walk(
        base,
        base,
        0,
        &mut second,
        &mut locks,
        &mut total,
        &mut dirs,
    )?;
    if first != second {
        return Err("技能包在复制期间发生变化，旧版本保留，请重新检查".into());
    }
    let files = Value::Object(first);
    let (skill, warnings) = assess(&files)?;
    Ok(Capture {
        directory: crate::display_local_path(&base.canonicalize().map_err(|_| "技能来源不可用")?),
        fingerprint: hash(&files.to_string()),
        files,
        skill,
        warnings,
        _locks: locks,
    })
}

pub(super) fn validate_files(files: &Value) -> Result<(), String> {
    let files = files.as_object().ok_or("固定资源清单无效")?;
    let mut total = 0;
    let mut names = HashSet::new();
    if files.is_empty() || files.len() > 33 {
        return Err("固定资源数量无效".into());
    }
    for (path, file) in files {
        if !relative(path)
            || !names.insert(path.to_lowercase())
            || file.as_object().is_none_or(|v| v.len() != 6)
        {
            return Err("固定资源路径或结构无效".into());
        }
        total += decode(file)?.len();
        if file["readable"]
            != json!(
                file["encoding"] == "utf8"
                    && file["bytes"]
                        .as_u64()
                        .is_some_and(|n| n <= MAX_REFERENCE as u64)
                    && text_resource(path)
            )
        {
            return Err("固定资源可读状态无效".into());
        }
    }
    if total > MAX_BYTES {
        return Err("固定资源累计超限".into());
    }
    Ok(())
}
