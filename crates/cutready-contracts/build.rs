// The conformance suite links the desktop app, whose macOS screen capture
// needs the Swift runtime. Link args from src-tauri/build.rs don't propagate to
// dependents, so mirror its rpath here.
fn main() {
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
            println!("cargo:rustc-link-arg=-Wl,-rpath,{swift_lib}");
        }
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
