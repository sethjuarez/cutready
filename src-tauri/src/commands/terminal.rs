use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    thread::{self, JoinHandle},
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtyPair, PtySize};
use serde::Serialize;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    State,
};
use tauri_plugin_auditaur::auditaur_command;
use uuid::Uuid;

use crate::AppState;

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    reader: Option<JoinHandle<()>>,
}

#[derive(Debug, Serialize)]
pub struct TerminalOpenResult {
    session_id: String,
    cwd: String,
    shell: String,
}

#[auditaur_command(skip_all, err)]
pub async fn terminal_open(
    cols: u16,
    rows: u16,
    on_output: Channel,
    app_state: State<'_, AppState>,
    terminal_state: State<'_, TerminalState>,
) -> Result<TerminalOpenResult, String> {
    let cwd = workspace_root(&app_state)?;
    let (shell, args) = default_shell();
    let pty = native_pty_system();
    let pair = pty
        .openpty(size(cols, rows))
        .map_err(|error| format!("Failed to open terminal PTY: {error}"))?;
    let PtyPair { slave, master } = pair;

    let mut command = CommandBuilder::new(&shell);
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "CutReady");
    if std::env::var_os("LANG").is_none() {
        command.env("LANG", "en_US.UTF-8");
    }
    for arg in args {
        command.arg(arg);
    }

    let child = slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to start shell: {error}"))?;
    drop(slave);

    let session_id = Uuid::new_v4().to_string();
    let mut reader = master
        .try_clone_reader()
        .map_err(|error| format!("Failed to attach terminal output: {error}"))?;
    let mut killer = child.clone_killer();
    let reader_handle = thread::Builder::new()
        .name(format!("cutready-terminal-reader-{}", &session_id[..8]))
        .spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if on_output
                            .send(InvokeResponseBody::Raw(buffer[..count].to_vec()))
                            .is_err()
                        {
                            let _ = killer.kill();
                            break;
                        }
                    }
                    Err(error) => {
                        tracing::debug!("terminal reader ended: {error}");
                        break;
                    }
                }
            }
        })
        .map_err(|error| format!("Failed to start terminal reader: {error}"))?;

    let writer = master
        .take_writer()
        .map_err(|error| format!("Failed to attach terminal input: {error}"))?;

    terminal_state
        .sessions
        .lock()
        .map_err(|error| error.to_string())?
        .insert(
            session_id.clone(),
            TerminalSession {
                master,
                writer,
                child,
                reader: Some(reader_handle),
            },
        );

    Ok(TerminalOpenResult {
        session_id,
        cwd: cwd.display().to_string(),
        shell,
    })
}

#[auditaur_command(skip_all, err)]
pub async fn terminal_write(
    session_id: String,
    data: Vec<u8>,
    terminal_state: State<'_, TerminalState>,
) -> Result<(), String> {
    let mut sessions = terminal_state
        .sessions
        .lock()
        .map_err(|error| error.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Terminal session not found: {session_id}"))?;
    session
        .writer
        .write_all(&data)
        .map_err(|error| format!("Failed to write terminal input: {error}"))?;
    session
        .writer
        .flush()
        .map_err(|error| format!("Failed to flush terminal input: {error}"))?;
    Ok(())
}

#[auditaur_command(skip_all, err)]
pub async fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    terminal_state: State<'_, TerminalState>,
) -> Result<(), String> {
    let sessions = terminal_state
        .sessions
        .lock()
        .map_err(|error| error.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Terminal session not found: {session_id}"))?;
    session
        .master
        .resize(size(cols, rows))
        .map_err(|error| format!("Failed to resize terminal: {error}"))?;
    Ok(())
}

#[auditaur_command(skip_all, err)]
pub async fn terminal_close(
    session_id: String,
    terminal_state: State<'_, TerminalState>,
) -> Result<(), String> {
    terminal_state.close(&session_id)
}

impl TerminalState {
    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .remove(session_id);
        if let Some(session) = session {
            close_session(session);
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut sessions) => sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>(),
            Err(error) => {
                tracing::warn!("Failed to lock terminal sessions for cleanup: {error}");
                Vec::new()
            }
        };
        for session in sessions {
            close_session(session);
        }
    }
}

fn close_session(mut session: TerminalSession) {
    let _ = session.writer.flush();
    drop(session.writer);
    let _ = session.child.kill();
    drop(session.master);
    if let Some(reader) = session.reader.take() {
        let _ = reader.join();
    }
}

fn workspace_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let root = if let Some(project) = state
        .current_project
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
    {
        project.root.clone()
    } else if let Some(repo) = state
        .current_repo
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
    {
        repo.root.clone()
    } else {
        return Err("No workspace is open".to_string());
    };

    validate_workspace_root(&root)?;
    Ok(root)
}

fn validate_workspace_root(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Workspace root does not exist: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!(
            "Workspace root is not a directory: {}",
            path.display()
        ));
    }
    Ok(())
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(20),
        rows: rows.max(2),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(target_os = "windows")]
fn default_shell() -> (String, Vec<String>) {
    for shell in ["pwsh.exe", "powershell.exe", "cmd.exe"] {
        if command_exists(shell) {
            return if shell == "cmd.exe" {
                (shell.to_string(), Vec::new())
            } else {
                (shell.to_string(), vec!["-NoLogo".to_string()])
            };
        }
    }
    ("cmd.exe".to_string(), Vec::new())
}

#[cfg(not(target_os = "windows"))]
fn default_shell() -> (String, Vec<String>) {
    if let Some(shell) = std::env::var_os("SHELL").and_then(|shell| shell.into_string().ok()) {
        if Path::new(&shell).exists() {
            return (shell, Vec::new());
        }
    }
    for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if Path::new(shell).exists() {
            return (shell.to_string(), Vec::new());
        }
    }
    ("/bin/sh".to_string(), Vec::new())
}

#[cfg(target_os = "windows")]
fn command_exists(command: &str) -> bool {
    use std::os::windows::process::CommandExt;

    std::process::Command::new("where")
        .arg(command)
        .creation_flags(0x08000000)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}
