use super::UnifiedTaskItem;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};

/// Search aliases describe existing source identities, never additional write capabilities.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskSourceRef {
    provider: String,
    library_id: String,
    document_id: String,
    source_id: String,
}
pub(super) fn has_provider(task: &UnifiedTaskItem, provider: &str) -> bool {
    task.provider == provider
        || task
            .source_refs
            .iter()
            .any(|source| source.provider == provider)
}

impl From<&UnifiedTaskItem> for TaskSourceRef {
    fn from(task: &UnifiedTaskItem) -> Self {
        Self {
            provider: task.provider.clone(),
            library_id: task.library_id.clone(),
            document_id: task.document_id.clone(),
            source_id: task.source_id.clone(),
        }
    }
}

/// Run after binding identities are verified and before linked source rows are deduplicated.
pub(super) fn attach(tasks: &mut [UnifiedTaskItem]) {
    let mut linked: HashMap<String, BTreeSet<TaskSourceRef>> = HashMap::new();
    for task in tasks.iter().filter(|task| task.sync_state != "unlinked") {
        linked
            .entry(task.id.clone())
            .or_default()
            .insert(task.into());
    }
    for task in tasks {
        task.source_refs = if task.sync_state == "unlinked" {
            vec![TaskSourceRef::from(&*task)]
        } else {
            linked
                .get(&task.id)
                .map(|sources| sources.iter().cloned().collect())
                .unwrap_or_default()
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(
        id: &str,
        provider: &str,
        library: &str,
        document: &str,
        source: &str,
        state: &str,
    ) -> UnifiedTaskItem {
        UnifiedTaskItem {
            id: id.into(),
            provider: provider.into(),
            library_id: library.into(),
            document_id: document.into(),
            source_id: source.into(),
            sync_state: state.into(),
            title: "Same title".into(),
            ..UnifiedTaskItem::default()
        }
    }

    #[test]
    fn linked_aliases_keep_exact_materialized_source_identities() {
        let mut tasks = vec![
            source(
                "hub-1",
                "craft",
                "craft-vault",
                "craft-doc",
                "craft-block",
                "linked",
            ),
            source(
                "hub-1",
                "dida365",
                "dida-account",
                "dida-task",
                "dida-task",
                "linked",
            ),
        ];
        attach(&mut tasks);
        assert_eq!(tasks[0].source_refs, tasks[1].source_refs);
        assert_eq!(tasks[0].source_refs.len(), 2);
        let json = serde_json::to_value(&tasks[0].source_refs).unwrap();
        assert_eq!(json[1]["provider"], "dida365");
        assert_eq!(json[1]["libraryId"], "dida-account");
        assert_eq!(json[1]["documentId"], "dida-task");
        assert_eq!(json[1]["sourceId"], "dida-task");
    }

    #[test]
    fn same_titles_and_source_ids_in_other_libraries_never_become_aliases() {
        let mut tasks = vec![
            source("hub-1", "dida365", "account-one", "task", "task", "linked"),
            source("hub-2", "dida365", "account-two", "task", "task", "linked"),
            source(
                "independent",
                "dida365",
                "account-three",
                "task",
                "task",
                "unlinked",
            ),
        ];
        attach(&mut tasks);
        assert!(tasks
            .iter()
            .all(|task| task.source_refs == vec![TaskSourceRef::from(task)]));
    }

    #[test]
    fn missing_bound_sources_are_not_advertised_and_conflicts_stay_read_only() {
        let mut tasks = vec![source(
            "hub-1",
            "craft",
            "craft-vault",
            "doc",
            "block",
            "conflict",
        )];
        tasks[0].linked_library_ids = vec!["craft-vault".into(), "missing-dida-account".into()];
        tasks[0].status_write_blocked_reason = Some("Binding requires review".into());
        attach(&mut tasks);
        assert_eq!(tasks[0].source_refs, vec![TaskSourceRef::from(&tasks[0])]);
        assert_eq!(tasks[0].sync_state, "conflict");
        assert_eq!(
            tasks[0].status_write_blocked_reason.as_deref(),
            Some("Binding requires review")
        );
    }
}
