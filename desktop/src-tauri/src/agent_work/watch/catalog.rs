//! A schedule compares Hub's local index, using exact identities and versions.
use super::*;
use std::collections::BTreeMap;

const MAX_CHANGES: usize = 12;
type Inventory = BTreeMap<String, String>;

pub(super) fn prepare(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_watch_catalogs(
        work_id TEXT PRIMARY KEY REFERENCES agent_works(id),
        inventory_json TEXT NOT NULL);",
    )?;
    c.prepare("SELECT work_id,inventory_json FROM agent_watch_catalogs LIMIT 0")?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    locator: EvidenceLocator,
    kind: &'static str,
    version: Option<String>,
}

fn load(c: &Connection, id: &str) -> Result<Inventory, String> {
    let raw: String = c
        .query_row(
            "SELECT inventory_json FROM agent_watch_catalogs WHERE work_id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|_| "缺少资料库复查基线，请重新设置定时复查")?;
    serde_json::from_str(&raw).map_err(|_| "资料库复查基线不可用".into())
}

fn save(c: &Connection, id: &str, entries: &Inventory) -> Result<(), String> {
    let data = serde_json::to_string(entries).map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO agent_watch_catalogs(work_id,inventory_json) VALUES(?1,?2)
         ON CONFLICT(work_id) DO UPDATE SET inventory_json=excluded.inventory_json",
        params![id, data],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn current(root: &Path, c: &Connection, work: &Work) -> Result<Inventory, String> {
    work.grant
        .reader(root)?
        .scheduled_library_inventory(c)?
        .into_iter()
        .map(|(locator, version)| {
            serde_json::to_string(&locator)
                .map(|key| (key, version))
                .map_err(|e| e.to_string())
        })
        .collect()
}

pub(super) fn capture(root: &Path, c: &Connection, work: &Work) -> Result<(), String> {
    // Existing databases can first use this optional feature after upgrading.
    prepare(c).map_err(|error| error.to_string())?;
    save(c, &work.id, &current(root, c, work)?)
}

pub(super) fn delta(root: &Path, c: &Connection, work: &Work) -> Result<Value, String> {
    let before = load(c, &work.id)?;
    let after = current(root, c, work)?;
    let changed = after
        .iter()
        .filter_map(|(key, version)| match before.get(key) {
            Some(previous) if previous == version => None,
            Some(_) => Some((key, "changed", Some(version.clone()))),
            None => Some((key, "added", Some(version.clone()))),
        });
    let removed = before
        .keys()
        .filter(|key| !after.contains_key(*key))
        .map(|key| (key, "missing", None));
    let mut count = 0;
    let mut changes = Vec::new();
    for (key, kind, version) in changed.chain(removed) {
        count += 1;
        if changes.len() < MAX_CHANGES {
            let locator = serde_json::from_str(key).map_err(|_| "资料定位记录不可用")?;
            changes.push(Change {
                locator,
                kind,
                version,
            });
        }
    }
    Ok(json!({"changes":changes,"remaining":count-changes.len(),"coverage":"authorizedLocalCache"}))
}

pub(super) fn advance(
    root: &Path,
    c: &Connection,
    work: &Work,
    delta: &Value,
) -> Result<(), String> {
    let mut baseline = load(c, &work.id)?;
    let after = current(root, c, work)?;
    for change in delta["changes"].as_array().into_iter().flatten() {
        let locator: EvidenceLocator = serde_json::from_value(change["locator"].clone())
            .map_err(|_| "定时复查的资料定位无效")?;
        let key = serde_json::to_string(&locator).map_err(|e| e.to_string())?;
        match (change["version"].as_str(), after.get(&key)) {
            (Some(expected), Some(actual)) if actual == expected => {
                baseline.insert(key, actual.clone());
            }
            (None, None) => {
                baseline.remove(&key);
            }
            _ => (),
        }
    }
    save(c, &work.id, &baseline)
}
