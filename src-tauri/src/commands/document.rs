//! Tauri commands for document CRUD operations.

use chrono::Utc;
use tauri::State;
use uuid::Uuid;

use crate::engine::project;
use crate::models::document::{Document, DocumentSummary};
use crate::AppState;

#[tauri::command]
pub async fn create_document(title: String, state: State<'_, AppState>) -> Result<Document, String> {
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let doc = Document::new(title);
    project.documents.push(doc.clone());
    project.updated_at = Utc::now();

    // Save to disk
    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(doc)
}

#[tauri::command]
pub async fn update_document(
    id: String,
    content: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let doc_id: Uuid = id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let doc = project
        .documents
        .iter_mut()
        .find(|d| d.id == doc_id)
        .ok_or("Document not found")?;

    doc.content = content;
    doc.updated_at = Utc::now();
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn update_document_title(
    id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let doc_id: Uuid = id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let doc = project
        .documents
        .iter_mut()
        .find(|d| d.id == doc_id)
        .ok_or("Document not found")?;

    doc.title = title;
    doc.updated_at = Utc::now();
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn delete_document(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let doc_id: Uuid = id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let idx = project
        .documents
        .iter()
        .position(|d| d.id == doc_id)
        .ok_or("Document not found")?;

    project.documents.remove(idx);
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn list_documents(state: State<'_, AppState>) -> Result<Vec<DocumentSummary>, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_ref().ok_or("No project is currently open")?;

    Ok(project.documents.iter().map(DocumentSummary::from).collect())
}

#[tauri::command]
pub async fn get_document(id: String, state: State<'_, AppState>) -> Result<Document, String> {
    let doc_id: Uuid = id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_ref().ok_or("No project is currently open")?;

    project
        .documents
        .iter()
        .find(|d| d.id == doc_id)
        .cloned()
        .ok_or_else(|| "Document not found".into())
}
