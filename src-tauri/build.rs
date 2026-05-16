fn main() {
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
            let swift_lib = format!(
                "{xcode_path}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx"
            );
            println!("cargo:rustc-link-search=native={swift_lib}");
            println!("cargo:rustc-link-arg=-Wl,-rpath,{swift_lib}");
        }
        println!("cargo:rustc-link-search=native=/usr/lib/swift");
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    tauri_build::build();
}
