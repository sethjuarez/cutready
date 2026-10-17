use std::collections::BTreeSet;
use std::path::Path;

use crate::engine::project;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProjectReference {
    pub id: String,
    pub reference: String,
    pub name: String,
    pub content: String,
    pub content_type: String,
}

pub fn resolve_project_references(
    root: &Path,
    user_messages: &[String],
) -> Vec<ResolvedProjectReference> {
    let mut resolved = Vec::new();
    let mut seen = BTreeSet::new();
    for reference in user_messages
        .iter()
        .flat_map(|message| extract_project_reference_names_from_text(message))
    {
        let id = format!("project-reference:{}", normalize_ref_name(&reference));
        if seen.insert(id.clone()) {
            if let Some(item) = resolve_project_reference(root, &reference, id) {
                resolved.push(item);
            }
        }
    }
    resolved
}

fn resolve_project_reference(
    root: &Path,
    reference: &str,
    id: String,
) -> Option<ResolvedProjectReference> {
    if let Ok(sketches) = project::scan_sketches(root) {
        for sketch_summary in &sketches {
            if matches_ref(reference, &sketch_summary.path, &sketch_summary.title) {
                let sketch = project::read_sketch(&root.join(&sketch_summary.path)).ok()?;
                return Some(ResolvedProjectReference {
                    id,
                    reference: reference.to_string(),
                    name: sketch_summary.title.clone(),
                    content: format_sketch_for_ref(&sketch),
                    content_type: "application/json".into(),
                });
            }
        }
    }

    if let Ok(notes) = project::scan_notes(root) {
        for note in &notes {
            if matches_ref(reference, &note.path, &note.title) {
                let content = project::read_note(&root.join(&note.path)).ok()?;
                return Some(ResolvedProjectReference {
                    id,
                    reference: reference.to_string(),
                    name: note.title.clone(),
                    content,
                    content_type: "text/markdown".into(),
                });
            }
        }
    }

    if let Ok(chats) = project::scan_chat_artifacts(root) {
        for chat in &chats {
            if matches_ref(reference, &chat.path, &chat.title) {
                let content = project::read_note(&root.join(&chat.path)).ok()?;
                return Some(ResolvedProjectReference {
                    id,
                    reference: reference.to_string(),
                    name: chat.title.clone(),
                    content: format_chat_artifact_for_ref(&content),
                    content_type: "text/markdown".into(),
                });
            }
        }
    }

    if let Ok(storyboards) = project::scan_storyboards(root) {
        for storyboard_summary in &storyboards {
            if matches_ref(
                reference,
                &storyboard_summary.path,
                &storyboard_summary.title,
            ) {
                let storyboard =
                    project::read_storyboard(&root.join(&storyboard_summary.path)).ok()?;
                return Some(ResolvedProjectReference {
                    id,
                    reference: reference.to_string(),
                    name: storyboard_summary.title.clone(),
                    content: super::tools::format_storyboard_for_agent(root, &storyboard),
                    content_type: "text/markdown".into(),
                });
            }
        }
    }

    None
}

pub(super) fn extract_project_reference_names_from_text(text: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'@' {
            index += 1;
            continue;
        }

        if index > 0 {
            let prev = bytes[index - 1] as char;
            if prev.is_ascii_alphanumeric() || prev == '_' {
                index += 1;
                continue;
            }
        }

        let start = index + 1;
        if start >= bytes.len() {
            break;
        }

        let (raw, next_index) = if bytes[start] == b'"' || bytes[start] == b'\'' {
            let quote = bytes[start];
            let content_start = start + 1;
            let mut end = content_start;
            while end < bytes.len() && bytes[end] != quote {
                end += 1;
            }
            (&text[content_start..end], end.saturating_add(1))
        } else {
            let mut end = start;
            while end < bytes.len() {
                let ch = bytes[end] as char;
                if ch.is_whitespace() || matches!(ch, ',' | ';' | ')' | ']' | '}') {
                    break;
                }
                end += 1;
            }
            (&text[start..end], end)
        };

        let reference = raw
            .trim()
            .trim_matches(|ch: char| matches!(ch, '.' | ':' | ',' | ';' | ')' | ']' | '}'))
            .to_string();
        let normalized = normalize_ref_name(&reference);
        if !reference.is_empty()
            && !normalized.starts_with("http://")
            && !normalized.starts_with("https://")
            && !normalized.starts_with("web:http://")
            && !normalized.starts_with("web:https://")
        {
            refs.push(reference);
        }
        index = next_index.max(index + 1);
    }
    refs
}

pub(super) fn matches_ref(name: &str, path: &str, title: &str) -> bool {
    let name_lower = normalize_ref_name(name);
    if path.to_lowercase() == name_lower || title.to_lowercase() == name_lower {
        return true;
    }
    Path::new(path)
        .file_stem()
        .is_some_and(|stem| stem.to_string_lossy().to_lowercase() == name_lower)
}

fn normalize_ref_name(name: &str) -> String {
    let trimmed = name.trim().trim_matches('"').trim_matches('\'');
    let without_type = trimmed
        .strip_prefix("sketch:")
        .or_else(|| trimmed.strip_prefix("note:"))
        .or_else(|| trimmed.strip_prefix("storyboard:"))
        .or_else(|| trimmed.strip_prefix("chat-artifact:"))
        .or_else(|| trimmed.strip_prefix("chat:"))
        .unwrap_or(trimmed);
    without_type
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_lowercase()
}

fn format_sketch_for_ref(sketch: &crate::models::sketch::Sketch) -> String {
    let mut out = format!("# {}\n\n", sketch.title);
    if let Some(desc) = sketch.description.as_str() {
        if !desc.is_empty() {
            out.push_str(&format!("{desc}\n\n"));
        }
    }
    for (index, row) in sketch.rows.iter().enumerate() {
        out.push_str(&format!(
            "## Row {} [{}]\n**Narrative:** {}\n**Actions:** {}\n\n",
            index, row.time, row.narrative, row.demo_actions
        ));
    }
    out
}

fn format_chat_artifact_for_ref(content: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(content) else {
        return content.to_string();
    };

    let title = value
        .get("title")
        .and_then(|item| item.as_str())
        .unwrap_or("Chat");
    let mut out = format!("# {title}\n\n");

    if let Some(summary) = value.get("summary").and_then(|item| item.as_str()) {
        if !summary.trim().is_empty() {
            out.push_str(summary.trim());
            out.push_str("\n\n");
        }
    }

    if let Some(turns) = value.get("turns").and_then(|item| item.as_array()) {
        for (index, turn) in turns.iter().enumerate() {
            let role = turn
                .get("role")
                .and_then(|item| item.as_str())
                .unwrap_or("turn");
            let text = turn
                .get("text")
                .and_then(|item| item.as_str())
                .unwrap_or("")
                .trim();
            if !text.is_empty() {
                out.push_str(&format!("## Turn {} ({role})\n{text}\n\n", index + 1));
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn resolves_chat_artifact_references() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("chat-artifacts")).unwrap();
        std::fs::write(
            root.join("chat-artifacts/demo.cv"),
            r#"{"title":"Demo","turns":[{"role":"user","text":"What should we show?"},{"role":"assistant","text":"Show the payoff."}]}"#,
        )
        .unwrap();

        let refs = resolve_project_references(root, &["Use @chat:demo for context".into()]);

        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].name, "demo");
        assert!(refs[0].content.contains("What should we show?"));
        assert!(refs[0].content.contains("Show the payoff."));
    }
}
