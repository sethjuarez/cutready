//! Converted commands reject with the `CmdError` envelope (ADR 0003): plain
//! failures keep their old text as `message` under `command_failed`.

use super::{agent::fetch_url_content, cmd_err, project::open_in_terminal, CmdError};

fn rejection(error: &CmdError) -> serde_json::Value {
    serde_json::to_value(error).unwrap()
}

#[test]
fn plain_failures_serialize_as_command_failed_with_the_old_text() {
    assert_eq!(
        rejection(&cmd_err("No project is currently open")),
        serde_json::json!({ "code": "command_failed", "message": "No project is currently open" })
    );
}

#[test]
fn draftline_refusals_reach_the_frontend_with_their_code_and_details() {
    let refusal = serde_json::json!({
        "code": "folder_is_elsewhere",
        "message": "This repository's CutReady project lives in 'cutready'.",
        "details": { "folder": "cutready" },
    });
    let error = cmd_err(crate::engine::project::ProjectError::Draftline(
        refusal.to_string(),
    ));
    assert_eq!(rejection(&error), refusal);
}

#[test]
fn converted_project_command_rejects_with_command_failed_envelope() {
    let missing = "definitely/not/a/cutready/dir".to_string();
    let error = tauri::async_runtime::block_on(open_in_terminal(missing.clone())).unwrap_err();
    assert_eq!(
        rejection(&error),
        serde_json::json!({
            "code": "command_failed",
            "message": format!("Directory does not exist: {missing}"),
        })
    );
}

#[test]
fn transfer_conflict_keeps_legacy_message_and_names_the_path() {
    assert_eq!(
        rejection(&CmdError::file_exists("flows/login.sk")),
        serde_json::json!({
            "code": "file_exists",
            "message": "FILE_EXISTS:flows/login.sk",
            "details": { "path": "flows/login.sk" },
        })
    );
}

#[test]
fn converted_agent_command_rejects_with_command_failed_envelope() {
    let expected =
        tauri::async_runtime::block_on(crate::engine::agent::web::fetch_and_clean("not a url"))
            .unwrap_err();
    let error = tauri::async_runtime::block_on(fetch_url_content("not a url".into())).unwrap_err();
    assert_eq!(
        rejection(&error),
        serde_json::json!({ "code": "command_failed", "message": expected })
    );
}
