use super::super::checkpoint::Proof;
use super::*;
fn database() -> (Connection, String) {
    let c = initialize_database(&PathBuf::from(":memory:")).unwrap();
    super::super::schema(&c).unwrap();
    let id = "a".repeat(64);
    c.execute("INSERT INTO cloud_maintenance_runs(namespace,id,configuration,state,phase,created_at,completed_at,error,proof,purpose) VALUES('ns',?1,'configuration','prepared','publish',1,0,'','','cleanup')",[&id]).unwrap();
    (c, id)
}
fn store(c: &Connection, id: &str, raw: &str) {
    c.execute(
        "UPDATE cloud_maintenance_runs SET proof=?1 WHERE namespace='ns' AND id=?2",
        params![raw, id],
    )
    .unwrap();
}
fn valid(id: &str) -> Proof {
    Proof {
        format: 1,
        generation: id.into(),
        namespace_hash: digest(b"ns"),
        device: "fixture-device".into(),
        created_at: 123,
        covered_hash: digest(b"covered"),
        covered_objects: 1,
        replacements: vec![Replacement {
            key: "reading/v1/changes/fixture.json".into(),
            kind: "reading".into(),
            hash: digest(b"body"),
        }],
    }
}
#[test]
fn released_proof_bytes_and_order_remain_exact_while_replacements_are_consumed_individually() {
    let (c, id) = database();
    let mut expected = valid(&id);
    expected.replacements.push(Replacement {
        key: "second".into(),
        kind: "copies".into(),
        hash: digest(b"two"),
    });
    let raw = format!(" \n{}\n ", serde_json::to_string(&expected).unwrap());
    store(&c, &id, &raw);
    let mut keys = Vec::new();
    each(&c, "ns", &id, |r| {
        keys.push(r.key.clone());
        Ok(())
    })
    .unwrap();
    assert_eq!(
        keys,
        vec![
            expected.replacements[0].key.clone(),
            expected.replacements[1].key.clone()
        ]
    );
    assert_eq!(body(&c, "ns", &id).unwrap(), raw.as_bytes());
}
#[test]
fn streamed_proof_builder_preserves_released_serializer_and_coverage_tuple_bytes() {
    let (c, id) = database();
    for (key, replacement, content) in [
        ("source-b", false, b"two".as_slice()),
        ("source-a", false, b"one".as_slice()),
        ("target-b", true, b"four".as_slice()),
        ("target-a", true, b"three".as_slice()),
    ] {
        c.execute(
            "INSERT INTO cloud_maintenance_objects VALUES('ns',?1,?2,'reading',?3,'read',?4)",
            params![id, key, content, replacement],
        )
        .unwrap();
    }
    let raw = build(&c, "ns", &id, "fixture-device").unwrap();
    let actual: Proof = serde_json::from_str(&raw).unwrap();
    assert_eq!(raw, serde_json::to_string(&actual).unwrap());
    assert_eq!(actual.covered_objects, 2);
    assert_eq!(
        actual.covered_hash,
        digest(
            &serde_json::to_vec(&vec![
                ("source-a", digest(b"one")),
                ("source-b", digest(b"two"))
            ])
            .unwrap()
        )
    );
    assert_eq!(
        actual
            .replacements
            .iter()
            .map(|r| r.key.as_str())
            .collect::<Vec<_>>(),
        vec!["target-a", "target-b"]
    );
    store(&c, &id, &raw);
    assert_eq!(body(&c, "ns", &id).unwrap(), raw.as_bytes());
}
#[test]
fn malformed_eof_unknown_or_duplicate_metadata_cannot_commit_consumer_changes() {
    let (c, id) = database();
    c.execute("CREATE TABLE imported(key TEXT)", []).unwrap();
    let raw = serde_json::to_string(&valid(&id)).unwrap();
    for bad in [
        format!("{raw} garbage"),
        raw.replacen("\"format\":1", "\"format\":1,\"format\":1", 1),
        raw.replacen("\"format\":1", "\"format\":1,\"unknown\":0", 1),
        raw.replace("\"namespaceHash\"", "\"wrongNamespace\""),
    ] {
        store(&c, &id, &bad);
        let tx = c.unchecked_transaction().unwrap();
        assert!(each(&tx, "ns", &id, |r| {
            tx.execute("INSERT INTO imported VALUES(?1)", [&r.key])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .is_err());
        drop(tx);
        assert_eq!(
            c.query_row("SELECT count(*) FROM imported", [], |r| r
                .get::<_, usize>(0))
                .unwrap(),
            0
        );
    }
}
#[test]
fn proof_object_limits_are_enforced_without_reintroducing_global_history_limit() {
    let (c, id) = database();
    let raw = serde_json::to_string(&valid(&id)).unwrap();
    let header = raw.split("\"replacements\":[").next().unwrap();
    c.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<=200000) UPDATE cloud_maintenance_runs SET proof=?1||'\"replacements\":['||(SELECT group_concat('{\"key\":\"k\",\"kind\":\"reading\",\"hash\":\"a\"}') FROM n)||']}'",[header]).unwrap();
    assert!(each(&c, "ns", &id, |_| Ok(())).is_err());
    c.execute(
        "UPDATE cloud_maintenance_runs SET proof=CAST(zeroblob(?1) AS TEXT)",
        [ROUND_BYTES + 1],
    )
    .unwrap();
    assert!(body(&c, "ns", &id).is_err());
    store(&c, &id, &raw);
    let mut w = Bounded(Vec::new());
    assert_eq!(w.write(&vec![b' '; ROUND_BYTES]).unwrap(), ROUND_BYTES);
    assert!(w.write(b"x").is_err());
}
