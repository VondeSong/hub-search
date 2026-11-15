//! Shared flashcard persistence and IPC contracts, without application state.
use crate::{
    flashcard_cloud_sync, flashcard_decks::FlashcardSnapshotDeck, flashcard_profiles,
    flashcard_sync_drafts,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardDateCount {
    pub(crate) date: String,
    pub(crate) count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardDashboardStats {
    pub(crate) total_cards: i64,
    pub(crate) due_cards: i64,
    pub(crate) new_due_cards: i64,
    pub(crate) new_cards: i64,
    pub(crate) learning_cards: i64,
    pub(crate) mastered_cards: i64,
    pub(crate) suspended_cards: i64,
    pub(crate) new_studied_today: i64,
    pub(crate) total_reviews: i64,
    pub(crate) reviewed_today: i64,
    pub(crate) retention_rate: f64,
    pub(crate) rating_counts: [i64; 4],
    pub(crate) daily_activity: Vec<FlashcardDateCount>,
    #[serde(flatten)]
    pub(crate) experience: FlashcardStudyExperience,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardStudyExperience {
    pub(crate) study_day: String,
    pub(crate) extra_new_allowance: i64,
    pub(crate) timed_review_count: i64,
    pub(crate) average_review_ms: Option<f64>,
    pub(crate) future_due: Vec<FlashcardDateCount>,
    pub(crate) next_due_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Flashcard {
    pub(crate) id: String,
    pub(crate) deck_id: String,
    pub(crate) question: String,
    pub(crate) answer: String,
    pub(crate) explanation: String,
    pub(crate) card_type: String,
    pub(crate) card_data: Value,
    pub(crate) source_library_id: String,
    pub(crate) source_document_id: String,
    pub(crate) source_block_id: String,
    pub(crate) source_title: String,
    pub(crate) source_path: String,
    pub(crate) source_hash: String,
    pub(crate) media: Value,
    pub(crate) tags: Value,
    pub(crate) evidence: String,
    pub(crate) confidence: Option<f64>,
    pub(crate) custom_fields: Value,
    pub(crate) generation: Value,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) due_at: i64,
    pub(crate) interval_days: f64,
    pub(crate) ease: f64,
    pub(crate) repetitions: i64,
    pub(crate) lapses: i64,
    pub(crate) status: String,
    pub(crate) source_changed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardReviewResult {
    pub(crate) card: Flashcard,
    pub(crate) review_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardDraft {
    pub(crate) id: String,
    pub(crate) batch_id: String,
    pub(crate) deck_name: String,
    pub(crate) question: String,
    pub(crate) answer: String,
    pub(crate) explanation: String,
    pub(crate) card_type: String,
    pub(crate) card_data: Value,
    pub(crate) source_library_id: String,
    pub(crate) source_document_id: String,
    pub(crate) source_block_id: String,
    pub(crate) source_title: String,
    pub(crate) source_path: String,
    pub(crate) source_hash: String,
    pub(crate) media: Value,
    pub(crate) tags: Value,
    pub(crate) custom_fields: Value,
    pub(crate) evidence: String,
    pub(crate) confidence: Option<f64>,
    pub(crate) generation: Value,
    pub(crate) idempotency_key: String,
    pub(crate) created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardImportResult {
    pub(crate) batch_id: String,
    pub(crate) total: usize,
    pub(crate) imported: usize,
    pub(crate) duplicates: usize,
    pub(crate) invalid: usize,
    pub(crate) errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardDraftResolutionResult {
    pub(crate) accepted: usize,
    pub(crate) rejected: usize,
    pub(crate) skipped: usize,
    pub(crate) deck_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardSyncSettings {
    pub(crate) url: String,
    pub(crate) username: String,
    pub(crate) has_password: bool,
    pub(crate) auto_sync: bool,
    pub(crate) configured: bool,
    pub(crate) last_sync_at: Option<i64>,
    pub(crate) last_error: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardStudySettings {
    pub(crate) daily_new_limit: i64,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardEncryptedEnvelope {
    pub(crate) format: String,
    pub(crate) kdf: String,
    pub(crate) iterations: u32,
    pub(crate) salt: String,
    pub(crate) nonce: String,
    pub(crate) ciphertext: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardSnapshotFolder {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) sort_order: i64,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardSnapshotTombstone {
    pub(crate) entity_type: String,
    pub(crate) entity_id: String,
    pub(crate) deleted_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardSnapshotCard {
    pub(crate) id: String,
    pub(crate) deck_id: String,
    pub(crate) question: String,
    pub(crate) answer: String,
    pub(crate) explanation: String,
    pub(crate) card_type: String,
    #[serde(default = "default_flashcard_card_data_json")]
    pub(crate) card_data_json: String,
    pub(crate) source_library_id: String,
    pub(crate) source_document_id: String,
    pub(crate) source_block_id: String,
    pub(crate) source_title: String,
    pub(crate) source_path: String,
    pub(crate) source_hash: String,
    pub(crate) media_json: String,
    #[serde(default = "default_flashcard_tags_json")]
    pub(crate) tags_json: String,
    #[serde(default)]
    pub(crate) evidence: String,
    #[serde(default)]
    pub(crate) confidence: Option<f64>,
    #[serde(default = "default_flashcard_custom_fields_json")]
    pub(crate) custom_fields_json: String,
    #[serde(default = "default_flashcard_card_data_json")]
    pub(crate) generation_json: String,
    pub(crate) status: String,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) due_at: i64,
    pub(crate) interval_days: f64,
    pub(crate) ease: f64,
    pub(crate) repetitions: i64,
    pub(crate) lapses: i64,
    #[serde(default)]
    pub(crate) fsrs_state_json: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardSnapshotReview {
    pub(crate) id: String,
    pub(crate) card_id: String,
    pub(crate) rating: i64,
    pub(crate) reviewed_at: i64,
    pub(crate) previous_due_at: i64,
    pub(crate) next_due_at: i64,
    pub(crate) previous_interval_days: f64,
    pub(crate) next_interval_days: f64,
    pub(crate) elapsed_ms: Option<i64>,
    #[serde(default)]
    pub(crate) previous_ease: Option<f64>,
    #[serde(default)]
    pub(crate) previous_repetitions: Option<i64>,
    #[serde(default)]
    pub(crate) previous_lapses: Option<i64>,
    #[serde(default)]
    pub(crate) scheduler_version: i64,
    #[serde(default)]
    pub(crate) previous_fsrs_state_json: String,
    #[serde(default)]
    pub(crate) scheduler_profile_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardSyncSnapshot {
    pub(crate) version: i64,
    pub(crate) device_id: String,
    pub(crate) exported_at: i64,
    #[serde(default)]
    pub(crate) folders: Vec<FlashcardSnapshotFolder>,
    #[serde(default)]
    pub(crate) tombstones: Vec<FlashcardSnapshotTombstone>,
    pub(crate) decks: Vec<FlashcardSnapshotDeck>,
    pub(crate) cards: Vec<FlashcardSnapshotCard>,
    pub(crate) reviews: Vec<FlashcardSnapshotReview>,
    #[serde(default)]
    pub(crate) study_settings: Option<FlashcardStudySettings>,
    #[serde(default)]
    pub(crate) quality_records: Vec<Value>,
    #[serde(default)]
    pub(crate) drafts: Vec<flashcard_sync_drafts::SnapshotDraft>,
    #[serde(default)]
    pub(crate) scheduler_profiles: Vec<flashcard_profiles::Profile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardSyncSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cloud_report: Option<flashcard_cloud_sync::CloudReport>,
    pub(crate) uploaded_cards: usize,
    pub(crate) downloaded_cards: usize,
    pub(crate) merged_reviews: usize,
    pub(crate) uploaded_media: usize,
    pub(crate) downloaded_media: usize,
    pub(crate) conflict_retries: usize,
    pub(crate) completed_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlashcardSyncHistoryItem {
    pub(crate) id: String,
    pub(crate) started_at: i64,
    pub(crate) completed_at: i64,
    pub(crate) status: String,
    pub(crate) uploaded_cards: i64,
    pub(crate) downloaded_cards: i64,
    pub(crate) merged_reviews: i64,
    pub(crate) uploaded_media: i64,
    pub(crate) downloaded_media: i64,
    pub(crate) conflict_retries: i64,
    pub(crate) error: String,
}

pub(crate) fn default_flashcard_card_data_json() -> String {
    "{}".to_string()
}

pub(crate) fn default_flashcard_tags_json() -> String {
    "[]".to_string()
}

pub(crate) fn default_flashcard_custom_fields_json() -> String {
    "{}".to_string()
}
