use super::*;

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Request {
    Read,
    Patch {
        operation_id: String,
        expected_goal_binding: Value,
        expected_task_revision: u64,
        source_command_id: String,
        upsert: Vec<TaskSpec>,
        remove: Vec<String>,
    },
}

pub(in crate::agent_work) fn schema() -> Value {
    fn object(properties: Value) -> Value {
        let required: Vec<_> = properties.as_object().unwrap().keys().cloned().collect();
        json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
    }
    let id = json!({"type":"string","minLength":1,"maxLength":180});
    let ids = json!({"type":"array","maxItems":16,"items":id});
    let text = json!({"type":"string","minLength":1,"maxLength":1000});
    let spec = object(
        json!({"taskId":{"type":"string","minLength":1,"maxLength":64},"parentId":{"type":["string","null"],"maxLength":64},
        "requirementRefs":ids,"criterion":text,"dependencies":ids,
        "requiredResult":{"type":"string","enum":["response","chart","draft","action"]},
        "status":{"type":"string","enum":["pending","in_progress","waiting_decision","blocked","done","cancelled"]},
        "proofIds":ids,"review":{"type":"string","maxLength":2000},"blocker":{"type":["string","null"],"maxLength":1000}}),
    );
    let read = object(json!({"action":{"type":"string","enum":["read"]}}));
    let patch = object(
        json!({"action":{"type":"string","enum":["patch"]},"operationId":id,
        "expectedGoalBinding":goal::completion::schema()["anyOf"][0]["properties"]["goalBinding"],
        "expectedTaskRevision":{"type":"integer","minimum":0},"sourceCommandId":id,
        "upsert":{"type":"array","maxItems":64,"items":spec},"remove":{"type":"array","maxItems":64,"items":id}}),
    );
    json!({"anyOf":[read,patch],"description":"按需要维护 Work 任务树，简单问答无需建任务。先 read 获取 revision、goalBinding、sourceCommandId，再 patch。upsert 是指定步骤的完整定义，未列出的步骤保持不变；remove 只删步骤，不删用户要求。done 必须有语义核对和所需类型的真实 proofId，且依赖/子任务已完成。依赖改变后 pending/needsRevalidation 必须重新核对并显式提交 done。只维护计划，不执行工具、授权或业务写入。"})
}
