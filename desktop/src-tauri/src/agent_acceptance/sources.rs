//! Synthetic cached inputs only. Never seeds an Agent work, grant, report,
//! extraction text, condition, action or verification receipt.
use super::*;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    format: String,
    task_completed: bool,
    pdf_version: u8,
    extract: bool,
}
const LIBRARY: &str = "agent-sources-acceptance";
const TASK: &str = "agent-condition-task";
const PDF: &str = "agent-condition-pdf";
pub(super) fn prepare(app: &AppHandle) -> Result<bool, String> {
    let Some(root) = isolated_runtime::root() else {
        return Ok(false);
    };
    let path = root.join("agent-sources-acceptance.json");
    if !path.exists() {
        return Ok(false);
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 1024 {
        return Err("来源验收输入过大".into());
    }
    let config: Config = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "来源验收输入无效")?;
    if config.format != "hub-agent-source-acceptance-v1" || ![1, 2].contains(&config.pdf_version) {
        return Err("来源验收身份或版本无效".into());
    }
    let database = root.join("craft-search.sqlite3");
    let (mut c, _writer) = open_write_database(&database)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO libraries(id,provider,name,enabled,added_at) VALUES(?1,'dida365','Agent 条件验收（虚构缓存）',1,1)",[LIBRARY]).map_err(|e|e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO dida_projects(library_id,project_id,name,raw_json,synced_at) VALUES(?1,'fixture-project','工艺核对','{}',1)",[LIBRARY]).map_err(|e|e.to_string())?;
    let raw = json!({"id":TASK,"projectId":"fixture-project","title":"Agent 条件验收任务","content":"核对 AssemblyFixture.pdf 的工艺尺寸要求；没有实测结果。此为虚构验收材料。","status":if config.task_completed{2}else{0},"createdTime":"2026-10-01T08:00:00+08:00","completedTime":if config.task_completed{json!("2026-10-17T13:00:00+08:00")}else{Value::Null}});
    let mut parsed = Vec::new();
    collect_dida_tasks(&raw, "fixture-project", &mut parsed);
    upsert_dida_task(
        &tx,
        LIBRARY,
        "工艺核对",
        parsed.first().ok_or("验收任务解析失败")?,
        1_792_212_000,
    )?;
    let existing: Option<i64> = tx
        .query_row(
            "SELECT json_extract(metadata_json,'$.fixtureVersion') FROM source_items WHERE id=?1",
            [PDF],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if existing != Some(config.pdf_version as i64) {
        let bytes = pdf_bytes(if config.pdf_version == 1 {
            "Assembly fixture tolerance limit is 10 millimeters. No measured result is recorded."
        } else {
            "Assembly fixture tolerance limit is 8 millimeters. No measured result is recorded."
        })?;
        let store = BlobStore::open(&blob_store_path(app)?)?;
        let blob = store.put(&bytes)?;
        tx.execute("INSERT OR IGNORE INTO blobs(hash,size,mime_type,relative_path,created_at,verified_at) VALUES(?1,?2,'application/pdf',?3,1,1)",params![blob.hash,blob.size as i64,blob.relative_path]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO source_items(id,space_id,document_id,remote_id,source_type,title,mime_type,modified_at,content_hash,blob_hash,status,metadata_json,created_at,updated_at,provider) VALUES(?1,?2,?3,'fixture:AssemblyFixture.pdf','file','AssemblyFixture.pdf','application/pdf',?4,?5,?5,'downloaded',?6,1,1,'dida365') ON CONFLICT(id) DO UPDATE SET modified_at=excluded.modified_at,content_hash=excluded.content_hash,blob_hash=excluded.blob_hash,status='downloaded',metadata_json=excluded.metadata_json",params![PDF,LIBRARY,TASK,1_792_212_000+config.pdf_version as i64,blob.hash,json!({"fixtureVersion":config.pdf_version}).to_string()]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO extractions(id,source_item_id,extractor,extractor_version,status,created_at,updated_at) VALUES('agent-acceptance-pdf',?1,'pdf_native','1','pending',1,1) ON CONFLICT(source_item_id,extractor,extractor_version) DO UPDATE SET status='pending',text_blob_hash=NULL,input_version=NULL",[PDF]).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO index_jobs(job_key,space_id,source_id,source_type,job_type,status,priority,created_at,updated_at,provider,next_attempt_at) VALUES('agent-acceptance-pdf',?1,?2,'file','extract_pdf','pending',25,1,1,'dida365',?3) ON CONFLICT(job_key) DO UPDATE SET status='pending',worker_id=NULL,locked_at=NULL,lease_until=NULL,attempts=0,next_attempt_at=excluded.next_attempt_at",params![LIBRARY,PDF,if config.extract{0}else{now_timestamp()+3600}]).map_err(|e|e.to_string())?;
    } else if config.extract {
        tx.execute("UPDATE index_jobs SET next_attempt_at=0 WHERE job_key='agent-acceptance-pdf' AND status='pending'",[]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}
fn pdf_bytes(text: &str) -> Result<Vec<u8>, String> {
    use lopdf::{
        content::{Content, Operation},
        Document, Object, Stream,
    };
    let mut doc = Document::with_version("1.5");
    let pages = doc.new_object_id();
    let font = doc
        .add_object(lopdf::dictionary! {"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Courier"});
    let resources = doc.add_object(lopdf::dictionary! {"Font"=>lopdf::dictionary!{"F1"=>font}});
    let content = Content {
        operations: vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 10.into()]),
            Operation::new("Td", vec![35.into(), 600.into()]),
            Operation::new("Tj", vec![Object::string_literal(text)]),
            Operation::new("ET", vec![]),
        ],
    };
    let stream = doc.add_object(Stream::new(
        lopdf::dictionary! {},
        content.encode().map_err(|e| e.to_string())?,
    ));
    let page =
        doc.add_object(lopdf::dictionary! {"Type"=>"Page","Parent"=>pages,"Contents"=>stream});
    doc.objects.insert(pages,Object::Dictionary(lopdf::dictionary!{"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1,"Resources"=>resources,"MediaBox"=>vec![0.into(),0.into(),700.into(),842.into()]}));
    let catalog = doc.add_object(lopdf::dictionary! {"Type"=>"Catalog","Pages"=>pages});
    doc.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
