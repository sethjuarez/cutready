use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

use cutready_cli::edit::{self, Expect};
use cutready_cli::project::{Failure, Project};
use cutready_cli::{discovery, mcp, validate, CONTRACT_VERSION};
use cutready_core::contracts::{ReviewAction, ReviewResolution, RunReview, SaveContext};
use cutready_desktop_io::SystemClock;
use serde_json::Value;

const USAGE: &str = "\
Usage:
  cutready-cli edit <project> <document> --expected <version|absent> [--ops <file>] [--run <id>]
  cutready-cli validate <project> [<document>...]
  cutready-cli review <project>
  cutready-cli keep <project> <document> --run <id> --through <seq>
  cutready-cli undo <project> <document> --run <id> --through <seq>
  cutready-cli mcp <project>
  cutready-cli register [--force]
  cutready-cli discover
  cutready-cli --version

edit reads a JSON array of EditOps from --ops (or stdin) and applies it as a
run CutReady shows for review. --expected is the version `validate` or the
MCP read_document tool reported, or `absent` for a new document.
review lists runs awaiting Keep or Undo with each document's through_seq;
keep and undo resolve one document of one run through that seq.
mcp serves the project to an agent over stdio.
register records this binary as the user's cutready-cli (a newer registered
install wins unless --force); discover prints the registered one, failing
if it is missing or speaks another edit contract.";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => code,
        Err(Usage(message)) => {
            eprintln!("{message}\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

struct Usage(String);

fn usage(message: impl Into<String>) -> Usage {
    Usage(message.into())
}

fn run(args: &[String]) -> Result<ExitCode, Usage> {
    let Some((command, rest)) = args.split_first() else {
        return Err(usage("Missing command"));
    };
    match command.as_str() {
        "--version" | "-V" => {
            println!(
                "cutready-cli {} (edit contract {CONTRACT_VERSION})",
                env!("CARGO_PKG_VERSION")
            );
            Ok(ExitCode::SUCCESS)
        }
        "--help" | "-h" | "help" => {
            println!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        "edit" => edit_command(rest),
        "validate" => {
            let (project, docs) = rest
                .split_first()
                .ok_or_else(|| usage("validate needs a project folder"))?;
            Ok(match validate::validate(&PathBuf::from(project), docs) {
                Ok(report) => print_json(&report.to_value(&ctx()), report.ok),
                Err(err) => failed(&err),
            })
        }
        "review" => {
            let [project] = rest else {
                return Err(usage("review needs exactly one project folder"));
            };
            let result = Project::open(&PathBuf::from(project))
                .and_then(|project| project.reviews(&SystemClock));
            Ok(match result {
                Ok(reviews) => print_json(&reviews_json(&reviews), true),
                Err(err) => failed(&err),
            })
        }
        "keep" | "undo" => resolve_command(command, rest),
        "register" => {
            let force = match rest {
                [] => false,
                [flag] if flag == "--force" => true,
                _ => return Err(usage("register takes only --force")),
            };
            let Some(dir) = discovery::default_dir() else {
                return Ok(no_config_dir());
            };
            let result = discovery::Registration::current()
                .and_then(|install| Ok((discovery::register(&dir, &install, force)?, install)));
            Ok(match result {
                Ok((outcome, install)) => {
                    print_json(&outcome.to_registration(&install).to_value(&ctx()), true)
                }
                Err(err) => failed(&Failure::other(err.to_string())),
            })
        }
        "discover" => {
            if !rest.is_empty() {
                return Err(usage("discover takes no arguments"));
            }
            let Some(dir) = discovery::default_dir() else {
                return Ok(no_config_dir());
            };
            Ok(match discovery::discover(&dir, CONTRACT_VERSION) {
                Ok(found) => print_json(&found.to_install().to_value(&ctx()), true),
                Err(err) => failed(&Failure::from(err.to_cmd_error())),
            })
        }
        "mcp" => {
            let [project] = rest else {
                return Err(usage("mcp needs exactly one project folder"));
            };
            let clock = SystemClock;
            let mut server = match mcp::Server::new(&PathBuf::from(project), &clock) {
                Ok(server) => server,
                Err(err) => {
                    eprintln!("cutready-cli mcp: {}", err.message());
                    return Ok(ExitCode::FAILURE);
                }
            };
            let stdin = std::io::stdin().lock();
            let stdout = std::io::stdout().lock();
            if let Err(err) = server.serve(stdin, stdout) {
                eprintln!("cutready-cli mcp: {err}");
                return Ok(ExitCode::FAILURE);
            }
            Ok(if server.closed() {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            })
        }
        other => Err(usage(format!("Unknown command {other}"))),
    }
}

fn edit_command(args: &[String]) -> Result<ExitCode, Usage> {
    let mut positional = Vec::new();
    let mut expected = None;
    let mut ops_file = None;
    let mut run_id = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| {
            iter.next()
                .cloned()
                .ok_or_else(|| usage(format!("{name} needs a value")))
        };
        match arg.as_str() {
            "--expected" => expected = Some(value("--expected")?),
            "--ops" => ops_file = Some(value("--ops")?),
            "--run" => run_id = Some(value("--run")?),
            flag if flag.starts_with("--") => return Err(usage(format!("Unknown option {flag}"))),
            _ => positional.push(arg.clone()),
        }
    }
    let [project, doc] = positional.as_slice() else {
        return Err(usage("edit needs a project folder and a document"));
    };
    let expect = match expected.as_deref() {
        Some("absent") => Expect::Absent,
        Some(version) => Expect::Version(version.to_string()),
        None => return Err(usage("edit needs --expected <version|absent>")),
    };
    let text = match ops_file.as_deref() {
        None | Some("-") => {
            let mut text = String::new();
            std::io::stdin()
                .read_to_string(&mut text)
                .map_err(|e| usage(format!("Could not read ops from stdin: {e}")))?;
            text
        }
        Some(file) => std::fs::read_to_string(file)
            .map_err(|e| usage(format!("Could not read {file}: {e}")))?,
    };
    let result = edit::parse_ops(&text).and_then(|ops| {
        edit::edit(
            &PathBuf::from(project),
            &SystemClock,
            doc,
            &expect,
            &ops,
            run_id.as_deref(),
        )
    });
    Ok(match result {
        Ok(applied) => print_json(&applied.to_value(&ctx()), true),
        Err(err) => failed(&err),
    })
}

fn resolve_command(command: &str, args: &[String]) -> Result<ExitCode, Usage> {
    let mut positional = Vec::new();
    let mut run_id = None;
    let mut through = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| {
            iter.next()
                .cloned()
                .ok_or_else(|| usage(format!("{name} needs a value")))
        };
        match arg.as_str() {
            "--run" => run_id = Some(value("--run")?),
            "--through" => through = Some(value("--through")?),
            flag if flag.starts_with("--") => return Err(usage(format!("Unknown option {flag}"))),
            _ => positional.push(arg.clone()),
        }
    }
    let [project, doc] = positional.as_slice() else {
        return Err(usage(format!(
            "{command} needs a project folder and a document"
        )));
    };
    let run_id = run_id.ok_or_else(|| usage(format!("{command} needs --run <id>")))?;
    let through_seq: u64 = through
        .ok_or_else(|| usage(format!("{command} needs --through <seq>")))?
        .parse()
        .map_err(|_| usage("--through must be a non-negative integer"))?;
    let result = Project::open(&PathBuf::from(project)).and_then(|project| {
        if command == "keep" {
            project.keep(&SystemClock, &run_id, doc, through_seq)
        } else {
            project.undo(&SystemClock, &run_id, doc, through_seq)
        }
    });
    Ok(match result {
        Ok(()) => {
            let resolution = ReviewResolution {
                run_id,
                path: doc.clone(),
                resolved: if command == "keep" {
                    ReviewAction::Keep
                } else {
                    ReviewAction::Undo
                },
            };
            print_json(&resolution.to_value(&ctx()), true)
        }
        Err(err) => failed(&err),
    })
}

fn ctx() -> SaveContext {
    SaveContext::default()
}

fn reviews_json(reviews: &[RunReview]) -> Value {
    Value::Array(
        reviews
            .iter()
            .map(|review| review.to_value(&ctx()))
            .collect(),
    )
}

fn no_config_dir() -> ExitCode {
    failed(&Failure::other("no per-user config directory"))
}

/// Prints the `CommandFailure` and fails.
fn failed(err: &Failure) -> ExitCode {
    print_json(&err.to_json(), false)
}

fn print_json(value: &Value, ok: bool) -> ExitCode {
    println!("{value}");
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
