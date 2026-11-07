use super::*;
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Request {
    Read {
        revision: Option<u64>,
    },
    Revise {
        operation_id: String,
        expected_goal_binding: Value,
        expected_goal_revision: u64,
        source_command_id: String,
        content: Content,
        retirements: Vec<Retirement>,
        rationale: String,
    },
}
pub(in crate::agent_work) fn schema() -> Value {
    fn object(p: Value) -> Value {
        let required: Vec<_> = p.as_object().unwrap().keys().cloned().collect();
        json!({"type":"object","properties":p,"required":required,"additionalProperties":false})
    }
    let id = json!({"type":"string","minLength":1,"maxLength":180});
    let ids = json!({"type":"array","maxItems":16,"items":id});
    let text = json!({"type":"string","minLength":1,"maxLength":2000});
    let item = object(
        json!({"itemId":{"type":"string","minLength":1,"maxLength":64},"kind":{"type":"string","enum":["constraint","acceptanceCriterion","ambiguity"]},"text":text,"sourceRefs":ids}),
    );
    let content = object(
        json!({"effectiveGoal":object(json!({"text":text,"sourceRefs":ids})),"items":{"type":"array","maxItems":48,"items":item}}),
    );
    let retirement =
        object(json!({"itemId":id,"sourceCommandId":id,"reason":text,"replacementIds":ids}));
    json!({"anyOf":[object(json!({"action":{"type":"string","enum":["read"]},"revision":{"type":["integer","null"],"minimum":1}})),
        object(json!({"action":{"type":"string","enum":["revise"]},"operationId":id,"expectedGoalBinding":completion::schema()["anyOf"][0]["properties"]["goalBinding"],
        "expectedGoalRevision":{"type":"integer","minimum":0},"sourceCommandId":id,"content":content,"retirements":{"type":"array","maxItems":48,"items":retirement},"rationale":text}))],
        "description":"用户目标的有来源解释。read revision=null 读当前，指定数字读历史。revise 提交完整解释快照；sourceRefs 只能引用 sources 中原始用户要求身份。旧 itemId 内容保持不变；替代或消除歧义使用新 itemId，并在 retirements 逐项引用比旧条目更新的真实用户命令，保留未冲突条目。replacementIds 可为空表示用户取消该条。不得通过省略条目删除要求。有效解释不授予任何权限；歧义保留为 ambiguity，不能猜测授权。简单问答无需建立解释版本。"})
}
