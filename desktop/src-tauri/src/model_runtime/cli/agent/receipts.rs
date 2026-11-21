use super::capabilities::NativeCapabilities;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    time::{Duration, Instant},
};

const OUTPUT_BYTES: usize = 8192;
const PATCH_BYTES: usize = 12_288;

pub(super) fn viewed_image(directory: &Path, path: &Value) -> Option<Value> {
    let name = path.as_str().filter(|name| name.len() <= 1024)?;
    let resolved =
        NativeCapabilities::workspace_file(&directory.join("workspace"), Path::new(name)).ok()?;
    let mut file = std::fs::File::open(resolved)
        .ok()?
        .take(4 * 1024 * 1024 + 1);
    let mut data = Vec::new();
    file.read_to_end(&mut data).ok()?;
    if data.len() > 4 * 1024 * 1024 {
        return None;
    }
    Some(json!({"path":name,"sha256":format!("{:x}",Sha256::digest(data))}))
}

fn prefix(text: &str, budget: usize) -> &str {
    let mut end = text.len().min(budget);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn patch_counts(diff: &str) -> Option<(usize, usize)> {
    let mut counts = None;
    let mut in_hunk = false;
    for line in diff.lines() {
        if line.starts_with("@@ ") {
            counts.get_or_insert((0, 0));
            in_hunk = true;
        } else if line.starts_with("diff --git ") {
            in_hunk = false;
        } else if let Some((added, removed)) = counts.as_mut().filter(|_| in_hunk) {
            *added += usize::from(line.starts_with('+'));
            *removed += usize::from(line.starts_with('-'));
        }
    }
    counts
}

pub(super) fn edits(changes: &Value) -> Value {
    let mut remaining = PATCH_BYTES;
    let files = changes.as_array().into_iter().flatten().filter_map(|change| {
        let path = change["path"].as_str().filter(|path| !path.trim().is_empty())?;
        let patch = change["diff"].as_str().filter(|patch| !patch.is_empty());
        let preview = patch.map(|patch| prefix(patch, remaining)).filter(|preview| !preview.is_empty());
        remaining -= preview.map_or(0, str::len);
        let counts = match change["kind"]["type"].as_str() {
            // The app server returns the actual file body for adds/deletes.
            Some("add") => Some((patch.map_or(0, |body| body.lines().count()), 0)),
            Some("delete") => Some((0, patch.map_or(0, |body| body.lines().count()))),
            _ => patch.and_then(patch_counts),
        };
        Some(json!({"path":prefix(path,1024),"patch":preview,"truncated":patch.is_some_and(|p| p.len() > preview.map_or(0,str::len)),"added":counts.map(|c| c.0),"removed":counts.map(|c| c.1)}))
    }).take(20).collect::<Vec<_>>();
    json!(files)
}

pub(super) fn turn_diff(diff: &str) -> Value {
    // Use the provider's consolidated deltas. An event per edit cannot tell
    // whether a later edit reverted an earlier change to the same file.
    let files = diff
        .lines()
        .filter(|line| line.starts_with("diff --git "))
        .count();
    if files == 0 && !diff.trim().is_empty() {
        return Value::Null;
    }
    let (added, removed) = patch_counts(diff).unwrap_or_default();
    let preview = prefix(diff, PATCH_BYTES);
    json!({"files":files,"added":added,"removed":removed,"patch":preview,"truncated":preview.len()<diff.len()})
}

struct Command {
    event: Value,
    output: String,
    truncated: bool,
    sent: Option<Instant>,
}

impl Command {
    fn append(&mut self, delta: &str) {
        if self.truncated {
            return;
        }
        let part = prefix(delta, OUTPUT_BYTES.saturating_sub(self.output.len()));
        self.output.push_str(part);
        self.truncated = part.len() < delta.len();
    }

    fn project(&self, event: &mut Value) {
        if !self.output.is_empty() {
            event["commandOutput"] = json!(self.output);
        }
        if self.truncated {
            event["outputTruncated"] = json!(true);
        }
    }
}

#[derive(Default)]
pub(super) struct Commands(HashMap<String, Command>);

impl Commands {
    pub(super) fn item(&mut self, item: &Value, event: &mut Value, completed: bool) {
        let Some(id) = item["id"].as_str() else {
            return;
        };
        let blank = || Command {
            event: Value::Null,
            output: String::new(),
            truncated: false,
            sent: None,
        };
        if completed {
            let mut command = self.0.remove(id).unwrap_or_else(blank);
            if let Some(output) = item["aggregatedOutput"]
                .as_str()
                .filter(|output| !output.is_empty())
            {
                command.output.clear();
                command.truncated = false;
                command.append(output);
            }
            command.project(event);
        } else if self.0.contains_key(id) || self.0.len() < 64 {
            let command = self.0.entry(id.to_string()).or_insert_with(blank);
            command.project(event);
            command.event = event.clone();
        }
    }

    pub(super) fn delta(&mut self, value: &Value) -> Option<Value> {
        let command = self.0.get_mut(value["itemId"].as_str()?)?;
        let delta = value["delta"].as_str().filter(|s| !s.is_empty())?;
        if command.truncated {
            return None;
        }
        command.append(delta);
        if !command.truncated
            && command
                .sent
                .is_some_and(|sent| sent.elapsed() < Duration::from_millis(180))
        {
            return None;
        }
        command.sent = Some(Instant::now());
        let mut event = command.event.clone();
        command.project(&mut event);
        Some(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_hunks_without_counting_headers_and_bounds_utf8() {
        let patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n---old\n+++new\n";
        assert_eq!(turn_diff(patch)["added"], 1);
        assert_eq!(turn_diff(patch)["removed"], 1);
        assert_eq!(turn_diff(patch)["files"], 1);
        let values =
            edits(&json!([{"path":"a","diff":patch},{"path":"b","diff":"图".repeat(PATCH_BYTES)}]));
        assert_eq!(values[0]["added"], 1);
        assert_eq!(values[1]["truncated"], true);
        assert!(values[1]["patch"].as_str().unwrap().len() <= PATCH_BYTES - patch.len());
    }

    #[test]
    fn counts_file_bodies_for_add_and_delete() {
        let files = edits(&json!([
            {"path":"created.md","kind":{"type":"add"},"diff":"# Entry\r\n\r\nDescription\r\n"},
            {"path":"removed.txt","kind":{"type":"delete"},"diff":"old\nsecond"},
            {"path":"empty","kind":{"type":"add"},"diff":""}
        ]));
        assert_eq!(
            (files[0]["added"].as_u64(), files[0]["removed"].as_u64()),
            (Some(3), Some(0))
        );
        assert_eq!(
            (files[1]["added"].as_u64(), files[1]["removed"].as_u64()),
            (Some(0), Some(2))
        );
        assert_eq!(files[2]["added"], 0);
    }

    #[test]
    fn running_output_stays_with_its_command_and_completion_replaces_it() {
        let mut commands = Commands::default();
        let mut event = json!({"state":"running"});
        commands.item(&json!({"id":"a"}), &mut event, false);
        assert!(commands
            .delta(&json!({"itemId":"other","delta":"invalid"}))
            .is_none());
        assert_eq!(
            commands
                .delta(&json!({"itemId":"a","delta":"partial"}))
                .unwrap()["commandOutput"],
            "partial"
        );
        let mut completed = json!({"state":"completed","exitCode":0});
        commands.item(
            &json!({"id":"a","aggregatedOutput":"whole output"}),
            &mut completed,
            true,
        );
        assert_eq!(completed["commandOutput"], "whole output");
        assert!(commands
            .delta(&json!({"itemId":"a","delta":"late"}))
            .is_none());
    }
}
