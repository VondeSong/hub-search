use super::*;
use crate::source_evidence::tests::Fixture;

fn note(library: &str, document: &str, page: Option<&str>) -> EvidenceLocator {
    EvidenceLocator::Note {
        library_id: library.into(),
        document_id: document.into(),
        page_id: page.map(str::to_string),
    }
}
fn reader(f: &Fixture, notes: Vec<EvidenceLocator>) -> EvidenceReader {
    EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec![], vec![])
            .unwrap()
            .with_notes(notes)
            .unwrap(),
    )
}
fn obsidian(vault: &str, file: &str) -> String {
    let mut uri = Url::parse("obsidian://open").unwrap();
    uri.query_pairs_mut()
        .append_pair("vault", vault)
        .append_pair("file", file);
    uri.to_string()
}

#[test]
fn exact_obsidian_identity_is_not_read_evidence_and_existing_reader_revalidates_versions() {
    let f = Fixture::new();
    f.note("notes", "目录/记录", "原文 v1");
    let target = note("notes", "目录/记录", None);
    let r = reader(&f, vec![target.clone()]);
    let uri = obsidian("Notes", "目录/记录.md");
    let result = r.resolve_link(&uri).unwrap();
    assert_eq!(result["status"], "resolved");
    assert_eq!(result["locator"], json!(target));
    assert_eq!(result["originalUrl"], uri);
    assert_eq!(result["bodyRead"], false);
    assert_eq!(result["networkRequested"], false);
    assert!(result.get("content").is_none() && result.get("version").is_none());
    let before = r.read(&target, 0, 100, None).unwrap();
    f.note("notes", "目录/记录", "原文 v2");
    assert!(r.read(&target, 0, 100, Some(&before.version)).is_err());
    let after = r.read(&target, 0, 100, None).unwrap();
    assert_ne!(before.version, after.version);
    assert_eq!(after.content, "原文 v2");
    f.c()
        .execute(
            "DELETE FROM documents WHERE space_id='notes' AND id='目录/记录'",
            [],
        )
        .unwrap();
    assert_eq!(
        r.resolve_link(&uri).unwrap()["status"],
        "notInAuthorizedScope"
    );
}

#[test]
fn empty_or_partial_scope_does_not_reveal_private_existence_or_choose_ambiguous_vaults() {
    let f = Fixture::new();
    f.note("notes", "same", "可授权");
    f.note("private", "same", "私有正文");
    f.c()
        .execute("UPDATE libraries SET name='Notes' WHERE id='private'", [])
        .unwrap();
    let uri = obsidian("Notes", "same");
    let empty = reader(&f, vec![]);
    let denied = empty.resolve_link(&uri).unwrap();
    assert_eq!(denied["status"], "notInAuthorizedScope");
    assert!(denied.get("locator").is_none());
    let only = reader(&f, vec![note("notes", "same", None)]);
    assert_eq!(only.resolve_link(&uri).unwrap()["status"], "resolved");
    let both = reader(
        &f,
        vec![note("notes", "same", None), note("private", "same", None)],
    );
    assert_eq!(both.resolve_link(&uri).unwrap()["status"], "ambiguous");
    f.c()
        .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
        .unwrap();
    assert_eq!(
        only.resolve_link(&uri).unwrap()["status"],
        "notInAuthorizedScope"
    );
}

#[test]
fn malformed_or_ambiguous_parameters_never_silently_change_target() {
    let f = Fixture::new();
    let r = reader(&f, vec![]);
    for uri in [
        "",
        "obsidian://open?vault=Notes&file=a&file=b",
        "obsidian://open?vault=Notes",
        "obsidian://open?vault=Notes&file=../a",
        "obsidian://open?vault=Notes&file=C%3A%5Ca",
        "obsidian://open?vault=Notes&file=%FF",
        "obsidian://open?vault=Notes&file=a#section",
        "obsidian://open?vault=Notes&file=a&line=2",
        "obsidian://open/path?vault=Notes&file=a",
        "https://user:pass@example.com/private",
        "file:///C:/secret",
        "javascript:alert(1)",
        " https://example.com",
        "https://example.com\n",
    ] {
        assert!(r.resolve_link(uri).is_err(), "must reject {uri:?}");
    }
}

#[test]
fn missing_connectors_and_public_readers_return_unavailable_without_network_or_body() {
    let f = Fixture::new();
    let r = reader(&f, vec![]);
    for (uri, reason) in [
        (
            "https://app.notion.com/p/page?source=copy_link",
            "missingHubNotionConnection",
        ),
        (
            "https://team.notion.site/page",
            "missingHubNotionConnection",
        ),
        (
            "https://notion.com.evil.example/page",
            "publicWebReaderUnavailable",
        ),
        ("http://127.0.0.1/private", "publicWebReaderUnavailable"),
    ] {
        let result = r.resolve_link(uri).unwrap();
        assert_eq!(result["status"], "unavailable");
        assert_eq!(result["reason"], reason);
        assert_eq!(result["originalUrl"], uri);
        assert_eq!(result["networkRequested"], false);
        assert_eq!(result["bodyRead"], false);
        assert!(result.get("locator").is_none());
    }
}

fn craft(f: &Fixture) {
    f.c().execute_batch("INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider) VALUES('craft','doc','Root','Root','root',1,'v1','craft');
    INSERT INTO content_items(id,space_id,document_id,block_id,page_id,content_type,heading,body,source_hash,provider,ordinal) VALUES
    ('card-a','craft','doc','child','doc','craft_subpage','','card', 'v1','craft',0),
    ('child-a','craft','doc','child-heading','child','markdown_section','','child text','v1','craft',1),
    ('child-b','craft','doc','sibling-heading','sibling','markdown_section','','sibling text','v1','craft',2);").unwrap();
}

#[test]
fn craft_child_link_preserves_exact_page_and_cannot_fall_back_to_parent_or_sibling() {
    let f = Fixture::new();
    craft(&f);
    let child = note("craft", "doc", Some("child"));
    let r = reader(&f, vec![child.clone()]);
    for block in ["child", "child-heading"] {
        let result = r
            .resolve_link(&format!("craftdocs://open?spaceId=craft&blockId={block}"))
            .unwrap();
        assert_eq!(result["status"], "resolved");
        assert_eq!(result["locator"], json!(child));
    }
    for block in ["doc", "sibling", "sibling-heading"] {
        assert_eq!(
            r.resolve_link(&format!("craftdocs://open?spaceId=craft&blockId={block}"))
                .unwrap()["status"],
            "notInAuthorizedScope"
        );
    }
    let parent = reader(&f, vec![note("craft", "doc", Some("doc"))]);
    assert_eq!(
        parent
            .resolve_link("craftdocs://open?spaceId=craft&blockId=child")
            .unwrap()["status"],
        "notInAuthorizedScope"
    );
    assert_eq!(
        parent
            .resolve_link("craftdocs://open?spaceId=craft&blockId=doc")
            .unwrap()["locator"],
        json!(note("craft", "doc", Some("doc")))
    );
}

fn reading_reader(f: &Fixture, keys: &[&str]) -> EvidenceReader {
    EvidenceReader::new(
        &f.root,
        EvidenceScope::new(vec![], keys.iter().map(|s| s.to_string()).collect()).unwrap(),
    )
}

#[test]
fn saved_reading_url_resolves_only_identity_then_existing_reader_supplies_versioned_body() {
    let f = Fixture::new();
    f.reading("selected", "保存原文");
    let r = reading_reader(&f, &["selected"]);
    let resolved = r.resolve_link("https://EXAMPLE.com:443/selected").unwrap();
    let locator = EvidenceLocator::Reading {
        item_key: "selected".into(),
    };
    assert_eq!(resolved["status"], "resolved");
    assert_eq!(resolved["locator"], json!(locator));
    assert_eq!(resolved["evidenceOrigin"], "authorizedSavedReading");
    assert_eq!(resolved["bodyRead"], false);
    assert_eq!(resolved["networkRequested"], false);
    assert_eq!(resolved["remoteVerified"], false);
    assert!(resolved.get("content").is_none() && resolved.get("version").is_none());
    let actual = r.read(&locator, 0, 8000, None).unwrap();
    assert!(actual.content.contains("保存原文"));
    assert_eq!(actual.source_path, "https://example.com/selected");
    f.c().execute("UPDATE collection_x_items SET post_json=json_set(post_json,'$.text','原文更新'),read_version=read_version+1 WHERE item_key='selected'",[]).unwrap();
    assert!(r.read(&locator, 0, 8000, Some(&actual.version)).is_err());
    assert!(r
        .read(&locator, 0, 8000, None)
        .unwrap()
        .content
        .contains("原文更新"));
}

#[test]
fn saved_url_does_not_reveal_private_existence_or_grant_removed_items() {
    let f = Fixture::new();
    f.reading("private", "私有正文");
    let empty = reading_reader(&f, &[]);
    for url in ["https://example.com/private", "https://example.com/absent"] {
        let value = empty.resolve_link(url).unwrap();
        assert_eq!(value["reason"], "publicWebReaderUnavailable");
        assert!(value.get("locator").is_none());
        assert_eq!(value["bodyRead"], false);
    }
    let authorized = reading_reader(&f, &["private"]);
    assert_eq!(
        authorized
            .resolve_link("https://example.com/private")
            .unwrap()["status"],
        "resolved"
    );
    assert!(empty
        .read(
            &EvidenceLocator::Reading {
                item_key: "private".into()
            },
            0,
            100,
            None
        )
        .is_err());
    for state in ["archived", "removed", "deleted"] {
        f.c().execute("INSERT INTO collection_lifecycle(item_key,state) VALUES('private',?1) ON CONFLICT(item_key) DO UPDATE SET state=excluded.state",[state]).unwrap();
        let v = authorized
            .resolve_link("https://example.com/private")
            .unwrap();
        assert_eq!(
            v["status"],
            if state == "archived" {
                "resolved"
            } else {
                "unavailable"
            }
        );
    }
}

#[test]
fn saved_url_duplicate_selection_is_limited_to_authorized_identities() {
    let f = Fixture::new();
    f.reading("a", "A");
    f.reading("b", "B");
    f.c().execute("UPDATE collection_x_items SET post_json=json_set(post_json,'$.url','https://example.com/same')",[]).unwrap();
    let one = reading_reader(&f, &["a"]);
    assert_eq!(
        one.resolve_link("https://example.com/same").unwrap()["locator"],
        json!({"kind":"reading","itemKey":"a"})
    );
    let both = reading_reader(&f, &["a", "b"]);
    let v = both.resolve_link("https://example.com/same").unwrap();
    assert_eq!(v["status"], "ambiguous");
    assert!(v.get("locator").is_none());
    assert_eq!(v["networkRequested"], false);
}

#[test]
fn saved_url_retains_query_fragment_and_scheme_and_never_claims_live_notion() {
    let f = Fixture::new();
    f.reading("a", "保存副本");
    let r = reading_reader(&f, &["a"]);
    f.c().execute("UPDATE collection_x_items SET post_json=json_set(post_json,'$.url','https://app.notion.com/p/page?v=1#part') WHERE item_key='a'",[]).unwrap();
    let exact = r
        .resolve_link("https://app.notion.com/p/page?v=1#part")
        .unwrap();
    assert_eq!(exact["status"], "resolved");
    assert_eq!(exact["remoteVerified"], false);
    assert_eq!(exact["evidenceOrigin"], "authorizedSavedReading");
    for url in [
        "https://app.notion.com/p/page?v=2#part",
        "https://app.notion.com/p/page?v=1",
        "http://app.notion.com/p/page?v=1#part",
    ] {
        assert_eq!(
            r.resolve_link(url).unwrap()["reason"],
            "missingHubNotionConnection"
        );
    }
    f.c().execute("UPDATE collection_x_items SET post_json=json_set(post_json,'$.url','https://example.com/changed') WHERE item_key='a'",[]).unwrap();
    assert_eq!(
        r.resolve_link("https://app.notion.com/p/page?v=1#part")
            .unwrap()["reason"],
        "missingHubNotionConnection"
    );
    assert_eq!(
        r.resolve_link("https://example.com/changed").unwrap()["status"],
        "resolved"
    );
}

#[test]
fn malformed_saved_metadata_is_not_used_as_a_url_or_exposed() {
    let f = Fixture::new();
    f.reading("a", "正文");
    let r = reading_reader(&f, &["a"]);
    for raw in [
        "{broken",
        r#"{"url":42,"text":"不应泄露"}"#,
        r#"{"url":"https://user:secret@example.com/a"}"#,
    ] {
        f.c()
            .execute(
                "UPDATE collection_x_items SET post_json=?1 WHERE item_key='a'",
                [raw],
            )
            .unwrap();
        let v = r.resolve_link("https://example.com/a").unwrap();
        assert_eq!(v["status"], "unavailable");
        assert!(!v.to_string().contains("secret") && !v.to_string().contains("不应泄露"));
    }
}
