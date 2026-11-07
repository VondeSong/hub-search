//! A page shares library metadata and loads item receipts in bounded queries.
use super::*;
use std::collections::HashMap;

type Library = (String, String, Option<String>, bool);
struct Projection {
    libraries: HashMap<String, Library>,
    roots: HashMap<String, String>,
    exports: HashMap<String, Option<String>>,
    lifecycle: HashMap<String, (String, Option<String>)>,
    destinations: HashMap<String, Vec<(String, String)>>,
    operations: HashMap<String, Value>,
    attention: HashMap<String, Vec<Value>>,
    base: storage::StorageConfig,
}

impl Projection {
    fn load(c: &Connection, keys: &[String]) -> Result<Self, String> {
        let keys = serde_json::to_string(keys).map_err(|e| e.to_string())?;
        let mut result = Self {
            libraries: HashMap::new(),
            roots: HashMap::new(),
            exports: HashMap::new(),
            lifecycle: HashMap::new(),
            destinations: HashMap::new(),
            operations: HashMap::new(),
            attention: HashMap::new(),
            base: storage::config(c)?,
        };
        if has_libraries(c)? {
            let mut s = c
                .prepare("SELECT id,provider,name,location,enabled FROM libraries")
                .map_err(|e| e.to_string())?;
            for row in s
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        (
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, Option<String>>(3)?,
                            r.get::<_, bool>(4)?,
                        ),
                    ))
                })
                .map_err(|e| e.to_string())?
            {
                let (key, value) = row.map_err(|e| e.to_string())?;
                result.libraries.insert(key, value);
            }
        }
        let mut s = c
            .prepare("SELECT destination,root FROM collection_roots")
            .map_err(|e| e.to_string())?;
        for row in s
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
        {
            let (key, value) = row.map_err(|e| e.to_string())?;
            result.roots.insert(key, value);
        }
        let mut s = c.prepare("SELECT e.item_key,r.root FROM collection_obsidian_exports e LEFT JOIN collection_roots r ON r.destination=e.destination
            WHERE e.item_key IN (SELECT value FROM json_each(?1)) ORDER BY e.local_seq DESC").map_err(|e| e.to_string())?;
        for row in s
            .query_map([&keys], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| e.to_string())?
        {
            let (key, value) = row.map_err(|e| e.to_string())?;
            result.exports.entry(key).or_insert(value);
        }
        let mut s = c.prepare("SELECT item_key,state,destination FROM collection_lifecycle WHERE item_key IN (SELECT value FROM json_each(?1))").map_err(|e| e.to_string())?;
        for row in s
            .query_map([&keys], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?),
                ))
            })
            .map_err(|e| e.to_string())?
        {
            let (key, value) = row.map_err(|e| e.to_string())?;
            result.lifecycle.insert(key, value);
        }
        let mut s = c.prepare("SELECT item_key,target,state FROM collection_library_destinations WHERE selected=1 AND item_key IN (SELECT value FROM json_each(?1)) ORDER BY local_seq").map_err(|e| e.to_string())?;
        for row in s
            .query_map([&keys], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
        {
            let (key, target, state) = row.map_err(|e| e.to_string())?;
            result
                .destinations
                .entry(key)
                .or_default()
                .push((target, state));
        }
        let mut s = c.prepare("SELECT item_key,action,target,phase,error,detail FROM collection_library_jobs
            WHERE item_key IN (SELECT value FROM json_each(?1)) AND (action<>'move' OR NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_jobs.item_key AND d.target=collection_library_jobs.target AND d.selected=0))").map_err(|e| e.to_string())?;
        for row in s.query_map([&keys], |r| Ok((r.get::<_,String>(0)?,json!({"action":r.get::<_,String>(1)?,"target":r.get::<_,String>(2)?,"phase":r.get::<_,String>(3)?,"error":r.get::<_,String>(4)?,"detail":r.get::<_,String>(5)?})))).map_err(|e| e.to_string())? {
            let (key,value) = row.map_err(|e| e.to_string())?; result.operations.insert(key,value);
        }
        let blocked = super::super::query::BLOCKED_OPERATION;
        let mut s = c.prepare(&format!("SELECT item_key,action,target,phase,error,plan,detail,0 AS parked,updated_at FROM collection_library_jobs
            WHERE item_key IN (SELECT value FROM json_each(?1)) AND {blocked} AND NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_jobs.item_key AND d.target=collection_library_jobs.target AND d.selected=0)
            UNION ALL SELECT item_key,action,target,phase,error,plan,detail,1 AS parked,updated_at FROM collection_library_pending
            WHERE item_key IN (SELECT value FROM json_each(?1)) AND {blocked} AND NOT EXISTS(SELECT 1 FROM collection_library_destinations d WHERE d.item_key=collection_library_pending.item_key AND d.target=collection_library_pending.target AND d.selected=0)
            ORDER BY updated_at DESC")).map_err(|e| e.to_string())?;
        for row in s.query_map([&keys], |r| Ok((r.get::<_,String>(0)?,json!({"key":r.get::<_,String>(0)?,"action":r.get::<_,String>(1)?,"target":r.get::<_,String>(2)?,"phase":r.get::<_,String>(3)?,"error":r.get::<_,String>(4)?,"plan":serde_json::from_str::<Value>(&r.get::<_,String>(5)?).unwrap_or(Value::Null),"detail":r.get::<_,String>(6)?,"parked":r.get::<_,bool>(7)?})))).map_err(|e| e.to_string())? {
            let (key,mut value) = row.map_err(|e| e.to_string())?; operation_error(&mut value); result.attention.entry(key).or_default().push(value);
        }
        Ok(result)
    }

    fn obsidian(&self, root: &str, inherited: bool) -> Value {
        let found = self
            .libraries
            .iter()
            .filter(|(_, (provider, _, location, enabled))| {
                !root.is_empty()
                    && *enabled
                    && provider == "obsidian"
                    && location.as_deref().is_some_and(|path| {
                        normalized_vault_path(path) == normalized_vault_path(root)
                    })
            })
            .min_by_key(|(id, _)| *id);
        let (id, name) = found
            .map(|(id, (_, name, _, _))| (Some(id.as_str()), name.clone()))
            .unwrap_or_else(|| {
                (
                    None,
                    root.trim_end_matches(['/', '\\'])
                        .rsplit(['/', '\\'])
                        .find(|part| !part.is_empty())
                        .unwrap_or("Obsidian")
                        .to_string(),
                )
            });
        json!({"kind":"obsidian","name":name,"path":root,"libraryId":id,"isDefault":inherited})
    }

    fn location(&self, key: &str, chosen: Option<&str>) -> Value {
        if chosen == Some("hub") {
            return json!({"kind":"hub","name":"Hub 本地数据库","isDefault":false});
        }
        if let Some(hash) = chosen.and_then(|id| id.strip_prefix("vault:")) {
            return self.obsidian(
                self.roots.get(hash).map(String::as_str).unwrap_or(""),
                false,
            );
        }
        if let Some(id) = chosen {
            return match self.libraries.get(id) {
                Some((kind, name, path, enabled)) => {
                    json!({"kind":kind,"name":name,"path":path,"libraryId":enabled.then_some(id),"isDefault":false})
                }
                None => json!({"kind":"library","name":"未连接的资料库","isDefault":false}),
            };
        }
        if let Some(root) = self.exports.get(key) {
            return self.obsidian(root.as_deref().unwrap_or(""), false);
        }
        self.default_location()
    }

    fn default_location(&self) -> Value {
        if self.base.mode == "obsidian" {
            self.obsidian(&self.base.vault_path, true)
        } else {
            json!({"kind":"hub","name":"Hub 本地数据库","isDefault":true})
        }
    }

    fn decorate(&self, key: &str, value: &mut Value) {
        let life = self.lifecycle.get(key);
        value["lifecycle"] = json!(life.map(|v| v.0.as_str()).unwrap_or("active"));
        let location = self.location(key, life.and_then(|v| v.1.as_deref()));
        value["destinationId"] = location["libraryId"].clone();
        value["storageLocation"] = location;
        let mut locations = vec![self.default_location()];
        if let Some(copies) = self.destinations.get(key) {
            for (target, state) in copies {
                let mut location = self.location(key, Some(target));
                location["target"] = json!(target);
                location["copyState"] = json!(state);
                if state == "queued" {
                    if let Some(job) = self
                        .operations
                        .get(key)
                        .filter(|job| job["target"].as_str() == Some(target.as_str()))
                    {
                        let phase = job["phase"].as_str().unwrap_or("");
                        let error = job["error"].as_str().unwrap_or("");
                        location["copyState"] = json!(if !error.is_empty()
                            || matches!(phase, "partial" | "failed" | "unknown" | "needs_review")
                        {
                            "blocked"
                        } else if matches!(phase, "planning" | "saving" | "writing" | "cleanup") {
                            "running"
                        } else {
                            "queued"
                        });
                    }
                }
                if !locations.iter().any(|l| {
                    l["libraryId"].is_string() && l["libraryId"] == location["libraryId"]
                        || l["kind"] == location["kind"]
                            && l["path"].is_string()
                            && location["path"].as_str().is_some_and(|path| {
                                normalized_vault_path(path)
                                    == normalized_vault_path(l["path"].as_str().unwrap())
                            })
                        || l["kind"] == "hub" && location["kind"] == "hub"
                }) {
                    locations.push(location);
                }
            }
        }
        value["destinationIds"] = json!(locations
            .iter()
            .filter_map(|l| l["libraryId"].as_str())
            .collect::<Vec<_>>());
        value["storageLocations"] = json!(locations);
        let mut operation = self.operations.get(key).cloned().unwrap_or(Value::Null);
        operation_error(&mut operation);
        value["operation"] = operation;
        value["attentionOperations"] = json!(self.attention.get(key).cloned().unwrap_or_default());
    }
}

pub(super) fn decorate_one(c: &Connection, key: &str, value: &mut Value) -> Result<(), String> {
    Projection::load(c, &[key.to_string()])?.decorate(key, value);
    Ok(())
}
pub(super) fn decorate_page(c: &Connection, items: &mut [Value]) -> Result<(), String> {
    let keys = items
        .iter()
        .map(|v| v["key"].as_str().ok_or("收藏身份缺失").map(str::to_string))
        .collect::<Result<Vec<_>, _>>()?;
    let projection = Projection::load(c, &keys)?;
    for (key, value) in keys.iter().zip(items) {
        projection.decorate(key, value);
    }
    Ok(())
}
