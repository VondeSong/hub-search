//! Thin IPC/database admission for deck operations; rules live in flashcard_decks.
use crate::flashcard_decks::{self, FlashcardDeckFolderSummary, FlashcardDeckSummary};
use crate::{database_path, open_database, open_write_database};
use tauri::AppHandle;

#[tauri::command]
pub(crate) fn list_flashcard_decks(app: AppHandle) -> Result<Vec<FlashcardDeckSummary>, String> {
    let connection = open_database(&database_path(&app)?)?;
    flashcard_decks::list_flashcard_decks(&connection)
}

#[tauri::command]
pub(crate) fn list_flashcard_deck_folders(
    app: AppHandle,
) -> Result<Vec<FlashcardDeckFolderSummary>, String> {
    let connection = open_database(&database_path(&app)?)?;
    flashcard_decks::list_flashcard_deck_folders(&connection)
}

#[tauri::command]
pub(crate) fn create_flashcard_deck(app: AppHandle, name: String) -> Result<String, String> {
    let (mut connection, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_decks::create_flashcard_deck(&mut connection, name)
}

#[tauri::command]
pub(crate) fn create_flashcard_deck_folder(
    app: AppHandle,
    name: String,
) -> Result<FlashcardDeckFolderSummary, String> {
    let (connection, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_decks::create_flashcard_deck_folder(&connection, name)
}

#[tauri::command]
pub(crate) fn rename_flashcard_deck(
    app: AppHandle,
    deck_id: String,
    name: String,
) -> Result<(), String> {
    let (connection, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_decks::rename_flashcard_deck(&connection, deck_id, name)
}

#[tauri::command]
pub(crate) fn rename_flashcard_deck_folder(
    app: AppHandle,
    folder_id: String,
    name: String,
) -> Result<(), String> {
    let (connection, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_decks::rename_flashcard_deck_folder(&connection, folder_id, name)
}

#[tauri::command]
pub(crate) fn pin_flashcard_deck_folder(app: AppHandle, folder_id: String) -> Result<(), String> {
    let (mut connection, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_decks::pin_flashcard_deck_folder(&mut connection, folder_id)
}

#[tauri::command]
pub(crate) fn delete_flashcard_deck_folder(
    app: AppHandle,
    folder_id: String,
) -> Result<(), String> {
    let (mut connection, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_decks::delete_flashcard_deck_folder(&mut connection, folder_id)
}

#[tauri::command]
pub(crate) fn delete_flashcard_deck(app: AppHandle, deck_id: String) -> Result<(), String> {
    let (mut connection, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_decks::delete_flashcard_deck(&mut connection, deck_id)
}

#[tauri::command]
pub(crate) fn move_flashcard_deck(
    app: AppHandle,
    deck_id: String,
    folder_id: Option<String>,
    before_deck_id: Option<String>,
) -> Result<(), String> {
    let (mut connection, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_decks::move_flashcard_deck(&mut connection, deck_id, folder_id, before_deck_id)
}

#[tauri::command]
pub(crate) fn create_flashcard_subdeck(
    app: AppHandle,
    name: String,
    parent_deck_id: String,
) -> Result<String, String> {
    let (mut c, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_decks::create_subdeck(&mut c, &name, &parent_deck_id)
}
#[tauri::command]
pub(crate) fn set_flashcard_deck_parent(
    app: AppHandle,
    deck_id: String,
    parent_deck_id: Option<String>,
) -> Result<(), String> {
    let (mut c, _writer) = open_write_database(&database_path(&app)?)?;
    flashcard_decks::set_parent(&mut c, &deck_id, parent_deck_id.as_deref().unwrap_or(""))
}
