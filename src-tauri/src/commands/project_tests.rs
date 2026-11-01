//! Unit tests for `commands::project`, kept out of the module to hold its file budget.

use std::ffi::OsString;

use super::startup_project_path_from_args;

#[test]
fn startup_project_path_parses_space_separated_flag() {
    let path = startup_project_path_from_args([
        OsString::from("cutready.exe"),
        OsString::from("--project"),
        OsString::from("D:\\cutready\\start-2026"),
    ]);

    assert_eq!(path.as_deref(), Some("D:\\cutready\\start-2026"));
}

#[test]
fn startup_project_path_parses_equals_flag() {
    let path = startup_project_path_from_args([
        OsString::from("cutready.exe"),
        OsString::from("--open-project=D:\\cutready\\build-2026"),
    ]);

    assert_eq!(path.as_deref(), Some("D:\\cutready\\build-2026"));
}
