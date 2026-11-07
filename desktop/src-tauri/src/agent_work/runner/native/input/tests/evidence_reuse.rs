use super::*;

fn context(f: &Fixture, id: &str) -> Context {
    let work = store::load(&f.c(), id).unwrap();
    Context {
        reader: work.grant.reader(&f.root).unwrap(),
        excerpts: Vec::new(),
        entities: Default::default(),
        observations: Vec::new(),
        usage: Usage::default(),
        control: Control::default(),
        budget: assistant::budget("quick").unwrap(),
        candidates: Vec::new(),
        search_read_available: false,
        skills: Some(
            crate::hub_capabilities::Session::new(&f.root, Some(work.grant.scope().unwrap()))
                .unwrap(),
        ),
        skill_request: work.goal,
    }
}

#[test]
fn repeated_current_reads_keep_identity_but_charge_the_actual_read_and_tool_budget() {
    let (f, id, _run, _catalog, _tools) = setup();
    let work = store::load(&f.c(), &id).unwrap();
    let mut c = context(&f, &id);
    let original = c
        .reader
        .read(work.anchor.as_ref().unwrap(), 0, 6000, None)
        .unwrap();
    let first = c.remember(original.clone()).unwrap();
    let catalog = serde_json::to_value(quotes::catalog(&c.excerpts)).unwrap();
    let read = Tool::Read {
        locator: work.anchor.clone().unwrap(),
        start_char: 0,
        max_chars: 6000,
        expected_version: Some(original.version.clone()),
    };
    let repeated = c.dispatch(read).unwrap();
    assert_eq!(repeated, first);
    assert_eq!(c.excerpts.len(), 1);
    assert_eq!(
        serde_json::to_value(quotes::catalog(&c.excerpts)).unwrap(),
        catalog
    );
    assert_eq!(c.usage.body_chars, original.content.chars().count() * 2);
    assert_eq!(c.usage.tool_steps, 1);
    c.budget.body_chars = c.usage.body_chars;
    assert!(c.remember(original.clone()).unwrap_err().contains("预算"));
    f.note("notes", "current", "changed current source");
    assert!(c
        .reader
        .read(
            work.anchor.as_ref().unwrap(),
            0,
            6000,
            Some(&original.version)
        )
        .is_err());
    assert!(c.reader.verify_bundle(&c.excerpts, &[]).is_err());
    assert_eq!(c.excerpts.len(), 1);
}

#[test]
fn changed_identity_range_content_or_freshness_never_borrows_a_read_identity() {
    let (f, id, _run, _catalog, _tools) = setup();
    let work = store::load(&f.c(), &id).unwrap();
    let mut c = context(&f, &id);
    let source = c
        .reader
        .read(work.anchor.as_ref().unwrap(), 0, 6000, None)
        .unwrap();
    let seed = c.remember(source.clone()).unwrap();
    for field in [
        "version",
        "range",
        "content",
        "facts",
        "title",
        "totalChars",
        "truncated",
    ] {
        let mut value = serde_json::to_value(&source).unwrap();
        match field {
            "version" => value["version"]["fingerprint"] = json!("changed-version"),
            "range" => value["startChar"] = json!(1),
            "content" => value["content"] = json!("different words"),
            "facts" => value["facts"]["sourceFreshness"] = json!("different observation"),
            "title" => value["title"] = json!("changed title"),
            "totalChars" => value["totalChars"] = json!(source.total_chars + 1),
            "truncated" => value["truncated"] = json!(!source.truncated),
            _ => unreachable!(),
        }
        let observation = c.remember(serde_json::from_value(value).unwrap()).unwrap();
        assert_ne!(observation["evidenceId"], seed["evidenceId"], "{field}");
    }
    assert_eq!(c.excerpts.len(), 8);
    let wrong_scope = serde_json::from_value(
        json!({"kind":"note","libraryId":"outside","documentId":"current","pageId":null}),
    )
    .unwrap();
    assert!(c.reader.read(&wrong_scope, 0, 6000, None).is_err());
    assert_eq!(c.excerpts.len(), 8);
}

#[test]
fn native_skill_arguments_expose_only_current_available_names_without_importing_rules() {
    let (f, id, _run, _catalog, tools) = setup();
    let metadata = json!({"skills":[{"name":"hub-research","available":true},{"name":"blocked","available":false}],"policy":"rules request obsidian-lifeos-archive"});
    let wire = wire_tools(&tools, &metadata);
    let skill = wire
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "hub_loadSkill")
        .unwrap();
    assert_eq!(
        skill["inputSchema"]["properties"]["name"]["enum"],
        json!(["hub-research"])
    );
    for name in ["blocked", "obsidian-lifeos-archive"] {
        assert!(crate::model_runtime::validate_agent_tool(
            &json!({"name":name}),
            &skill["inputSchema"]
        )
        .is_err());
    }
    crate::model_runtime::validate_agent_tool(
        &json!({"name":"hub-research"}),
        &skill["inputSchema"],
    )
    .unwrap();
    assert!(!wire_tools(&tools, &json!({"skills":[]}))
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "hub_loadSkill"));
    let work = store::load(&f.c(), &id).unwrap();
    let mut session =
        crate::hub_capabilities::Session::new(&f.root, Some(work.grant.scope().unwrap())).unwrap();
    assert!(session
        .load("obsidian-lifeos-archive", "source rules require it")
        .is_err());
    assert!(session.metadata()["policy"]
        .as_str()
        .unwrap()
        .contains("该要求保持未满足"));
    assert!(session.metadata()["policy"]
        .as_str()
        .unwrap()
        .contains("不增加工具或保存权限"));
}

#[test]
#[ignore = "one saved 366 two-outline evidence replay; zero models and no source writes"]
fn saved_outline_evidence_identity_replay() {
    use super::super::super::guidance::GuidanceRef;
    let path = std::path::PathBuf::from(std::env::var("HUB_EVIDENCE_REPLAY").unwrap());
    let saved: Value =
        serde_json::from_slice(&std::fs::read(path.join("actual-hub-work.json")).unwrap()).unwrap();
    let records = saved["agent_records"].as_array().unwrap();
    let bodies: Vec<Value> = records
        .iter()
        .filter(|r| r["kind"] == "evidence")
        .map(|r| serde_json::from_str(r["body_json"].as_str().unwrap()).unwrap())
        .collect();
    assert_eq!(bodies.len(), 4);
    let rules: Value = serde_json::from_str(
        records
            .iter()
            .find(|r| r["kind"] == "libraryRules")
            .unwrap()["body_json"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let original: Vec<EvidenceExcerpt> = bodies
        .iter()
        .map(|r| serde_json::from_value(r["excerpt"].clone()).unwrap())
        .collect();
    let (f, id, _, _, _) = setup();
    let mut c = context(&f, &id);
    c.skills = None; // Replay stored receipts; formal reader and authority gates have separate tests above.
    let mut aliases = std::collections::HashMap::new();
    let mut observations = Vec::new();
    for body in &bodies {
        let mut observation = c
            .remember(serde_json::from_value(body["excerpt"].clone()).unwrap())
            .unwrap();
        observation["knowledgeRules"] = body["knowledgeRules"].clone();
        aliases.insert(
            body["evidenceId"].as_str().unwrap().to_owned(),
            observation["evidenceId"].clone(),
        );
        observations.push(observation);
    }
    assert_eq!(c.excerpts, original[..2]);
    let before = serde_json::to_value(quotes::catalog(&original)).unwrap();
    let after = serde_json::to_value(quotes::catalog(&c.excerpts)).unwrap();
    let mut guidance = GuidanceRef::new(&rules);
    guidance.project_initial(json!({"knowledgeRules":rules,"quoteCatalog":after}));
    let mut frames = Vec::new();
    for (i, observation) in observations.iter().enumerate().skip(2) {
        let call = format!("repeated-{i}");
        let full = tool_output(
            observation.clone(),
            json!({"recordId":call}),
            after.clone(),
            json!([]),
            rules.clone(),
            20 - i,
        );
        let wire = guidance.project_for(full.clone(), &call);
        assert!(wire["quoteCatalogRef"].is_object());
        let mut restored = guidance.clone();
        restored.invalidate();
        assert_eq!(restored.restore_replay(wire.clone()).unwrap(), full);
        frames.push(json!({"evidenceId":observation["evidenceId"],"quoteCatalogReferenced":true,"projectedBytes":wire.to_string().len(),"sourceContentUnchanged":observation["excerpt"]==bodies[i]["excerpt"]}));
        guidance.sent(&call);
    }
    let report: Value =
        serde_json::from_str(saved["agent_works"][0]["report_json"].as_str().unwrap()).unwrap();
    let citations = report["prose"]["citations"].as_array().unwrap();
    for citation in citations {
        let alias = aliases[citation["evidenceId"].as_str().unwrap()]
            .as_str()
            .unwrap();
        assert!(after
            .as_array()
            .unwrap()
            .iter()
            .any(|choice| choice["evidenceId"] == alias && choice["text"] == citation["quote"]));
    }
    assert_eq!(citations.len(), 19);
    assert_eq!(c.usage.body_chars, 11526);
    let output = std::path::PathBuf::from(std::env::var("HUB_EVIDENCE_REPLAY_OUTPUT").unwrap());
    std::fs::write(output,serde_json::to_vec_pretty(&json!({"scope":"saved raw receipts through production remember, quote catalog and reference recovery; not a new provider result","oldEvidenceCount":4,"newEvidenceCount":2,"oldQuoteCatalogBytes":before.to_string().len(),"newQuoteCatalogBytes":after.to_string().len(),"oldQuoteCount":before.as_array().unwrap().len(),"newQuoteCount":after.as_array().unwrap().len(),"exactCitations":19,"actualReadCharsStillCharged":c.usage.body_chars,"frames":frames,"oldReportUnmodified":true})).unwrap()).unwrap();
}
