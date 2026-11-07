use super::*;
#[test]
fn indexed_domain_fingerprint_matches_released_complete_comparison_and_ignores_stale_hash_scratch()
{
    let mut c = scratch().unwrap();
    let ns = "fixture-namespace";
    c.execute(
        "INSERT INTO flashcard_decks(id,name,created_at,updated_at) VALUES('deck','Deck',1,1)",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO flashcards(id,deck_id,question,answer,created_at,updated_at,due_at) VALUES('card','deck','Q','A',1,1,1)",[]).unwrap();
    for id in ["901", "902"] {
        x_bookmarks::reading_sync_test_import(
            &mut c,
            crate::x_bookmarks::Post {
                id: id.into(),
                text: format!("Formal {id}"),
                content_status: "complete".into(),
                url: "https://example.invalid/fixture".into(),
                ..Default::default()
            },
        );
    }
    let mut expected = BTreeMap::new();
    expected.insert(
        "flashcards",
        digest(
            &serde_json::to_vec(
                &crate::flashcard_cloud_sync::content_identity(
                    &local_flashcard_snapshot(&c).unwrap(),
                )
                .unwrap(),
            )
            .unwrap(),
        ),
    );
    for kind in ["reading", "copies", "manifests", "devices"] {
        let mut after = 0;
        let mut hashes = Vec::new();
        loop {
            let page = match kind {
                "reading" => reading_sync::maintenance_export_page(&c, after).unwrap(),
                "copies" => reading_sync::copies::maintenance_export_page(&c, ns, after).unwrap(),
                "manifests" => reading_sync::media::maintenance_export_page(&c, ns, after).unwrap(),
                _ => devices::maintenance_export_page(&c, ns, after).unwrap(),
            };
            if page.is_empty() {
                break;
            }
            for (row, body) in page {
                after = row;
                hashes.push(digest(&body));
            }
        }
        hashes.sort();
        expected.insert(kind, digest(&serde_json::to_vec(&hashes).unwrap()));
    }
    assert_eq!(fingerprint(&c, ns).unwrap(), expected);
    c.execute(
        "INSERT INTO maintenance_domain_hashes VALUES('stale previous retry')",
        [],
    )
    .unwrap();
    assert_eq!(fingerprint(&c, ns).unwrap(), expected);
    assert_eq!(
        c.query_row("SELECT count(*) FROM maintenance_domain_hashes", [], |r| {
            r.get::<_, usize>(0)
        })
        .unwrap(),
        0
    );
}
