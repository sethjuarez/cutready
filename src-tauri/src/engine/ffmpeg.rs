//! FFmpeg/FFprobe executable resolution shared by recording and export.

use std::{
    env,
    ffi::OsStr,
    fmt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const FFMPEG_ENV: &str = "CUTREADY_FFMPEG";
const FFPROBE_ENV: &str = "CUTREADY_FFPROBE";
const SETTINGS_FILE: &str = "settings.json";
const APP_DATA_DIR: &str = "com.cutready.app";
const FFMPEG_SETTING: &str = "ffmpegExecutablePath";
const FFPROBE_SETTING: &str = "ffprobeExecutablePath";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Ffmpeg,
    Ffprobe,
}

impl Tool {
    fn executable_name(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
        }
    }

    fn env_var(self) -> &'static str {
        match self {
            Self::Ffmpeg => FFMPEG_ENV,
            Self::Ffprobe => FFPROBE_ENV,
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::Ffmpeg => "FFmpeg",
            Self::Ffprobe => "FFprobe",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToolResolutionError {
    tool: Tool,
    searched: Vec<PathBuf>,
}

impl fmt::Display for ToolResolutionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let searched = self
            .searched
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        write!(
            f,
            "{} executable was not found. Searched: {}",
            self.tool.display_name(),
            if searched.is_empty() {
                "<no candidate paths>".to_string()
            } else {
                searched
            }
        )
    }
}

impl std::error::Error for ToolResolutionError {}

pub fn resolve_ffmpeg() -> Result<PathBuf, ToolResolutionError> {
    resolve_tool(Tool::Ffmpeg)
}

pub fn resolve_ffprobe() -> Result<PathBuf, ToolResolutionError> {
    resolve_tool(Tool::Ffprobe)
}

fn resolve_tool(tool: Tool) -> Result<PathBuf, ToolResolutionError> {
    let candidates = tool_candidates(tool);
    if let Some(path) = candidates.iter().find(|path| is_executable_file(path)) {
        return Ok(path.clone());
    }

    Err(ToolResolutionError {
        tool,
        searched: candidates,
    })
}

fn tool_candidates(tool: Tool) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(explicit) = env::var_os(tool.env_var()).filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(explicit));
    }

    if let Some(configured) = persisted_tool_path(tool) {
        candidates.push(configured);
    }

    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            candidates.extend(executable_candidates_in_dir(&dir, tool.executable_name()));
        }
    }

    for dir in platform_search_dirs() {
        candidates.extend(executable_candidates_in_dir(&dir, tool.executable_name()));
    }

    dedupe_paths(candidates)
}

fn persisted_tool_path(tool: Tool) -> Option<PathBuf> {
    let settings_path = dirs::data_dir()?.join(APP_DATA_DIR).join(SETTINGS_FILE);
    let content = std::fs::read_to_string(settings_path).ok()?;
    let settings = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    let key = match tool {
        Tool::Ffmpeg => FFMPEG_SETTING,
        Tool::Ffprobe => FFPROBE_SETTING,
    };
    settings
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn executable_candidates_in_dir(dir: &Path, executable_name: &str) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates = vec![dir.join(format!("{executable_name}.exe"))];
        candidates.push(dir.join(executable_name));
        candidates
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![dir.join(executable_name)]
    }
}

fn platform_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "macos")]
    {
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]);
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            let local_app_data = PathBuf::from(local_app_data);
            dirs.push(local_app_data.join("Microsoft\\WinGet\\Links"));
            dirs.extend(winget_ffmpeg_package_dirs(
                &local_app_data.join("Microsoft\\WinGet\\Packages"),
            ));
        }
        if let Some(program_data) = env::var_os("ProgramData") {
            dirs.push(PathBuf::from(program_data).join("chocolatey\\bin"));
        }
        if let Some(program_files) = env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(&program_files).join("ffmpeg\\bin"));
            dirs.push(PathBuf::from(&program_files).join("FFmpeg\\bin"));
        }
        if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
            dirs.push(PathBuf::from(&program_files_x86).join("ffmpeg\\bin"));
            dirs.push(PathBuf::from(&program_files_x86).join("FFmpeg\\bin"));
        }
    }

    #[cfg(target_os = "linux")]
    {
        dirs.extend([
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/snap/bin"),
        ]);
    }

    dirs
}

#[cfg(target_os = "windows")]
fn winget_ffmpeg_package_dirs(packages_root: &Path) -> Vec<PathBuf> {
    let Ok(packages) = std::fs::read_dir(packages_root) else {
        return Vec::new();
    };

    let mut dirs = Vec::new();
    for package in packages.flatten() {
        let package_path = package.path();
        let Some(package_name) = package_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !package_name.starts_with("Gyan.FFmpeg_") {
            continue;
        }

        let Ok(builds) = std::fs::read_dir(&package_path) else {
            continue;
        };
        for build in builds.flatten() {
            let build_path = build.path();
            let Some(build_name) = build_path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if build_name.starts_with("ffmpeg-") {
                dirs.push(build_path.join("bin"));
            }
        }
    }

    dirs
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.iter().any(|existing| existing == &path) {
            deduped.push(path);
        }
    }
    deduped
}

pub fn run_ffmpeg<I, S>(args: I) -> anyhow::Result<std::process::Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_resolved_command(resolve_ffmpeg()?, args)
}

pub fn run_ffprobe<I, S>(args: I) -> anyhow::Result<std::process::Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_resolved_command(resolve_ffprobe()?, args)
}

pub fn command_for_ffmpeg() -> anyhow::Result<Command> {
    Ok(command_for_path(resolve_ffmpeg()?))
}

fn run_resolved_command<I, S>(program: PathBuf, args: I) -> anyhow::Result<std::process::Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = command_for_path(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command.output()?)
}

fn command_for_path(program: PathBuf) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_common_paths_include_homebrew_locations() {
        #[cfg(target_os = "macos")]
        {
            let dirs = platform_search_dirs();
            assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
            assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
        }
    }

    #[test]
    fn dedupe_paths_preserves_first_occurrence() {
        let first = PathBuf::from("a");
        let second = PathBuf::from("b");
        assert_eq!(
            dedupe_paths(vec![first.clone(), second.clone(), first.clone()]),
            vec![first, second]
        );
    }

    #[test]
    fn windows_winget_ffmpeg_package_dirs_include_gyan_bin() {
        #[cfg(target_os = "windows")]
        {
            let root = env::temp_dir().join(format!(
                "cutready-winget-ffmpeg-test-{}",
                std::process::id()
            ));
            let package = root.join("Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe");
            let bin = package.join("ffmpeg-8.1.2-full_build").join("bin");
            std::fs::create_dir_all(&bin).expect("create winget ffmpeg fixture");

            let dirs = winget_ffmpeg_package_dirs(&root);

            assert!(dirs.contains(&bin));
            let _ = std::fs::remove_dir_all(root);
        }
    }
}
