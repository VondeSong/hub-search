//! Public process interaction only; answers never grant tool or source permission.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

fn bounded(value: &Value, max: usize) -> Result<&str, String> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= max)
        .ok_or_else(|| "原生交互字段无效或过长".into())
}

pub(crate) fn question(id: &Value, p: &Value, thread: &str, turn: &str) -> Result<Value, String> {
    if p["threadId"] != thread
        || p["turnId"] != turn
        || p.to_string().len() > 32768
        || !(id.as_i64().is_some() || id.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 256))
    {
        return Err("原生问题身份无效".into());
    }
    bounded(&p["itemId"], 256)?;
    let questions = p["questions"]
        .as_array()
        .filter(|q| !q.is_empty() && q.len() <= 3)
        .ok_or("原生问题数量无效")?;
    let mut ids = HashSet::new();
    for q in questions {
        if !ids.insert(bounded(&q["id"], 100)?) {
            return Err("原生问题身份重复".into());
        }
        bounded(&q["header"], 80)?;
        bounded(&q["question"], 500)?;
        if q["isSecret"] == true {
            return Err("普通对话不接收密码或凭据；请使用专用身份验证入口".into());
        }
        for field in ["isOther", "isSecret"] {
            if q.get(field).is_some_and(|v| !v.is_boolean()) {
                return Err("原生问题选项无效".into());
            }
        }
        if !q["options"].is_null() {
            let options = q["options"]
                .as_array()
                .filter(|v| v.len() <= 8)
                .ok_or("原生问题选项无效")?;
            let mut labels = HashSet::new();
            for option in options {
                if !labels.insert(bounded(&option["label"], 120)?) {
                    return Err("原生问题选项重复".into());
                }
                if option["description"]
                    .as_str()
                    .is_none_or(|s| s.chars().count() > 500)
                {
                    return Err("原生问题说明无效".into());
                }
            }
        }
    }
    if !p["isBlocking"].is_boolean() {
        return Err("原生问题缺少等待方式".into());
    }
    let key = format!(
        "{:x}",
        Sha256::digest(json!([thread, turn, id]).to_string().as_bytes())
    );
    Ok(
        json!({"key":key,"requestId":id,"threadId":thread,"turnId":turn,"itemId":p["itemId"],
        "questions":questions,"isBlocking":p["isBlocking"]}),
    )
}

pub(crate) fn async_question(p: &Value, thread: &str, turn: &str) -> Result<Option<Value>, String> {
    let item = &p["item"];
    if item["type"] != "agentMessage" || item["delivery"] != "async" || item["questions"].is_null()
    {
        return Ok(None);
    }
    if p.to_string().len() > 32768 || p["threadId"] != thread || p["turnId"] != turn {
        return Err("异步问题轮次或容量无效".into());
    }
    let id = bounded(&item["id"], 256)?;
    let questions = item["questions"]
        .as_array()
        .filter(|q| !q.is_empty() && q.len() <= 3)
        .ok_or("异步问题数量无效")?;
    let mut normalized = Vec::new();
    for (index, q) in questions.iter().enumerate() {
        let title = bounded(&q["title"], 500)?;
        let options = if q["options"].is_null() {
            Value::Null
        } else {
            let values = q["options"]
                .as_array()
                .filter(|v| v.len() <= 8)
                .ok_or("异步问题选项无效")?;
            let mut options = Vec::new();
            for value in values {
                options.push(json!({"label":bounded(value,120)?,"description":""}));
            }
            json!(options)
        };
        normalized.push(json!({"id":format!("q{index}"),"header":"你的选择","question":title,"isOther":true,"options":options}));
    }
    let key = format!(
        "{:x}",
        Sha256::digest(json!([thread, turn, "async", id]).to_string().as_bytes())
    );
    let mut request = question(
        &json!(key),
        &json!({"threadId":thread,"turnId":turn,"itemId":id,"isBlocking":false,"questions":normalized}),
        thread,
        turn,
    )?;
    request["key"] = json!(key);
    request["delivery"] = json!("async");
    request.as_object_mut().unwrap().remove("requestId");
    Ok(Some(request))
}

pub(crate) fn answer(
    request: &Value,
    answers: &Value,
    cancel: bool,
) -> Result<(Value, String), String> {
    let questions = request["questions"].as_array().ok_or("已保存问题无效")?;
    let values = answers.as_object().ok_or("回答格式无效")?;
    if cancel && !values.is_empty() {
        return Err("暂不回答不能同时提交答案".into());
    }
    if !cancel && values.len() != questions.len() {
        return Err("请回答每个问题".into());
    }
    let mut wire = serde_json::Map::new();
    let mut text = Vec::new();
    for q in questions {
        let id = q["id"].as_str().ok_or("已保存问题身份无效")?;
        if cancel {
            text.push(format!(
                "暂不回答：{}",
                q["question"].as_str().unwrap_or_default()
            ));
            continue;
        }
        let value = bounded(&answers[id], 700)?;
        if q["isOther"] != true
            && q["options"]
                .as_array()
                .is_some_and(|opts| !opts.is_empty() && !opts.iter().any(|o| o["label"] == value))
        {
            return Err("请选择问题提供的选项".into());
        }
        wire.insert(id.into(), json!({"answers":[value]}));
        text.push(format!(
            "{}\n回答：{value}",
            q["question"].as_str().unwrap_or_default()
        ));
    }
    let text = text.join("\n\n");
    if text.chars().count() > 4000 {
        return Err("回答过长，请缩短后再提交".into());
    }
    Ok((json!({"answers":wire}), text))
}

#[cfg(test)]
#[test]
fn core_async_question_preserves_typed_choices_and_rejects_unbound_or_invalid_data() {
    let p = json!({"threadId":"thread","turnId":"turn","item":{"type":"agentMessage","id":"call-async","delivery":"async","phase":"final_answer","text":"问题摘要","questions":[{"title":"可用时段？","options":["上午","晚上"]}]}});
    let q = async_question(&p, "thread", "turn").unwrap().unwrap();
    assert_eq!(q["delivery"], "async");
    assert!(q.get("requestId").is_none());
    assert_eq!(q["questions"][0]["options"][1]["label"], "晚上");
    assert_eq!(q["questions"][0]["isOther"], true);
    assert!(answer(&q, &json!({"q0":"19:00–20:00"}), false)
        .unwrap()
        .1
        .contains("19:00–20:00"));
    assert!(async_question(&p, "other", "turn").is_err());
    for questions in [
        json!([]),
        json!([{"title":""}]),
        json!([{"title":"问题","options":42}]),
        json!([{"title":"问题","options":["重复","重复"]}]),
    ] {
        let mut bad = p.clone();
        bad["item"]["questions"] = questions;
        assert!(async_question(&bad, "thread", "turn").is_err());
    }
    let mut ordinary = p;
    ordinary["item"].as_object_mut().unwrap().remove("delivery");
    assert!(async_question(&ordinary, "thread", "turn")
        .unwrap()
        .is_none());
}

pub(super) fn plan(p: &Value, thread: &str, turn: &str) -> Result<Value, String> {
    if p["threadId"] != thread || p["turnId"] != turn {
        return Err("原生计划轮次不匹配".into());
    }
    let steps = p["plan"]
        .as_array()
        .filter(|s| s.len() <= 64)
        .ok_or("原生计划步骤无效")?;
    let mut text = String::new();
    if let Some(explanation) = p["explanation"].as_str().filter(|s| !s.is_empty()) {
        if explanation.chars().count() > 2000 {
            return Err("原生计划说明过长".into());
        }
        text.push_str(explanation);
        text.push_str("\n\n");
    }
    for (index, step) in steps.iter().enumerate() {
        let status = match step["status"].as_str() {
            Some("pending") => "待进行",
            Some("inProgress") => "进行中",
            Some("completed") => "模型标记完成",
            _ => return Err("原生计划状态无效".into()),
        };
        text.push_str(&format!(
            "{}. {} — {status}\n",
            index + 1,
            bounded(&step["step"], 2000)?
        ));
    }
    if text.is_empty() {
        text = "模型已清空当前计划。".into();
    }
    if text.len() > 32768 {
        return Err("原生计划超过过程记录容量".into());
    }
    Ok(
        json!({"id":format!("plan-{:x}",Sha256::digest(turn.as_bytes())),"kind":"plan","state":"completed","text":text}),
    )
}

#[derive(Default)]
pub(super) struct Inputs {
    requests: HashMap<String, Value>,
    sent: HashSet<String>,
    resolved: HashSet<String>,
}
impl Inputs {
    pub(super) fn waiting(&self) -> bool {
        self.requests
            .keys()
            .any(|k| !self.sent.contains(k) && !self.resolved.contains(k))
    }
    pub(super) fn register(&mut self, request: Value) -> Result<bool, String> {
        let key = request["key"].as_str().ok_or("问题身份缺失")?.to_string();
        if let Some(old) = self.requests.get(&key) {
            return if old == &request {
                Ok(false)
            } else {
                Err("同一问题身份对应不同内容".into())
            };
        }
        if self.requests.len() >= 8 {
            return Err("本轮提问数量已达上限".into());
        }
        self.requests.insert(key, request);
        Ok(true)
    }
    pub(super) fn reply(&mut self, value: &Value) -> Result<Option<Value>, String> {
        let key = value["key"].as_str().ok_or("回答身份缺失")?;
        if self.sent.contains(key) || self.resolved.contains(key) {
            return Ok(None);
        }
        let Some(request) = self.requests.get(key) else {
            return Ok(None);
        };
        let mut answers = serde_json::Map::new();
        let wire = value["response"]["answers"]
            .as_object()
            .ok_or("回答格式损坏")?;
        for (id, answer) in wire {
            let a = answer["answers"]
                .as_array()
                .filter(|v| v.len() == 1)
                .ok_or("回答格式损坏")?;
            answers.insert(id.clone(), a[0].clone());
        }
        let (response, _) = answer(request, &Value::Object(answers), wire.is_empty())?;
        self.sent.insert(key.into());
        Ok(Some(json!({"id":request["requestId"],"result":response})))
    }
    pub(super) fn resolve(&mut self, p: &Value, thread: &str) -> Option<String> {
        if p["threadId"] != thread {
            return None;
        }
        let key = self
            .requests
            .iter()
            .find(|(_, v)| v["requestId"] == p["requestId"])
            .map(|(k, _)| k.clone())?;
        self.resolved.insert(key.clone()).then_some(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn params() -> Value {
        json!({"threadId":"thread","turnId":"turn","itemId":"item","isBlocking":true,"questions":[{"id":"q","header":"范围","question":"处理哪部分？","isOther":true,"isSecret":false,"options":[{"label":"当前材料","description":"只处理已选材料"}]}]})
    }
    #[test]
    fn native_interaction_questions_bind_identity_and_reject_secrets_and_bad_shapes() {
        let p = params();
        let a = question(&json!(1), &p, "thread", "turn").unwrap();
        let b = question(&json!("1"), &p, "thread", "turn").unwrap();
        assert_ne!(a["key"], b["key"]);
        assert!(question(&json!(1), &p, "thread", "other").is_err());
        for field in ["isSecret", "options", "id"] {
            let mut bad = p.clone();
            bad["questions"][0][field] = match field {
                "isSecret" => json!(true),
                "options" => json!({}),
                _ => json!(""),
            };
            assert!(question(&json!(1), &bad, "thread", "turn").is_err());
        }
        let mut duplicate = p.clone();
        duplicate["questions"]
            .as_array_mut()
            .unwrap()
            .push(p["questions"][0].clone());
        assert!(question(&json!(1), &duplicate, "thread", "turn").is_err());
        assert!(question(&json!({"id":1}), &p, "thread", "turn").is_err());
    }
    #[test]
    fn native_interaction_answers_validate_question_ids_options_and_cancel() {
        let mut request = question(&json!(1), &params(), "thread", "turn").unwrap();
        let (wire, text) = answer(&request, &json!({"q":"自定义范围"}), false).unwrap();
        assert_eq!(wire, json!({"answers":{"q":{"answers":["自定义范围"]}}}));
        assert!(text.contains("处理哪部分？"));
        assert!(answer(&request, &json!({"wrong":"回答"}), false).is_err());
        assert!(answer(&request, &json!({"q":""}), false).is_err());
        request["questions"][0]["isOther"] = json!(false);
        assert!(answer(&request, &json!({"q":"未知选项"}), false).is_err());
        assert!(answer(&request, &json!({"q":"当前材料"}), false).is_ok());
        assert_eq!(
            answer(&request, &json!({}), true).unwrap().0,
            json!({"answers":{}})
        );
        assert!(answer(&request, &json!({"q":"当前材料"}), true).is_err());
    }
    #[test]
    fn native_interaction_replies_once_and_resolved_or_foreign_requests_never_receive_answers() {
        let mut inputs = Inputs::default();
        let request = question(&json!(7), &params(), "thread", "turn").unwrap();
        assert!(inputs.register(request.clone()).unwrap());
        assert!(!inputs.register(request.clone()).unwrap());
        let reply =
            json!({"key":request["key"],"response":{"answers":{"q":{"answers":["当前材料"]}}}});
        let wire = inputs.reply(&reply).unwrap().unwrap();
        assert_eq!(wire["id"], 7);
        assert!(inputs.reply(&reply).unwrap().is_none());
        assert!(!inputs.waiting());
        let mut fresh = Inputs::default();
        fresh.register(request.clone()).unwrap();
        assert!(fresh
            .resolve(&json!({"threadId":"other","requestId":7}), "thread")
            .is_none());
        assert!(fresh.waiting());
        assert!(fresh
            .resolve(&json!({"threadId":"thread","requestId":7}), "thread")
            .is_some());
        assert!(fresh.reply(&reply).unwrap().is_none());
        assert!(fresh
            .reply(&json!({"key":"not-this-turn"}))
            .unwrap()
            .is_none());
        let mut changed = request;
        changed["itemId"] = json!("changed");
        assert!(fresh.register(changed).is_err());
    }
    #[test]
    fn native_interaction_plan_is_one_public_snapshot_and_never_claims_business_completion() {
        let mut p = json!({"threadId":"thread","turnId":"turn","explanation":"先核对资料","plan":[{"step":"读取","status":"inProgress"}]});
        let first = plan(&p, "thread", "turn").unwrap();
        p["plan"][0]["status"] = json!("completed");
        let next = plan(&p, "thread", "turn").unwrap();
        assert_eq!(first["id"], next["id"]);
        assert_eq!(next["kind"], "plan");
        assert!(next["text"].as_str().unwrap().contains("模型标记完成"));
        assert!(plan(&p, "thread", "other").is_err());
        p["plan"][0]["status"] = json!("saved");
        assert!(plan(&p, "thread", "turn").is_err());
        p["plan"] = json!([]);
        assert!(plan(&p, "thread", "turn").is_ok());
        let request = super::super::Request {
            directory: std::path::Path::new("isolated"),
            authentication_identity: "unused",
                auth_root: None,
                auth_selection: None,
            thread: None,
            instructions: "Hub rules",
            image_input: &[],
            input: "",
            tools: json!([]),
            compact_before_turn: false,
            external_mcp: false,
            web_search: Default::default(),
        };
        let config = super::super::thread_params(&request, "");
        assert_eq!(
            config["config"]["features.default_mode_request_user_input"],
            true
        );
        assert_eq!(config["config"]["tools.update_plan.enabled"], true);
        assert!(config.get("baseInstructions").is_none());
    }
}
