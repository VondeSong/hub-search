//! Explicit answer saves reuse the existing authenticated, controlled transports.
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
    }
    Ok(json!({"provider":provider,"objectId":object,"verified":true,"inspected":true}))
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
            let result=call_dida_write_tool_raw(&client,&session,"create_task",json!({"task":{"projectId":project,"title":title,"content":content,"kind":kind,"status":0,"priority":0}}),64701).await?;
            let id=find_nested_string(&tool_result_json(&result),&["id","taskId","task_id"]).ok_or("滴答未返回保存身份；请核对目标清单，不重复创建")?;
            created(&id)?;
            let live=dida_read(&client,&session,&id,project).await?;
            if live.title!=title||live.content.trim()!=content.trim()||live.kind.to_ascii_uppercase()!=kind{return Err("滴答已返回保存位置，但正文或类型读回不一致；请核对结果".into());}
            Ok(json!({"verified":true,"provider":provider,"objectId":id,"projectId":project,"kind":kind,"operation":if kind=="TEXT"{"newTask"}else{"newNote"}}))
        }
    })).await
}
