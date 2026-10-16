# CutReady contracts

Portable CutReady document contracts, written in TypeSpec and emitted by [Typra](https://github.com/sethjuarez/typra). They keep the desktop app (Rust backend, TypeScript frontend) and the iOS/iPad companion (Swift) from drifting.

## What lives here

| Path | Role |
| --- | --- |
| `sketch.tsp` | `.sk` document models: `Sketch`, `PlanningRow`, locks, narration, motion |
| `edits.tsp` | `SketchDocument` operations, `PlanningTiming`, and the shared edit error payload |
| `vectors/build.mjs` | Readable vector fixtures; writes `vectors.tsp` |
| `generated/` | Swift model package and Markdown reference (do not edit) |

Generated code outside this folder:

| Path | Role |
| --- | --- |
| `crates/cutready-contracts/src/model/` | Rust models (do not edit) |
| `crates/cutready-contracts/src/generated_tests/` | Rust model tests and `@vector` harness (do not edit) |
| `crates/cutready-contracts/src/vector_adapters.rs` | Binds vectors to desktop code (hand-written) |
| `ios/Tests/CutReadyContractConformanceTests/` | Swift `@vector` harness plus hand-written `VectorAdapters.swift` |
| `src/contracts/generated/` | TypeScript models and Vitest `@vector` harness (do not edit); `src/types/sketch.ts` derives the frontend document types from these models |
| `src/contracts/vectorAdapters.ts` | Binds vectors to frontend code (hand-written) |

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
npm run typecheck:contracts   # from the repo root
npx vitest run src/contracts
```

A vector with no adapter fails unless it is waived. A waived vector that starts passing also fails, so remove waivers as adapters land.

The TypeScript harness waives the `SketchDocument` vectors: the frontend sends edits to the Rust backend over IPC and never saves `.sk` files itself.

The `Contracts` workflow (`.github/workflows/contracts.yml`) runs `npm run check`, the Rust, Swift, and TypeScript conformance suites, and the sketch model regressions on changes to the contract or any binding.

## Canonical save form

Desktop is the reference. Every runtime must save `.sk` files this way. Fields that are always written but may be `null` use `T | null = null`: legacy files may omit the key, and save always writes it. Unknown fields are declared with `...Record<unknown>`. The vectors pin all of it through each runtime's production code.

| Rule | Detail |
| --- | --- |
| Wire names | `snake_case` |
| Unknown fields | Preserved on `Sketch` and `PlanningRow`, not on nested models |
| Optional fields | A known optional field set to `null` loads like an absent key. Locks default to `false`; empty optional collections are omitted on save. Unknown fields keep their null values. |
| Always written | Row `locked`, all six `locks`, `screenshot` (`null` if unset); sketch `locked`, `description` (`null` if unset); narration `duration_ms` (`null` if unknown) |
| Omitted when unset or empty | `visual`, `design_plan`, `duration_seconds`, `motion_points`, `typing_spots`, `motion_plan`, `narration`, `narration_plan`, `metadata` |
| Legacy state | `"sketch"` loads as `"draft"` |
| Timestamps | Saved as UTC with `Z`: no fraction for whole seconds, otherwise 3, 6, or 9 digits. Unchanged timestamps keep their precision; edit times (`now`) carry at most microseconds |

## Edit policy

| Check | Result |
| --- | --- |
| Sketch `locked` | Every edit fails with `locked_document` |
| Row `locked` | Fails with `locked_row` only if that row's content changes, including unknown and desktop-only fields |
| Cell lock | Fails with `locked_cell` only if that cell changes; screenshot and visual locks guard both cells |
| Reorder | Checked position by position against the locks at each position |
| Comparison | Exact: text that differs only in Unicode composition is a change |
| Time edit | A changed `time` sets `duration_seconds` to `PlanningTiming.parseDurationSeconds(time)`, omitted when null; an unchanged `time` keeps it |
| Success | `updated_at` is set to the edit time |

## Timing

`PlanningTiming.parseDurationSeconds` turns a `time` label (`1:30`, `~25s`, `2m 15s`) into whole seconds. Desktop Rust, desktop TypeScript, and iOS each implement it, and each runs the same vectors through its own `@vector` harness. An unchanged label keeps its duration, so imported ranges such as `0:05 - 0:19` keep theirs. The agent's `write_sketch` tool lets an explicit `duration_seconds` win over the parsed one.

## Typra workarounds

| Gap | Workaround |
| --- | --- |
| Formatter output depends on locally installed `swift-format`/`rustfmt`/Prettier | `format: false` on every code target keeps output deterministic |
| Generated TypeScript imports `LoadContext`/`SaveContext` it doesn't use | `src/contracts/tsconfig.json` turns off `noUnusedLocals` |
