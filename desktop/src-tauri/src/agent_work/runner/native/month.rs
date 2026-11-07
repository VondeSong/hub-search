//! Deterministic replay through native argument admission and production Context.
//! No provider, fake model result, reference rows or replacement budget is used.
use super::*;
use crate::source_evidence::tests::Fixture;

fn output(name: &str, value: &Value) {
    if let Ok(directory) = std::env::var("HUB_READ_BUDGET_REPORT") {
        std::fs::write(
            Path::new(&directory).join(name),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}

struct Route {
    f: Fixture,
    work: Work,
    run: String,
    context: Context,
    original: Vec<String>,
    days: Vec<String>,
}
impl Route {
    fn new(bodies: Vec<String>) -> Self {
        let days = (0..bodies.len())
            .map(|i| format!("2025-07-{:02}", i + 1))
            .collect();
        Self::with_days(bodies, days)
    }
    fn with_days(bodies: Vec<String>, days: Vec<String>) -> Self {
        let f = Fixture::new();
        std::fs::write(
            f.root.join("analysis-snapshot-policy.json"),
            b"{\"retentionHours\":168,\"maxStoreMib\":128}",
        )
        .unwrap();
        let mut notes = Vec::new();
        for (i, body) in bodies.iter().enumerate() {
            let id = format!("month-{i:02}");
            let title = &days[i];
            f.note("notes", &id, body);
            f.c()
                .execute(
                    "UPDATE documents SET title=?1,path=?2 WHERE space_id='notes' AND id=?3",
                    params![title, format!("selected-month/{title}.md"), id],
                )
                .unwrap();
            notes.push(json!({"kind":"note","libraryId":"notes","documentId":id,"pageId":null}));
        }
        let view = crate::agent_work::ui(&f.root,&json!({"action":"create","goal":"完整读取所选月份，核对主睡眠；无精确值时如实说明并保留出处，不伪造均值或图表",
            "successCriteria":"整月范围，原文只读，授权与证据检查不变","anchor":notes[0],
            "grant":{"libraryIds":[],"notes":notes,"readingItemKeys":[]}})).unwrap();
        let (work, run) = crate::agent_work::tests::claim(&f, view["work"]["id"].as_str().unwrap());
        let control = Control::bounded(Duration::from_secs(180));
        let context = Context {
            reader: work
                .grant
                .reader(&f.root)
                .unwrap()
                .controlled(control.clone()),
            excerpts: Vec::new(),
            entities: HashSet::new(),
            observations: Vec::new(),
            usage: Usage::default(),
            control: control.clone(),
            budget: assistant::budget("quick").unwrap(),
            candidates: Vec::new(),
            search_read_available: false,
            skills: Some(
                crate::hub_capabilities::Session::new(&f.root, Some(work.grant.scope().unwrap()))
                    .unwrap()
                    .controlled(control),
            ),
            skill_request: work.goal.clone(),
        };
        Self {
            f,
            work,
            run,
            context,
            original: bodies,
            days,
        }
    }
    fn step(&mut self, name: &str, args: Value) -> Result<Value, String> {
        let specs = tools(self.context.skills.as_ref())?;
        let call = json!({"tool":name,"arguments":args,"callId":format!("offline-{}",self.context.usage.tool_steps)});
        let decoded = arguments::decode(
            &self.f.root,
            &self.run,
            &specs,
            &call,
            &mut self.context.usage.tool_steps,
            self.context.budget.tool_steps,
        )?
        .map_err(|feedback| feedback.to_string())?;
        self.context.dispatch(decoded)
    }
    fn capture(&mut self) -> Value {
        self.step("hub_create_analysis_snapshot", json!({}))
            .unwrap()["snapshot"]
            .clone()
    }
    fn page(
        &mut self,
        snapshot: &Value,
        index: usize,
        start: usize,
        limit: usize,
    ) -> Result<Value, String> {
        self.step("hub_read_analysis_snapshot",json!({"expectedSnapshot":snapshot,"itemIndex":index,"start":start,"limit":limit,"itemCount":8}))
    }
}

#[test]
fn v1_formal_trigger_frozen_read_failure_restores_then_permanent_denial_stays_explicit() {
    let body = "# 2025-07-01\n固定材料只读核对。\n";
    let mut route = Route::new(vec![body.into()]);
    let snapshot = route.capture();
    let first = route.page(&snapshot, 0, 0, 8000).unwrap();
    let database = route.f.root.join("analysis-snapshots.sqlite3");
    let held = route.f.root.join("formal-read-held.sqlite3");
    std::fs::rename(&database, &held).unwrap();
    let failed = route.page(&snapshot, 0, 0, 8000);
    std::fs::rename(&held, &database).unwrap();
    let transient = failed.unwrap_err();
    assert!(transient.contains("分析快照存储不可用"), "{transient}");
    let recovered = route.page(&snapshot, 0, 0, 8000).unwrap();
    assert_eq!(
        first["items"][0]["content"],
        recovered["items"][0]["content"]
    );
    assert_eq!(recovered["snapshot"], snapshot);
    route
        .f
        .c()
        .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
        .unwrap();
    let permanent = route.page(&snapshot, 0, 0, 8000).unwrap_err();
    assert!(!permanent.is_empty());
    output(
        "ux07-trigger-qualification.json",
        &json!({"case":"UX-07","track":"deterministic native argument admission and production Context, no model decision score","trigger":"after frozen snapshot capture, before body read","transient":"remove only isolated analysis snapshot path; restore original database immediately after real read error","transientError":transient,"sameSnapshotRecovery":true,"permanent":"isolated authorized library enabled=0 before next read","permanentError":permanent,"permanentReturnedBody":false,"sourceUnchanged":route.original[0]==body,"modelCalls":0}),
    );
}

fn month() -> Route {
    let path = std::env::var("HUB_READ_MONTH_MANIFEST").unwrap();
    let manifest: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(manifest["selection"]["targetStart"], "2025-07-01");
    assert_eq!(manifest["selection"]["targetEnd"], "2025-07-31");
    let root =
        std::fs::canonicalize(manifest["selection"]["sourceDirectory"].as_str().unwrap()).unwrap();
    let inputs = manifest["inputs"].as_array().unwrap();
    assert_eq!(inputs.len(), 26);
    let bodies = inputs
        .iter()
        .map(|item| {
            let day = item["recordedDay"].as_str().unwrap();
            assert!(day.starts_with("2025-07-") && day.len() == 10);
            let path = std::fs::canonicalize(root.join(format!("{day}.md"))).unwrap();
            assert_eq!(path.parent(), Some(root.as_path()));
            let bytes = std::fs::read(path).unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), item["sha256"]);
            String::from_utf8(bytes).unwrap()
        })
        .collect();
    Route::with_days(
        bodies,
        inputs
            .iter()
            .map(|item| item["recordedDay"].as_str().unwrap().to_owned())
            .collect(),
    )
}

#[test]
#[ignore = "authorized full-month manifest required; deterministic host replay, no model"]
fn single_item_snapshot_reads_exhaust_24_steps_after_22_sources() {
    let mut r = month();
    let snapshot = r.capture();
    let listed = r
        .step(
            "hub_list_note_sources",
            json!({"expectedSnapshot":snapshot,"limit":32}),
        )
        .unwrap();
    assert_eq!(listed["total"], 26);
    let budget = serde_json::to_value(r.context.budget).unwrap();
    let mut read = 0;
    let mut read_chars = 0;
    let mut denial = None;
    for index in 0..26 {
        match r.step(
            "hub_read_analysis_snapshot",
            json!({"expectedSnapshot":snapshot,"itemIndex":index,"start":0,"limit":8000}),
        ) {
            Ok(value) => {
                assert_eq!(value["content"], r.original[index]);
                read += 1;
                read_chars += r.original[index].chars().count();
            }
            Err(error) => {
                denial = Some((index, error));
                break;
            }
        }
    }
    let (index, error) = denial.expect("Expected original 24-step refusal, never increase budget");
    output(
        "single-item-replay.json",
        &json!({"selected":26,"read":read,"unread":26-read,"deniedItemIndex":index,"error":error,
        "usedToolSteps":r.context.usage.tool_steps,"readCharacters":read_chars,"chargedBodyCharacters":r.context.usage.body_chars,
        "budget":budget,"modelCalls":0,"sourceWrites":0,"fullScopeRead":false}),
    );
    assert_eq!(read, 22);
    assert_eq!(index, 22);
    assert!(error.contains("工具步骤预算已用尽"));
    assert_eq!(r.context.usage.tool_steps, 24);
    assert_eq!(r.context.budget.tool_steps, 24);
    assert!(store::records(&r.f.root, &r.work.id, "chartRevision", 32)
        .unwrap()
        .is_empty());
    assert!(store::records(&r.f.root, &r.work.id, "delivery", 32)
        .unwrap()
        .is_empty());
}

#[test]
#[ignore = "authorized full-month manifest required; deterministic host replay, no model"]
fn bounded_snapshot_pages_read_full_month_with_unchanged_budget() {
    let mut r = month();
    let before = serde_json::to_value(r.context.budget).unwrap();
    let snapshot = r.capture();
    r.step(
        "hub_list_note_sources",
        json!({"expectedSnapshot":snapshot,"limit":32}),
    )
    .unwrap();
    let mut index = 0;
    let mut start = 0;
    let mut pages = 0;
    let mut collected = vec![String::new(); 26];
    loop {
        let result = r.page(&snapshot, index, start, 8000);
        if let Err(error) = &result {
            output(
                "page-entry-error.json",
                &json!({"error":error,"itemIndex":index,"usedToolSteps":r.context.usage.tool_steps,"modelCalls":0}),
            );
        }
        let page = result.unwrap();
        pages += 1;
        assert_eq!(page["snapshot"], snapshot);
        assert!(page.to_string().len() <= 48_000);
        let mut chars = 0;
        let items = page["items"].as_array().unwrap();
        assert!(items.len() <= 8);
        for item in items {
            let i = item["itemIndex"].as_u64().unwrap() as usize;
            assert_eq!(item["title"], r.days[i]);
            assert_eq!(item["path"], format!("selected-month/{}.md", r.days[i]));
            assert_eq!(item["start"], collected[i].chars().count());
            let text = item["content"].as_str().unwrap();
            chars += text.chars().count();
            collected[i].push_str(text);
            assert_eq!(item["end"], collected[i].chars().count());
            assert_eq!(
                item["sourceRevision"]["bodySha256"],
                format!("{:x}", Sha256::digest(r.original[i].as_bytes()))
            );
        }
        assert!(chars <= 8000);
        assert_eq!(page["readCharacters"], chars);
        if page["next"].is_null() {
            break;
        }
        let next = page["next"]["itemIndex"].as_u64().unwrap() as usize;
        let position = page["next"]["start"].as_u64().unwrap() as usize;
        assert!((next, position) > (index, start));
        index = next;
        start = position;
    }
    assert_eq!(collected, r.original);
    assert_eq!(pages, 4);
    assert_eq!(r.context.usage.body_chars, 11370);
    assert_eq!(r.context.usage.tool_steps, 6);
    assert_eq!(serde_json::to_value(r.context.budget).unwrap(), before);
    output(
        "full-month-pages.json",
        &json!({"notes":26,"pages":pages,"readCharacters":r.context.usage.body_chars,"usedToolSteps":r.context.usage.tool_steps,
        "remainingToolSteps":24-r.context.usage.tool_steps,"budgetBefore":before,"budgetAfter":r.context.budget,
        "allSourceBodiesAndVersionsMatched":true,"modelCalls":0,"autonomousExtractionVerified":false}),
    );
}

#[test]
fn snapshot_page_continuations_authorization_and_body_quota_stay_strict() {
    let text = "学💤e\u{301}".repeat(2251); // Scalar/byte positions differ, and one source spans pages.
    let mut r = Route::new(vec![text.clone(), "中间".into(), "末尾".into()]);
    let snapshot = r.capture();
    let first = r.page(&snapshot, 0, 0, 8000).unwrap();
    assert_eq!(first["readCharacters"], 8000);
    assert_eq!(first["next"], json!({"itemIndex":0,"start":8000}));
    let rest = r.page(&snapshot, 0, 8000, 8000).unwrap();
    assert!(rest["next"].is_null());
    let joined = format!(
        "{}{}",
        first["items"][0]["content"].as_str().unwrap(),
        rest["items"][0]["content"].as_str().unwrap()
    );
    assert_eq!(joined, text);
    assert_eq!(rest["items"].as_array().unwrap().len(), 3);
    let mut unavailable = Route::new(vec!["有效原文".into(), String::new()]);
    let missing = unavailable.capture();
    let unavailable_error = unavailable.page(&missing, 0, 0, 8000).unwrap_err();
    assert!(
        unavailable_error.contains("没有可用正文"),
        "{unavailable_error}"
    );
    assert_eq!(unavailable.context.usage.body_chars, 0);
    let legacy = r
        .step(
            "hub_read_analysis_snapshot",
            json!({"expectedSnapshot":snapshot,"itemIndex":0,"start":1,"limit":3}),
        )
        .unwrap();
    assert_eq!(legacy["content"], "💤e\u{301}");
    assert!(legacy.get("items").is_none());
    r.f.note("notes", "month-00", "changed live body");
    let historical = r.page(&snapshot, 0, 0, 100).unwrap();
    assert_eq!(
        historical["items"][0]["content"],
        text.chars().take(100).collect::<String>()
    );
    for count in [0, 9] {
        assert!(r
            .step(
                "hub_read_analysis_snapshot",
                json!({"expectedSnapshot":snapshot,"itemIndex":0,"itemCount":count})
            )
            .is_err());
    }
    let mut bounded = Route::new(vec!["长".repeat(8000)]);
    let s = bounded.capture();
    for _ in 0..4 {
        bounded.page(&s, 0, 0, 8000).unwrap();
    }
    assert_eq!(bounded.context.usage.body_chars, 32000);
    let last = bounded.page(&s, 0, 0, 8000).unwrap();
    assert_eq!(last["readCharacters"], 4000);
    assert!(!last["next"].is_null());
    assert_eq!(bounded.context.usage.body_chars, 36000);
    assert!(bounded
        .page(&s, 0, 0, 8000)
        .unwrap_err()
        .contains("正文预算"));
    let mut oversized = Route::new(vec!["原文".into()]);
    oversized
        .f
        .c()
        .execute(
            "UPDATE documents SET title=?1 WHERE id='month-00'",
            ["大".repeat(20_000)],
        )
        .unwrap();
    let s = oversized.capture();
    assert!(oversized
        .page(&s, 0, 0, 8000)
        .unwrap_err()
        .contains("48000"));
    assert_eq!(oversized.context.usage.body_chars, 0);
    for mode in ["delete", "revoke", "expiry", "wrongScope", "cancel"] {
        let mut scoped = Route::new(vec!["原文".into()]);
        let s = scoped.capture();
        match mode {
            "delete" => {
                scoped
                    .f
                    .c()
                    .execute("DELETE FROM documents WHERE id='month-00'", [])
                    .unwrap();
            }
            "revoke" => {
                scoped
                    .f
                    .c()
                    .execute("UPDATE libraries SET enabled=0 WHERE id='notes'", [])
                    .unwrap();
            }
            "expiry" => {
                Connection::open(scoped.f.root.join("analysis-snapshots.sqlite3"))
                    .unwrap()
                    .execute("UPDATE snapshots SET expires_at=0", [])
                    .unwrap();
            }
            "wrongScope" => {
                scoped.context.skills = Some(
                    crate::hub_capabilities::Session::new(
                        &scoped.f.root,
                        Some(EvidenceScope::new(vec!["private".into()], vec![]).unwrap()),
                    )
                    .unwrap(),
                );
            }
            _ => scoped.context.control.cancel(),
        }
        assert!(scoped.page(&s, 0, 0, 8000).is_err(), "{mode}");
    }
    output(
        "page-guards.json",
        &json!({"scalarContinuation":true,"multipleSourceContinuation":true,"unavailableBodyRefusesWholePage":true,"itemCount0And9Rejected":true,
        "bodyCharsCeiling":36000,"remainingBudgetClampsPage":true,"serialized48000Limit":true,
        "singleItemWireShapePreserved":true,"historicalBodyNotSubstituted":true,"deleteRevokeExpiryScopeCancelRejected":true,"modelCalls":0}),
    );
}
