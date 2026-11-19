//! Read previously executed results with the same input checks as file artifacts.
use super::*;
use std::collections::{BTreeMap, HashSet};

const MAX_RECORDS: usize = 32;

#[derive(Default)]
struct CellSamples {
    title: String,
    batches: Vec<(u64, u64, Value)>,
    coordinates: HashSet<(String, String)>,
    by_sheet: BTreeMap<String, usize>,
    duplicates: usize,
    invalid: usize,
    overlap: bool,
}

type Coordinate = (String, String, bool);

fn cell_coordinate(row: &Value) -> Option<Coordinate> {
    let fields = row.as_array()?;
    let sheet = fields.first()?.as_str()?;
    let source_row = fields.get(1)?;
    let address = fields.get(2)?.as_str()?;
    let (column, address_row) = address.split_at(address.find(|c: char| c.is_ascii_digit())?);
    if column.is_empty() || !column.bytes().all(|c| c.is_ascii_uppercase()) || sheet.is_empty() {
        return None;
    }
    let address_row = address_row.parse::<u64>().ok().filter(|row| *row != 0)?;
    let source_row = source_row
        .as_u64()
        .or_else(|| source_row.as_str()?.parse().ok())?;
    Some((sheet.into(), address.into(), address_row == source_row))
}

impl CellSamples {
    fn add(&mut self, receipt: &Value, output: &Value) -> Option<()> {
        let start = output["start"].as_u64().filter(|start| *start > 0)?;
        let rows = output["details"]
            .as_array()
            .filter(|rows| !rows.is_empty())?;
        let count = output["count"]
            .as_u64()
            .filter(|count| *count == rows.len() as u64)?;
        let end = start.checked_add(count - 1)?;
        let coordinates = rows
            .iter()
            .map(cell_coordinate)
            .collect::<Option<Vec<_>>>()?;
        self.overlap |= self
            .batches
            .iter()
            .any(|(a, b, _)| *a <= end && start <= *b);
        self.batches
            .push((start, end, receipt["executionId"].clone()));
        for (sheet, address, matches) in coordinates {
            *self.by_sheet.entry(sheet.clone()).or_default() += 1;
            self.duplicates += usize::from(!self.coordinates.insert((sheet, address)));
            self.invalid += usize::from(!matches);
        }
        Some(())
    }

    fn summary(mut self) -> Value {
        self.batches.sort_unstable_by_key(|(start, _, _)| *start);
        let batches: Vec<_> = self
            .batches
            .iter()
            .map(|(a, b, id)| {
                json!({
                    "firstRecord":a,"lastRecord":b,"executionId":id
                })
            })
            .collect();
        json!({"input":self.title,"batches":batches,"overlappingBatches":self.overlap,
            "sampledRecords":(!self.overlap).then(||self.by_sheet.values().sum::<usize>()),
            "bySheet":(!self.overlap).then_some(self.by_sheet),
            "duplicateCoordinates":(!self.overlap).then_some(self.duplicates),
            "rowNumberMismatches":(!self.overlap).then_some(self.invalid)})
    }
}

fn compact_fields(output: &Value) -> Value {
    let fields = output
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, value)| key.len() <= 80 && value.to_string().len() <= 320)
        .take(6)
        .map(|(key, value)| (key.clone(), value.clone()));
    Value::Object(fields.collect())
}

pub(in crate::agent_work) fn saved(root: &Path, work: &Work) -> Result<Value, String> {
    let c = crate::source_evidence::open_read_database(root)?;
    let current = store::load(&c, &work.id)?;
    if current.state == "revoked"
        || current.revision != work.revision
        || current.authorization_version != work.authorization_version
    {
        return Err("事项或资料授权已变化，未返回分析结果".into());
    }
    let mut q = c.prepare("SELECT body_json FROM agent_records WHERE work_id=?1 AND kind IN ('analysisExecution','analysisInspection') ORDER BY rowid DESC LIMIT ?2").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![work.id, MAX_RECORDS + 1], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<Value>, String>>()?;
    let mut verifier = dependencies::Verifier::new(root, &current);
    let mut revisions = HashSet::new();
    let mut results = Vec::new();
    let mut cell_samples = BTreeMap::<(String, String), CellSamples>::new();
    let mut unavailable = 0;
    for receipt in rows.iter().take(MAX_RECORDS) {
        if let Some(artifact) = receipt["artifactId"].as_str() {
            if !revisions.insert(artifact) {
                continue;
            }
        }
        if receipt["output"]["exitCode"] != 0
            || !receipt["inputs"].is_array()
            || verifier.verify(receipt).is_err()
        {
            unavailable += 1;
            continue;
        }
        let inputs = receipt["inputs"].as_array().unwrap();
        let output = &receipt["output"]["output"];
        let filenames: Vec<_> = inputs.iter().map(|input| &input["title"]).collect();
        let mut batch = false;
        if let [input] = inputs.as_slice() {
            if let (Some(hash), Some(title)) = (input["sha256"].as_str(), input["title"].as_str()) {
                let group = cell_samples
                    .entry((dependencies::id(input), hash.into()))
                    .or_default();
                group.title = title.into();
                batch = group.add(receipt, output).is_some();
            }
        }
        if !batch {
            let fields = compact_fields(output);
            if fields.as_object().is_some_and(|v| !v.is_empty()) && results.len() < 8 {
                results.push(
                    json!({"executionId":receipt["executionId"],"artifactId":receipt["artifactId"],
                    "revision":receipt["revision"],"inputs":filenames,"fields":fields}),
                );
            }
        }
    }
    let samples: Vec<_> = cell_samples
        .into_values()
        .filter(|sample| !sample.batches.is_empty())
        .map(CellSamples::summary)
        .collect();
    Ok(
        json!({"results":results,"cellSamples":samples,"unavailableCount":unavailable,
        "earlierExecutionsOmitted":rows.len()>MAX_RECORDS,
        "meaning":"从同一事项仍可核对输入版本的历史执行回执中读取。单元格汇总由留存的行字面值复核，范围按 CSV 数据记录编号，可能有间隔。批次重叠时不合计。回读未重新执行脚本，不能证明全表或其他版本。"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_cell_samples_count_cross_batch_coordinates_and_withhold_overlapping_totals() {
        let receipt = json!({"executionId":"one"});
        let first = json!({"start":1,"count":2,"details":[["Main",1,"A1"],["Main",2,"A2"]]});
        let separate = json!({"start":4,"count":2,"details":[["Main",1,"A1"],["Other",3,"B4"]]});
        let overlapping = json!({"start":2,"count":1,"details":[["Main",2,"A2"]]});

        let mut samples = CellSamples::default();
        samples.add(&receipt, &first).unwrap();
        samples
            .add(&json!({"executionId":"two"}), &separate)
            .unwrap();
        let summary = samples.summary();
        assert_eq!(summary["sampledRecords"], 4);
        assert_eq!(summary["bySheet"], json!({"Main":3,"Other":1}));
        assert_eq!(summary["duplicateCoordinates"], 1);
        assert_eq!(summary["rowNumberMismatches"], 1);
        assert_eq!(summary["batches"][1]["firstRecord"], 4);

        let mut samples = CellSamples::default();
        samples.add(&receipt, &first).unwrap();
        samples
            .add(&json!({"executionId":"three"}), &overlapping)
            .unwrap();
        let summary = samples.summary();
        assert_eq!(summary["overlappingBatches"], true);
        assert!(summary["sampledRecords"].is_null());
        assert!(summary["bySheet"].is_null());
    }
}
