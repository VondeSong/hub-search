//! Shared collection content model; no provider credentials.
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Origin {
    pub name: String,
    pub url: String,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Media {
    pub kind: String,
    pub url: String,
    pub preview_url: String,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Post {
    pub id: String,
    pub text: String,
    pub author_name: String,
    pub author_handle: String,
    pub published_at: String,
    pub url: String,
    pub media: Vec<Media>,
    pub links: Vec<String>,
    pub quoted_text: String,
    pub content_status: String,
    #[serde(default)]
    pub liked: bool,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub author_id: String,
    #[serde(default)]
    pub conversation_id: String,
    #[serde(default)]
    pub reply_to_id: String,
    #[serde(default)]
    pub reply_to_handle: String,
    #[serde(default)]
    pub reply_count: u64,
    #[serde(default)]
    pub quote_id: String,
    #[serde(default)]
    pub quote: Option<Box<Post>>,
    #[serde(default)]
    pub thread: Vec<Post>,
    #[serde(default)]
    pub all_media: Vec<Media>,
    #[serde(default)]
    pub thread_status: String,
    #[serde(default)]
    pub thread_cursors: Vec<String>,
    #[serde(default)]
    pub thread_seen_cursors: Vec<String>,
    #[serde(default)]
    pub thread_format: u32,
    #[serde(default)]
    pub thread_error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Item {
    pub key: String,
    pub post: Post,
    pub collected_at: i64,
    pub read: bool,
}
