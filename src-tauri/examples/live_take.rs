//! Headless live narrated take.
//!
//! ```text
//! cargo run -p cutready --example live_take -- src-tauri/examples/live-take-scripts/fixture.json
//! ```
//!
//! See `docs/video/live-take-learnings.md` for the script format and env.

fn main() {
    let args = match cutready_lib::live_take::parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(64);
        }
    };
    match tauri::async_runtime::block_on(cutready_lib::live_take::run_cli(args)) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("live take failed: {e:#}");
            std::process::exit(1);
        }
    }
}
