use super::*;
// Decimal minor units avoid floating point drift in sums and refunds.
pub(super) fn minor(s: &str) -> Result<i64, String> {
    let parts = s.split('.').collect::<Vec<_>>();
    if parts.len() > 2
        || parts[0].is_empty()
        || !parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()))
        || parts.get(1).is_some_and(|p| p.is_empty() || p.len() > 2)
    {
        return Err("金额须为非负十进制字符串，最多两位小数".into());
    }
    let whole = parts[0].parse::<i64>().map_err(|_| "金额超出范围")?;
    let fraction = parts
        .get(1)
        .map(|s| format!("{s:0<2}").parse::<i64>().unwrap())
        .unwrap_or(0);
    whole
        .checked_mul(100)
        .and_then(|v| v.checked_add(fraction))
        .filter(|v| *v <= 100_000_000_000)
        .ok_or("金额超出本轮范围".into())
}
fn money(n: i64) -> String {
    let sign = if n < 0 { "-" } else { "" };
    let n = n.unsigned_abs();
    format!("{sign}{}.{:02}", n / 100, n % 100)
}
fn metric_kind(kind: &str) -> Option<&str> {
    match kind {
        "expense" | "refund" => Some("expense"),
        "health" | "readingFinished" | "film" | "episode" | "activity" => Some(kind),
        _ => None,
    }
}
fn key(kind: &str, account: &Value, currency: &Value, reread: bool) -> String {
    format!(
        "{kind}|{}|{}|{reread}",
        account.as_str().unwrap_or(""),
        currency.as_str().unwrap_or("")
    )
}
fn period(config: &Value, event: &str) -> Result<Option<usize>, String> {
    let windows = config["windows"].as_array().ok_or("回顾窗口损坏")?;
    if windows.is_empty() {
        let event_day = date(event.get(..10).ok_or("事件日期格式无效")?)?;
        let as_of =
            chrono::DateTime::parse_from_rfc3339(config["asOf"].as_str().ok_or("数据截止缺失")?)
                .map_err(|_| "截止无效")?;
        if event_day > as_of.date_naive() {
            return Ok(None);
        }
        if event.len() > 10 {
            let instant =
                chrono::DateTime::parse_from_rfc3339(event).map_err(|_| "事件时点无效")?;
            if instant > as_of {
                return Ok(None);
            }
        }
        return Ok(Some(0));
    }
    if config["dateOnly"] == true {
        let d = date(event)?;
        for (i, w) in windows.iter().enumerate() {
            let start = date(&w["start"].as_str().ok_or("窗口无效")?[..10])?;
            let end = date(&w["end"].as_str().ok_or("窗口无效")?[..10])?;
            if d >= start && d < end {
                return Ok(Some(i));
            }
        }
    } else {
        let at = chrono::DateTime::parse_from_rfc3339(event)
            .map_err(|_| "本轮按时点比较，只有日期的记录需改用共同完整日期")?;
        for (i, w) in windows.iter().enumerate() {
            let start =
                chrono::DateTime::parse_from_rfc3339(w["start"].as_str().ok_or("窗口无效")?)
                    .map_err(|_| "窗口无效")?;
            let end = chrono::DateTime::parse_from_rfc3339(w["end"].as_str().ok_or("窗口无效")?)
                .map_err(|_| "窗口无效")?;
            if at >= start && at < end {
                return Ok(Some(i));
            }
        }
    }
    Ok(None)
}
pub(super) fn calculate(
    root: &Path,
    c: &Connection,
    work: &Work,
    run: &str,
    args: &Value,
    config: &Value,
    excerpts: &[EvidenceExcerpt],
) -> Result<Value, String> {
    let mut rows = args["rows"].as_array().ok_or("回顾候选无效")?.clone();
    let mut ids = BTreeSet::new();
    let mut events = BTreeSet::new();
    let mut excluded = 0;
    for i in 0..rows.len() {
        let mut row = rows[i].clone();
        let id = text(&row, "id", 180)?;
        if !ids.insert(id.clone()) {
            return Err("候选行身份重复".into());
        }
        let refs = resolve_refs(root, c, work, &row["refs"], excerpts)?;
        row["dependencies"] = json!(refs);
        row["reviewer"] = json!("modelReview");
        let mut reason = None;
        let kind = text(&row, "kind", 40)?;
        if row["valueKind"] != "exact" {
            reason = Some("字段存在歧义、冲突或缺失".to_owned());
        } else if let Some(duplicate) = row["duplicateOf"].as_str() {
            let original = rows[..i]
                .iter()
                .find(|r| r["id"] == duplicate)
                .ok_or("重复候选必须指向之前的实际原行")?;
            if original["eventId"] != row["eventId"]
                || original["amount"] != row["amount"]
                || original["kind"] != row["kind"]
                || original["currency"] != row["currency"]
                || original["account"] != row["account"]
            {
                return Err("重复记录的交易身份、币种、账户或金额不一致，需先核对".into());
            }
            reason = Some(format!("重复导入，已排除；原行 {duplicate}"));
        } else if metric_kind(&kind).is_none() {
            reason = Some("非实际可计量事件：转账、还款、计划、收藏与在读不计入这些指标".into());
        } else if row["eventDate"].is_null() {
            reason = Some("缺少明确事件日期".into());
        } else {
            let at = text(&row, "eventDate", 40)?;
            let event_day = at.get(..10).ok_or("事件日期格式无效")?;
            date(event_day)?;
            let dependencies = row["dependencies"].as_array().unwrap().clone();
            if !dependencies
                .iter()
                .any(|d| d["quote"].as_str().unwrap_or_default().contains(event_day))
            {
                return Err("归期日期缺少明确原文定位；不能用补录或修改时间猜测".into());
            }
            match period(config, &at) {
                Ok(Some(p)) => row["period"] = json!(p),
                Ok(None) => reason = Some("事件不在本次窗口".into()),
                Err(e) => reason = Some(e),
            }
            if kind == "expense" || kind == "refund" {
                let amount = text(&row, "amount", 30)?;
                let value = minor(&amount)?;
                text(&row, "currency", 8)?;
                text(&row, "account", 120)?;
                if !dependencies
                    .iter()
                    .any(|d| d["quote"].as_str().is_some_and(|q| q.contains(&amount)))
                {
                    return Err("金额缺少精确原文定位".into());
                }
                row["minorUnits"] = json!(if kind == "refund" { -value } else { value });
            }
            let event = text(&row, "eventId", 180)?;
            if !events.insert(format!("{kind}|{event}")) {
                return Err("同一事件重复，需显式 duplicateOf 或核对事件身份".into());
            }
        }
        if let Some(reason) = reason {
            excluded += 1;
            row["included"] = json!(false);
            row["exclusionReason"] = json!(reason);
        } else {
            row["included"] = json!(true);
        }
        rows[i] = row;
    }
    let mut metrics = vec![];
    let mut metric_keys = BTreeSet::new();
    for coverage in args["coverage"].as_array().ok_or("覆盖声明无效")? {
        let kind = text(coverage, "metric", 40)?;
        let coverage_refs = resolve_refs(root, c, work, &coverage["refs"], excerpts)?;
        if kind == "expense"
            && (coverage["current"] != "missing" || coverage["previous"] != "missing")
        {
            text(coverage, "currency", 8)?;
            text(coverage, "account", 120)?;
        }
        for reread in if matches!(kind.as_str(), "readingFinished" | "film" | "episode") {
            vec![false, true]
        } else {
            vec![false]
        } {
            let metric_key = key(&kind, &coverage["account"], &coverage["currency"], reread);
            if !metric_keys.insert(metric_key.clone()) {
                return Err("同一指标与账户币种的覆盖重复".into());
            }
            let matching = rows
                .iter()
                .filter(|r| {
                    metric_kind(r["kind"].as_str().unwrap_or_default()) == Some(kind.as_str())
                        && (kind != "expense"
                            || r["account"] == coverage["account"]
                                && r["currency"] == coverage["currency"])
                        && r["reread"] == reread
                })
                .collect::<Vec<_>>();
            if reread && matching.is_empty() {
                continue;
            }
            let mut values = [None, None];
            let mut deps = coverage_refs.clone();
            let mut contributions = vec![];
            for (p, field) in ["current", "previous"].iter().enumerate() {
                if p == 1 && config["windows"].as_array().map_or(0, Vec::len) < 2 {
                    continue;
                }
                let relevant = matching
                    .iter()
                    .filter(|r| r["included"] == true && r["period"] == p)
                    .copied()
                    .collect::<Vec<_>>();
                if coverage[*field] == "missing" {
                    if !relevant.is_empty() {
                        return Err("声明缺失的期间存在采用行，请先核对覆盖".into());
                    }
                    continue;
                }
                // Absence is zero only when the source-backed coverage is explicitly verified.
                if relevant.is_empty() && coverage[*field] != "verified" {
                    continue;
                }
                let mut total = 0_i64;
                let mut unique = BTreeSet::new();
                for r in relevant {
                    if kind == "readingFinished" && !unique.insert(text(r, "entity", 180)?) {
                        continue;
                    }
                    let value = if kind == "expense" {
                        r["minorUnits"].as_i64().ok_or("金额计算字段缺失")?
                    } else {
                        1
                    };
                    total = total.checked_add(value).ok_or("合计超过范围")?;
                    deps.extend(r["dependencies"].as_array().unwrap().iter().cloned());
                    contributions.push(json!({"rowId":r["id"],"period":p,"category":r["category"],"value":if kind=="expense"{money(value)}else{value.to_string()}}));
                }
                values[p] = Some(total);
            }
            let health_types = matching
                .iter()
                .filter(|r| r["included"] == true)
                .map(|r| r["category"].to_string())
                .collect::<BTreeSet<_>>();
            let comparable = coverage["comparable"] == true
                && values.iter().all(Option::is_some)
                && (kind != "health" || health_types.len() == 1);
            let difference = if comparable {
                Some(values[0].unwrap() - values[1].unwrap())
            } else {
                None
            };
            let percent = if comparable && values[1].unwrap() > 0 {
                Some(format!(
                    "{:.2}",
                    difference.unwrap() as f64 / values[1].unwrap() as f64 * 100.0
                ))
            } else {
                None
            };
            deps.sort_by_key(Value::to_string);
            deps.dedup();
            let label = match kind.as_str() {
                "expense" => format!(
                    "已记录净支出 · {}",
                    coverage["account"].as_str().unwrap_or_default()
                ),
                "health" => "已记录健康事件（不代表病情变化）".into(),
                "readingFinished" => "明确完读作品".into(),
                "film" => "实际看过的电影".into(),
                "episode" => "实际看过的剧集".into(),
                _ => "实际参与活动".into(),
            };
            let format_value = |v: i64| {
                if kind == "expense" {
                    money(v)
                } else {
                    v.to_string()
                }
            };
            metrics.push(json!({"id":metric_key,"label":format!("{}{}",label,if reread{" · 重读／重看"}else{""}),"unit":if kind=="expense"{coverage["currency"].as_str().unwrap_or_default()}else{match kind.as_str(){"readingFinished"=>"部作品","film"=>"部","episode"=>"集",_=>"次"}},"current":values[0].map(format_value),"previous":values[1].map(format_value),"difference":difference.map(format_value),"percent":percent,"status":if comparable{"同口径已记录内容"}else{"仅已知记录／不可比"},"coverage":coverage,"dependencies":deps,"contributions":contributions}));
        }
    }
    // Every included metric must have an explicit coverage statement.
    for row in rows.iter().filter(|r| r["included"] == true) {
        let kind = metric_kind(row["kind"].as_str().unwrap()).unwrap();
        let k = key(
            kind,
            if kind == "expense" {
                &row["account"]
            } else {
                &Value::Null
            },
            if kind == "expense" {
                &row["currency"]
            } else {
                &Value::Null
            },
            row["reread"] == true,
        );
        if !metric_keys.contains(&k) {
            return Err("采用行缺少对应的期间覆盖与可比声明".into());
        }
    }
    let id = format!("calculation-{}", crate::random_url_safe(16));
    let dependencies = metrics
        .iter()
        .flat_map(|m| m["dependencies"].as_array().unwrap().clone())
        .collect::<Vec<_>>();
    let value = json!({"id":id,"methodVersion":METHOD,"config":config,"rows":rows,"metrics":metrics,"excluded":excluded,"createdAt":store::stamp(),"dependencies":dependencies,"scopeFingerprint":fingerprint(root,c,work)?,"extractionReviewer":"modelReview","arithmetic":"hostDecimalMinorUnits"});
    store::insert(c, &work.id, Some(run), "reviewCalculation", &value)?;
    Ok(value)
}
