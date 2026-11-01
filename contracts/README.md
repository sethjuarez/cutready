# CutReady contracts

Portable CutReady document contracts, written in TypeSpec and emitted by [Typra](https://github.com/sethjuarez/typra). They keep the desktop app (Rust backend, TypeScript frontend) and the iOS/iPad companion (Swift) from drifting.

## What lives here

| Path | Role |
| --- | --- |
| `sketch.tsp` | `.sk` document models: `Sketch`, `PlanningRow`, locks, narration, motion |
| `edits.tsp` | `SketchDocument` operations and `PlanningTiming` |
| `ops.tsp` | `EditOp`, the typed sketch edits, and the `EditService` operations |
| `errors.tsp` | `CmdError`, the `{code, message, details}` envelope every runtime reports |
| `storyboard.tsp` | `.sb` document models plus canonical round-trip and legacy-upgrade operations |
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

The TypeScript harness waives the document vectors: the frontend sends edits to the Rust backend over IPC and never saves `.sk` or `.sb` files itself. The Swift harness waives `StoryboardDocument` vectors while the companion remains view-only for storyboards, and `EditService` vectors while it keeps its own positional sketch edits.

The `Contracts` workflow (`.github/workflows/contracts.yml`) runs `npm run check`, the Rust, Swift, and TypeScript conformance suites, and the sketch model regressions on changes to the contract or any binding.

## Storyboard documents

Desktop is the reference for `.sb` files. `StoryboardDocument.roundTrip` pins the canonical save form; `StoryboardDocument.upgrade` converts older shapes before decode. Desktop runs the upgrade while scanning storyboards and opening one, then rewrites files that changed. It moves legacy `sketches` into `items`, maps item type `sketch` to `sketch_ref`, and fills canonical defaults. Unknown top-level fields are preserved.

The desktop TypeScript harness and the Swift harness currently waive these vectors because neither runtime owns storyboard persistence.

## Canonical save form

Desktop is the reference. Every runtime must save `.sk` files this way. Fields that are always written but may be `null` use `T | null = null`: legacy files may omit the key, and save always writes it. Unknown fields are declared with `...Record<unknown>`. The vectors pin all of it through each runtime's production code.

| Rule | Detail |
| --- | --- |
| Wire names | `snake_case` |
| Unknown fields | Preserved on `Sketch` and `PlanningRow`, not on nested models |
| Optional fields | A known optional field set to `null` loads like an absent key. Locks default to `false`; empty optional collections are omitted on save. Unknown fields keep their null values. |
| Row ids | Every row has a stable `id`, always written. Load and save fill missing, empty or `null` ids with `row-N` (1-based position, suffixed `-2`, `-3`… if taken); duplicate ids fail with `duplicate_row_id`. New rows from the desktop editor get a UUID. |
| Always written | Row `id`, `locked`, all six `locks`, `screenshot` (`null` if unset); sketch `locked`, `description` (`null` if unset); narration `duration_ms` (`null` if unknown) |
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

## Edit operations

`EditService.applySketchOps` and `applyStoryboardOps` apply a batch of typed `EditOp` values (`ops.tsp`) to a sketch or storyboard. Sketch ops address rows by stable `id`, not position. `cutready-core` (`edit_ops.rs`) is the reference.

| Op `kind` | Effect |
| --- | --- |
| `set_title`, `set_description`, `set_metadata` | Replace that sketch field |
| `set_row_text` | Set any of `time`, `narrative`, `demo_actions` on one row |
| `set_screenshot`, `set_visual` | Set or clear (`null`) that row's asset path |
| `insert_row` | Insert after `after_row_id` (`null` = first); a missing id gets `row-N` |
| `delete_row`, `reorder_rows` | Remove a row; reorder by a full list of row ids |
| `update_row`, `replace_rows` | Replace one row by id, or every row; lock state stays where it was |
| `set_lock` | Lock or unlock the sketch, a row (`row_id`), or a cell (`row_id` + `field`); storyboards and notes take no row |
| `touch` | Change nothing but `updated_at`; a sketch allows it while locked, a storyboard doesn't |
| `replace_sketch`, `replace_storyboard`, `replace_note` | Replace the whole document; ignores locks and keeps the given `updated_at` |
| `insert_storyboard_item`, `remove_storyboard_item`, `set_storyboard_items` | Insert at `index` (`null` or past the end appends), remove, or replace a storyboard's items |
| `write_note` | Replace a note's markdown; refused while the note is locked |

| Rule | Detail |
| --- | --- |
| Atomic | Ops are parsed and applied in order; the first failure rejects the whole batch and reports `details.op_index` |
| Locks | Content ops follow the edit policy above; `set_lock` is allowed on a locked sketch |
| Unknown ids | `row_not_found` with `details.row_id`; `locked_document` wins over it |
| Bad ops | An unknown `kind`, malformed op, or op for another document kind fails with `invalid_op` |
| Notes | A note batch changes the markdown or the lock, never both |
| Empty batch | Returns the sketch unchanged, including `updated_at` |

`EditService.documentVersion` returns `sha256:<hex>` of a file's bytes. `EditService.editDocument` is the host write path for every sketch, storyboard and note. Given the kind, the file on disk (`null` when absent), the version the ops were computed against (`null` to expect no file) and the ops, it fails with `stale_document` on a mismatch (with `details.current_version` when the file exists). A missing file must start with its kind's `replace_*` op. Otherwise it returns the canonical bytes to write and their version; for notes it also returns `note_locked` and `note_lock_changed`, since hosts keep note locks outside the file. Hosts only read and write the bytes.

## Timing

`PlanningTiming.parseDurationSeconds` turns a `time` label (`1:30`, `~25s`, `2m 15s`) into whole seconds. Desktop Rust, desktop TypeScript, and iOS each implement it, and each runs the same vectors through its own `@vector` harness. An unchanged label keeps its duration, so imported ranges such as `0:05 - 0:19` keep theirs. The agent's `write_sketch` tool lets an explicit `duration_seconds` win over the parsed one.

## Typra workarounds

| Gap | Workaround |
| --- | --- |
| Formatter output depends on locally installed `swift-format`/`rustfmt`/Prettier | `format: false` on every code target keeps output deterministic |
| Generated TypeScript imports `LoadContext`/`SaveContext` it doesn't use | `src/contracts/tsconfig.json` turns off `noUnusedLocals` |
