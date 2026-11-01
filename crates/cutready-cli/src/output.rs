//! Results the CLI prints and MCP tools return. Each is a Typra model from
//! `contracts/cli.tsp` (or a list of them), so hosts can load every result
//! with the generated types. `Output` is sealed: only this module implements
//! it. `scripts/check-cli-output.mjs` rejects JSON built or printed by hand
//! elsewhere, except the MCP protocol framing.

use serde_json::Value;

use cutready_core::contracts::{
    AppliedEdit, CliInstall, CliRegistration, CommandFailure, DocumentSnapshot, LoadContext,
    ReviewResolution, RunReview, RunStarted, SaveContext, ValidationReport,
};

use crate::project::Failure;

mod sealed {
    pub trait Sealed {}
}

/// A typed CLI/MCP result.
pub trait Output: sealed::Sealed {
    fn to_output(&self) -> Value;
}

/// Prints a result as the command's one line of stdout.
pub fn print(output: &(impl Output + ?Sized)) {
    println!("{}", output.to_output());
}

/// A result as indented JSON, for files such as `cli.json`.
pub fn pretty(output: &(impl Output + ?Sized)) -> String {
    format!("{:#}", output.to_output())
}

/// Writes a result as indented JSON plus a newline to a new file at `path`,
/// synced to disk.
pub fn write_file(path: &std::path::Path, output: &(impl Output + ?Sized)) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::File::create(path)?;
    writeln!(file, "{}", pretty(output))?;
    file.sync_all()
}

/// What a failed command prints: `{error: CmdError}`.
impl sealed::Sealed for Failure {}
impl Output for Failure {
    fn to_output(&self) -> Value {
        CommandFailure {
            error: self.error().clone(),
        }
        .to_output()
    }
}

impl<T: Output> sealed::Sealed for [T] {}
impl<T: Output> Output for [T] {
    fn to_output(&self) -> Value {
        Value::Array(self.iter().map(Output::to_output).collect())
    }
}

impl<T: Output> sealed::Sealed for Vec<T> {}
impl<T: Output> Output for Vec<T> {
    fn to_output(&self) -> Value {
        self.as_slice().to_output()
    }
}

macro_rules! typed_outputs {
    ($($model:ident),* $(,)?) => {
        $(impl sealed::Sealed for $model {}
        impl Output for $model {
            fn to_output(&self) -> Value {
                self.to_value(&SaveContext::default())
            }
        })*

        /// The contract model `value` is, exactly: it loads as that model and
        /// saves back unchanged (no missing, extra or mistyped fields). A list
        /// must hold `RunReview`s. Tests use this to pin every result's shape.
        pub fn contract_model(value: &Value) -> Option<&'static str> {
            if let Value::Array(items) = value {
                let reviews = items.iter().all(|item| {
                    item.is_object()
                        && RunReview::try_load_from_value(item, &LoadContext::default())
                            .is_ok_and(|model| model.to_output() == *item)
                });
                return reviews.then_some("RunReview[]");
            }
            if !value.is_object() {
                return None;
            }
            $(if $model::try_load_from_value(value, &LoadContext::default())
                .is_ok_and(|model| model.to_output() == *value)
            {
                return Some(stringify!($model));
            })*
            None
        }
    };
}

typed_outputs!(
    AppliedEdit,
    CliInstall,
    CliRegistration,
    CommandFailure,
    DocumentSnapshot,
    ReviewResolution,
    RunReview,
    RunStarted,
    ValidationReport,
);

#[cfg(test)]
mod tests {
    use super::{contract_model, Output};
    use cutready_core::contracts::RunStarted;
    use serde_json::json;

    #[test]
    fn a_typed_result_is_its_model() {
        let started = RunStarted {
            run_id: "r1".into(),
        };
        assert_eq!(contract_model(&started.to_output()), Some("RunStarted"));
        assert_eq!(contract_model(&json!([])), Some("RunReview[]"));
    }

    #[test]
    fn hand_built_shapes_are_not_models() {
        for value in [
            json!({ "run_id": "r1", "extra": true }),
            json!({ "run_id": 7 }),
            json!({}),
            json!("r1"),
            json!([{ "run_id": "r1" }]),
        ] {
            assert_eq!(contract_model(&value), None, "{value}");
        }
    }
}
