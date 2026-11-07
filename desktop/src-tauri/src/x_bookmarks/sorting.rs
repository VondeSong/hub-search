use super::*;

#[derive(Clone, Deserialize)]
pub(crate) struct Rule {
    pub field: String,
    #[serde(default)]
    pub ascending: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rules(fields: &[(&str, bool)]) -> Vec<Rule> {
        fields
            .iter()
            .map(|(field, ascending)| Rule {
                field: (*field).into(),
                ascending: *ascending,
            })
            .collect()
    }
    #[test]
    fn multiple_fields_sort_before_pagination_with_stable_ties() {
        let mut c = super::super::tests::database();
        storage::schema(&c).unwrap();
        for n in 1..=75 {
            let mut post = parse_post(&super::super::tests::tweet(&n.to_string())).unwrap();
            post.author_name = if n % 2 == 0 { "Alpha" } else { "Zulu" }.into();
            post.text = if n % 3 == 0 { "C" } else { "A" }.into();
            post.all_media = vec![Media {
                kind: "video".into(),
                url: format!("https://video.twimg.com/{n}.mp4"),
                preview_url: String::new(),
            }];
            let page = Page {
                posts: vec![post],
                cursor: None,
                cursor_only: false,
                ended: true,
                unavailable: 0,
            };
            persist_source_page(
                &mut c,
                "123",
                &page,
                n,
                if n % 2 == 0 {
                    Source::Likes
                } else {
                    Source::Bookmarks
                },
            )
            .unwrap();
            c.execute(
                "INSERT INTO collection_x_properties VALUES(?1,?2,?3)",
                params![
                    format!("{}:123:{n}", if n % 2 == 0 { "x-likes" } else { "x" }),
                    if n % 3 == 0 { "in_progress" } else { "unread" },
                    if n % 2 == 0 {
                        "[\"z\",\"A\"]"
                    } else {
                        "[\"b\"]"
                    }
                ],
            )
            .unwrap();
        }
        let run = |sorts: Vec<Rule>, offset: u32| {
            query_collection_items(
                &c,
                String::new(),
                false,
                offset,
                Some("all".into()),
                None,
                None,
                None,
                None,
                Some(sorts),
            )
            .unwrap()
            .3
        };
        let ids = |items: Vec<Value>| {
            items
                .iter()
                .map(|i| i["post"]["id"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        let fields = [("status", true), ("author", true), ("published", false)];
        let mut actual = ids(run(rules(&fields), 0));
        actual.extend(ids(run(rules(&fields), 60)));
        let mut expected = (1..=75).collect::<Vec<i32>>();
        expected.sort_by_key(|n| (n % 3 == 0, n % 2 != 0, -*n));
        assert_eq!(
            actual,
            expected.iter().map(i32::to_string).collect::<Vec<_>>()
        );
        // Every offered field must execute valid SQL, including correlated multi-select tags.
        for field in [
            "title",
            "status",
            "tags",
            "source",
            "author",
            "published",
            "collected",
            "media",
            "liked",
            "destination",
        ] {
            assert_eq!(run(rules(&[(field, true)]), 0).len(), 60);
        }
        assert_eq!(
            run(rules(&[("tags", true), ("published", true)]), 0)[0]["post"]["id"],
            "2"
        );
        assert_eq!(
            run(rules(&[("liked", false), ("published", true)]), 0)[0]["post"]["id"],
            "2"
        );
        assert_eq!(
            run(rules(&[("title", false), ("published", true)]), 0)[0]["post"]["id"],
            "3"
        );
    }
    #[test]
    fn invalid_or_duplicate_fields_cannot_enter_sql_and_legacy_settings_survive() {
        assert!(order(
            Some(rules(&[("DROP TABLE collection_x_items", true)])),
            None,
            None
        )
        .is_err());
        assert!(order(
            Some(rules(&[("author", true), ("author", false)])),
            None,
            None
        )
        .is_err());
        assert_eq!(
            order(None, Some("published".into()), Some(true)).unwrap(),
            order(Some(rules(&[("published", true)])), None, None).unwrap()
        );
        assert!(order(Some(vec![]), None, None)
            .unwrap()
            .starts_with("collected_at DESC"));
    }
}

pub(super) fn order(
    rules: Option<Vec<Rule>>,
    legacy: Option<String>,
    ascending: Option<bool>,
) -> Result<String, String> {
    let rules = rules.unwrap_or_else(|| {
        vec![Rule {
            field: legacy.unwrap_or_else(|| "collected".into()),
            ascending: ascending.unwrap_or(false),
        }]
    });
    if rules.len() > 10 {
        return Err("排序条件最多 10 个".into());
    }
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    for rule in rules {
        if !seen.insert(rule.field.clone()) {
            return Err("同一属性只能设置一条排序条件".into());
        }
        let field = match rule.field.as_str() {
            "collected" => "collected_at",
            "published" => "CASE WHEN json_extract(post_json,'$.source')='telegram' THEN CAST((julianday(json_extract(post_json,'$.publishedAt'))-2440587.5)*86400000.0-1288834974657.0 AS INTEGER)*4194304 ELSE CAST(json_extract(post_json,'$.id') AS INTEGER) END",
            "author" => "lower(COALESCE(NULLIF(json_extract(post_json,'$.authorName'),''),json_extract(post_json,'$.authorHandle'),''))",
            "title" => "lower(trim(COALESCE(json_extract(post_json,'$.text'),'')))",
            "source" => "CASE json_extract(post_json,'$.source') WHEN 'likes' THEN 1 WHEN 'telegram' THEN 2 ELSE 0 END",
            "status" => "CASE COALESCE((SELECT status FROM collection_x_properties p WHERE p.item_key=collection_x_items.item_key),CASE WHEN read_at>0 THEN 'read' ELSE 'unread' END) WHEN 'unread' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'read' THEN 2 ELSE 3 END",
            "tags" => "COALESCE((SELECT group_concat(tag,char(31)) FROM (SELECT value AS tag FROM collection_x_properties p,json_each(p.tags) WHERE p.item_key=collection_x_items.item_key ORDER BY lower(value))),'') COLLATE NOCASE",
            "media" => "COALESCE(json_array_length(post_json,'$.allMedia'),json_array_length(post_json,'$.media'),0)",
            "destination"=>"COALESCE((SELECT destination_name FROM collection_lifecycle l WHERE l.item_key=collection_x_items.item_key),'') COLLATE NOCASE",
            "liked" => "CASE WHEN json_extract(post_json,'$.source')='likes' OR json_extract(post_json,'$.liked')=1 THEN 1 ELSE 0 END",
            _ => return Err("未知排序属性".into()),
        };
        order.push(format!(
            "{field} {}",
            if rule.ascending { "ASC" } else { "DESC" }
        ));
    }
    if order.is_empty() {
        order.push("collected_at DESC".into());
    }
    order.push("CAST(json_extract(post_json,'$.id') AS INTEGER) DESC,item_key".into());
    Ok(order.join(","))
}
