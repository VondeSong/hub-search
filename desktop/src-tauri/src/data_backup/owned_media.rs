//! A reading export is a projection, never the owner of Hub's attachment bytes.
//! Publish a verified local copy before committing an attachment lookup.
use super::*;
use std::io::{Seek, SeekFrom};

pub(crate) fn retain_media(c: &Connection, source: &Path) -> Result<PathBuf, String> {
    // In-memory connections are test-only and have no persistent data root.
    let Some(database) = c.path().filter(|path| !path.is_empty()) else {
        return Ok(source.to_path_buf());
    };
    let root =
        files::existing_directory(Path::new(database).parent().ok_or("数据库缺少数据目录")?)?;
    files::reject_links(source)?;
    let source = source
        .canonicalize()
        .map_err(|e| format!("无法保存附件原件：{e}"))?;
    if source.starts_with(&root) && !source.starts_with(root.join("reading-media-v1")) {
        return Ok(source);
    }
    let cancel = AtomicBool::new(false);
    let mut input = files::open_stable(&source)?;
    let size = input.metadata().map_err(io_error)?.len();
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    let mut signature = Vec::new();
    loop {
        let n = input.read(&mut buffer).map_err(io_error)?;
        if n == 0 {
            break;
        }
        if signature.is_empty() {
            signature.extend_from_slice(&buffer[..n.min(8192)]);
        }
        digest.update(&buffer[..n]);
    }
    let hash = format!("{:x}", digest.finalize());
    // Earlier migrations already retained many identical originals here. Reuse
    // those verified bytes rather than creating another recovery copy.
    if let Some(name) = source.file_name() {
        let recovered = root
            .join("collection-files/recovered-assets")
            .join(&hash)
            .join(name);
        if recovered.is_file() {
            files::reject_links(&recovered)?;
            if fs::metadata(&recovered).map_err(io_error)?.len() == size
                && files::hash_file(&recovered, &cancel)? == hash
            {
                return Ok(recovered);
            }
        }
    }
    // Native attachment opening also needs a usable file extension. Detect
    // binary media so renamed images still reuse one content-addressed object;
    // keep document/text types whose container does not identify the format.
    let declared = source
        .extension()
        .and_then(|v| v.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|v| !v.is_empty() && v.len() <= 12 && v.bytes().all(|b| b.is_ascii_alphanumeric()));
    let extension = match declared.as_deref() {
        Some(v @ ("docx" | "xlsx" | "pptx" | "txt" | "md")) => v.to_string(),
        _ => infer::get(&signature)
            .map(|kind| kind.extension().to_string())
            .or(declared)
            .unwrap_or_else(|| "bin".into()),
    };
    let target = root
        .join("collection-files/assets")
        .join(&hash[..2])
        .join(format!("{hash}.{extension}"));
    files::reject_links(&target)?;
    if target.exists() {
        if fs::metadata(&target).map_err(io_error)?.len() == size
            && files::hash_file(&target, &cancel)? == hash
        {
            return Ok(target);
        }
        return Err("数据目录中的同名附件校验失败，原件与当前引用均保留".into());
    }
    files::check_space(&root, size.saturating_add(16 * 1024 * 1024))?;
    fs::create_dir_all(target.parent().ok_or("附件缺少父目录")?).map_err(io_error)?;
    files::reject_links(&target)?;
    let temporary = target.with_extension(format!("copy-{}.partial", identifier()));
    let result = (|| {
        input.seek(SeekFrom::Start(0)).map_err(io_error)?;
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(io_error)?;
        let copied = std::io::copy(&mut input, &mut output).map_err(io_error)?;
        output.sync_all().map_err(io_error)?;
        drop(output);
        if copied != size || files::hash_file(&temporary, &cancel)? != hash {
            return Err("附件副本校验失败，未改变当前引用".into());
        }
        files::publish_new_file(&temporary, &target)?;
        Ok(target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
#[path = "owned_media_tests.rs"]
mod tests;
