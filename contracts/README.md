# CutReady contracts

Portable CutReady document contracts, written in TypeSpec and emitted by [Typra](https://github.com/sethjuarez/typra). They keep the desktop app (Rust) and the iOS/iPad companion (Swift) from drifting.

## What lives here

| Path | Role |
| --- | --- |
| `sketch.tsp` | `.sk` document models: `Sketch`, `PlanningRow`, locks, narration, motion |
| `edits.tsp` | `SketchDocument` operations and the shared edit error payload |
| `vectors/build.mjs` | Readable vector fixtures; writes `vectors.tsp` |
| `generated/` | Swift model package and Markdown reference (do not edit) |

Generated code outside this folder:

| Path | Role |
| --- | --- |
| `crates/cutready-contracts/src/model/` | Rust models (do not edit) |
| `crates/cutready-contracts/src/generated_tests/` | Rust model tests and `@vector` harness (do not edit) |
| `crates/cutready-contracts/src/vector_adapters.rs` | Binds vectors to desktop code (hand-written) |
| `ios/Tests/CutReadyContractConformanceTests/` | Swift `@vector` harness plus hand-written `VectorAdapters.swift` |

## Workflow

```bash
cd contracts
npm ci
npm run generate   # rebuild vectors.tsp and every generated output
npm run check      # regenerate and fail if the committed tree differs
```

Run the conformance suites:

```bash
cargo test -p cutready-contracts
swift test --package-path contracts/generated/swift
swift test --package-path ios
```

A vector with no adapter fails unless it is waived. A waived vector that starts passing also fails, so remove waivers as adapters land.

## Canonical save form

Desktop is the reference. Every runtime must save `.sk` files this way. Typra can't express explicit `null` or unknown-field passthrough yet, so the vectors pin these rules.

| Rule | Detail |
| --- | --- |
| Wire names | `snake_case` |
| Unknown fields | Preserved on `Sketch` and `PlanningRow` |
| Always written | Row `locked`, all six `locks`, `screenshot` (`null` if unset); sketch `locked`, `description` (`null` if unset); narration `duration_ms` (`null` if unknown) |
| Omitted when unset or empty | `visual`, `design_plan`, `duration_seconds`, `motion_points`, `typing_spots`, `motion_plan`, `narration`, `narration_plan`, `metadata` |
| Legacy state | `"sketch"` loads as `"draft"` |
| Timestamps | RFC 3339 UTC; a runtime never rewrites a timestamp it did not change |

## Edit policy

| Check | Result |
| --- | --- |
| Sketch `locked` | Every edit fails with `locked_document` |
| Row `locked` | Fails with `locked_row` only if that row's content changes |
| Cell lock | Fails with `locked_cell` only if that cell changes; screenshot and visual locks guard both cells |
| Reorder | Checked position by position against the locks at each position |
| Success | `updated_at` is set to the edit time |

## Open policy questions

- Desktop's time-cell UI recomputes `duration_seconds`; the agent tool and iOS don't. The vectors pin today's shared behavior (unchanged) until the timing slice decides.
- Desktop TypeScript types aren't generated yet.

## Typra workarounds

| Gap | Workaround |
| --- | --- |
| Non-string scalar arrays on discriminated subtypes load as `Vec<Value>` in Rust | Separate `updateRowText` and `reorderRows` operations instead of one polymorphic edit |
| Rust tests PascalCase multi-word enum values that the model emits as `Subtle_push` | `MotionPlan.kind` is a documented `string` |
| No unsigned integers (`uint8`/`uint32`/`uint64` emit invalid Rust and Swift) | Signed `int32`/`int64`; values are documented as non-negative |
| Formatter output depends on locally installed `swift-format`/`rustfmt` | `format: false` on Rust and Swift targets keeps output deterministic |
