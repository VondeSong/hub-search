use std::path::Path;

/// Keep the native turn's WAL open across short-lived tool/record connections.
/// This is an idle connection, not a read transaction or a writer permit: every
/// existing authorization/source read and commit still uses its original owner.
/// Normal auto-checkpoints remain enabled; return/error/unwind drops the owner.
pub(super) fn hold(root: &Path) -> Result<rusqlite::Connection, String> {
    crate::database::open_database(&root.join("craft-search.sqlite3"))
}

#[cfg(all(test, windows))]
mod tests;
