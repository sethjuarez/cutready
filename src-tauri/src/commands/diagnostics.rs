//! Diagnostics commands for local debugging.

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::engine::{agent::tools::normalize_visual_document_for_save, project};
use crate::AppState;

#[derive(Debug, Serialize)]
pub struct DiagnosticsDump {
    app_version: &'static str,
    project: Option<ProjectDiagnostics>,
    environment: EnvironmentDiagnostics,
    visual: Option<VisualDiagnostics>,
    checks: Vec<DiagnosticCheck>,
}

#[derive(Debug, Serialize)]
pub struct ProjectDiagnostics {
    name: String,
    root: String,
}

#[derive(Debug, Serialize)]
pub struct EnvironmentDiagnostics {
    diagnostics_enabled: bool,
    diagnostics_value: Option<String>,
    elucim_bridge_enabled: bool,
    elucim_bridge_value: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DiagnosticCheck {
    id: &'static str,
    status: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
pub struct VisualDiagnostics {
    sketch_path: String,
    row_index: usize,
    visual_path: Option<String>,
    inline_visual: bool,
    version: Option<String>,
    scene_id: Option<String>,
    timeline_ids: Vec<String>,
    state_machine_ids: Vec<String>,
    default_state_machine: Option<String>,
    normalized_default_state_machine: Option<String>,
    normalized_state_machine_ids: Vec<String>,
    valid_after_normalization: bool,
    normalization_error: Option<String>,
}

#[tauri::command]
pub async fn dump_diagnostics(
    sketch_path: Option<String>,
    row_index: Option<usize>,
    state: State<'_, AppState>,
) -> Result<DiagnosticsDump, String> {
    if !diagnostics_enabled() {
        return Err(
            "Diagnostics are disabled. Run a debug build or set CUTREADY_DIAGNOSTICS=1 to enable them."
                .to_string(),
        );
    }

    let project = state
        .current_project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let environment = EnvironmentDiagnostics {
        diagnostics_enabled: true,
        diagnostics_value: std::env::var("CUTREADY_DIAGNOSTICS").ok(),
        elucim_bridge_enabled: env_flag("CUTREADY_ELUCIM_BRIDGE"),
        elucim_bridge_value: std::env::var("CUTREADY_ELUCIM_BRIDGE").ok(),
    };

    let visual = match (project.as_ref(), sketch_path, row_index) {
        (Some(project), Some(sketch_path), Some(row_index)) => {
            Some(visual_diagnostics(&project.root, sketch_path, row_index)?)
        }
        _ => None,
    };
    let has_project = project.is_some();
    let checks = diagnostic_checks(has_project, &environment, visual.as_ref());
    let project = project.map(|project| ProjectDiagnostics {
        name: project.name,
        root: project.root.display().to_string(),
    });

    Ok(DiagnosticsDump {
        app_version: env!("CARGO_PKG_VERSION"),
        project,
        environment,
        visual,
        checks,
    })
}

fn diagnostics_enabled() -> bool {
    cfg!(debug_assertions) || env_flag("CUTREADY_DIAGNOSTICS")
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn diagnostic_checks(
    has_project: bool,
    environment: &EnvironmentDiagnostics,
    visual: Option<&VisualDiagnostics>,
) -> Vec<DiagnosticCheck> {
    let mut checks = vec![
        DiagnosticCheck {
            id: "diagnostics.enabled",
            status: "pass",
            message: "Diagnostics command is enabled for this process.".to_string(),
        },
        DiagnosticCheck {
            id: "project.loaded",
            status: if has_project { "pass" } else { "warning" },
            message: if has_project {
                "A CutReady project is currently open.".to_string()
            } else {
                "No CutReady project is open, so project-scoped checks are unavailable.".to_string()
            },
        },
        DiagnosticCheck {
            id: "elucim.bridge",
            status: if environment.elucim_bridge_enabled {
                "pass"
            } else {
                "warning"
            },
            message: if environment.elucim_bridge_enabled {
                "CUTREADY_ELUCIM_BRIDGE is enabled.".to_string()
            } else {
                "CUTREADY_ELUCIM_BRIDGE is not enabled; bridge-only visual agent operations are unavailable."
                    .to_string()
            },
        },
    ];

    if let Some(visual) = visual {
        checks.push(DiagnosticCheck {
            id: "visual.normalization",
            status: if visual.valid_after_normalization {
                "pass"
            } else {
                "fail"
            },
            message: visual
                .normalization_error
                .clone()
                .unwrap_or_else(|| "Visual document normalized successfully.".to_string()),
        });
    }

    checks
}

fn visual_diagnostics(
    root: &std::path::Path,
    sketch_path: String,
    row_index: usize,
) -> Result<VisualDiagnostics, String> {
    let abs_path = project::safe_resolve(root, &sketch_path).map_err(|e| e.to_string())?;
    let sketch = project::read_sketch_with_migration(&abs_path, root).map_err(|e| e.to_string())?;
    let row = sketch
        .rows
        .get(row_index)
        .ok_or_else(|| format!("Row index {row_index} does not exist in {sketch_path}"))?;
    let Some(visual_ref) = row.visual.as_ref() else {
        return Err(format!(
            "Row index {row_index} in {sketch_path} does not have a visual"
        ));
    };

    let (visual, visual_path, inline_visual) = match visual_ref {
        Value::String(path) => (
            project::read_visual(root, path).map_err(|e| e.to_string())?,
            Some(path.clone()),
            false,
        ),
        visual => (visual.clone(), None, true),
    };

    let normalized = normalize_visual_document_for_save(&visual);
    let (
        normalized_default_state_machine,
        normalized_state_machine_ids,
        valid_after_normalization,
        normalization_error,
    ) = match normalized {
        Ok(normalized) => (
            normalized
                .get("defaultStateMachine")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            object_keys(&normalized, "stateMachines"),
            true,
            None,
        ),
        Err(error) => (None, Vec::new(), false, Some(error)),
    };

    Ok(VisualDiagnostics {
        sketch_path,
        row_index,
        visual_path,
        inline_visual,
        version: visual
            .get("version")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        scene_id: visual
            .get("scene")
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        timeline_ids: object_keys(&visual, "timelines"),
        state_machine_ids: object_keys(&visual, "stateMachines"),
        default_state_machine: visual
            .get("defaultStateMachine")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        normalized_default_state_machine,
        normalized_state_machine_ids,
        valid_after_normalization,
        normalization_error,
    })
}

fn object_keys(value: &Value, key: &str) -> Vec<String> {
    let mut keys = value
        .get(key)
        .and_then(|v| v.as_object())
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    keys.sort();
    keys
}
