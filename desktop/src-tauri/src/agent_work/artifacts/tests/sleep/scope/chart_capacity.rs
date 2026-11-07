use super::*;

fn preserve_old(f: &Fixture, id: &str, old: &Value, delivery: &Value) {
    assert_eq!(
        store::records(&f.root, id, "delivery", 1).unwrap()[0],
        *delivery
    );
    assert!(view_on(&f.root, &f.c(), &store::load(&f.c(), id).unwrap())
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["content"] == *old));
}

#[test]
fn v1_closure_chart_exact_capacity_uses_real_statistics_and_preserves_old_results() {
    let (f, id, old, delivery) = protected();
    let body = (0..120)
        .map(|i| format!("# {}-01-01\npayload\n", 2010 + i))
        .collect::<String>();
    f.note("notes", "current", &body);
    let run = "chart-capacity-run";
    let work = store::claim(&f.root, &id, run).unwrap();
    let reader = work.grant.reader(&f.root).unwrap();
    let snapshot = analysis::execute(&reader, "hub_create_analysis_snapshot", &json!({})).unwrap();
    let control = Control::default();
    let mut found = None;
    // Sizing uses the actual statistics producer. The two final requests
    // still traverse the complete production chart validation/store entry.
    'search: for grouping in ["month", "year"] {
        for metric in ["units", "characters"] {
            for groups in 24..=120 {
                let input = json!({"expectedSnapshot":snapshot["snapshot"],"unit":"day","groupBy":grouping,"dateTo":format!("{}-12-31",2009+groups),"terms":[]});
                let spec = json!({"title":"容量边界","mark":"bar","metric":metric,"term":null,"sort":"groupAsc"});
                let data = compute(&f.root, &work, &input, &spec, &control).unwrap();
                let base = data.to_string().len();
                if base >= 48_000 || (48_000 - base) % (groups + 1) != 0 {
                    continue;
                }
                let delta = (48_000 - base) / (groups + 1);
                let object_bytes = json!({"term":"","matchingUnits":0,"occurrences":0})
                    .to_string()
                    .len();
                for count in 1..=12 {
                    let min: usize = (0..count).map(|i| format!("q{i}").len()).sum();
                    let Some(sum) = delta.checked_sub(count * object_bytes + count - 1) else {
                        continue;
                    };
                    if sum < min || sum >= count * 100 {
                        continue;
                    }
                    let mut extra = sum - min;
                    let mut terms = Vec::new();
                    for i in 0..count {
                        let prefix = format!("q{i}");
                        let pad = extra.min(100 - prefix.len());
                        extra -= pad;
                        terms.push(format!("{prefix}{}", "z".repeat(pad)));
                    }
                    assert_eq!(extra, 0);
                    let mut exact = input.clone();
                    exact["terms"] = json!(terms);
                    let actual = compute(&f.root, &work, &exact, &spec, &control).unwrap();
                    assert_eq!(
                        actual.to_string().len(),
                        48_000,
                        "predicted boundary must equal the real producer"
                    );
                    found = Some((exact, spec, groups));
                    break 'search;
                }
            }
        }
    }
    let (exact, spec, groups) =
        found.expect("bounded authorized statistics fixture must reach the exact serialized limit");
    let request =
        json!({"action":"create","operationId":"chart-exact-limit","analysis":exact,"spec":spec});
    let accepted = execute(&f.root, &work, run, &request, &control).unwrap();
    assert_eq!(accepted["content"]["data"].to_string().len(), 48_000);
    let mut over = request.clone();
    over["operationId"] = json!("chart-over-limit");
    // A previously shortest term has room for one extra ASCII character.
    let terms = over["analysis"]["terms"].as_array_mut().unwrap();
    let index = terms
        .iter()
        .position(|t| t.as_str().unwrap().len() < 100)
        .unwrap();
    let longer = format!("{}z", terms[index].as_str().unwrap());
    terms[index] = json!(longer);
    let count_before: i64 = f
        .c()
        .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r.get(0))
        .unwrap();
    let error = execute(&f.root, &work, run, &over, &control).unwrap_err();
    assert!(error.contains("有界成果容量"), "{error}");
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        count_before
    );
    preserve_old(&f, &id, &old, &delivery);
    output(
        "chart-capacity.json",
        &json!({"acceptedSerializedDataBytes":48000,"rejectedSerializedDataBytes":48000+groups+1,"groups":groups,"producer":"authorized frozen source -> real analyze -> compute -> execute -> store","oldResultsIntact":true,"rejectionAppendedRecords":false,"error":error,"modelCalls":0}),
    );
}

#[test]
fn v1_closure_chart_write_abort_rolls_back_without_staling_old_results() {
    let (f, id, old, delivery) = protected();
    let run = "chart-write-failure";
    let work = store::claim(&f.root, &id, run).unwrap();
    let chart = records(&f.c(), &id, "chartRevision").unwrap()[0].clone();
    f.c().execute_batch("CREATE TRIGGER reject_chart_revision BEFORE INSERT ON agent_records WHEN NEW.kind='chartRevision' BEGIN SELECT RAISE(ABORT,'injected chart write failure'); END;").unwrap();
    let before: i64 = f
        .c()
        .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r.get(0))
        .unwrap();
    let request = json!({"action":"patch","operationId":"write-abort","artifactId":chart["artifactId"],"expectedRevision":chart["revision"],"analysis":null,"spec":{"title":"失败不覆盖旧成果","mark":"line","metric":"sleep_duration_hours","term":null,"sort":"groupAsc"},"reason":"controlled transaction write failure"});
    let error = execute(&f.root, &work, run, &request, &Control::default()).unwrap_err();
    assert!(error.contains("injected chart write failure"), "{error}");
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
    preserve_old(&f, &id, &old, &delivery);
    output(
        "chart-write-abort.json",
        &json!({"injected":"SQLite BEFORE INSERT RAISE(ABORT), actual production patch/store transaction; not physical disk failure","error":error,"oldResultsIntact":true,"transactionRolledBack":true,"modelCalls":0}),
    );
}
