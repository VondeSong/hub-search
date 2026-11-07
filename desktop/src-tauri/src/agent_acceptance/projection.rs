//! One isolated M1 projection replay. No provider, UI automation or business action.
use super::*;
use crate::agent_work as work_api;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    time::Instant,
};

const WORK: &str = "work-qmx-qclI33T4evy-Xe9Dpb4Z";
const RUN: &str = "run-Az2v9GRImnYQJGrxW25O6mZm";
const FOLDER: &str = "v3-m1-native-acceptance-20261027";
const SAMPLES: usize = 60;
const CAPTURE_AT: usize = 20;
const GATE_MS: f64 = 150.0;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    library_id: String,
    document_id: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    format: String,
    round: u8,
    records_sha256: String,
    grant_sha256: String,
    documents: Vec<Document>,
    seed_snapshot: String,
    binary_sha256: String,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn json_bytes(value: &Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value).map_err(|e| e.to_string())
}
fn save(root: &Path, name: &str, value: &Value) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join(name))
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn validate_plan(root: &Path, p: &Plan) -> Result<(), String> {
    if p.format != "hub-m1-projection-native-v1"
        || !(1..=3).contains(&p.round)
        || root.file_name().and_then(|v| v.to_str()) != Some(format!("round-{}", p.round).as_str())
        || root
            .parent()
            .and_then(Path::file_name)
            .and_then(|v| v.to_str())
            != Some(FOLDER)
        || root
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|v| v.to_str())
            != Some(".local")
        || p.documents.len() != 2
        || p.documents.iter().any(|d| d.library_id != "notes")
        || [&p.records_sha256, &p.grant_sha256, &p.binary_sha256]
            .iter()
            .any(|v| v.len() != 64 || !v.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("验收仅允许本批三份已冻结的 M1 隔离副本".into());
    }
    Ok(())
}
fn records(root: &Path) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let mut q=c.prepare("SELECT id,run_id,kind,body_json,created_at FROM agent_records WHERE work_id=?1 ORDER BY rowid").map_err(|e|e.to_string())?;
    let rows = q
        .query_map([WORK], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(json!(rows))
}
fn preflight(root: &Path, p: &Plan) -> Result<(Work, Value), String> {
    validate_plan(root, p)?;
    let before = records(root)?;
    if before.as_array().map(Vec::len) != Some(26)
        || hash(&json_bytes(&before)?) != p.records_sha256
    {
        return Err("M1 原26条记录前缀不匹配".into());
    }
    let c = crate::source_evidence::open_read_database(root)?;
    let w = store::load(&c, WORK)?;
    let grant: String = c
        .query_row(
            "SELECT grant_json FROM agent_works WHERE id=?1",
            [WORK],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let count = |table: &str| -> Result<i64, String> {
        c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .map_err(|e| e.to_string())
    };
    if w.state != "investigating"
        || w.active_run.as_deref() != Some(RUN)
        || w.report.is_some()
        || w.revision != 2
        || w.authorization_version != 1
        || hash(grant.as_bytes()) != p.grant_sha256
        || w.grant.notes.len() != 2
        || !w.grant.library_ids.is_empty()
        || !w.grant.reading_item_keys.is_empty()
        || count("agent_works")? != 1
        || count("agent_runs")? != 2
        || count("agent_actions")? != 0
    {
        return Err("M1 处理态、授权或历史身份不匹配".into());
    }
    let mut body_bytes = 0;
    for d in &p.documents {
        if !w.grant.notes.iter().any(|n|matches!(n,EvidenceLocator::Note{library_id,document_id,page_id:None} if library_id==&d.library_id && document_id==&d.document_id)) {return Err("材料不属于原授权".into());}
        let body: String = c
            .query_row(
                "SELECT markdown FROM documents WHERE space_id=?1 AND id=?2",
                params![d.library_id, d.document_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if hash(body.as_bytes()) != d.sha256 {
            return Err("原材料正文已变化".into());
        }
        body_bytes += body.len();
    }
    let request: Value = serde_json::from_str(before[25][3].as_str().ok_or("原工具记录损坏")?)
        .map_err(|e| e.to_string())?;
    let budget: Value = serde_json::from_str(before[6][3].as_str().ok_or("原预算记录损坏")?)
        .map_err(|e| e.to_string())?;
    if body_bytes != 47
        || request["operation"] != "capability"
        || request["name"] != "hub_create_analysis_snapshot"
        || request["arguments"] != json!({})
        || budget != json!(assistant::budget("quick")?)
    {
        return Err("原M1峰值处的工具、预算或负载不匹配".into());
    }
    store::check_run(root, &w, RUN)?;
    let snapshots = Connection::open_with_flags(
        root.join("analysis-snapshots.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    let only: (i64, String) = snapshots
        .query_row(
            "SELECT count(*),COALESCE(min(id),'') FROM snapshots",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    if only != (1, p.seed_snapshot.clone()) {
        return Err("必须使用只含原首份快照的全新副本".into());
    }
    Ok((w, before))
}
fn qualified(samples: &[Value], capture: &Value) -> bool {
    samples.len() == SAMPLES
        && samples.iter().enumerate().all(|(index, s)| {
            let t = &s["nativeTiming"];
            let Some(ms) = t["projectionMs"]
                .as_f64()
                .filter(|v| v.is_finite() && *v >= 0.0)
            else {
                return false;
            };
            let Some(phases) = t["phases"].as_array().filter(|v| v.len() == 13) else {
                return false;
            };
            let mut previous = 0.0;
            phases.iter().all(|p| {
                p["elapsedMs"].as_f64().is_some_and(|v| {
                    v.is_finite() && v >= previous && v <= ms && {
                        previous = v;
                        true
                    }
                })
            }) && s["index"] == index
                && s["state"] == "investigating"
                && s["activeRun"] == RUN
                && s["runActive"] == true
        })
        && capture["itemsTotal"] == 2
        && capture["byteCount"] == 47
        && samples.iter().any(|s| {
            let Some(end) = s["nativeTiming"]["hostEpochMs"].as_f64() else {
                return false;
            };
            let Some(ms) = s["nativeTiming"]["projectionMs"].as_f64() else {
                return false;
            };
            let start = capture["dispatchStartEpochMs"]
                .as_f64()
                .unwrap_or(f64::INFINITY);
            let finish = capture["dispatchEndEpochMs"]
                .as_f64()
                .unwrap_or(f64::NEG_INFINITY);
            // Conservative allowance for the existing whole-millisecond host clock.
            end.min(finish) - (end - ms).max(start) > 2.0
        })
}
fn maximum(samples: &[Value]) -> f64 {
    samples
        .iter()
        .filter_map(|s| s["nativeTiming"]["projectionMs"].as_f64())
        .fold(0.0, f64::max)
}
fn passed(samples: &[Value], capture: &Value) -> bool {
    qualified(samples, capture) && maximum(samples) <= GATE_MS
}
fn execute(
    root: &Path,
    p: &Plan,
    samples: &mut Vec<Value>,
    log: &mut std::fs::File,
) -> Result<Value, String> {
    let (work, before) = preflight(root, p)?;
    let control = Control::bounded(Duration::from_secs(60));
    let key = (work_api::root_key(root), WORK.to_string());
    if work_api::active()
        .lock()
        .map_err(|_| "运行登记不可用")?
        .contains_key(&key)
    {
        return Err("该副本已有运行".into());
    }
    work_api::active()
        .lock()
        .map_err(|_| "运行登记不可用")?
        .insert(
            key.clone(),
            work_api::Active {
                run_id: RUN.into(),
                control: control.clone(),
                is_action: false,
            },
        );
    let _owner = work_api::Running(key);
    let mut prepared = Context {
        reader: work.grant.reader(root)?.controlled(control.clone()),
        excerpts: vec![],
        entities: HashSet::new(),
        observations: vec![],
        usage: Usage::default(),
        control: control.clone(),
        budget: assistant::budget("quick")?,
        candidates: vec![],
        search_read_available: false,
        skills: Some(
            crate::hub_capabilities::Session::new(root, Some(work.grant.scope()?))?
                .controlled(control.clone()),
        ),
        skill_request: work.goal.clone(),
    };
    let initial: Value = serde_json::from_str(before[9][3].as_str().ok_or("初始取证记录损坏")?)
        .map_err(|e| e.to_string())?;
    let excerpt: EvidenceExcerpt =
        serde_json::from_value(initial["excerpt"].clone()).map_err(|_| "初始取证记录损坏")?;
    prepared.usage.body_chars = excerpt.content.chars().count();
    prepared
        .entities
        .insert(serde_json::to_string(&excerpt.locator).map_err(|e| e.to_string())?);
    prepared.usage.entities_read = 1;
    prepared.excerpts.push(excerpt);
    prepared.usage.tool_steps = 2;
    let mut context = Some(prepared);
    let capture_request: Value =
        serde_json::from_str(before[25][3].as_str().ok_or("原工具记录损坏")?)
            .map_err(|e| e.to_string())?;
    let root_owned = root.to_path_buf();
    let mut capture = None;
    let mut failure = None;
    for index in 0..SAMPLES {
        if index == CAPTURE_AT {
            let mut context = context.take().ok_or("已消费本轮唯一捕获")?;
            let request = capture_request.clone();
            let root = root_owned.clone();
            let ready = std::sync::Arc::new(std::sync::Barrier::new(2));
            let wait = ready.clone();
            capture = Some(std::thread::spawn(move || -> Result<Value, String> {
                wait.wait();
                let start = chrono::Utc::now().timestamp_millis();
                let raw = context.dispatch(Tool::Capability {
                    name: "hub_create_analysis_snapshot".into(),
                    arguments: json!({}),
                })?;
                let end = chrono::Utc::now().timestamp_millis();
                let c = crate::source_evidence::open_read_database(&root)?;
                let w = store::load(&c, WORK)?;
                drop(c);
                store::check_run(&root, &w, RUN)?;
                let result_ref = store::tool_results::capture(&root, WORK, RUN, &request, &raw)?;
                Ok(
                    json!({"dispatchStartEpochMs":start,"dispatchEndEpochMs":end,"snapshot":raw["snapshot"],"itemsTotal":raw["itemsTotal"],"byteCount":raw["byteCount"],"resultRef":result_ref}),
                )
            }));
            ready.wait();
        }
        let result = (|| {
            control.check()?;
            let started = Instant::now();
            let value = work_api::ui(root, &json!({"action":"status","id":WORK}))?;
            let sample = json!({"index":index,"nativeTiming":value["nativeTiming"],"wholeStatusMs":started.elapsed().as_secs_f64()*1000.0,"state":value["work"]["state"],"activeRun":value["work"]["activeRun"],"runActive":value["runActive"],"recordVersion":value["recordVersion"]});
            log.write_all(&json_bytes(&sample)?)
                .and_then(|_| log.write_all(b"\n"))
                .map_err(|e| e.to_string())?;
            samples.push(sample);
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            failure = Some(error);
            break;
        }
    }
    let captured = capture
        .ok_or("未进入固定捕获点")?
        .join()
        .map_err(|_| "快照回放线程中断")??;
    if let Some(error) = failure {
        return Err(error);
    }
    let after = records(root)?;
    let original = preflight_prefix(&after)?;
    if hash(&json_bytes(&original)?) != p.records_sha256
        || after.as_array().map(Vec::len) != Some(27)
    {
        return Err("原记录前缀或新工具回执数量改变".into());
    }
    if captured["snapshot"] == p.seed_snapshot {
        return Err("未新建本轮两篇输入快照".into());
    }
    Ok(
        json!({"completed":true,"qualified":qualified(samples,&captured),"gateMs":GATE_MS,"maximumMs":maximum(samples),"passed":passed(samples,&captured),"capture":captured,"models":0,"sourceWrites":0,"businessActions":0,"samplesExpected":SAMPLES,"samplesRecorded":samples.len(),"samplesOmitted":0,"originalRecordsRetained":true,"scope":"native backend projection of original M1 peak phase; no provider, model quality or new GUI paint claim"}),
    )
}
fn preflight_prefix(records: &Value) -> Result<Value, String> {
    Ok(json!(records
        .as_array()
        .ok_or("记录列表损坏")?
        .iter()
        .take(26)
        .cloned()
        .collect::<Vec<_>>()))
}

pub(crate) fn run_cli() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 3
        || args[0] != "--m1-projection-acceptance"
        || args[1] != "--isolated-data-root"
    {
        return Err("只允许本批专用模式与明确隔离目录".into());
    }
    crate::isolated_runtime::initialize()?;
    let root = crate::isolated_runtime::root().ok_or("验收不允许使用个人运行目录")?;
    if crate::isolated_runtime::automatic_workers_enabled() {
        return Err("验收不能启动后台任务".into());
    }
    let path = root.join("m1-projection-acceptance.json");
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 8192 {
        return Err("验收配置过大".into());
    }
    let p: Plan = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    validate_plan(root, &p)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if hash(&fs::read(&exe).map_err(|e| e.to_string())?) != p.binary_sha256 {
        return Err("原生候选身份不匹配".into());
    }
    let _lease = crate::data_portability::session_lease(root)?;
    let _c = crate::database::open_database(&root.join("craft-search.sqlite3"))?;
    drop(_c);
    crate::source_evidence::analysis::prepare_existing_store(root)?;
    preflight(root, &p)?;
    save(
        root,
        "m1-projection-started.json",
        &json!({"round":p.round,"version":env!("CARGO_PKG_VERSION"),"binarySha256":p.binary_sha256,"samples":SAMPLES,"models":0}),
    )?;
    let mut log = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("m1-projection-samples.jsonl"))
        .map_err(|e| e.to_string())?;
    let mut samples = Vec::with_capacity(SAMPLES);
    let result = execute(root, &p, &mut samples, &mut log);
    log.sync_all().map_err(|e| e.to_string())?;
    let mut report = match result {
        Ok(v) => v,
        Err(error) => {
            json!({"completed":false,"qualified":false,"passed":false,"error":error,"models":0})
        }
    };
    report["round"] = json!(p.round);
    report["version"] = json!(env!("CARGO_PKG_VERSION"));
    report["binarySha256"] = json!(p.binary_sha256);
    report["samples"] = json!(samples);
    save(root, "m1-projection-result.json", &report)?;
    if report["qualified"] != true {
        return Err("可比性或完整采样条件未满足，已保留结果".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_m1_plan_rejects_other_profiles_rounds_and_payloads() {
        let mut p = Plan {
            format: "hub-m1-projection-native-v1".into(),
            round: 1,
            records_sha256: "a".repeat(64),
            grant_sha256: "b".repeat(64),
            binary_sha256: "c".repeat(64),
            seed_snapshot: "analysis-v1:seed".into(),
            documents: vec![
                Document {
                    library_id: "notes".into(),
                    document_id: "a".into(),
                    sha256: "d".repeat(64),
                },
                Document {
                    library_id: "notes".into(),
                    document_id: "b".into(),
                    sha256: "e".repeat(64),
                },
            ],
        };
        let good = PathBuf::from(".local").join(FOLDER).join("round-1");
        assert!(validate_plan(&good, &p).is_ok());
        assert!(validate_plan(Path::new("personal/round-1"), &p).is_err());
        p.round = 4;
        assert!(validate_plan(&good, &p).is_err());
        p.round = 1;
        p.documents.pop();
        assert!(validate_plan(&good, &p).is_err());
    }
    #[test]
    fn full_sampling_overlap_and_unchanged_maximum_gate_are_required() {
        let sample = json!({"nativeTiming":{"projectionMs":150.0,"hostEpochMs":1000.0,"phases":(0..13).map(|i|json!({"phase":format!("p{i}"),"elapsedMs":i as f64})).collect::<Vec<_>>()},"state":"investigating","activeRun":RUN,"runActive":true});
        let mut rows: Vec<_> = (0..SAMPLES)
            .map(|i| {
                let mut s = sample.clone();
                s["index"] = json!(i);
                s
            })
            .collect();
        let original = rows.clone();
        let capture = json!({"itemsTotal":2,"byteCount":47,"dispatchStartEpochMs":800.0,"dispatchEndEpochMs":1100.0});
        assert!(passed(&rows, &capture));
        rows[3]["nativeTiming"]["projectionMs"] = json!(150.0001);
        assert!(!passed(&rows, &capture));
        rows.pop();
        assert!(!qualified(&rows, &capture));
        rows.push(json!({}));
        assert!(!qualified(&rows, &capture));
        assert!(!qualified(
            &original,
            &json!({"itemsTotal":2,"byteCount":47,"dispatchStartEpochMs":1001.0,"dispatchEndEpochMs":1100.0})
        ));
    }
    #[test]
    #[ignore = "one saved preflight qualification; no capture, samples, provider or performance score"]
    fn saved_m1_native_entry_qualification_once() {
        let root = PathBuf::from(std::env::var("HUB_M1_NATIVE_QUALIFICATION_ROOT").unwrap());
        let p: Plan =
            serde_json::from_slice(&fs::read(root.join("m1-projection-acceptance.json")).unwrap())
                .unwrap();
        let before = records(&root).unwrap();
        let (work, _) = preflight(&root, &p).unwrap();
        assert_eq!(work.grant.notes.len(), 2);
        assert_eq!(before, records(&root).unwrap());
        assert_eq!(p.round, 1);
    }
}
