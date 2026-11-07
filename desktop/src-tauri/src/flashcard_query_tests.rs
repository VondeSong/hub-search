use super::*;
use crate::{initialize_database, install_flashcard_list_revision};
use std::path::PathBuf;

fn database(size: usize) -> Connection {
    let connection = initialize_database(&PathBuf::from(":memory:")).unwrap();
    install_flashcard_list_revision(&connection).unwrap();
    connection.execute("INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('a','A',1,1),('b','B',1,1)", []).unwrap();
    for index in 0..size {
        connection.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at,tags_json,custom_fields_json) VALUES(?1,'a',?2,'Answer',?3,?3,1,?4,?5)", params![format!("card-{index:04}"), format!("Question {index}"), index as i64, json!([format!("tag-{index}")]).to_string(), json!({format!("field-{index}"): format!("value-{index}")}).to_string()]).unwrap();
    }
    connection
}

#[test]
fn metadata_only_review_plan_retains_unlimited_counts_without_reading_card_ids_or_bodies() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let connection = database(1201);
    connection.execute("INSERT INTO metadata(key,value) VALUES('flashcard_daily_new_limit','0') ON CONFLICT(key) DO UPDATE SET value='0'",[]).unwrap();
    connection.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Read {
            table_name: "flashcards",
            column_name: "id" | "question" | "answer" | "media_json",
        } => Authorization::Deny,
        _ => Authorization::Allow,
    }));
    let result = review_plan_details(&connection, "a", 0, 100, false, false).unwrap();
    assert_eq!(result["sessionIds"], json!([]));
    assert_eq!(result["eligibleCount"], 1201);
    assert_eq!(result["sessionCount"], 1201);
    connection.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    assert_eq!(
        review_plan_details(&connection, "a", 0, 100, false, true).unwrap()["sessionIds"]
            .as_array()
            .unwrap()
            .len(),
        1201
    );
}
fn page(connection: &Connection, query: &Query, offset: usize, limit: usize) -> Value {
    read_page(
        connection,
        "a",
        false,
        Some(query),
        offset,
        limit,
        None,
        100,
        true,
    )
    .unwrap()
}
fn ids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["id"].as_str().unwrap().into())
        .collect()
}

#[test]
fn browser_full_result_filters_tail_without_materializing_first_1000() {
    let connection = database(1201);
    let query = Query {
        search: "value-1200".into(),
        ..Query::default()
    };
    let result = page(&connection, &query, 0, 60);
    assert_eq!(ids(&result), ["card-1200"]);
    assert_eq!(result["total"], 1);
    assert_eq!(result["scopeTotal"], 1201);
    assert_eq!(result["tags"].as_array().unwrap().len(), 1201);
    assert_eq!(result["customFieldKeys"], json!(["field-1200"]));
}

#[test]
fn browser_paging_and_selection_preserve_all_results_sort_and_revision() {
    let mut connection = database(1201);
    let query = Query {
        sort: "created".into(),
        ascending: true,
        ..Query::default()
    };
    let first = page(&connection, &query, 0, 60);
    let revision = first["revision"].as_str().unwrap();
    let mut all = vec![];
    for offset in (0..1201).step_by(60) {
        all.extend(ids(&read_page(
            &connection,
            "a",
            false,
            Some(&query),
            offset,
            60,
            Some(revision),
            100,
            false,
        )
        .unwrap()));
    }
    assert_eq!(all.len(), 1201);
    assert_eq!(all.first().unwrap(), "card-0000");
    assert_eq!(all.last().unwrap(), "card-1200");
    let selected = selection_ids(
        &connection,
        "a",
        false,
        &query,
        0,
        2000,
        Some(revision),
        100,
    )
    .unwrap();
    assert_eq!(selected["ids"], json!(all));
    assert_eq!(
        update_batch(
            &mut connection,
            &["card-1200".into()],
            None,
            Some(vec!["changed".into()]),
            None,
            10
        )
        .unwrap(),
        1
    );
    assert!(read_page(
        &connection,
        "a",
        false,
        Some(&query),
        60,
        60,
        Some(revision),
        100,
        false
    )
    .unwrap_err()
    .contains("FLASHCARD_LIST_CHANGED"));
    assert!(selection_ids(
        &connection,
        "a",
        false,
        &query,
        0,
        2000,
        Some(revision),
        100
    )
    .unwrap_err()
    .contains("FLASHCARD_LIST_CHANGED"));
}

#[test]
fn browser_board_columns_have_independent_offsets_complete_counts_and_fixed_time() {
    let connection = database(140);
    connection
        .execute(
            "UPDATE flashcards SET repetitions=1,due_at=101 WHERE id>='card-0070'",
            [],
        )
        .unwrap();
    let initial = page(&connection, &Query::default(), 0, 24);
    assert_eq!(initial["stageCounts"]["new"], 70);
    assert_eq!(initial["stageCounts"]["learning"], 70);
    for stage in ["new", "learning"] {
        let query = Query {
            column_stage: Some(stage.into()),
            ..Query::default()
        };
        let first = read_page(
            &connection,
            "a",
            false,
            Some(&query),
            0,
            24,
            initial["revision"].as_str(),
            100,
            false,
        )
        .unwrap();
        let second = read_page(
            &connection,
            "a",
            false,
            Some(&query),
            24,
            24,
            initial["revision"].as_str(),
            100,
            false,
        )
        .unwrap();
        assert_eq!(first["total"], 70);
        assert_eq!(first["matchedTotal"], 140);
        let mut combined = ids(&first);
        combined.extend(ids(&second));
        assert_eq!(
            combined
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            48
        );
        assert_eq!(second["asOf"], 100);
    }
}

#[test]
fn browser_stage_type_mastered_scope_and_invalid_query_contracts() {
    let connection = database(5);
    connection
        .execute(
            "UPDATE flashcards SET repetitions=1 WHERE id IN ('card-0001','card-0002','card-0003')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE flashcards SET due_at=200,interval_days=30 WHERE id='card-0002'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE flashcards SET status='suspended',card_type='cloze' WHERE id='card-0003'",
            [],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE flashcards SET status='deleted' WHERE id='card-0004'",
            [],
        )
        .unwrap();
    assert_eq!(
        page(
            &connection,
            &Query {
                include_mastered: false,
                ..Query::default()
            },
            0,
            60
        )["total"],
        3
    );
    assert_eq!(
        ids(&page(
            &connection,
            &Query {
                stage: "mastered".into(),
                ..Query::default()
            },
            0,
            60
        )),
        ["card-0002"]
    );
    assert_eq!(
        ids(&page(
            &connection,
            &Query {
                card_type: "cloze".into(),
                ..Query::default()
            },
            0,
            60
        )),
        ["card-0003"]
    );
    assert_eq!(
        read_page(
            &connection,
            "",
            true,
            Some(&Query::default()),
            0,
            60,
            None,
            100,
            true
        )
        .unwrap()["total"],
        2
    );
    assert_eq!(
        read_page(
            &connection,
            "b",
            false,
            Some(&Query::default()),
            0,
            60,
            None,
            100,
            true
        )
        .unwrap()["scopeTotal"],
        0
    );
    assert!(read_page(
        &connection,
        "a",
        false,
        Some(&Query {
            sort: "injected".into(),
            ..Query::default()
        }),
        0,
        60,
        None,
        100,
        false
    )
    .is_err());
}

#[test]
fn browser_unicode_locale_order_and_javascript_custom_value_search() {
    let connection = database(9);
    let questions = [
        "重庆",
        "北京",
        "上海",
        "Árbol",
        "😀",
        "İstanbul",
        "ΟΣ",
        "ß",
        "\u{feff}Mixed",
    ];
    for (index, question) in questions.into_iter().enumerate() {
        connection.execute("UPDATE flashcards SET question=?1,tags_json='[\"  标签  \"]',custom_fields_json=?2 WHERE id=?3",params![question,json!({"bool":true,"null":null,"object":{"x":1},"array":["a",null,"b"],"big":1e21,"tiny":1e-7}).to_string(),format!("card-{index:04}")]).unwrap();
    }
    let query = Query {
        sort: "question".into(),
        ascending: true,
        ..Query::default()
    };
    let ordered = page(&connection, &query, 0, 60);
    let collator = Collator::try_new(locale!("zh-CN").into(), CollatorOptions::default()).unwrap();
    let mut expected: Vec<_> = questions
        .into_iter()
        .enumerate()
        .map(|(index, question)| (question, index))
        .collect();
    expected.sort_by(|left, right| collator.compare(left.0, right.0));
    assert_eq!(
        ids(&ordered),
        expected
            .iter()
            .map(|(_, index)| format!("card-{index:04}"))
            .collect::<Vec<_>>()
    );
    assert_eq!(ordered["tags"], json!(["标签"]));
    for needle in ["TRUE", "null", "[object Object]", "a,,b", "1e+21", "1e-7"] {
        assert_eq!(
            page(
                &connection,
                &Query {
                    search: needle.into(),
                    ..Query::default()
                },
                0,
                60
            )["total"],
            9,
            "{needle}"
        );
    }
    assert_eq!(
        ids(&page(
            &connection,
            &Query {
                search: "οσ".into(),
                ..Query::default()
            },
            0,
            60
        )),
        Vec::<String>::new()
    );
    assert_eq!(
        ids(&page(
            &connection,
            &Query {
                search: "ος".into(),
                ..Query::default()
            },
            0,
            60
        )),
        ["card-0006"]
    );
    assert_eq!(
        ids(&page(
            &connection,
            &Query {
                search: "i\u{307}".into(),
                ..Query::default()
            },
            0,
            60
        )),
        ["card-0005"]
    );
    assert_eq!(
        ids(&page(
            &connection,
            &Query {
                search: "\u{feff}mixed \u{feff}".into(),
                ..Query::default()
            },
            0,
            60
        )),
        ["card-0008"]
    );
}

#[test]
fn browser_fallback_sort_ties_match_original_due_created_order() {
    let connection = database(3);
    connection.execute("UPDATE flashcards SET updated_at=1,due_at=CASE WHEN id='card-0002' THEN 200 ELSE 1 END",[]).unwrap();
    for ascending in [true, false] {
        assert_eq!(
            ids(&page(
                &connection,
                &Query {
                    ascending,
                    ..Query::default()
                },
                0,
                60
            )),
            ["card-0001", "card-0000", "card-0002"]
        );
    }
}

#[test]
fn bulk_over_500_is_unique_complete_and_rolls_back_all_producer_effects() {
    let mut connection = database(1201);
    let mut ids: Vec<String> = (0..1201).map(|index| format!("card-{index:04}")).collect();
    ids.push("card-0000".into());
    ids.push("missing".into());
    let revision = revision(&connection, None).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_bulk BEFORE UPDATE ON flashcards WHEN NEW.id='card-0800' BEGIN SELECT RAISE(ABORT,'injected bulk failure'); END;").unwrap();
    assert!(update_batch(
        &mut connection,
        &ids,
        Some("b".into()),
        Some(vec!["same".into()]),
        Some(json!({"field":"new"})),
        50
    )
    .is_err());
    assert_eq!(count(&connection, "deck_id='a'", &[]).unwrap(), 1201);
    assert_eq!(revision, super::revision(&connection, None).unwrap());
    connection.execute_batch("DROP TRIGGER fail_bulk;").unwrap();
    assert_eq!(
        update_batch(
            &mut connection,
            &ids,
            Some("b".into()),
            Some(vec!["same".into()]),
            Some(json!({"field":"new"})),
            50
        )
        .unwrap(),
        1201
    );
    assert_eq!(
        count(
            &connection,
            "deck_id='b' AND tags_json='[\"same\"]' AND custom_fields_json='{\"field\":\"new\"}'",
            &[]
        )
        .unwrap(),
        1201
    );
    assert_eq!(delete_batch(&mut connection, &ids, 60).unwrap(), 1201);
    assert_eq!(delete_batch(&mut connection, &ids, 60).unwrap(), 0);
}

#[test]
fn bulk_invalid_target_does_not_change_any_selected_card() {
    let mut connection = database(600);
    let ids = (0..600)
        .map(|index| format!("card-{index:04}"))
        .collect::<Vec<_>>();
    let before = revision(&connection, None).unwrap();
    assert!(update_batch(
        &mut connection,
        &ids,
        Some("missing".into()),
        Some(vec!["changed".into()]),
        None,
        10
    )
    .is_err());
    assert_eq!(before, revision(&connection, None).unwrap());
    assert_eq!(count(&connection, "deck_id='a'", &[]).unwrap(), 600);
}

#[test]
fn review_plan_keeps_mature_priority_daily_quota_unlimited_and_scope() {
    let connection = database(1201);
    connection
        .execute(
            "UPDATE flashcards SET repetitions=1 WHERE id='card-1200'",
            [],
        )
        .unwrap();
    connection.execute("INSERT INTO metadata(key,value) VALUES('flashcard_daily_new_limit','5') ON CONFLICT(key) DO UPDATE SET value=excluded.value",[]).unwrap();
    connection.execute("INSERT INTO flashcard_reviews(id,card_id,rating,reviewed_at,previous_due_at,next_due_at,previous_interval_days,next_interval_days,previous_repetitions,previous_lapses) VALUES('review-new','card-0000',3,100,1,200,0,1,0,0)",[]).unwrap();
    let plan = review_plan(&connection, "a", 0, 100).unwrap();
    assert_eq!(plan["sessionIds"].as_array().unwrap().len(), 5);
    assert_eq!(plan["sessionIds"][0], "card-1200");
    assert_eq!(plan["newAvailable"], 4);
    assert_eq!(plan["newWaiting"], 1196);
    assert_eq!(
        review_plan(&connection, "a", 1, 100).unwrap()["sessionIds"],
        json!(["card-1200"])
    );
    assert_eq!(
        review_plan(&connection, "b", 0, 100).unwrap()["eligibleCount"],
        0
    );
    connection
        .execute(
            "UPDATE metadata SET value='0' WHERE key='flashcard_daily_new_limit'",
            [],
        )
        .unwrap();
    assert_eq!(
        review_plan(&connection, "", 0, 100).unwrap()["sessionIds"]
            .as_array()
            .unwrap()
            .len(),
        1201
    );
    connection
        .execute(
            "UPDATE flashcards SET status='suspended' WHERE id='card-1200'",
            [],
        )
        .unwrap();
    assert_eq!(
        review_plan(&connection, "a", 0, 100).unwrap()["eligibleCount"],
        1200
    );
}
