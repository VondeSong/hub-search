//! Bounded SSE assembly. Only public envelope fields enter the preview channel.
use super::*;

pub(super) const MAX_WIRE_BYTES: usize = 16 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

pub(super) struct Stream<'a> {
    pending: Vec<u8>,
    data: String,
    content: String,
    model: Value,
    usage: Value,
    finish: Value,
    done: bool,
    thinking: bool,
    text_bytes: usize,
    last: Instant,
    previous: (String, String, bool),
    pub wire_bytes: usize,
    publish: &'a mut dyn FnMut(&Value) -> Result<(), String>,
}
impl<'a> Stream<'a> {
    pub fn new(publish: &'a mut dyn FnMut(&Value) -> Result<(), String>) -> Self {
        Self { pending: vec![], data: String::new(), content: String::new(), model: Value::Null,
            usage: Value::Null, finish: Value::Null, done: false, thinking: false, text_bytes: 0,
            last: Instant::now(), previous: (String::new(), String::new(), false), wire_bytes: 0, publish }
    }
    pub fn start(&mut self) -> Result<(), String> {
        for kind in ["reasoning", "answer"] {
            (self.publish)(&json!({"kind":kind,"text":"","state":"running"}))?;
        }
        Ok(())
    }
    pub fn feed(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.wire_bytes += bytes.len();
        if self.wire_bytes > MAX_WIRE_BYTES { return Err(TOO_LARGE.into()); }
        self.pending.extend_from_slice(bytes);
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let raw: Vec<_> = self.pending.drain(..=end).collect();
            let line = std::str::from_utf8(&raw).map_err(|_| FORMAT)?.trim_end_matches(['\r','\n']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    let data = std::mem::take(&mut self.data);
                    self.event(data.trim_end_matches('\n'))?;
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
                self.data.push('\n');
            } else if !line.starts_with(':') && !line.starts_with("event:") && !line.starts_with("id:") && !line.starts_with("retry:") {
                return Err(FORMAT.into());
            }
        }
        Ok(())
    }
    fn event(&mut self, data: &str) -> Result<(), String> {
        if self.done { return Err(FORMAT.into()); }
        if data == "[DONE]" { self.done = true; return Ok(()); }
        let event: Value = serde_json::from_str(data).map_err(|_| FORMAT)?;
        if event.get("error").is_some() { return Err(FORMAT.into()); }
        if !event["usage"].is_null() { self.usage = event["usage"].clone(); }
        if event["model"].is_string() { self.model = event["model"].clone(); }
        let choices = event["choices"].as_array().ok_or(FORMAT)?;
        if choices.is_empty() && !self.usage.is_null() { return Ok(()); }
        if choices.len() != 1 || choices[0]["index"].as_u64() != Some(0) { return Err(FORMAT.into()); }
        let choice = &choices[0];
        let delta = &choice["delta"];
        self.text_bytes += ["content", "reasoning_content"].iter().map(|key| delta[key].as_str().map_or(0, str::len)).sum::<usize>();
        if self.text_bytes > MAX_TEXT_BYTES { return Err(TOO_LARGE.into()); }
        if delta.get("tool_calls").is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty())) {
            return Err(CAPABILITY.into());
        }
        if let Some(text) = delta["reasoning_content"].as_str().filter(|t| !t.is_empty()) {
            let _ = text; // Raw reasoning is neither retained nor forwarded as a public summary.
            if !self.thinking {
                self.thinking = true;
                (self.publish)(&json!({"kind":"reasoning","text":"正在思考，等待公开摘要…","state":"running"}))?;
            }
        }
        if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            if !self.finish.is_null() { return Err(FORMAT.into()); }
            if self.content.len() + text.len() > super::super::MAX_OUTPUT_BYTES { return Err(TOO_LARGE.into()); }
            self.content.push_str(text);
            self.preview("running", false)?;
        }
        if !choice["finish_reason"].is_null() {
            if !self.finish.is_null() { return Err(FORMAT.into()); }
            self.finish = choice["finish_reason"].clone();
        }
        Ok(())
    }
    pub fn is_done(&self) -> bool { self.done }
    pub fn account(&self, receipt: &mut execution::Receipt) {
        if !self.usage.is_null() { capture_usage(&json!({"usage":self.usage,"model":self.model}), receipt); }
    }
    pub fn finish(&mut self) -> Result<Vec<u8>, String> {
        if !self.pending.is_empty() || !self.data.is_empty() || !self.done || self.finish.is_null() { return Err(TRUNCATED.into()); }
        serde_json::to_vec(&json!({"model":self.model,"usage":self.usage,"choices":[{"finish_reason":self.finish,"message":{"content":self.content}}]})).map_err(|_| FORMAT.into())
    }
    pub fn preview(&mut self, state: &str, force: bool) -> Result<(), String> {
        if !force && self.last.elapsed() < Duration::from_millis(150) { return Ok(()); }
        let summary = field(&self.content, &["rationale"]).unwrap_or_default().chars().take(1000).collect::<String>();
        let answer = field(&self.content, &["report","markdown"])
            .or_else(|| field(&self.content, &["report","summary"]))
            .unwrap_or_default();
        let truncated = answer.chars().nth(6000).is_some();
        let answer = answer.chars().take(6000).collect::<String>();
        if force || summary != self.previous.0 {
            (self.publish)(&json!({"kind":"reasoning","text":summary,"state":state}))?;
        }
        if force || answer != self.previous.1 || truncated != self.previous.2 {
            (self.publish)(&json!({"kind":"answer","text":answer,"state":state,"truncated":truncated}))?;
        }
        self.previous = (summary,answer,truncated);
        self.last = Instant::now();
        Ok(())
    }
}

// Decode only a named string in the public JSON envelope, including an unfinished string.
fn field(text: &str, path: &[&str]) -> Option<String> {
    let mut rest = text.trim_start().strip_prefix('{')?.trim_start();
    loop {
        let mut key = serde_json::Deserializer::from_str(rest).into_iter::<String>();
        let name = key.next()?.ok()?;
        rest = rest.get(key.byte_offset()..)?.trim_start().strip_prefix(':')?.trim_start();
        if name == path[0] {
            if path.len() > 1 { return field(rest, &path[1..]); }
            if !rest.starts_with('"') { return None; }
            let mut value = serde_json::Deserializer::from_str(rest).into_iter::<String>();
            if let Some(Ok(value)) = value.next() { return Some(value); }
            // At most one unfinished escape/surrogate pair is withheld until the next chunk.
            for trim in 0..=12.min(rest.len().saturating_sub(1)) {
                let Some(prefix) = rest.get(..rest.len()-trim) else { continue; };
                if let Ok(value) = serde_json::from_str::<String>(&format!("{prefix}\"")) { return Some(value); }
            }
            return None;
        }
        let mut skip = serde_json::Deserializer::from_str(rest).into_iter::<serde::de::IgnoredAny>();
        skip.next()?.ok()?;
        rest = rest.get(skip.byte_offset()..)?.trim_start().strip_prefix(',')?.trim_start();
    }
}

#[cfg(test)]
mod tests;
