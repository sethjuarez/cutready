//! `cutready-cli validate`: check that project documents load.

use std::path::{Path, PathBuf};

use cutready_core::contracts::{CmdError, DocumentValidation, ValidationReport};
use cutready_core::document::{self, DocumentError};

use crate::project::{Failure, Project};

/// Validates `docs` (every `.sk`, `.sb` and `.md` in the project when empty).
pub fn validate(root: &Path, docs: &[String]) -> Result<ValidationReport, Failure> {
    let project = Project::open(root)?;
    let docs = if docs.is_empty() {
        discover(project.root())?
    } else {
        docs.to_vec()
    };
    let documents: Vec<DocumentValidation> = docs
        .into_iter()
        .map(|doc| match check(&project, &doc) {
            Ok(version) => DocumentValidation {
                path: doc,
                ok: true,
                version: Some(version),
                error: None,
            },
            Err(err) => DocumentValidation {
                path: doc,
                ok: false,
                version: None,
                error: Some(err.error().clone()),
            },
        })
        .collect();
    Ok(ValidationReport {
        ok: documents.iter().all(|doc| doc.ok),
        documents,
    })
}

fn check(project: &Project, doc: &str) -> Result<String, Failure> {
    let snapshot = project.read(doc)?;
    let (Some(content), Some(version)) = (snapshot.content, snapshot.version) else {
        return Err(Failure::other(format!("{doc} does not exist")));
    };
    let decoded = if doc.ends_with(".sk") {
        document::sketch_from_json(&content).map(|_| ())
    } else if doc.ends_with(".sb") {
        document::storyboard_from_json(&content).map(|_| ())
    } else {
        Ok(())
    };
    decoded.map_err(|err| match err {
        DocumentError::DuplicateRowId(dup) => Failure::from(CmdError::from(&dup)),
        other => Failure::other(format!("{doc}: {other}")),
    })?;
    Ok(version)
}

/// Project documents, skipping dot folders (`.git`, `.cutready`) and
/// `node_modules`, as sorted project-relative paths. A folder it can't read
/// fails the whole validation rather than skipping documents unseen.
fn discover(root: &Path) -> Result<Vec<String>, Failure> {
    let unreadable = |dir: &Path, err: std::io::Error| {
        Failure::other(format!(
            "Could not read {}: {err}",
            root.join(dir).display()
        ))
    };
    let mut found = Vec::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(dir) = pending.pop() {
        let entries = std::fs::read_dir(root.join(&dir)).map_err(|e| unreadable(&dir, e))?;
        for entry in entries {
            let entry = entry.map_err(|e| unreadable(&dir, e))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = dir.join(&name);
            let kind = entry.file_type().map_err(|e| unreadable(&rel, e))?;
            if kind.is_dir() {
                if !name.starts_with('.') && name != "node_modules" {
                    pending.push(rel);
                }
            } else if [".sk", ".sb", ".md"].iter().any(|ext| name.ends_with(ext)) {
                found.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    found.sort();
    Ok(found)
}
