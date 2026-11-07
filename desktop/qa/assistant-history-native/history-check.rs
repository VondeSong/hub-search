//! Run the production SQLite history module without loading a desktop runtime.
//! Host transaction / running-task checks still require the full desktop suite.
#[allow(dead_code)]
#[path = "../../src-tauri/src/agent_work/store/history.rs"]
mod history;
