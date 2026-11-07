//! One bounded, Work-owned extraction metric. Semantic reviews remain attributed
//! to the model/user; the host verifies provenance and computes accepted values.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

const MAX_SOURCE_ITEMS: usize = 32;
mod batch_summary;

pub(in crate::agent_work) fn schema() -> Value {
    let id = json!({"type":"string","minLength":1,"maxLength":180});
    let text = json!({"type":"string","minLength":1,"maxLength":800});
    let nullable = json!({"anyOf":[id,{"type":"null"}]});
    let review = object(
        json!({"kind":{"type":"string","enum":["modelReview","userCorrection"]},"sourceRef":nullable,"reason":{"type":"string","minLength":1,"maxLength":800,"description":"如实说明实际评审者和依据。模型自主阅读、判断均属模型语义评审，不得声称人工核对、人工确认或人工金标。userCorrection 仅用于当前 goalState 中真实用户命令的纠正，sourceRef 必须引用该命令；不能把模型自己的检查描述为用户确认。"}}),
    );
    let evidence = object(
        json!({"itemIndex":{"type":"integer","minimum":0,"maximum":MAX_SOURCE_ITEMS - 1},
        "sourceRevision":{"type":"object"},"contentHash":id,
        "start":{"type":"integer","minimum":0},"end":{"type":"integer","minimum":1},"text":text}),
    );
    let mut row = object(json!({"rowId":id,"eventRef":nullable,"rawValue":text,
        "normalizedValue":{"anyOf":[{"type":"number","minimum":0,"maximum":24},{"type":"null"}]},
        "unit":{"type":"string","enum":["hours"]},
        "valueKind":{"type":"string","enum":["exact","ambiguous","missing","conflicting"],"description":"按同一事件的完整上下文分类，与是否纳入分析分开判断。exact：明确且无未解决冲突的实际时长。ambiguous：有睡眠时长数值或起止时间线索，但因估计、范围、在床与实际睡眠区别或中途清醒等不能确定唯一精确实际时长；即使原文说不清楚，也不能仅据此标missing。missing：既无时长数值也无起止时间线索，仅未记录、未知或只有不含时长的定性叙述。conflicting：同一事件存在不能以明确更正关系消解的矛盾记载。明确更正可消解旧值，不自动构成conflicting。后三类normalizedValue必须为null，不纳入精确均值；保留具体不确定性和排除原因。没有睡眠事件材料时不为每个日期虚构missing行，未覆盖日期由coverage表达。"},
        "eventDate":{"anyOf":[{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},{"type":"null"}]},
        "timezone":{"type":"string","enum":["Asia/Shanghai","UTC"]},"dateBasis":{"type":"string","enum":["recordedDay","userSpecified","unknown"],"description":"recordedDay 按出处所在正文日期段；正文完全没有日期段时，可使用固定快照中无冲突的 YYYY-MM-DD.md 文件记录日。不得由自由标题、修改时间或模型猜测日期。"},
        "evidenceRefs":{"type":"array","minItems":1,"maxItems":4,"items":evidence},
        "reviewState":{"type":"string","enum":["proposed","accepted_for_analysis","rejected"]},"reviewBasis":review,
        "ambiguity":{"type":"string","maxLength":800},"exclusionReason":{"type":"string","maxLength":800},
        "correctionSource":{"anyOf":[review,{"type":"null"}],"description":"create 每行必须为 null。revise 改动已有行或新增行时必须填写实际评审来源：modelReview 的 sourceRef 为 null，reason 说明真实评审；userCorrection 的 sourceRef 必须来自当前 goalState 的真实用户命令，不是引文编号。新增行也需来源，但不能伪造被替代行。未改动行保留原字段，不重写历史。"},
        "supersedes":{"anyOf":[id,{"type":"null"}],"description":"create 每行及 revise 新增行必须为 null。revise 改动已有行时为字符串 expectedRevision:rowId，例如旧修订号 2、rowId 为 record-a，则填写 \"2:record-a\"；不是新修订号，不含 datasetId，不是单独 rowId 或对象。未改动行保留旧值及其它全部字段。"}}));
    row["description"] = json!("完整行对象：显式提供 required 中全部字段，包括合法的 null 和空字符串；缺字段不等于 null。日期和值使用 eventDate、normalizedValue，并提供单位、固定原文出处、归日和评审等其它必填字段；date/hours 不是可用别名，不由宿主推测转换。候选与精确值接受分开：本人明确醒来或被吵醒，即使没有时刻和时长，也可保留 missing/null 候选；只有晨起情绪、疲劳或在床不适不确认睡眠事件，保留歧义或非指标排除。不要只按睡眠关键词或有无数字筛选候选。");
    let fields = json!({"operationId":id,"methodRef":id,"inclusionRule":text,"dateRule":text,
        "rows":{"type":"array","maxItems":64,"items":row,"description":"create 与 revise 都提交完整行对象组成的 rows；revise 保留全部原行，不是按 rowId 合并字段或只提交改动字段。已读完本次候选时首次优先直接 create 完整 rows，无需先空建。空 rows 仍可表示空数据状态，但不代表抽取完成或形成可核对图表。"}});
    let mut create = fields.clone();
    create["action"] = json!({"type":"string","enum":["create"]});
    create["expectedSnapshot"] = id.clone();
    let mut revise = fields;
    revise["action"] = json!({"type":"string","enum":["revise"]});
    revise["datasetId"] = id.clone();
    revise["expectedRevision"] = json!({"type":"integer","minimum":1,"maximum":32,"description":"先 read 当前数据集，填写所读旧修订号；改动已有行的 supersedes 使用这个号和该行 rowId，不用提交后新修订号。"});
    json!({"anyOf":[object(create),object(revise),object(json!({"action":{"type":"string","enum":["read"]},"datasetId":id.clone(),"revision":{"type":"integer","minimum":1,"maximum":32}})),object(json!({"action":{"type":"string","enum":["batchSummary"]},"datasets":{"type":"array","minItems":1,"maxItems":8,"items":object(json!({"datasetId":id,"revision":{"type":"integer","minimum":1,"maximum":32}}))}}))],
        "description":"仅主睡眠时长 sleep_duration_hours，标准单位 hours。先读取固定快照原文，提交带 Unicode scalar [start,end) 出处的完整候选。主睡眠不含午睡；在床起止、六个多小时、冲突及缺失不得伪造精确值。接受依据必须注明 modelReview 或真实 userCorrection 来源。仅 accepted_for_analysis 的精确值聚合；不明事件键不能接受。已读完候选时可直接 create 完整 rows，无需先创建空数据集；create 每行 correctionSource/supersedes 均为 null。revise 保留全部行，改动已有行填写 correctionSource 和字符串 supersedes（expectedRevision:rowId）；新增行 correctionSource 必填、supersedes 为 null；未改动行保留全部原字段。排除旧行请标 rejected，不静默删除。数据修订后原图表失效，须 chart patch 绑定新 dataset revision 后 validate。当前单数据集最多32篇、每篇8000字符及64行。固定清单可按manifestBatch分批捕获、各自保存；batchSummary显式引用最多8个当前数据集修订，核对清单分区并汇总已接受精确行，不合并重叠材料/重复事件、不把空行或工具捕获当语义抽取完整。"})
}

// A compact, schema-derived checklist for the first prompt. It is metadata,
// never a candidate row, default values or evidence.
pub(in crate::agent_work) fn row_checklist() -> Value {
    let schema = schema();
    let row = &schema["anyOf"][0]["properties"]["rows"]["items"];
    json!({"kind":"requiredFieldChecklist","valuesProvided":false,
        "requiredFields":row["required"],
        "evidenceRequiredFields":row["properties"]["evidenceRefs"]["items"]["required"],
        "reviewRequiredFields":row["properties"]["reviewBasis"]["required"],
        "usage":"提交每行前逐项核对完整键清单，不能只交 eventDate/normalizedValue/rowId。此清单不是行数据或默认值；具体值、出处和评审必须由实际材料及当前用户要求提供，仍按工具 inputSchema 和领域门校验。"})
}

pub(super) fn binding_schema() -> Value {
    object(json!({"source":{"type":"string","enum":["sleepDataset"]},
        "expectedSnapshot":{"type":"string","minLength":1},"datasetId":{"type":"string","minLength":1},
        "datasetRevision":{"type":"integer","minimum":1,"maximum":32},
        "aggregation":{"type":"string","enum":["monthlyMean"]}}))
}

fn find_dataset(
    c: &Connection,
    work: &Work,
    id: &str,
    revision: Option<u64>,
) -> Result<Value, String> {
    records(c, &work.id, "sleepDatasetRevision")?
        .into_iter()
        .rev()
        .find(|v| v["datasetId"] == id && revision.is_none_or(|r| v["revision"] == r))
        .ok_or_else(|| "当前事项中不存在该睡眠数据集版本".into())
}

fn hash(value: &Value) -> String {
    let mut body = value.clone();
    body.as_object_mut().unwrap().remove("contentHash");
    digest(&body)
}

fn eligible_dataset(root: &Path, c: &Connection, work: &Work, value: &Value) -> Result<(), String> {
    if value["contentHash"] != hash(value)
        || value["authorizationVersion"] != work.authorization_version
        || work.state == "revoked"
    {
        return Err("睡眠数据集内容或授权已改变".into());
    }
    analysis::verify_in_transaction(
        &store::materials::grant_at(
            c,
            work,
            value["goalBinding"]["workRevision"]
                .as_i64()
                .ok_or("数据集事项版本缺失")?,
        )?
        .reader(root)?,
        c,
        &json!({"sleep":{"snapshot":value["snapshot"],"arguments":{"expectedSnapshot":value["snapshot"]}}}),
    )
}

fn projection(root: &Path, c: &Connection, work: &Work, value: Value) -> Result<Value, String> {
    eligible_dataset(root, c, work, &value)?;
    let current = find_dataset(
        c,
        work,
        value["datasetId"].as_str().ok_or("数据集身份损坏")?,
        None,
    )?;
    Ok(
        json!({"datasetId":value["datasetId"],"revision":value["revision"],"currentRevision":current["revision"],
        "state":if current["revision"]==value["revision"]{"current"}else{"stale"},"content":value,
        "verification":"Host checked source identity, coordinates and structure; semantic acceptance is attributed review, not objective certification."}),
    )
}

pub(in crate::agent_work) fn manifest_on(
    root: &Path,
    c: &Connection,
    work: &Work,
) -> Result<Value, String> {
    let mut latest = BTreeMap::new();
    for v in records(c, &work.id, "sleepDatasetRevision")? {
        latest.insert(
            v["datasetId"].as_str().ok_or("数据集身份损坏")?.to_owned(),
            v,
        );
    }
    Ok(json!(latest.into_values().filter_map(|v| {
        eligible_dataset(root,c,work,&v).ok()?;
        Some(json!({"datasetId":v["datasetId"],"revision":v["revision"],"snapshot":v["snapshot"],"metric":v["metric"],"coverage":v["coverage"],
            "sourceReview":{"interface":"currentWorkUi","requiresChart":false,"revision":v["revision"],"rows":v["rows"].as_array().map(Vec::len),
                "policy":"事项中的已保存睡眠数据提供每行固定原文入口，按数据版本核对；无需为了提供此入口在模型轮次逐行重复read。正文点击引用仍须使用本轮quoteCatalog。打开数据出处时仍检查授权、固定来源、期限和范围。"}}))
    }).collect::<Vec<_>>()))
}

pub(in crate::agent_work) fn view_on(
    root: &Path,
    c: &Connection,
    work: &Work,
) -> Result<Value, String> {
    if work.state == "revoked" {
        return Ok(json!([]));
    }
    let mut latest = BTreeMap::new();
    for value in records(c, &work.id, "sleepDatasetRevision")? {
        let id = value["datasetId"]
            .as_str()
            .ok_or("数据集身份损坏")?
            .to_owned();
        latest.insert(id, value);
    }
    Ok(json!(latest.into_values().map(|value| {
        projection(root,c,work,value.clone()).unwrap_or_else(|error|json!({
            "datasetId":value["datasetId"],"revision":value["revision"],"state":"unavailable","message":error}))
    }).collect::<Vec<_>>()))
}

// Exact persisted dataset revisions are readable with or without a chart.
// These UI reads add no model evidence and provide no budget exception.
pub(in crate::agent_work) fn reopen(root: &Path, args: &Value) -> Result<Value, String> {
    let id = text(args, "id", 150)?;
    let dataset = text(args, "datasetId", 100)?;
    let revision = args["revision"]
        .as_u64()
        .filter(|n| (1..=32).contains(n))
        .ok_or("数据版本无效")?;
    let mut c = crate::source_evidence::open_read_database(root)?;
    let tx = c.transaction().map_err(|error| error.to_string())?;
    let work = store::load(&tx, &id)?;
    let value = find_dataset(&tx, &work, &dataset, Some(revision))?;
    if args["action"] == "sleepDataset" {
        return projection(root, &tx, &work, value);
    }
    if args["action"] != "sleepDatasetSource" {
        return Err("未知睡眠数据操作".into());
    }
    eligible_dataset(root, &tx, &work, &value)?;
    let row = text(args, "rowId", 180)?;
    let index = args["evidenceIndex"]
        .as_u64()
        .and_then(|i| usize::try_from(i).ok())
        .ok_or("出处编号无效")?;
    let evidence = value["rows"]
        .as_array()
        .and_then(|rows| rows.iter().find(|item| item["rowId"] == row))
        .and_then(|item| item["evidenceRefs"].as_array())
        .and_then(|refs| refs.get(index))
        .ok_or("此数据版本中不存在指定出处")?;
    let start = evidence["start"].as_u64().ok_or("出处区间损坏")?;
    let end = evidence["end"]
        .as_u64()
        .filter(|end| *end >= start)
        .ok_or("出处区间损坏")?;
    let context_start = start.saturating_sub(160);
    let mut result = analysis::execute(
        &store::materials::grant_at(
            &tx,
            &work,
            value["goalBinding"]["workRevision"]
                .as_i64()
                .ok_or("数据集事项版本缺失")?,
        )?
        .reader(root)?,
        "hub_read_analysis_snapshot",
        &json!({"expectedSnapshot":value["snapshot"],"itemIndex":evidence["itemIndex"],"start":context_start,
            "limit":end.saturating_sub(context_start).saturating_add(160).min(8000)}),
    )?;
    result["evidence"] = evidence.clone();
    result["datasetId"] = json!(dataset);
    result["revision"] = json!(revision);
    Ok(result)
}

fn review_source(review: &Value, sources: &Value) -> Result<(), String> {
    match review["kind"].as_str() {
        Some("modelReview") if review["sourceRef"].is_null() => Ok(()),
        Some("userCorrection")
            if sources
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["requirementId"] == review["sourceRef"]) =>
        {
            Ok(())
        }
        _ => Err("评审来源必须是模型评审（无用户来源）或真实原始用户命令".into()),
    }
}

// Read every member through the existing snapshot owner, including its current
// authorization/deletion checks. Never substitute live text for captured text.
fn inputs(
    root: &Path,
    work: &Work,
    snapshot: &Value,
    control: &Control,
) -> Result<(Vec<Value>, Value), String> {
    let reader = work.grant.reader(root)?.controlled(control.clone());
    let listed = analysis::execute(
        &reader,
        "hub_list_note_sources",
        &json!({"expectedSnapshot":snapshot,"limit":MAX_SOURCE_ITEMS}),
    )?;
    if listed["total"]
        .as_u64()
        .is_none_or(|n| n == 0 || n > MAX_SOURCE_ITEMS as u64)
    {
        return Err(format!(
            "睡眠抽取当前仅支持1至{MAX_SOURCE_ITEMS}份固定材料；未保存，已有成果保留"
        ));
    }
    let notes = listed["notes"].as_array().ok_or("材料清单无效")?;
    if Some(notes.len() as u64) != listed["total"].as_u64() || !listed["nextOffset"].is_null() {
        return Err("固定材料清单不完整；未保存，已有成果保留".into());
    }
    let mut bodies = Vec::new();
    for item in notes {
        let mut body = analysis::execute(
            &reader,
            "hub_read_analysis_snapshot",
            &json!({"expectedSnapshot":snapshot,"itemIndex":item["itemIndex"],"start":0,"limit":8000}),
        )?;
        if !body["nextStart"].is_null() {
            return Err("睡眠抽取单篇超过8000字符；未保存，请缩小范围，不截断冒充完整读取".into());
        }
        // Captured metadata from the snapshot owner, never a model-supplied date.
        body["sourcePath"] = item["path"].clone();
        bodies.push(body);
    }
    Ok((bodies, listed["inputSet"].clone()))
}

// Only a canonical daily filename can supply a recorded day when the original
// body has no date sections. Keep text and Unicode evidence coordinates intact.
fn captured_file_day(body: &Value) -> Option<String> {
    fn canonical_day(value: &str) -> Option<String> {
        if value.len() != 10 {
            return None;
        }
        let date = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
        (date.to_string() == value).then(|| value.to_owned())
    }
    let filename = body["sourcePath"].as_str()?.rsplit(['/', '\\']).next()?;
    let (stem, extension) = filename.rsplit_once('.')?;
    if !extension.eq_ignore_ascii_case("md") {
        return None;
    }
    let day = canonical_day(stem)?;
    if body["title"]
        .as_str()
        .and_then(canonical_day)
        .is_some_and(|title_day| title_day != day)
    {
        return None;
    }
    Some(day)
}

fn validate_rows(
    rows: &[Value],
    bodies: &[Value],
    sources: &Value,
    previous: Option<&Value>,
) -> Result<Value, String> {
    let mut ids = BTreeSet::new();
    let mut events = BTreeSet::new();
    let mut occurrences = BTreeSet::new();
    let mut accepted_dates = BTreeSet::new();
    let mut all_dates = BTreeSet::new();
    let mut recognized = 0usize;
    let mut file_date_sections = 0usize;
    let mut unassigned = 0usize;
    let mut accepted_timezone: Option<&str> = None;
    for body in bodies {
        let text = body["content"].as_str().ok_or("固定原文无效")?;
        let headers = analysis::date_headers(text);
        if headers.is_empty() {
            if let Some(day) = captured_file_day(body) {
                recognized += 1;
                file_date_sections += 1;
                all_dates.insert(day);
                continue;
            }
        }
        recognized += headers.len();
        unassigned += headers.first().map_or_else(
            || text.chars().count(),
            |(_, start, _)| text[..*start].chars().count(),
        );
        for (date, _, _) in headers {
            all_dates.insert(date.to_string());
        }
    }
    let mut accepted = 0usize;
    for row in rows {
        let id = row["rowId"].as_str().ok_or("抽取行身份缺失")?;
        if !ids.insert(id) {
            return Err("抽取行身份重复".into());
        }
        review_source(&row["reviewBasis"], sources)?;
        if let Some(old) = previous {
            if let Some(old_row) = old["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["rowId"] == id)
            {
                if old_row != row {
                    if row["supersedes"] != format!("{}:{id}", old["revision"])
                        || row["correctionSource"].is_null()
                    {
                        return Err(format!("改动行必须保留 correctionSource 和 supersedes；rowId={id}：correctionSource 必须非空并注明合法 modelReview 或真实 userCorrection 来源；supersedes 必须为字符串 \"{}:{id}\"（expectedRevision:rowId），不能只填 rowId 或对象。", old["revision"]));
                    }
                    review_source(&row["correctionSource"], sources)?;
                }
            } else if !row["supersedes"].is_null() || row["correctionSource"].is_null() {
                return Err(format!("新增行需纠正来源，不能伪造被替代行；rowId={id}：revise 新增行的 correctionSource 必须非空（modelReview 的 sourceRef=null 并填写 reason；userCorrection 引用真实用户命令）；supersedes 必须为 null（不存在旧行）。"));
            } else {
                review_source(&row["correctionSource"], sources)?;
            }
        } else if !row["correctionSource"].is_null() || !row["supersedes"].is_null() {
            return Err("初始抽取不能伪造修订历史".into());
        }
        let date = row["eventDate"].as_str();
        if let Some(d) = date {
            chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(|_| "事件日期无效")?;
        }
        let is_accepted = row["reviewState"] == "accepted_for_analysis";
        let number = row["normalizedValue"].as_f64();
        if row["valueKind"] != "exact" && !row["normalizedValue"].is_null() {
            return Err("歧义、冲突或缺失值不得补零或伪造精度".into());
        }
        if row["valueKind"] == "exact"
            && number.is_none_or(|v| !v.is_finite() || !(0.0..=24.0).contains(&v))
        {
            return Err("精确主睡眠时长须为0至24小时".into());
        }
        if is_accepted
            && (row["valueKind"] != "exact"
                || date.is_none()
                || row["eventRef"].as_str().is_none()
                || row["ambiguity"] != ""
                || row["exclusionReason"] != "")
        {
            return Err("仅明确归日、事件身份和无歧义的精确主睡眠值可纳入".into());
        }
        if !is_accepted && row["ambiguity"] == "" && row["exclusionReason"] == "" {
            return Err("未纳入行须说明歧义或排除原因".into());
        }
        if is_accepted {
            let timezone = row["timezone"].as_str().unwrap();
            if accepted_timezone.is_some_and(|t| t != timezone) {
                return Err("同一聚合不可混用事件时区".into());
            }
            accepted_timezone = Some(timezone);
            if row["dateBasis"] == "unknown"
                || (row["dateBasis"] == "userSpecified"
                    && row["reviewBasis"]["kind"] != "userCorrection")
            {
                return Err("事件归日缺少明确依据".into());
            }
        }
        if is_accepted && !events.insert(row["eventRef"].as_str().unwrap()) {
            return Err("同一主睡眠事件不能重复纳入".into());
        }
        for e in row["evidenceRefs"].as_array().ok_or("抽取出处缺失")? {
            let body = bodies
                .iter()
                .find(|b| b["itemIndex"] == e["itemIndex"])
                .ok_or("出处不在固定材料内")?;
            let text = body["content"].as_str().unwrap();
            let start = e["start"].as_u64().ok_or("出处起点无效")? as usize;
            let end = e["end"].as_u64().ok_or("出处终点无效")? as usize;
            if end <= start
                || end > text.chars().count()
                || e["text"]
                    != text
                        .chars()
                        .skip(start)
                        .take(end - start)
                        .collect::<String>()
                || e["sourceRevision"] != body["sourceRevision"]
                || e["contentHash"] != body["sourceRevision"]["bodySha256"]
            {
                return Err("出处坐标、片段或来源版本不一致（Unicode scalar [start,end)）".into());
            }
            if is_accepted && row["dateBasis"] == "recordedDay" {
                let headers = analysis::date_headers(text);
                let start_byte = text
                    .char_indices()
                    .nth(start)
                    .map_or(text.len(), |(i, _)| i);
                let end_byte = text.char_indices().nth(end).map_or(text.len(), |(i, _)| i);
                let section =
                    headers
                        .iter()
                        .enumerate()
                        .find(|(i, (_, heading_start, body_start))| {
                            start_byte >= *heading_start
                                && end_byte > *body_start
                                && end_byte <= headers.get(i + 1).map_or(text.len(), |(_, s, _)| *s)
                        });
                let matches_date = if headers.is_empty() {
                    captured_file_day(body).as_deref() == date
                } else {
                    section.is_some_and(|(_, (d, _, _))| Some(d.to_string()).as_deref() == date)
                };
                if !matches_date {
                    return Err("事件归日与出处所在日期段不一致".into());
                }
            }
            // Same occurrence under different event IDs must not be counted twice.
            if is_accepted && !occurrences.insert(format!("{}:{start}:{end}", e["itemIndex"])) {
                return Err("相同原文出现位置不能重复纳入".into());
            }
        }
        if is_accepted {
            accepted += 1;
            accepted_dates.insert(date.unwrap().to_owned());
        }
    }
    if let Some(old) = previous {
        if old["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| !ids.contains(r["rowId"].as_str().unwrap()))
        {
            return Err("修订不可静默删除旧行；请保留并说明排除原因".into());
        }
    }
    let mut coverage = json!({"material":{"read":bodies.len(),"matched":bodies.len(),"basis":"hostReadAllCapturedMembers"},
        "dates":{"recognizedSections":recognized,"uniqueDates":all_dates.len(),"unassignedCharacters":unassigned,"denominator":"captured date headings; undated text is not assigned a date"},
        "metric":{"candidates":rows.len(),"accepted":accepted,"excluded":rows.len()-accepted,
            "missing":rows.iter().filter(|r|r["valueKind"]=="missing").count(),"ambiguous":rows.iter().filter(|r|r["valueKind"]=="ambiguous").count(),"conflicting":rows.iter().filter(|r|r["valueKind"]=="conflicting").count(),
            "datesWithoutAcceptedValue":all_dates.difference(&accepted_dates).count(),"denominator":"candidate events; accepted exact main-sleep events only, never imputed zero"},
        "history":{"status":"unknown","basis":"authorized captured local cache, not a complete calendar or remote history"}});
    if file_date_sections > 0 {
        coverage["dates"]["fileDateSections"] = json!(file_date_sections);
        coverage["dates"]["headingSections"] = json!(recognized - file_date_sections);
        coverage["dates"]["policy"] = json!("capturedFilenameFallback-v1");
        coverage["dates"]["denominator"] = json!("captured date headings; only heading-free bodies may use an unambiguous canonical daily filename; other undated text is not assigned a date");
    }
    Ok(coverage)
}

pub(in crate::agent_work) fn execute(
    root: &Path,
    work: &Work,
    run: &str,
    request: &Value,
    control: &Control,
) -> Result<Value, String> {
    crate::model_runtime::validate_agent_tool(request, &schema())?;
    store::check_run(root, work, run)?;
    control.check()?;
    if request.to_string().len() > 32_768 {
        return Err("睡眠抽取请求超过有界容量，未保存".into());
    }
    let c = crate::source_evidence::open_read_database(root)?;
    if request["action"] == "batchSummary" {
        c.execute_batch("BEGIN DEFERRED")
            .map_err(|e| e.to_string())?;
        return batch_summary::summarize(root, &c, work, request, control);
    }
    if request["action"] == "read" {
        let value = find_dataset(
            &c,
            work,
            request["datasetId"].as_str().unwrap(),
            request["revision"].as_u64(),
        )?;
        drop(c);
        return store::write(root, |c| {
            let current = check_current(c, work, run, control)?;
            projection(root, c, &current, value)
        });
    }
    let request_hash = digest(request);
    if let Some(old) = records(&c, &work.id, "sleepDatasetRevision")?
        .into_iter()
        .find(|v| v["operationId"] == request["operationId"])
    {
        if old["requestHash"] != request_hash {
            return Err("operationId 已用于不同抽取请求".into());
        }
        drop(c);
        return store::write(root, |c| {
            let current = check_current(c, work, run, control)?;
            projection(root, c, &current, old)
        });
    }
    let previous = if request["action"] == "revise" {
        Some(find_dataset(
            &c,
            work,
            request["datasetId"].as_str().unwrap(),
            None,
        )?)
    } else {
        None
    };
    if let Some(old) = &previous {
        eligible_dataset(root, &c, work, old)?;
        if old["revision"] != request["expectedRevision"] {
            return Err("睡眠数据集版本冲突，请重读".into());
        }
    }
    let snapshot = previous
        .as_ref()
        .map(|v| v["snapshot"].clone())
        .unwrap_or(request["expectedSnapshot"].clone());
    let binding = store::goal::for_run(root, work, run)?;
    let (bodies, input_set) = inputs(root, work, &snapshot, control)?;
    let sources = store::goal::completion::sources_on(&c, work)?;
    let coverage = validate_rows(
        request["rows"].as_array().unwrap(),
        &bodies,
        &sources,
        previous.as_ref(),
    )?;
    let revision = previous
        .as_ref()
        .map_or(1, |v| v["revision"].as_u64().unwrap() + 1);
    if revision > 32 {
        return Err("睡眠数据集已到32版上限，原版本保留".into());
    }
    let id = previous
        .as_ref()
        .map(|v| v["datasetId"].clone())
        .unwrap_or(json!(format!("sleep-{}", crate::random_url_safe(18))));
    let mut value = json!({"schemaVersion":1,"datasetId":id,"revision":revision,"workId":work.id,"snapshot":snapshot,
        "scopeRevision":input_set["scopeRevision"],"authorizationVersion":work.authorization_version,
        "metric":"sleep_duration_hours","unit":"hours","methodRef":request["methodRef"],"parserVersion":input_set["parserVersion"],"offsetUnit":"unicodeScalarValue",
        "inclusionRule":request["inclusionRule"],"dateRule":request["dateRule"],"rows":request["rows"],"coverage":coverage,"inputSet":input_set,
        "operationId":request["operationId"],"requestHash":request_hash,"goalBinding":binding,"createdAt":chrono::Utc::now().timestamp_millis()});
    value["contentHash"] = json!(hash(&value));
    if value.to_string().len() > 40_000 {
        return Err("睡眠数据集超过当前持久化容量，原版本保留".into());
    }
    drop(c);
    store::write(root, |c| {
        let current = check_current(c, work, run, control)?;
        store::goal::ensure_binding_on(c, &current, &binding)?;
        eligible_dataset(root, c, &current, &value)?;
        let all = records(c, &work.id, "sleepDatasetRevision")?;
        if let Some(old) = all
            .iter()
            .find(|v| v["operationId"] == request["operationId"])
        {
            if old["requestHash"] != request_hash {
                return Err("operationId 已用于不同抽取请求".into());
            }
            return projection(root, c, &current, old.clone());
        }
        if previous.is_some() {
            if find_dataset(c, &current, id.as_str().unwrap(), None)?["revision"]
                != request["expectedRevision"]
            {
                return Err("睡眠数据集版本冲突，请重读".into());
            }
        } else if all.iter().filter(|v| v["revision"] == 1).count() >= 4 {
            return Err("本事项睡眠数据集已达4份上限".into());
        }
        insert(c, &current, run, "sleepDatasetRevision", &value)?;
        store::tasks::revalidate_on(root, c, &current)?;
        projection(root, c, &current, value)
    })
}

pub(super) fn current_on(c: &Connection, work: &Work, input: &Value) -> Result<bool, String> {
    if input["source"] != "sleepDataset" {
        return Ok(true);
    }
    Ok(find_dataset(
        c,
        work,
        input["datasetId"].as_str().ok_or("数据集身份缺失")?,
        None,
    )?["revision"]
        == input["datasetRevision"])
}

pub(super) fn verify_binding(
    root: &Path,
    c: &Connection,
    work: &Work,
    input: &Value,
) -> Result<(), String> {
    if input["source"] != "sleepDataset" {
        return Ok(());
    }
    let v = find_dataset(
        c,
        work,
        input["datasetId"].as_str().ok_or("数据集身份缺失")?,
        input["datasetRevision"].as_u64(),
    )?;
    eligible_dataset(root, c, work, &v)?;
    if input["expectedSnapshot"] != v["snapshot"] {
        return Err("图表与睡眠数据集快照不一致".into());
    }
    Ok(())
}

pub(super) fn compute(
    root: &Path,
    work: &Work,
    input: &Value,
    spec: &Value,
    control: &Control,
) -> Result<Value, String> {
    control.check()?;
    let c = crate::source_evidence::open_read_database(root)?;
    verify_binding(root, &c, work, input)?;
    if !current_on(&c, work, input)? {
        return Err("睡眠数据集已修订，需绑定最新版本重新计算".into());
    }
    if spec["metric"] != "sleep_duration_hours"
        || !spec["term"].is_null()
        || input["aggregation"] != "monthlyMean"
    {
        return Err("主睡眠图表仅支持明确的 monthlyMean 小时均值，不接受关键词或其他聚合".into());
    }
    let v = find_dataset(
        &c,
        work,
        input["datasetId"].as_str().unwrap(),
        input["datasetRevision"].as_u64(),
    )?;
    let mut groups: BTreeMap<String, (f64, usize)> = BTreeMap::new();
    for row in v["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["reviewState"] == "accepted_for_analysis")
    {
        let day = chrono::NaiveDate::parse_from_str(
            row["eventDate"].as_str().ok_or("事件日期缺失")?,
            "%Y-%m-%d",
        )
        .map_err(|_| "事件日期损坏")?;
        let entry = groups.entry(day.format("%Y-%m").to_string()).or_default();
        entry.0 += row["normalizedValue"].as_f64().ok_or("睡眠数值损坏")?;
        entry.1 += 1;
    }
    if groups.is_empty() {
        return Err("没有可纳入的精确主睡眠时长；不将缺失或歧义补零，数据集已保留供核对".into());
    }
    let mut rows = groups
        .into_iter()
        .map(|(group, (sum, n))| json!({"group":group,"value":sum/n as f64,"sampleCount":n}))
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        let group = a["group"].as_str().cmp(&b["group"].as_str());
        match spec["sort"].as_str() {
            Some("groupDesc") => group.reverse(),
            Some("valueAsc") => a["value"]
                .as_f64()
                .unwrap()
                .total_cmp(&b["value"].as_f64().unwrap())
                .then(group),
            Some("valueDesc") => b["value"]
                .as_f64()
                .unwrap()
                .total_cmp(&a["value"].as_f64().unwrap())
                .then(group),
            _ => group,
        }
    });
    Ok(
        json!({"datasetRevision":digest(&json!({"input":input,"contentHash":v["contentHash"]})),"extractionDataset":{"datasetId":v["datasetId"],"revision":v["revision"],"metric":v["metric"],"aggregation":"monthlyMean","methodRef":v["methodRef"],"inclusionRule":v["inclusionRule"],"dateRule":v["dateRule"],"rows":v["rows"],"coverage":v["coverage"]},
        "statistics":{"documentsAnalyzed":v["coverage"]["material"]["read"],"inputSet":v["inputSet"],"unassignedCharacters":v["coverage"]["dates"]["unassignedCharacters"],"duplicateDateSections":v["coverage"]["dates"]["recognizedSections"].as_u64().unwrap()-v["coverage"]["dates"]["uniqueDates"].as_u64().unwrap()},"rows":rows,"unit":"主睡眠平均时长（小时）"}),
    )
}

pub(in crate::agent_work) fn verify_batch_summary_on(
    root: &Path,
    c: &Connection,
    work: &Work,
    value: &Value,
) -> Result<(), String> {
    batch_summary::verify_saved(root, c, work, value)
}
