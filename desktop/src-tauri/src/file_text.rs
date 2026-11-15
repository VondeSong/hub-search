//! Bounded, read-only text extraction. Original bytes remain the source of truth.
#[cfg(any(test, feature = "experimental-local-file-text"))]
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
use std::io::Read;
#[cfg(any(test, feature = "experimental-local-file-text"))]
use std::{
    io::Cursor,
    time::{Duration, Instant},
};

#[cfg(any(test, feature = "experimental-local-file-text"))]
const MAX_INPUT: usize = 64 * 1024 * 1024;
#[cfg(any(test, feature = "experimental-local-file-text"))]
const MAX_XML: u64 = 8 * 1024 * 1024;
const MAX_TEXT: usize = 4 * 1024 * 1024;

pub(crate) fn supported(mime: &str) -> bool {
    matches!(
        mime,
        "text/plain" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
}

#[cfg(any(test, feature = "experimental-local-file-text"))]
pub(crate) fn extract(bytes: &[u8], mime: &str) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("文件为零字节，不能提取正文".into());
    }
    if bytes.len() > MAX_INPUT {
        return Err("文件超过 64 MiB 文本提取上限".into());
    }
    match mime {
        "text/plain" => decode_text(bytes),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
            let mut archive =
                zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "文件不是可读取的 DOCX 包")?;
            if archive.len() > 4096 {
                return Err("DOCX 包内文件数量超过上限".into());
            }
            let part = archive
                .by_name("word/document.xml")
                .map_err(|_| "DOCX 缺少正文部件或已加密")?;
            if part.size() > MAX_XML {
                return Err("DOCX 正文超过 8 MiB 提取上限".into());
            }
            let mut xml = Vec::new();
            part.take(MAX_XML + 1)
                .read_to_end(&mut xml)
                .map_err(|_| "无法读取 DOCX 正文")?;
            if xml.len() as u64 > MAX_XML {
                return Err("DOCX 正文超过提取上限".into());
            }
            word_text(&xml)
        }
        _ => Err("尚未支持此文件格式的文本提取".into()),
    }
}

#[cfg(any(test, feature = "experimental-local-file-text"))]
fn decode_text(bytes: &[u8]) -> Result<String, String> {
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let raw = &bytes[2..];
        if raw.len() % 2 != 0 {
            return Err("UTF-16 文件长度不完整".into());
        }
        let little = bytes[0] == 0xff;
        let units = raw
            .chunks_exact(2)
            .map(|p| {
                if little {
                    u16::from_le_bytes([p[0], p[1]])
                } else {
                    u16::from_be_bytes([p[0], p[1]])
                }
            })
            .collect::<Vec<_>>();
        String::from_utf16(&units).map_err(|_| "UTF-16 正文包含无效字符")?
    } else {
        String::from_utf8(
            bytes
                .strip_prefix(&[0xef, 0xbb, 0xbf])
                .unwrap_or(bytes)
                .to_vec(),
        )
        .map_err(|_| "文本编码不受支持，请使用 UTF-8 或带 BOM 的 UTF-16")?
    };
    if text.len() > MAX_TEXT {
        return Err("正文超过 4 MiB 提取上限".into());
    }
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t' | '\u{c}'))
    {
        return Err("文件包含二进制控制字符，未作为文本导入".into());
    }
    Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
}

#[cfg(any(test, feature = "experimental-local-file-text"))]
fn word_text(xml: &[u8]) -> Result<String, String> {
    let mut reader = NsReader::from_reader(xml);
    let started = Instant::now();
    let mut output = String::new();
    let mut text_depth = None;
    let mut depth = 0usize;
    let mut events = 0usize;
    let mut document = false;
    let mut roots = 0;
    loop {
        events += 1;
        if events > 2_000_000 || started.elapsed() > Duration::from_secs(5) {
            return Err("DOCX 正文解析达到资源上限".into());
        }
        let (namespace, event) = reader
            .read_resolved_event()
            .map_err(|_| "DOCX 正文 XML 损坏")?;
        let word = matches!(namespace, ResolveResult::Bound(ns) if ns.as_ref() == b"http://schemas.openxmlformats.org/wordprocessingml/2006/main" || ns.as_ref() == b"http://purl.oclc.org/ooxml/wordprocessingml/main");
        match event {
            Event::Start(tag) => {
                if depth == 0 {
                    roots += 1;
                    if roots != 1 || !word || tag.local_name().as_ref() != b"document" {
                        return Err("DOCX 正文根结构无效".into());
                    }
                }
                depth += 1;
                if depth > 256 {
                    return Err("DOCX 正文嵌套过深".into());
                }
                if word && tag.local_name().as_ref() == b"document" {
                    document = true;
                }
                if word && tag.local_name().as_ref() == b"t" {
                    text_depth = Some(depth);
                }
            }
            Event::Empty(tag) if depth == 0 => {
                roots += 1;
                if roots != 1 || !word || tag.local_name().as_ref() != b"document" {
                    return Err("DOCX 正文根结构无效".into());
                }
                document = true;
            }
            Event::Empty(tag) if word => match tag.local_name().as_ref() {
                b"tab" => output.push('\t'),
                b"br" | b"cr" => output.push('\n'),
                _ => {}
            },
            Event::End(tag) => {
                if text_depth == Some(depth) {
                    text_depth = None;
                }
                if word {
                    match tag.local_name().as_ref() {
                        b"p" | b"tr" => output.push('\n'),
                        b"tc" => output.push('\t'),
                        _ => {}
                    }
                }
                depth = depth.saturating_sub(1);
            }
            Event::Text(text) if text_depth.is_some() => {
                output.push_str(&text.xml10_content().map_err(|_| "无法解码 DOCX 正文")?)
            }
            Event::Text(text) if depth == 0 => {
                if !text
                    .xml10_content()
                    .map_err(|_| "DOCX 根外文字无效")?
                    .trim()
                    .is_empty()
                {
                    return Err("DOCX 根节点外存在正文".into());
                }
            }
            Event::CData(text) if text_depth.is_some() => {
                output.push_str(&text.xml10_content().map_err(|_| "无法解码 DOCX 正文")?)
            }
            Event::GeneralRef(reference) if text_depth.is_some() => {
                let name = reference.decode().map_err(|_| "DOCX 引用无效")?;
                let entity = format!("&{name};");
                output.push_str(
                    &quick_xml::escape::unescape(&entity)
                        .map_err(|_| "DOCX 包含不支持的实体引用")?,
                );
            }
            Event::DocType(_) => return Err("DOCX 包含文档类型声明，已停止提取".into()),
            Event::Eof => break,
            _ => {}
        }
        if output.len() > MAX_TEXT {
            return Err("DOCX 文本超过 4 MiB 上限".into());
        }
    }
    if depth != 0 {
        return Err("DOCX 正文结构不完整".into());
    }
    if !document {
        return Err("未找到有效的 DOCX 正文根节点".into());
    }
    Ok(output)
}

#[cfg(feature = "experimental-local-file-text")]
pub(crate) async fn process_jobs(
    path: &std::path::PathBuf,
    store: &crate::BlobStore,
) -> Result<usize, String> {
    use crate::*;
    use rusqlite::params;
    // Opt-in builds only. Existing originals are read locally, never downloaded here.
    {
        let (mut connection, _writer) = open_write_database(path)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let sources = {
            let mut stmt = transaction.prepare("SELECT s.space_id,s.id,s.source_type,s.provider FROM source_items s JOIN libraries l ON l.id=s.space_id WHERE l.enabled=1 AND l.provider IN ('craft','dida365','files') AND s.blob_hash IS NOT NULL AND s.status NOT IN ('removed','missing','unavailable') AND s.mime_type IN ('text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document')").map_err(|e|e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let mut queued = 0;
        for (library, source, kind, provider) in sources {
            let input = match attachment_evidence::input_on(&transaction, &library, &source) {
                Ok(v) => v,
                Err(_) => continue,
            };
            queued += transaction.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at,provider,payload) VALUES (?1,?2,?3,?4,'extract_file','pending',20,?5,?5,?6,?7) ON CONFLICT(job_key) DO NOTHING",params![format!("file-text-v2:{source}:{}",input.version),library,source,kind,now_timestamp(),provider,input.version]).map_err(|e|e.to_string())?;
            if queued >= 32 {
                break;
            }
        }
        transaction.commit().map_err(|e| e.to_string())?;
    }
    let jobs = claim_enabled_attachment_jobs(path, "extract_file", 2)?;
    let count = jobs.len();
    for job in jobs {
        let operation = match begin_pipeline_operation(path, &job, "extract_file") {
            Ok(value) => value,
            Err(error) => {
                finish_pipeline_result(path, &job, Err(error))?;
                continue;
            }
        };
        let outcome = async {
            let connection = open_database(path)?;
            let input = attachment_evidence::input_on(&connection, &job.space_id, &job.source_id)?;
            if job.payload.as_deref() != Some(input.version.as_str()) {
                complete_index_jobs(&connection,&[job.id],&job.worker_id)?;
                return Ok(());
            }
            let (document,title,mime,provider):(String,String,String,String) = connection.query_row("SELECT document_id,title,mime_type,provider FROM source_items WHERE id=?1 AND space_id=?2",params![job.source_id,job.space_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|e|e.to_string())?;
            let cache_version = format!("1:{mime}");
            let cached: Option<String> = connection.query_row("SELECT text_blob_hash FROM extraction_cache WHERE blob_hash=?1 AND extractor='file_text' AND extractor_version=?2 AND page_number=0 AND status='completed'",params![input.blob_hash,cache_version],|r|r.get(0)).ok();
            let blob_path = store.path_for(&input.blob_hash)?;
            drop(connection);
            // Hide prior-version derived hits even if the replacement file fails
            // to parse. Preserve the original and its historical text cache.
            {
                let (mut c, _writer) = open_write_database(path)?;
                pipeline_checkpoint(&c,&job,&operation,"extract_file")?;
                let tx=c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
                attachment_evidence::check_on(&tx,&job.space_id,&job.source_id,&input)?;
                let removed=tx.execute("DELETE FROM content_items WHERE source_item_id=?1 AND content_type='file_attachment' AND input_version IS NOT NULL AND input_version IS NOT ?2",params![job.source_id,input.version]).map_err(|e|e.to_string())?;
                if removed>0 { queue_index(&tx,&job.space_id,&document,&provider)?; }
                commit_pipeline_transaction(tx,Some(&operation),"无法清理旧版文件命中")?;
            }
            let expected = input.blob_hash.clone();
            let cached_store = store.clone();
            let text = tokio::task::spawn_blocking(move || {
                use sha2::{Digest,Sha256};
                if let Some(hash) = cached { return read_text_blob(&cached_store,&hash); }
                let file = std::fs::File::open(blob_path).map_err(|e|e.to_string())?;
                let mut bytes = Vec::new();
                file.take(MAX_INPUT as u64 + 1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
                if bytes.len()>MAX_INPUT { return Err("文件超过提取资源上限".into()); }
                if format!("{:x}",Sha256::digest(&bytes)) != expected { return Err("文件原件哈希核验失败".into()); }
                extract(&bytes,&mime).map_err(|e|format!("FILE_TEXT_TERMINAL:{e}"))
            }).await.map_err(|e|e.to_string())??;
            let text_blob = store.put(text.as_bytes())?;
            let (mut connection,_writer) = open_write_database(path)?;
            pipeline_checkpoint(&connection,&job,&operation,"extract_file")?;
            let tx = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
            attachment_evidence::check_on(&tx,&job.space_id,&job.source_id,&input)?;
            tx.execute("INSERT INTO blobs(hash,size,mime_type,relative_path,created_at,verified_at) VALUES (?1,?2,'text/plain',?3,?4,?4) ON CONFLICT(hash) DO NOTHING",params![text_blob.hash,text_blob.size as i64,text_blob.relative_path,now_timestamp()]).map_err(|e|e.to_string())?;
            tx.execute("INSERT INTO extraction_cache(blob_hash,extractor,extractor_version,page_number,status,text_blob_hash,created_at,updated_at) VALUES (?1,'file_text',?2,0,'completed',?3,?4,?4) ON CONFLICT(blob_hash,extractor,extractor_version,page_number) DO UPDATE SET status='completed',text_blob_hash=excluded.text_blob_hash,updated_at=excluded.updated_at,last_error=NULL",params![input.blob_hash,cache_version,text_blob.hash,now_timestamp()]).map_err(|e|e.to_string())?;
            tx.execute("DELETE FROM content_items WHERE source_item_id=?1 AND content_type='file_attachment'",[&job.source_id]).map_err(|e|e.to_string())?;
            for chunk in content::chunk_pdf_pages(&document,&job.source_id,&title,&[text]) {
                tx.execute("INSERT INTO content_items(id,space_id,document_id,block_id,content_type,heading,body,ordinal,source_hash,source_item_id,provider,input_version) VALUES (?1,?2,?3,?4,'file_attachment',?5,?6,?7,?8,?9,?10,?11)",params![format!("{}:file:{}:{}",job.source_id,input.version,chunk.ordinal),job.space_id,document,document,title,chunk.body,chunk.ordinal,chunk.source_hash,job.source_id,provider,input.version]).map_err(|e|e.to_string())?;
            }
            tx.execute("INSERT INTO extractions(id,source_item_id,extractor,extractor_version,status,text_blob_hash,created_at,updated_at,input_version) VALUES (?1,?2,'file_text','1','completed',?3,?4,?4,?5) ON CONFLICT(source_item_id,extractor,extractor_version) DO UPDATE SET status='completed',text_blob_hash=excluded.text_blob_hash,input_version=excluded.input_version,updated_at=excluded.updated_at,last_error=NULL",params![format!("file-text:{}",job.source_id),job.source_id,text_blob.hash,now_timestamp(),input.version]).map_err(|e|e.to_string())?;
            queue_index(&tx,&job.space_id,&document,&provider)?;
            complete_index_jobs(&tx,&[job.id],&job.worker_id)?;
            commit_pipeline_transaction(tx,Some(&operation),"无法提交文件正文")
        }.await;
        if let Err(error) = outcome {
            if pipeline_control_error(&error) {
                defer_pipeline_job(path, &job)?;
            } else if let Some(reason) = error.strip_prefix("FILE_TEXT_TERMINAL:") {
                finish_pipeline_result(
                    path,
                    &job,
                    fail_extraction(path, &job, reason, &operation),
                )?;
            } else {
                finish_pipeline_result(
                    path,
                    &job,
                    fail_pipeline_job_controlled(path, &job, &error, false, Some(&operation)),
                )?;
            }
        }
    }
    Ok(count)
}

#[cfg(feature = "experimental-local-file-text")]
fn fail_extraction(
    path: &std::path::PathBuf,
    job: &crate::PipelineJob,
    reason: &str,
    operation: &crate::library_runtime::Operation,
) -> Result<(), String> {
    use crate::*;
    use rusqlite::params;
    let (mut c, _writer) = open_write_database(path)?;
    pipeline_checkpoint(&c, job, operation, "extract_file")?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let input = attachment_evidence::input_on(&tx, &job.space_id, &job.source_id)?;
    if job.payload.as_deref() != Some(input.version.as_str()) {
        return Err("CONTENT_POLICY:输入已更新，旧提取失败已让出".into());
    }
    tx.execute("INSERT INTO extractions(id,source_item_id,extractor,extractor_version,status,created_at,updated_at,input_version,last_error) VALUES (?1,?2,'file_text','1','failed',?3,?3,?4,?5) ON CONFLICT(source_item_id,extractor,extractor_version) DO UPDATE SET status='failed',text_blob_hash=NULL,input_version=excluded.input_version,last_error=excluded.last_error,updated_at=excluded.updated_at",params![format!("file-text:{}",job.source_id),job.source_id,now_timestamp(),input.version,reason]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE index_jobs SET status='failed',updated_at=?1,last_error=?2,worker_id=NULL,locked_at=NULL,lease_until=NULL,next_attempt_at=0 WHERE id=?3 AND status='running' AND worker_id=?4",params![now_timestamp(),reason,job.id,job.worker_id]).map_err(|e|e.to_string())?;
    // A text extraction failure never invalidates an otherwise available original.
    commit_pipeline_transaction(tx, Some(operation), "无法记录正文提取失败")
}

#[cfg(feature = "experimental-local-file-text")]
fn queue_index(
    c: &rusqlite::Connection,
    library: &str,
    document: &str,
    provider: &str,
) -> Result<(), String> {
    use rusqlite::params;
    c.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at,provider) VALUES (?1,?2,?3,'document','upsert_lexical','pending',15,?4,?4,?5) ON CONFLICT(job_key) DO UPDATE SET status='pending',attempts=0,last_error=NULL,next_attempt_at=0,worker_id=NULL,locked_at=NULL,lease_until=NULL,updated_at=excluded.updated_at",params![format!("lexical:{library}:{document}"),library,document,crate::now_timestamp(),provider]).map_err(|e|e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_encoding_and_binary_rejection() {
        assert_eq!(
            extract(b"\xef\xbb\xbfA\r\nB", "text/plain").unwrap(),
            "A\nB"
        );
        assert_eq!(
            extract(&[0xff, 0xfe, 0x2d, 0x4e], "text/plain").unwrap(),
            "中"
        );
        assert!(extract(b"A\0B", "text/plain").is_err());
        assert!(extract(&[], "text/plain").is_err());
        assert!(extract(&[0xff, 0xfe, 1], "text/plain").is_err());
    }
    #[test]
    fn word_text_preserves_runs_and_rejects_entities_and_truncation() {
        assert_eq!(word_text(br#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>A&amp;B</w:t></w:r><w:r><w:t> C</w:t><w:tab/></w:r></w:p></w:document>"#).unwrap(), "A&B C\t\n");
        assert!(word_text(b"<!DOCTYPE x><w:p/>").is_err());
        assert!(word_text(b"<w:p><w:t>broken").is_err());
        assert!(word_text(br#"<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/><document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>"#).is_err());
        assert_eq!(word_text(br#"<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><p><r><t>Alias</t></r></p></document>"#).unwrap(),"Alias\n");
    }

    #[test]
    #[ignore = "explicit read-only check of existing daily files; no database writes"]
    fn live_daily_docx_text_is_readable_and_originals_unchanged() {
        use rusqlite::Connection;
        use sha2::{Digest, Sha256};
        let root = std::path::Path::new("C:/Users/yongs/AppData/Roaming/com.craftsearch.desktop");
        let connection = Connection::open_with_flags(
            root.join("craft-search.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let mut statement = connection.prepare("SELECT b.relative_path,b.hash FROM source_items s JOIN blobs b ON b.hash=s.blob_hash JOIN libraries l ON l.id=s.space_id WHERE l.enabled=1 AND s.mime_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document' AND b.size>0 AND b.size<67108864 AND s.title NOT LIKE '%测试%' AND s.title NOT LIKE '%验收%' ORDER BY b.size").unwrap();
        let mut count = 0;
        for row in statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
        {
            let (relative, hash) = row.unwrap();
            let path = root.join("blobs-v1").join(relative);
            let bytes = std::fs::read(&path).unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), hash);
            let text = extract(
                &bytes,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
            .unwrap();
            assert!(!text.trim().is_empty());
            assert_eq!(
                format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap())),
                hash
            );
            println!(
                "real DOCX {}: {} text characters; original unchanged",
                count + 1,
                text.chars().count()
            );
            count += 1;
        }
        assert!(
            count >= 3,
            "at least three actual nonempty DOCX originals required"
        );
    }

    #[test]
    #[ignore = "explicit read-only check of existing daily TXT attachments"]
    fn live_daily_txt_originals_unchanged() {
        use sha2::{Digest, Sha256};
        let directory = std::path::Path::new(
            "D:/03_Resources/Software/Apps/Obsidian/OS/Journals/2026/11/_hub-assets",
        );
        let mut paths = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|p| p.extension().is_some_and(|v| v == "txt"))
            .collect::<Vec<_>>();
        paths.sort();
        assert!(
            paths.len() >= 2,
            "two existing actual TXT attachments required"
        );
        for path in paths.into_iter().take(2) {
            let bytes = std::fs::read(&path).unwrap();
            let before = Sha256::digest(&bytes);
            let text = extract(&bytes, "text/plain").unwrap();
            assert!(!text.trim().is_empty());
            assert_eq!(before, Sha256::digest(std::fs::read(path).unwrap()));
            println!(
                "real TXT: {} characters, original unchanged",
                text.chars().count()
            );
        }
    }

    #[cfg(feature = "experimental-local-file-text")]
    #[tokio::test]
    #[ignore = "explicit daily-data derived-text write; coordinate with current client owner before running"]
    async fn live_daily_derived_text_pipeline() {
        use rusqlite::Connection;
        use sha2::{Digest, Sha256};
        let root = std::path::Path::new("C:/Users/yongs/AppData/Roaming/com.craftsearch.desktop");
        let path = root.join("craft-search.sqlite3");
        let store = crate::BlobStore::open(&root.join("blobs-v1")).unwrap();
        let c =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let originals = {
            let mut q=c.prepare("SELECT DISTINCT b.hash,b.relative_path FROM source_items s JOIN blobs b ON b.hash=s.blob_hash JOIN libraries l ON l.id=s.space_id WHERE l.enabled=1 AND l.provider IN ('craft','dida365','files') AND s.mime_type IN ('text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document')").unwrap();
            q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert!(!originals.is_empty());
        for (hash, relative) in &originals {
            assert_eq!(
                &format!(
                    "{:x}",
                    Sha256::digest(std::fs::read(root.join("blobs-v1").join(relative)).unwrap())
                ),
                hash
            );
        }
        drop(c);
        for _ in 0..16 {
            if process_jobs(&path, &store).await.unwrap() == 0 {
                break;
            }
        }
        let c =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let completed:i64=c.query_row("SELECT count(*) FROM extractions WHERE extractor='file_text' AND status='completed'",[],|r|r.get(0)).unwrap();
        let expected_nonempty:i64=c.query_row("SELECT count(*) FROM source_items s JOIN libraries l ON l.id=s.space_id JOIN blobs b ON b.hash=s.blob_hash WHERE l.enabled=1 AND l.provider IN ('craft','dida365','files') AND s.mime_type IN ('text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document') AND b.size>0 AND b.size<=67108864",[],|r|r.get(0)).unwrap();
        assert_eq!(completed,expected_nonempty,"every current nonempty real input must reach text storage; partial success is not full acceptance");
        let (result,library,document,expected):(String,String,String,String)=c.query_row("SELECT ci.id,ci.space_id,ci.document_id,ci.body FROM content_items ci JOIN extractions e ON e.source_item_id=ci.source_item_id AND e.extractor='file_text' WHERE ci.content_type='file_attachment' AND e.status='completed' LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        let preview_result = preview(&c, &store, &library, &document, &result);
        for (hash, relative) in &originals {
            assert_eq!(
                &format!(
                    "{:x}",
                    Sha256::digest(std::fs::read(root.join("blobs-v1").join(relative)).unwrap())
                ),
                hash
            );
        }
        let body = preview_result.unwrap().unwrap();
        let normalized = body
            .lines()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(normalized.contains(&expected),"preview and index must preserve the same text after documented whitespace normalization");
        let invalidated:i64=c.query_row("SELECT count(*) FROM source_items s JOIN index_jobs j ON j.source_id=s.id WHERE j.job_type='extract_file' AND j.job_key LIKE 'file-text-v2:%' AND s.status='unavailable'",[],|r|r.get(0)).unwrap();
        assert_eq!(
            invalidated, 0,
            "text extraction failures must not invalidate originals"
        );
        println!("{completed} real file sources reached derived text; sampled preview matches; all original blob hashes unchanged; lexical jobs queued, no second Tantivy writer opened");
    }
}

pub(crate) fn preview(
    c: &rusqlite::Connection,
    store: &crate::BlobStore,
    library: &str,
    document: &str,
    result: &str,
) -> Result<Option<String>, String> {
    use rusqlite::{params, OptionalExtension};
    if let Some(source) = result.strip_prefix("attachment-meta:") {
        let mime: Option<String> = c
            .query_row(
                "SELECT mime_type FROM source_items WHERE id=?1 AND space_id=?2 AND document_id=?3",
                params![source, library, document],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if !mime.as_deref().is_some_and(supported) {
            return Ok(None);
        }
    }
    let row: Option<(String, String, String)> = if let Some(source) =
        result.strip_prefix("attachment-meta:")
    {
        c.query_row("SELECT s.id,e.text_blob_hash,e.input_version FROM source_items s JOIN extractions e ON e.source_item_id=s.id AND e.extractor='file_text' AND e.extractor_version='1' AND e.status='completed' WHERE s.id=?1 AND s.space_id=?2 AND s.document_id=?3",params![source,library,document],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?
    } else {
        c.query_row("SELECT ci.source_item_id,e.text_blob_hash,e.input_version FROM content_items ci JOIN extractions e ON e.source_item_id=ci.source_item_id AND e.extractor='file_text' AND e.extractor_version='1' AND e.status='completed' WHERE ci.id=?1 AND ci.space_id=?2 AND ci.document_id=?3 AND ci.content_type='file_attachment'",params![result,library,document],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?
    };
    let Some((source, hash, version)) = row else {
        if result.starts_with("attachment-meta:") {
            return Err("此附件尚无可用提取正文，请打开原文件".into());
        }
        if result.contains(":file:v1:") {
            return Err("附件预览已过期，请重新搜索或定位".into());
        }
        return Ok(None);
    };
    let input = crate::attachment_evidence::input_on(c, library, &source)?;
    if input.version != version {
        return Err("附件已更新，正文需要重新提取".into());
    }
    let text = read_text_blob(store, &hash)?;
    let fence = "`".repeat(
        text.split(|c| c != '`')
            .map(str::len)
            .max()
            .unwrap_or(0)
            .max(2)
            + 1,
    );
    Ok(Some(format!(
        "只读提取正文；DOCX 仅含主正文，复杂布局请打开原文件。\n\n{fence}text\n{text}\n{fence}"
    )))
}

fn read_text_blob(store: &crate::BlobStore, hash: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut bytes = Vec::new();
    std::fs::File::open(store.path_for(hash)?)
        .map_err(|e| e.to_string())?
        .take(MAX_TEXT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_TEXT {
        return Err("附件正文超过预览上限".into());
    }
    if format!("{:x}", Sha256::digest(&bytes)) != hash {
        return Err("提取正文哈希核验失败".into());
    }
    String::from_utf8(bytes).map_err(|_| "附件正文编码无效".into())
}
