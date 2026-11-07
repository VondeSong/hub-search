use super::*;

fn old_results_intact(f: &Fixture, id: &str, chart: &Value, delivery: &Value) {
    assert_eq!(
        store::records(&f.root, id, "delivery", 1).unwrap()[0],
        *delivery
    );
    let current = store::view(&f.root, id).unwrap();
    assert_eq!(current["analysisArtifacts"][0]["content"], *chart);
}

#[test]
fn v1_acceptance_record_exact_boundaries_keep_old_deliveries() {
    let mut observed = Vec::new();
    // The real serialized string includes its two JSON quote bytes.
    let (f, id, chart, delivery) = protected();
    store::write(&f.root, |c| {
        store::insert(c, &id, None, "boundary", &json!("x".repeat(65_534)))
    })
    .unwrap();
    let error = store::write(&f.root, |c| {
        store::insert(c, &id, None, "boundary", &json!("x".repeat(65_535)))
    })
    .unwrap_err();
    assert!(error.contains("过大"));
    old_results_intact(&f, &id, &chart, &delivery);
    observed.push(json!({"kind":"singleRecord","acceptedBytes":65536,"rejectedBytes":65537,"oldResultsIntact":true,"error":error}));
    for assistant in [false, true] {
        for bytes_boundary in [false, true] {
            let (f, id, chart, delivery) = protected();
            let run = format!("capacity-{assistant}-{bytes_boundary}");
            store::claim(&f.root, &id, &run).unwrap();
            let (count_limit, byte_limit) = if assistant {
                (256usize, 1_048_576usize)
            } else {
                (64usize, 262_144usize)
            };
            store::write(&f.root, |c| {
                let mut count = 0;
                let mut bytes = 0;
                if assistant {
                    store::insert(c, &id, Some(&run), "agentProtocol", &json!({}))?;
                    count += 1;
                    bytes += 2;
                }
                if bytes_boundary {
                    while bytes < byte_limit {
                        let chunk = (byte_limit - bytes).min(65_536);
                        assert!(chunk >= 2);
                        store::insert(
                            c,
                            &id,
                            Some(&run),
                            "boundary",
                            &json!("x".repeat(chunk - 2)),
                        )?;
                        count += 1;
                        bytes += chunk;
                    }
                } else {
                    while count < count_limit {
                        store::insert(c, &id, Some(&run), "boundary", &json!({}))?;
                        count += 1;
                        bytes += 2;
                    }
                }
                Ok(())
            })
            .unwrap();
            let prior:(i64,i64)=f.c().query_row("SELECT COUNT(*),SUM(length(CAST(body_json AS BLOB))) FROM agent_records WHERE run_id=?1",[&run],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(
                if bytes_boundary {
                    prior.1 as usize
                } else {
                    prior.0 as usize
                },
                if bytes_boundary {
                    byte_limit
                } else {
                    count_limit
                }
            );
            let error = store::record(&f.root, &run, "over", &json!({})).unwrap_err();
            assert!(error.contains("预算"));
            let after:(i64,i64)=f.c().query_row("SELECT COUNT(*),SUM(length(CAST(body_json AS BLOB))) FROM agent_records WHERE run_id=?1",[&run],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
            assert_eq!(prior, after);
            old_results_intact(&f, &id, &chart, &delivery);
            observed.push(json!({"assistant":assistant,"boundary":if bytes_boundary{"bytes"}else{"count"},"acceptedCount":prior.0,"acceptedBytes":prior.1,"error":error,"oldResultsIntact":true}));
        }
    }
    output(
        "record-capacity.json",
        &json!({"checks":observed,"modelCalls":0}),
    );
}

#[test]
fn v1_acceptance_sqlite_page_quota_rolls_back_and_keeps_old_deliveries() {
    let (f, id, chart, delivery) = protected();
    let before: i64 = f
        .c()
        .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r.get(0))
        .unwrap();
    let result = store::write(&f.root, |c| {
        let pages: i64 = c
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let set: i64 = c
            .query_row(&format!("PRAGMA max_page_count={pages}"), [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        assert_eq!(set, pages);
        // Exercise SQLite's actual SQLITE_FULL path inside the production
        // transaction, without filling the user's disk or mocking the store.
        for _ in 0..32 {
            store::insert(c, &id, None, "pageQuota", &json!("q".repeat(65_534)))?;
        }
        Ok(())
    });
    let error = result.unwrap_err();
    assert!(
        error.contains("full"),
        "expected SQLite page quota rejection, got {error}"
    );
    assert_eq!(
        f.c()
            .query_row("SELECT COUNT(*) FROM agent_records", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        before
    );
    old_results_intact(&f, &id, &chart, &delivery);
    output(
        "sqlite-page-quota.json",
        &json!({"injected":"SQLite max_page_count at existing page count, not physical disk exhaustion","error":error,"transactionRolledBack":true,"oldResultsIntact":true,"modelCalls":0}),
    );
}
