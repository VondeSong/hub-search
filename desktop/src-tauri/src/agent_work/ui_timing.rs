//! Bounded native-UI observations. Never goal evidence or completion authority.
use super::*;

pub(super) fn clock() -> Value {
    json!({"hostEpochMs":chrono::Utc::now().timestamp_millis(),"clock":"host UTC epoch milliseconds; UI uses performance.timeOrigin + performance.now; offset bounded by IPC round trip"})
}

pub(super) fn save(root: &Path, args: &Value) -> Result<Value, String> {
    let work = text(args, "id", 150)?;
    let run = text(args, "runId", 150)?;
    let sample = &args["sample"];
    // Paired with useAgentUiTiming; leave room for the envelope under the
    // unchanged global 65,536-byte record limit.
    if sample.to_string().len() > 61_440 || !sample.is_object() {
        return Err("界面计时记录超过有界容量".into());
    }
    let allowed = [
        "schemaVersion",
        "traceId",
        "kind",
        "clock",
        "uiSubmitMs",
        "uiAcceptMs",
        "uiFirstFeedbackMs",
        "uiUsefulMs",
        "uiDoneMs",
        "uiPatchStartMs",
        "uiPatchVisibleMs",
        "renders",
        "rendersOmitted",
        "slowestProjection",
        "events",
        "eventsOmitted",
        "publicContentEventsSeen",
        "publicContentEventsOmitted",
        "nonContentEventsOmitted",
        "geometry",
        "visibility",
        "terminalState",
        "usefulCriterion",
    ];
    if sample
        .as_object()
        .unwrap()
        .keys()
        .any(|k| !allowed.contains(&k.as_str()))
        || sample["schemaVersion"] != 1
    {
        return Err("界面计时字段无效".into());
    }
    for field in [
        "uiSubmitMs",
        "uiAcceptMs",
        "uiFirstFeedbackMs",
        "uiUsefulMs",
        "uiDoneMs",
        "uiPatchStartMs",
        "uiPatchVisibleMs",
    ] {
        if !sample[field].is_null()
            && sample[field]
                .as_f64()
                .is_none_or(|v| !v.is_finite() || v < 0.0)
        {
            return Err("界面计时时钟无效".into());
        }
    }
    for (field, limit) in [("renders", 256), ("events", 96)] {
        if sample[field].as_array().is_none_or(|v| v.len() > limit) {
            return Err("界面计时样本超过上限".into());
        }
    }
    if let Some(peak) = sample.get("slowestProjection") {
        let object = peak.as_object().ok_or("投影分段格式无效")?;
        if object.len() != 4
            || object.keys().any(|k| {
                !["renderIndex", "projectionMs", "phases", "phaseStatus"].contains(&k.as_str())
            })
        {
            return Err("投影分段字段无效".into());
        }
        let renders = sample["renders"].as_array().unwrap();
        let index = peak["renderIndex"]
            .as_u64()
            .filter(|i| *i < renders.len() as u64)
            .ok_or("投影分段没有对应呈现")? as usize;
        let ms = peak["projectionMs"]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .ok_or("投影分段耗时无效")?;
        let maximum = renders
            .iter()
            .filter_map(|r| r["projectionMs"].as_f64())
            .filter(|v| v.is_finite())
            .fold(0.0_f64, f64::max);
        if renders[index]["projectionMs"].as_f64() != Some(ms) || ms != maximum {
            return Err("投影分段与最大呈现不一致".into());
        }
        match peak["phaseStatus"].as_str() {
            Some("unavailable") if peak["phases"].is_null() => (),
            Some("recorded") => {
                let phases = peak["phases"]
                    .as_array()
                    .filter(|v| !v.is_empty() && v.len() <= 16)
                    .ok_or("投影分段超过上限")?;
                let mut previous = 0.0;
                for phase in phases {
                    let fields = phase.as_object().ok_or("投影分段字段无效")?;
                    if fields.len() != 2
                        || fields
                            .keys()
                            .any(|k| !["phase", "elapsedMs"].contains(&k.as_str()))
                        || phase["phase"]
                            .as_str()
                            .is_none_or(|v| v.is_empty() || v.chars().count() > 64)
                    {
                        return Err("投影分段字段无效".into());
                    }
                    let elapsed = phase["elapsedMs"]
                        .as_f64()
                        .filter(|v| v.is_finite() && *v >= previous && *v <= ms)
                        .ok_or("投影分段时钟无效")?;
                    previous = elapsed;
                }
            }
            _ => return Err("投影分段状态无效".into()),
        }
    }
    let counters = [
        "publicContentEventsSeen",
        "publicContentEventsOmitted",
        "nonContentEventsOmitted",
    ];
    if counters.iter().any(|key| sample.get(*key).is_some()) {
        let seen = sample[counters[0]].as_u64().ok_or("公开内容计数无效")?;
        let missed = sample[counters[1]].as_u64().ok_or("公开内容计数无效")?;
        let other = sample[counters[2]].as_u64().ok_or("公开内容计数无效")?;
        let omitted = sample["eventsOmitted"].as_u64().ok_or("公开内容计数无效")?;
        let retained = sample["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["eventCategory"] == "publicStream" && e["publicHasText"] == true)
            .count() as u64;
        if retained.checked_add(missed) != Some(seen) || missed.checked_add(other) != Some(omitted)
        {
            return Err("公开内容计数与保留样本不一致".into());
        }
    }
    store::write(root, |c| {
        let current = store::load(c, &work)?;
        if current.state == "revoked" {
            return Err("调查授权已撤回".into());
        }
        let belongs: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_runs WHERE id=?1 AND work_id=?2)",
                params![run, work],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !belongs {
            return Err("界面计时运行不属于当前事项".into());
        }
        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM agent_records WHERE run_id=?1 AND kind='nativeUiTiming'",
                [&run],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count >= 4 {
            return Err("本轮界面计时记录已达上限".into());
        }
        store::insert(
            c,
            &work,
            Some(&run),
            "nativeUiTiming",
            &json!({"schemaVersion":1,"workId":work,"runId":run,"observedAtEpochMs":chrono::Utc::now().timestamp_millis(),"authority":"UI observation only; not business evidence","sample":sample}),
        )?;
        Ok(json!({"recorded":true}))
    })
}

pub(super) fn publication(root: &Path, work: &str, run: &str, started: std::time::Instant) {
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    let committed = chrono::Utc::now().timestamp_millis();
    // A diagnostic failure must not convert a committed delivery into failure.
    let _ = store::write(root, |c| {
        store::insert(
            c,
            work,
            Some(run),
            "nativePublication",
            &json!({"schemaVersion":1,"workId":work,"runId":run,"committedAtEpochMs":committed,"publicationMs":elapsed,"scope":"authorization/evidence checks, transaction and commit; not model or rendering","uiVisibleMs":null}),
        )
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn v1_acceptance_ui_timing_keeps_unknown_and_cannot_cross_work_or_become_evidence() {
        let f = crate::obsidian_edit::tests::Fixture::new();
        let doc = f.seed("Timing.md", "synthetic timing fixture");
        let anchor = EvidenceLocator::Note {
            library_id: "notes".into(),
            document_id: doc,
            page_id: None,
        };
        let id = store::create(
            &f.root,
            "timing".into(),
            "read only".into(),
            anchor.clone(),
            Grant {
                notes: vec![anchor],
                ..Default::default()
            },
        )
        .unwrap();
        store::claim(&f.root, &id, "ui-timing-run").unwrap();
        let sample = json!({"schemaVersion":1,"traceId":"trace","kind":"submit","clock":null,"uiSubmitMs":1.0,"uiAcceptMs":2.0,"uiFirstFeedbackMs":null,"uiUsefulMs":null,"uiDoneMs":null,"uiPatchStartMs":null,"uiPatchVisibleMs":null,"renders":[],"events":[],"geometry":null,"visibility":"visible","usefulCriterion":"host validated current publication"});
        let mut sample = sample;
        sample["events"] = json!([
            {"eventId":"state","eventCategory":"state","publicKind":null,"publicHasText":false},
            {"eventId":"empty-public","eventCategory":"publicStream","publicKind":"message","publicHasText":false}
        ]);
        let args = json!({"id":id,"runId":"ui-timing-run","sample":sample});
        assert_eq!(save(&f.root, &args).unwrap()["recorded"], true);
        let saved = store::records(&f.root, &id, "nativeUiTiming", 4).unwrap();
        assert!(saved[0]["sample"]["uiDoneMs"].is_null());
        assert_eq!(saved[0]["sample"]["events"], args["sample"]["events"]);
        assert!(store::records(&f.root, &id, "evidence", 4)
            .unwrap()
            .is_empty());
        let mut invalid = args.clone();
        invalid["runId"] = json!("foreign-run");
        assert!(save(&f.root, &invalid).unwrap_err().contains("不属于"));
        invalid = args.clone();
        invalid["sample"]["uiDoneMs"] = json!(-1);
        assert!(save(&f.root, &invalid).unwrap_err().contains("时钟"));
        invalid = args.clone();
        invalid["sample"]["report"] = json!("not allowed");
        assert!(save(&f.root, &invalid).unwrap_err().contains("字段"));
        let mut bounded = args.clone();
        bounded["sample"]["rendersOmitted"] = json!(0);
        bounded["sample"]["eventsOmitted"] = json!(0);
        bounded["sample"]["publicContentEventsSeen"] = json!(96);
        bounded["sample"]["publicContentEventsOmitted"] = json!(0);
        bounded["sample"]["nonContentEventsOmitted"] = json!(0);
        bounded["sample"]["events"] = Value::Array((0..96).map(|n| json!({"eventId":format!("event-{n}"),"eventCategory":"publicStream","publicKind":"message","publicHasText":true,"receivedMs":1792856421000.0,"visibleMs":1792856421100.0})).collect());
        bounded["sample"]["renders"] = Value::Array((0..256).map(|_| json!({"startedMs":1792856421000.0,"visibleMs":1792856421030.0,"projectionMs":25.0})).collect());
        assert!(bounded["sample"].to_string().len() < 61_440);
        assert_eq!(save(&f.root, &bounded).unwrap()["recorded"], true);
        assert!(
            store::records(&f.root, &id, "nativeUiTiming", 4).unwrap()[0]
                .to_string()
                .len()
                < 65_536
        );
        let mut with_phases = bounded.clone();
        with_phases["sample"]["slowestProjection"] = json!({"renderIndex":0,"projectionMs":25.0,"phaseStatus":"recorded","phases":[{"phase":"readPermit","elapsedMs":1.0},{"phase":"databaseSnapshot","elapsedMs":20.0}]});
        assert_eq!(save(&f.root, &with_phases).unwrap()["recorded"], true);
        let persisted = store::records(&f.root, &id, "nativeUiTiming", 4).unwrap();
        assert!(persisted.iter().any(
            |r| r["sample"]["slowestProjection"] == with_phases["sample"]["slowestProjection"]
        ));
        for peak in [
            json!({"renderIndex":0,"projectionMs":24.0,"phaseStatus":"recorded","phases":[]}),
            json!({"renderIndex":256,"projectionMs":25.0,"phaseStatus":"unavailable","phases":null}),
            json!({"renderIndex":0,"projectionMs":25.0,"phaseStatus":"recorded","phases":[{"phase":"db","elapsedMs":26.0}]}),
            json!({"renderIndex":0,"projectionMs":25.0,"phaseStatus":"recorded","phases":[{"phase":"db","elapsedMs":20.0},{"phase":"db","elapsedMs":1.0}]}),
            json!({"renderIndex":0,"projectionMs":25.0,"phaseStatus":"recorded","phases":[{"phase":"db","elapsedMs":1.0,"rawSource":"forbidden"}]}),
        ] {
            let mut invalid = with_phases.clone();
            invalid["sample"]["slowestProjection"] = peak;
            assert!(save(&f.root, &invalid).unwrap_err().contains("投影分段"));
        }
        invalid = bounded.clone();
        invalid["sample"]["publicContentEventsSeen"] = json!(95);
        assert!(save(&f.root, &invalid).unwrap_err().contains("计数"));
        invalid = bounded.clone();
        invalid["sample"]["publicContentEventsOmitted"] = json!(1);
        assert!(save(&f.root, &invalid).unwrap_err().contains("计数"));
        invalid = bounded.clone();
        invalid["sample"]
            .as_object_mut()
            .unwrap()
            .remove("nonContentEventsOmitted");
        assert!(save(&f.root, &invalid).unwrap_err().contains("计数"));
        invalid = bounded.clone();
        invalid["sample"]["events"]
            .as_array_mut()
            .unwrap()
            .push(json!({}));
        assert!(save(&f.root, &invalid).unwrap_err().contains("样本"));
        invalid = bounded.clone();
        invalid["sample"]["renders"]
            .as_array_mut()
            .unwrap()
            .push(json!({}));
        assert!(save(&f.root, &invalid).unwrap_err().contains("样本"));
        invalid = bounded;
        invalid["sample"]["usefulCriterion"] = json!("x".repeat(61_440));
        assert!(save(&f.root, &invalid).unwrap_err().contains("容量"));
        store::revoke(&f.root, &id).unwrap();
        assert!(save(&f.root, &args).unwrap_err().contains("撤回"));
    }
}
