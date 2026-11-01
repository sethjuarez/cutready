//! Review of agent runs: list what awaits Keep or Undo, and resolve it.

use cutready_core::contracts::SaveContext;
use tauri::State;
use tauri_plugin_auditaur::auditaur_command;

use crate::engine::document_writer;
use crate::AppState;

fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

/// Runs with changes nobody has kept or undone, oldest first, in the
/// canonical `RunReview` wire form.
#[auditaur_command(skip_all, err)]
pub async fn list_pending_reviews(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let root = project_root(&state)?;
    let reviews = document_writer::pending_reviews(&root).map_err(String::from)?;
    let ctx = SaveContext::default();
    Ok(reviews.iter().map(|review| review.to_value(&ctx)).collect())
}

/// Keeps a run's changes to `doc`. `through_seq` comes from the review; it
/// fails if the run changed the document since.
#[auditaur_command(skip_all, err)]
pub async fn keep_run_document(
    run_id: String,
    doc: String,
    through_seq: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    document_writer::keep_run_document(&root, &run_id, &doc, through_seq)
}

/// Undoes a run's changes to `doc`, keeping later edits that don't overlap.
#[auditaur_command(skip_all, err)]
pub async fn undo_run_document(
    run_id: String,
    doc: String,
    through_seq: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    document_writer::undo_run_document(&root, &run_id, &doc, through_seq)
}
