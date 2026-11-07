//! Immutable scheduling profiles travel with review events. Their content ID
//! covers both FSRS weights and Hub's interval policy, not just a version label.
use super::*;
use fsrs::FSRS;
use sha2::{Digest, Sha256};

pub(super) const DEFAULT_PARAMETERS: [f32; 21] = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
    0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Profile {
    pub id: String,
    pub algorithm: String,
    pub engine_version: String,
    pub scheduler_version: i64,
    pub parameters: Vec<f32>,
    pub desired_retention: f32,
    pub again_seconds: i64,
    pub minimum_interval_days: i64,
    pub maximum_interval_days: i64,
    pub elapsed_days: String,
    pub rounding: String,
}

impl Profile {
    pub(super) fn content_id(&self) -> Result<String, String> {
        let value = serde_json::to_value(self).map_err(|e| e.to_string())?;
        let mut body: std::collections::BTreeMap<_, _> = value
            .as_object()
            .ok_or("算法参数格式无效")?
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        body.remove("id");
        // Explicitly sorted keys and f32-to-JSON representation are part of
        // identity v1, independent of serde_json's preserve_order feature.
        Ok(format!(
            "fsrs-profile-v1-{:x}",
            Sha256::digest(serde_json::to_vec(&body).map_err(|e| e.to_string())?)
        ))
    }
    pub(super) fn model(&self) -> Result<FSRS, String> {
        FSRS::new(&self.parameters).map_err(|e| format!("FSRS 参数无效：{e}"))
    }
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.id != self.content_id()? {
            return Err("算法参数内容与身份不符，已保留原数据".into());
        }
        if self.algorithm != "FSRS-6"
            || self.engine_version != "fsrs-rs/6.6.2"
            || self.scheduler_version != 1
            || self.again_seconds != 600
            || self.minimum_interval_days != 1
            || self.maximum_interval_days != 36500
            || self.elapsed_days != "floor-utc-seconds/86400"
            || self.rounding != "nearest-day-no-fuzz"
        {
            return Err("算法或排程规则版本不支持，请升级应用".into());
        }
        if self.parameters.len() != 21
            || self.parameters.iter().any(|v| !v.is_finite())
            || !self.desired_retention.is_finite()
            || !(0.7..=0.99).contains(&self.desired_retention)
        {
            return Err("算法参数超出支持范围".into());
        }
        self.model()?;
        Ok(())
    }
}

pub(super) fn default_profile() -> Profile {
    let mut p = Profile {
        id: String::new(),
        algorithm: "FSRS-6".into(),
        engine_version: "fsrs-rs/6.6.2".into(),
        scheduler_version: 1,
        parameters: DEFAULT_PARAMETERS.to_vec(),
        desired_retention: 0.9,
        again_seconds: 600,
        minimum_interval_days: 1,
        maximum_interval_days: 36500,
        elapsed_days: "floor-utc-seconds/86400".into(),
        rounding: "nearest-day-no-fuzz".into(),
    };
    p.id = p.content_id().expect("default profile is serializable");
    p
}
pub(super) fn default_id() -> String {
    default_profile().id
}

pub(super) fn ensure(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS flashcard_scheduler_profiles(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS flashcard_profiles_no_update BEFORE UPDATE ON flashcard_scheduler_profiles
        BEGIN SELECT RAISE(ABORT,'Scheduling profiles are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS flashcard_profiles_no_delete BEFORE DELETE ON flashcard_scheduler_profiles
        BEGIN SELECT RAISE(ABORT,'Scheduling profiles are immutable'); END;") .map_err(|e|e.to_string())?;
    merge(c, &[default_profile()])
}
pub(super) fn merge(c: &Connection, profiles: &[Profile]) -> Result<(), String> {
    for p in profiles {
        p.validate()?;
        let old: Option<String> = c
            .query_row(
                "SELECT payload_json FROM flashcard_scheduler_profiles WHERE id=?1",
                [&p.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(old) = old {
            let old: Profile = serde_json::from_str(&old).map_err(|e| e.to_string())?;
            if old != *p {
                return Err("同一算法参数身份出现了不同内容，已保留原记录".into());
            }
        } else {
            c.execute(
                "INSERT INTO flashcard_scheduler_profiles(id,payload_json) VALUES(?1,?2)",
                params![p.id, serde_json::to_string(p).map_err(|e| e.to_string())?],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub(super) fn get(c: &Connection, id: &str) -> Result<Profile, String> {
    let raw: Option<String> = c
        .query_row(
            "SELECT payload_json FROM flashcard_scheduler_profiles WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let p: Profile =
        serde_json::from_str(&raw.ok_or("复习记录所需的算法参数尚未同步，请同步后重试")?)
            .map_err(|e| e.to_string())?;
    p.validate()?;
    Ok(p)
}
pub(super) fn snapshot(c: &Connection) -> Result<Vec<Profile>, String> {
    let mut q = c
        .prepare("SELECT payload_json FROM flashcard_scheduler_profiles ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| {
        r.map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    })
    .collect()
}
