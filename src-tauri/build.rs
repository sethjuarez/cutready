fn main() {
    emit_github_oauth_client_id();

    // Swift runtime rpath needed by screencapturekit (swift-bridge) on macOS
    #[cfg(target_os = "macos")]
    {
        let xcode_path = std::process::Command::new("xcode-select")
            .arg("-p")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();
        let xcode_path = xcode_path.trim();
        if !xcode_path.is_empty() {
            let swift_lib =
                format!("{xcode_path}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx");
            println!("cargo:rustc-link-search=native={swift_lib}");
            println!("cargo:rustc-link-arg=-Wl,-rpath,{swift_lib}");
        }
        println!("cargo:rustc-link-search=native=/usr/lib/swift");
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    tauri_build::build();
}

fn emit_github_oauth_client_id() {
    const KEY: &str = "CUTREADY_GITHUB_OAUTH_CLIENT_ID";
    println!("cargo:rerun-if-env-changed={KEY}");
    println!("cargo:rerun-if-changed=../.env");
    println!("cargo:rerun-if-changed=.env");

    if let Ok(value) = std::env::var(KEY) {
        let value = value.trim();
        if !value.is_empty() {
            println!("cargo:rustc-env={KEY}={value}");
            return;
        }
    }

    for path in ["../.env", ".env"] {
        if let Some(value) = read_env_value(path, KEY) {
            println!("cargo:rustc-env={KEY}={value}");
            return;
        }
    }
}

fn read_env_value(path: &str, key: &str) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    content.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let (candidate, value) = line.split_once('=')?;
        if candidate.trim() != key {
            return None;
        }
        let value = value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();
        (!value.is_empty()).then_some(value)
    })
}
