//! Diagnostics commands for local debugging.

use rusqlite::Connection;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;
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

#[derive(Debug, Serialize)]
pub struct AuditaurDiagnosticsSummary {
    session: Option<AuditaurSessionDiagnostics>,
    counts: AuditaurDiagnosticsCounts,
    frontend_errors: Vec<AuditaurDiagnosticItem>,
    failed_ipc: Vec<AuditaurDiagnosticItem>,
    failed_traces: Vec<AuditaurDiagnosticItem>,
    warning_logs: Vec<AuditaurDiagnosticItem>,
    notes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct AuditaurSessionDiagnostics {
    session_id: String,
    service_name: String,
    app_identifier: Option<String>,
    pid: Option<u32>,
    database_path: String,
    last_heartbeat_at: Option<String>,
}

#[derive(Debug, Serialize, Default)]
pub struct AuditaurDiagnosticsCounts {
    frontend_errors: i64,
    failed_ipc: i64,
    failed_traces: i64,
    warning_logs: i64,
}

#[derive(Debug, Serialize)]
pub struct AuditaurDiagnosticItem {
    timestamp_unix_nanos: String,
    source: String,
    kind: String,
    title: String,
    detail: Option<String>,
    status: Option<String>,
    trace_id: Option<String>,
    span_id: Option<String>,
    window_label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditaurDiscovery {
    session_id: String,
    service_name: String,
    app_identifier: Option<String>,
    pid: Option<u32>,
    database_path: PathBuf,
    last_heartbeat_at: Option<String>,
}

#[tauri::command]
pub async fn get_auditaur_diagnostics() -> Result<AuditaurDiagnosticsSummary, String> {
    let mut notes = Vec::new();
    let Some(discovery) = find_current_auditaur_discovery(&mut notes)? else {
        return Ok(AuditaurDiagnosticsSummary {
            session: None,
            counts: AuditaurDiagnosticsCounts::default(),
            frontend_errors: Vec::new(),
            failed_ipc: Vec::new(),
            failed_traces: Vec::new(),
            warning_logs: Vec::new(),
            notes,
        });
    };

    let conn = Connection::open_with_flags(
        &discovery.database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("Could not open Auditaur database: {e}"))?;
    conn.busy_timeout(Duration::from_millis(750))
        .map_err(|e| format!("Could not configure Auditaur database timeout: {e}"))?;

    let counts = AuditaurDiagnosticsCounts {
        frontend_errors: count_rows_or_note(
            &conn,
            "SELECT COUNT(*) FROM frontend_errors",
            "frontend error count",
            &mut notes,
        ),
        failed_ipc: count_rows_or_note(
            &conn,
            "SELECT COUNT(*) FROM tauri_ipc_calls WHERE status != 'OK'",
            "failed IPC count",
            &mut notes,
        ),
        failed_traces: count_rows_or_note(
            &conn,
            "SELECT COUNT(DISTINCT trace_id) FROM spans WHERE status_code = 'ERROR'",
            "failed trace count",
            &mut notes,
        ),
        warning_logs: count_rows_or_note(
            &conn,
            "SELECT COUNT(*) FROM logs WHERE severity_number >= 13 OR severity_text IN ('WARN', 'WARNING', 'ERROR')",
            "warning/error log count",
            &mut notes,
        ),
    };

    let frontend_errors = query_items_or_note(
        &conn,
        "SELECT timestamp_unix_nanos,
                    'frontend' AS source,
                    COALESCE(error_type, 'Frontend error') AS kind,
                    message AS title,
                    stack AS detail,
                    NULL AS status,
                    trace_id,
                    span_id,
                    window_label
             FROM frontend_errors
             ORDER BY timestamp_unix_nanos DESC
             LIMIT 10",
        "recent frontend errors",
        &mut notes,
    );
    let failed_ipc = query_items_or_note(
        &conn,
        "SELECT timestamp_unix_nanos,
                    'ipc' AS source,
                    command AS kind,
                    command AS title,
                    error_message AS detail,
                    status,
                    trace_id,
                    span_id,
                    window_label
             FROM tauri_ipc_calls
             WHERE status != 'OK'
             ORDER BY timestamp_unix_nanos DESC
             LIMIT 10",
        "recent failed IPC",
        &mut notes,
    );
    let failed_traces = query_items_or_note(
        &conn,
        "SELECT MAX(start_time_unix_nanos) AS timestamp_unix_nanos,
                    'trace' AS source,
                    'Failed trace' AS kind,
                    name AS title,
                    status_message AS detail,
                    status_code AS status,
                    trace_id,
                    span_id,
                    NULL AS window_label
             FROM spans
             WHERE status_code = 'ERROR'
             GROUP BY trace_id
             ORDER BY timestamp_unix_nanos DESC
             LIMIT 10",
        "recent failed traces",
        &mut notes,
    );
    let warning_logs = query_items_or_note(
        &conn,
        "SELECT timestamp_unix_nanos,
                    source,
                    COALESCE(severity_text, 'WARN') AS kind,
                    COALESCE(body, severity_text, 'Log entry') AS title,
                    body_json AS detail,
                    severity_text AS status,
                    trace_id,
                    span_id,
                    NULL AS window_label
             FROM logs
             WHERE severity_number >= 13 OR severity_text IN ('WARN', 'WARNING', 'ERROR')
             ORDER BY timestamp_unix_nanos DESC
             LIMIT 10",
        "recent warning/error logs",
        &mut notes,
    );

    Ok(AuditaurDiagnosticsSummary {
        session: Some(AuditaurSessionDiagnostics {
            session_id: discovery.session_id,
            service_name: discovery.service_name,
            app_identifier: discovery.app_identifier,
            pid: discovery.pid,
            database_path: discovery.database_path.display().to_string(),
            last_heartbeat_at: discovery.last_heartbeat_at,
        }),
        counts,
        frontend_errors,
        failed_ipc,
        failed_traces,
        warning_logs,
        notes,
    })
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

fn auditaur_root() -> PathBuf {
    std::env::var("AUDITAUR_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("auditaur")
        })
}

fn find_current_auditaur_discovery(
    notes: &mut Vec<String>,
) -> Result<Option<AuditaurDiscovery>, String> {
    let apps_dir = auditaur_root().join("apps");
    if !apps_dir.exists() {
        notes.push(format!(
            "Auditaur discovery directory does not exist: {}",
            apps_dir.display()
        ));
        return Ok(None);
    }

    let current_pid = std::process::id();
    let mut candidates = Vec::new();
    let entries = std::fs::read_dir(&apps_dir)
        .map_err(|e| format!("Could not read Auditaur discovery directory: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Could not read Auditaur discovery entry: {e}"))?;
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let content = match std::fs::read_to_string(entry.path()) {
            Ok(content) => content,
            Err(error) => {
                notes.push(format!(
                    "Skipping unreadable Auditaur discovery file {}: {error}",
                    entry.path().display()
                ));
                continue;
            }
        };
        let discovery: AuditaurDiscovery = match serde_json::from_str(&content) {
            Ok(discovery) => discovery,
            Err(error) => {
                notes.push(format!(
                    "Skipping invalid Auditaur discovery file {}: {error}",
                    entry.path().display()
                ));
                continue;
            }
        };

        if discovery.pid == Some(current_pid)
            && discovery.database_path.exists()
            && heartbeat_is_fresh(discovery.last_heartbeat_at.as_deref())
        {
            return Ok(Some(discovery));
        }
        if discovery.service_name == "cutready" && discovery.database_path.exists() {
            candidates.push(discovery);
        }
    }

    candidates.sort_by(|left, right| left.last_heartbeat_at.cmp(&right.last_heartbeat_at));
    let fallback = candidates.pop();
    if let Some(discovery) = &fallback {
        notes.push(format!(
            "Using newest readable CutReady Auditaur session {} because this process did not have a fresh matching discovery PID.",
            discovery.session_id
        ));
    }
    Ok(fallback)
}

fn heartbeat_is_fresh(last_heartbeat_at: Option<&str>) -> bool {
    let Some(last_heartbeat_at) = last_heartbeat_at else {
        return false;
    };
    let Ok(last_heartbeat_at) = chrono::DateTime::parse_from_rfc3339(last_heartbeat_at) else {
        return false;
    };
    let age = chrono::Utc::now().signed_duration_since(last_heartbeat_at.with_timezone(&chrono::Utc));
    age.num_seconds() <= 60
}

fn count_rows(conn: &Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get(0))
        .map_err(|e| format!("Auditaur count query failed: {e}"))
}

fn count_rows_or_note(conn: &Connection, sql: &str, label: &str, notes: &mut Vec<String>) -> i64 {
    match count_rows(conn, sql) {
        Ok(count) => count,
        Err(error) => {
            notes.push(format!("Could not read Auditaur {label}: {error}"));
            0
        }
    }
}

fn query_items_or_note(
    conn: &Connection,
    sql: &str,
    label: &str,
    notes: &mut Vec<String>,
) -> Vec<AuditaurDiagnosticItem> {
    match query_items(conn, sql) {
        Ok(items) => items,
        Err(error) => {
            notes.push(format!("Could not read Auditaur {label}: {error}"));
            Vec::new()
        }
    }
}

fn query_items(conn: &Connection, sql: &str) -> Result<Vec<AuditaurDiagnosticItem>, String> {
    let mut statement = conn
        .prepare(sql)
        .map_err(|e| format!("Auditaur query prepare failed: {e}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(AuditaurDiagnosticItem {
                timestamp_unix_nanos: row.get::<_, i64>(0)?.to_string(),
                source: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                detail: row.get(4)?,
                status: row.get(5)?,
                trace_id: row.get(6)?,
                span_id: row.get(7)?,
                window_label: row.get(8)?,
            })
        })
        .map_err(|e| format!("Auditaur query failed: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Auditaur row mapping failed: {e}"))
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
