//! Replay the saved normalized monthly report, without a provider or new input.
use super::*;
use crate::source_evidence::tests::Fixture;
mod quality_omission;
mod source_review;

struct Replay {
    f: Fixture,
    work: Work,
    run: String,
    report: Report,
    delivery: Value,
}
impl Replay {
    fn saved() -> Self {
        let directory = PathBuf::from(std::env::var("HUB_RESPONSE_REPLAY").unwrap());
        let f = Fixture::new();
        for name in [
            "analysis-snapshots.sqlite3",
            "analysis-snapshot-policy.json",
        ] {
            std::fs::copy(directory.join(name), f.root.join(name)).unwrap();
        }
        std::fs::copy(
            directory.join("saved-month.sqlite3"),
            f.root.join("craft-search.sqlite3"),
        )
        .unwrap();
        let c = f.c();
        let (id, raw): (String, String) = c
            .query_row("SELECT id,report_json FROM agent_works", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        let run: String = c
            .query_row(
                "SELECT id FROM agent_runs WHERE work_id=?1 ORDER BY rowid DESC LIMIT 1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        let delivery = store::records(&f.root, &id, "delivery", 1).unwrap()[0].clone();
        let report: Report = serde_json::from_str(&raw).unwrap();
        assert_eq!(serde_json::to_value(&report).unwrap(), delivery["report"]);
        // Restore only the run's pre-publication lifecycle in this disposable
        // copy. Keep every saved record, source, grant and original binding.
        c.execute("UPDATE agent_works SET state='investigating',active_run=?1,report_json=NULL WHERE id=?2", params![run,id]).unwrap();
        c.execute(
            "UPDATE agent_runs SET state='investigating',finished_at=NULL WHERE id=?1",
            [&run],
        )
        .unwrap();
        let work = store::load(&c, &id).unwrap();
        Self {
            f,
            work,
            run,
            report,
            delivery,
        }
    }
    fn evidence(&self) -> Vec<EvidenceExcerpt> {
        serde_json::from_value(self.delivery["evidence"].clone()).unwrap()
    }
    fn accept(&self, report: &Report) -> Result<Value, String> {
        validate(report, &self.evidence())?;
        store::goal::accept_report(
            &self.f.root,
            &self.work,
            &self.run,
            report,
            &store::goal::for_run(&self.f.root, &self.work, &self.run)?,
        )
    }
    fn publish(&self, report: &Report, control: &Control) -> Result<(), String> {
        let candidates: Vec<(EvidenceLocator, crate::source_evidence::EvidenceVersion)> =
            serde_json::from_value(self.delivery["candidates"].clone()).unwrap();
        store::publish(
            &self.f.root,
            &self.work,
            &self.run,
            report,
            &self.evidence(),
            &candidates,
            &self.delivery["actionReceipts"],
            &self.delivery["materialReads"],
            control,
        )
    }
    fn output(&self, name: &str, value: Value) {
        if let Ok(directory) = std::env::var("HUB_RESPONSE_REPORT") {
            std::fs::write(
                Path::new(&directory).join(name),
                serde_json::to_vec_pretty(&value).unwrap(),
            )
            .unwrap();
        }
    }
}

#[test]
#[ignore = "saved authorized monthly report and snapshot store required; no model"]
fn saved_month_report_reproduces_partial_despite_durable_delivery() {
    let r = Replay::saved();
    assert_eq!(r.work.grant.notes.len(), 26);
    assert!(r.work.grant.library_ids.is_empty());
    let assessed = r.accept(&r.report).unwrap();
    assert_eq!(assessed["workFulfillment"], "partial");
    assert_eq!(assessed["deterministicChecks"], "passed");
    assert_eq!(
        assessed["completionEvidence"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["status"] == "blocked")
            .count(),
        1
    );
    r.publish(&r.report, &Control::default()).unwrap();
    let reopened = store::view(&r.f.root, &r.work.id).unwrap();
    assert_eq!(reopened["goalAssessment"]["workFulfillment"], "partial");
    assert_eq!(
        reopened["work"]["report"],
        serde_json::to_value(&r.report).unwrap()
    );
    assert_eq!(
        store::records(&r.f.root, &r.work.id, "delivery", 2).unwrap()[1],
        r.delivery
    );
    r.output("saved-report-replay.json", json!({"normalizedReportUnchanged":true,"sources":26,
        "assessment":assessed,"publishedAndReopened":true,"originalDeliveryPreserved":true,"modelCalls":0}));
}

#[test]
#[ignore = "saved authorized monthly report and snapshot store required; no model"]
fn response_delivery_contract_allows_reviewed_absence_report_and_keeps_publication_gates() {
    let r = Replay::saved();
    let control = Control::default();
    let session = assistant::Session {
        root: &r.f.root,
        work: &r.work,
        run: &r.run,
        control: &control,
        operation: None,
        selection: Value::Null,
        app: None,
    };
    let context = session.dispatch(Tool::GoalState {}).unwrap();
    r.output(
        "response-contract-entry.json",
        json!({"responseDelivery":context.get("responseDelivery"),"modelCalls":0}),
    );
    assert_eq!(
        context["responseDelivery"]["scope"], "currentWork",
        "formal goalState lacks the host-owned response delivery contract"
    );
    assert_eq!(
        context["responseDelivery"]["acceptedState"],
        "validatedPendingPublication"
    );
    assert_eq!(context["responseDelivery"]["publicationAtomic"], true);
    assert_eq!(context["responseDelivery"]["completionResult"], "response");
    assert_eq!(
        session.capabilities().unwrap()["responseDelivery"],
        context["responseDelivery"]
    );
    let specs = tools(None).unwrap();
    let finish = specs
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "hub_finish")
        .unwrap();
    assert!(finish["description"].as_str().unwrap().contains("最终发布"));
    assert!(finish["description"].as_str().unwrap().contains("当前事项"));

    let mut raw = serde_json::to_value(&r.report).unwrap();
    raw["status"] = json!("completed");
    let items = raw["completion"]["items"].as_array_mut().unwrap();
    let blocked = items.iter_mut().find(|i| i["status"] == "blocked").unwrap();
    assert!(blocked["criterion"].as_str().unwrap().contains("当前事项"));
    blocked["status"] = json!("satisfied");
    blocked["explanation"] = json!("数据第1版已保存；本次报告通过最终发布事务留存于当前事项及历史，可重开核对，不要求外部保存或独立报告制品。离线语义复核，不是模型自主恢复证据。");
    let markdown = raw["summary"].as_str().unwrap();
    let begin = markdown.find("本报告随本次答复交付").unwrap();
    let end = markdown[begin..]
        .find('\n')
        .map_or(markdown.len(), |offset| begin + offset);
    let revised = format!("{}本报告随最终发布保存在当前事项及历史中，后续修订仍须核对授权、来源和版本；未另存到外部来源。{}", &markdown[..begin], &markdown[end..]);
    raw["summary"] = json!(revised);
    raw["prose"]["markdown"] = raw["summary"].clone();
    raw["limitations"]
        .as_array_mut()
        .unwrap()
        .retain(|item| !item.as_str().unwrap().contains("独立报告"));
    let report: Report = serde_json::from_value(raw.clone()).unwrap();
    let assessment = r.accept(&report).unwrap();
    assert_eq!(assessment["workFulfillment"], "fulfilled");
    assert_eq!(assessment["proofVersions"], json!([]));
    assert!(store::records(&r.f.root, &r.work.id, "chartRevision", 1)
        .unwrap()
        .is_empty());

    let mut chart = raw.clone();
    chart["completion"]["items"][0]["requiredResult"] = json!("chart");
    let missing_chart = r
        .accept(&serde_json::from_value(chart).unwrap())
        .unwrap_err();
    assert!(missing_chart.contains("缺少真实成果"), "{missing_chart}");
    let mut stale = raw.clone();
    stale["completion"]["goalBinding"]["authorizationVersion"] = json!(0);
    assert!(r
        .accept(&serde_json::from_value(stale).unwrap())
        .unwrap_err()
        .contains("用户要求已更新"));
    let mut changed = report.clone();
    changed.summary.push_str("changed after acceptance");
    let changed_error = r.publish(&changed, &control).unwrap_err();
    assert!(changed_error.contains("最终核验后"), "{changed_error}");
    assert_eq!(
        store::records(&r.f.root, &r.work.id, "delivery", 1).unwrap()[0],
        r.delivery
    );
    let datasets = store::records(&r.f.root, &r.work.id, "sleepDatasetRevision", 32).unwrap();
    assert_eq!(datasets.len(), 1);
    assert_eq!(datasets[0]["coverage"]["material"]["read"], 26);
    assert_eq!(datasets[0]["coverage"]["metric"]["accepted"], 0);
    assert!(datasets[0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["normalizedValue"].is_null()));
    r.publish(&report, &control).unwrap();
    let reopened = store::view(&r.f.root, &r.work.id).unwrap();
    assert_eq!(reopened["work"]["state"], "completed");
    assert_eq!(reopened["goalAssessment"]["workFulfillment"], "fulfilled");
    assert_eq!(
        reopened["work"]["report"],
        serde_json::to_value(&report).unwrap()
    );
    assert_eq!(
        store::records(&r.f.root, &r.work.id, "sleepDatasetRevision", 32).unwrap(),
        datasets
    );
    let deliveries = store::records(&r.f.root, &r.work.id, "delivery", 2).unwrap();
    assert_eq!(deliveries.len(), 2);
    assert_eq!(deliveries[1], r.delivery);
    r.output("reviewed-absence-publication.json", json!({"responseDelivery":context["responseDelivery"],
        "completion":assessment,"scope":26,"datasetUnchanged":true,"noChartCreated":true,
        "reopenedSameReport":true,"missingChartProofRejected":missing_chart,"postAcceptanceChangeRejected":changed_error,
        "staleAuthorizationBindingRejected":true,"originalDeliveryPreserved":true,
        "semanticReview":"offline reviewed variant; not autonomous model recovery","modelCalls":0}));
}
