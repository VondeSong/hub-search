//! Explicit saves reuse the existing authenticated, controlled transports.
use super::*;
pub(crate) async fn inspect_answer(
    app: &AppHandle,
    plan: &Value,
    object: &str,
) -> Result<Value, String> {
    let library = plan["libraryId"].as_str().ok_or("目标库缺失")?;
    let provider = plan["provider"].as_str().ok_or("目标类型缺失")?;
    crate::library_runtime::gate(&active_data_root(app)?, library)?;
    if agent_connection_fingerprint(app, library)? != plan["remote"]["connection"] {
        return Err("目标连接已改变，请在原连接核对保存结果".into());
    }
    let text = plan["text"].as_str().ok_or("原保存正文缺失")?;
    if provider == "craft" {
        let live = craft_request(
            app,
            library,
            reqwest::Method::GET,
            "blocks",
            &[("id", object)],
            None,
        )
        .await?;
        if !content_covered(text, &live) {
            return Err("目标页面尚未核对到完整保存内容，未重新写入".into());
        }
    } else {
        let session = session(app, library).await?;
        let live = dida_read(
            &client()?,
            &session,
            object,
            plan["projectId"].as_str().ok_or("原清单缺失")?,
        )
        .await?;
        if live.title != plan["title"]
            || live.content.trim() != text.trim()
            || live.kind.to_ascii_uppercase()
                != if plan["mode"] == "task" {
                    "TEXT"
                } else {
                    "NOTE"
                }
        {
            return Err("任务或笔记的标题、正文或类型不一致，未确认保存成功".into());
        }
        cache_saved_dida_task(app, plan, &live)?;
    }
    Ok(json!({"provider":provider,"objectId":object,"verified":true,"inspected":true}))
}
fn check_calendar_fields(plan: &Value, status: i64, start: Option<&str>) -> Result<(), String> {
    let expected = if plan["completed"] == true { 2 } else { 0 };
    if status != expected || start.and_then(|v| v.get(..10)) != plan["journalDate"].as_str() {
        return Err("滴答任务已创建，但状态或日期读回不一致；请核对目标清单".into());
    }
    Ok(())
}
fn dida_save_payload(
    plan: &Value,
    project: &str,
    title: &str,
    content: &str,
    kind: &str,
) -> Result<Value, String> {
    let mut task = json!({"projectId":project,"title":title,"content":content,"kind":kind,"status":0,"priority":0});
    if let Some(day) = plan["journalDate"].as_str() {
        let date =
            chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").map_err(|_| "任务日期无效")?;
        if date.format("%Y-%m-%d").to_string() != day {
            return Err("任务日期无效".into());
        }
        // All-day journal dates are civil days; UTC prevents timezone shifts on readback.
        task["startDate"] = json!(format!("{day}T00:00:00+0000"));
        task["isAllDay"] = json!(true);
        task["timeZone"] = json!("UTC");
        task["status"] = json!(if plan["completed"] == true { 2 } else { 0 });
    }
    Ok(json!({"task":task}))
}

fn cache_saved_dida_task(app: &AppHandle, plan: &Value, live: &DidaTask) -> Result<(), String> {
    if plan["journalDate"].is_string() {
        check_calendar_fields(plan, live.status, live.start_date.as_deref())?;
    }
    let library = plan["libraryId"].as_str().ok_or("保存资料库缺失")?;
    let project = plan["projectId"].as_str().ok_or("保存清单缺失")?;
    let name = plan["remote"]["projects"]
        .as_array()
        .and_then(|values| values.iter().find(|p| p["id"] == project))
        .and_then(|p| p["name"].as_str())
        .unwrap_or(project);
    let (mut c, _guard) = crate::open_write_database(&crate::database_path(app)?)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    crate::upsert_dida_task(&tx, library, name, live, crate::now_timestamp())?;
    tx.commit().map_err(|e| e.to_string())?;
    let _ = app.emit("task-list-updated", json!({"changed":1}));
    Ok(())
}

pub(crate) async fn answer_target(
    app: &AppHandle,
    library: &str,
    provider: &str,
    page: Option<&str>,
) -> Result<Value, String> {
    crate::library_runtime::gate(&active_data_root(app)?, library)?;
    if provider == "craft" {
        let snapshot = if let Some(page) = page {
            let live = craft_request(
                app,
                library,
                reqwest::Method::GET,
                "blocks",
                &[("id", page)],
                None,
            )
            .await?;
            json!(storage::hash(live.to_string().as_bytes()))
        } else {
            Value::Null
        };
        Ok(json!({"connection":agent_connection_fingerprint(app,library)?,"snapshot":snapshot}))
    } else if provider == "dida365" {
        let session = session(app, library).await?;
        let response =
            call_mcp_tool_raw(&client()?, &session, "list_projects", json!({}), 64700).await?;
        let mut projects = Vec::new();
        collect_dida_projects(&tool_result_json(&response), &mut projects);
        Ok(
            json!({"connection":agent_connection_fingerprint(app,library)?,"projects":projects.into_iter().map(|p|json!({"id":p.id,"name":p.name})).collect::<Vec<_>>()}),
        )
    } else {
        Err("此保存去向尚不支持".into())
    }
}
pub(crate) async fn save_answer(
    app: &AppHandle,
    plan: &Value,
    guard: crate::model_runtime::Control,
    created: impl Fn(&str) -> Result<(), String>,
) -> Result<Value, String> {
    let library = plan["libraryId"].as_str().ok_or("保存资料库缺失")?;
    let provider = plan["provider"].as_str().ok_or("保存提供方缺失")?;
    let page = plan["pageId"].as_str();
    let current = answer_target(app, library, provider, page).await?;
    if current["connection"] != plan["remote"]["connection"]
        || (provider == "craft" && current["snapshot"] != plan["remote"]["snapshot"])
    {
        return Err("目标连接或页面已变化，请重新预览后确认".into());
    }
    let content = plan["text"].as_str().ok_or("保存正文缺失")?;
    let title = plan["title"].as_str().ok_or("保存标题缺失")?;
    control::agent_scope(guard,control::scope(app,library,async{
        control::checkpoint()?;
        if provider=="craft"{
            let id=if let Some(page)=page{page.to_string()}else{
                let result=craft_request(app,library,reqwest::Method::POST,"documents",&[],Some(craft_create_document_body(title,"unsorted"))).await?;
                let id=craft_created_object(&result)?;created(&id)?;id
            };
            craft_request(app,library,reqwest::Method::POST,"blocks",&[],Some(json!({"markdown":content,"position":{"pageId":id,"position":"end"}}))).await?;
            let live=craft_request(app,library,reqwest::Method::GET,"blocks",&[("id",&id)],None).await?;
            if !content_covered(content,&live){return Err("Craft 已返回保存位置，正文读回尚未通过；请核对结果，勿重复创建".into());}
            Ok(json!({"verified":true,"provider":provider,"objectId":id,"operation":if page.is_some(){"append"}else{"newNote"}}))
        }else{
            let project=plan["projectId"].as_str().ok_or("请选择滴答清单")?;
            if !current["projects"].as_array().is_some_and(|ps|ps.iter().any(|p|p["id"]==project)){return Err("所选滴答清单已不可用，请重新选择".into());}
            let session=session(app,library).await?;let client=client()?;
            let kind=if plan["mode"]=="task"{"TEXT"}else{"NOTE"};
            let payload=dida_save_payload(plan,project,title,content,kind)?;
            let result=call_dida_write_tool_raw(&client,&session,"create_task",payload,64701).await?;
            let id=find_nested_string(&tool_result_json(&result),&["id","taskId","task_id"]).ok_or("滴答未返回保存身份；请核对目标清单，不重复创建")?;
            created(&id)?;
            let live=dida_read(&client,&session,&id,project).await?;
            if live.title!=title||live.content.trim()!=content.trim()||live.kind.to_ascii_uppercase()!=kind{return Err("滴答已返回保存位置，但正文或类型读回不一致；请核对结果".into());}
            cache_saved_dida_task(app,plan,&live)?;
            Ok(json!({"verified":true,"provider":provider,"objectId":id,"projectId":project,"kind":kind,"operation":if kind=="TEXT"{"newTask"}else{"newNote"}}))
        }
    })).await
}

#[cfg(test)]
mod journal_calendar_tests {
    use super::*;
    #[test]
    fn journal_task_dates_do_not_change_ordinary_answer_save_payloads() {
        let plain = dida_save_payload(&json!({}), "project", "标题", "正文", "NOTE").unwrap();
        assert!(plain["task"].get("startDate").is_none());
        assert!(plain["task"].get("isAllDay").is_none());
        assert_eq!(plain["task"]["status"], 0);
        let plan = json!({"journalDate":"2026-11-15","completed":true});
        let task = dida_save_payload(&plan, "project", "任务", "", "TEXT").unwrap();
        assert_eq!(task["task"]["status"], 2);
        assert_eq!(task["task"]["startDate"], "2026-11-15T00:00:00+0000");
        assert_eq!(task["task"]["timeZone"], "UTC");
        assert!(check_calendar_fields(&plan, 0, Some("2026-11-15T00:00:00+0000")).is_err());
        assert!(check_calendar_fields(&plan, 2, Some("2026-11-14T00:00:00+0000")).is_err());
        assert!(check_calendar_fields(&plan, 2, Some("2026-11-15T00:00:00+0000")).is_ok());
        assert!(
            dida_save_payload(&json!({"journalDate":"2026-02-30"}), "p", "t", "", "TEXT").is_err()
        );
    }
}
