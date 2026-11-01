//! `cutready-cli validate`: check that project documents load.

use std::path::{Path, PathBuf};

use cutready_core::contracts::CmdError;
use cutready_core::document::{self, DocumentError};
use serde_json::{json, Value};

use crate::project::{Failure, Project};

/// Validates `docs` (every `.sk`, `.sb` and `.md` in the project when empty)
/// and returns `(all_valid, {ok, documents: [{path, ok, version?, error?}]})`.
pub fn validate(root: &Path, docs: &[String]) -> Result<(bool, Value), Failure> {
    let project = Project::open(root)?;
    let docs = if docs.is_empty() {
        discover(project.root())
    } else {
        docs.to_vec()
    };
    let mut all_ok = true;
    let mut results = Vec::new();
    for doc in docs {
        let result = match check(&project, &doc) {
            Ok(version) => json!({ "path": doc, "ok": true, "version": version }),
            Err(err) => {
                all_ok = false;
                json!({ "path": doc, "ok": false, "error": err.to_json() })
            }
        };
        results.push(result);
    }
    Ok((all_ok, json!({ "ok": all_ok, "documents": results })))
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
        DocumentError::DuplicateRowId(dup) => Failure::Contract(Box::new(CmdError::from(&dup))),
        other => Failure::other(format!("{doc}: {other}")),
    })?;
    Ok(version)
}

/// Project documents, skipping dot folders (`.git`, `.cutready`) and
/// `node_modules`, as sorted project-relative paths.
fn discover(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(root.join(&dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = dir.join(&name);
            let Ok(kind) = entry.file_type() else {
                continue;
            };
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
    found
}
