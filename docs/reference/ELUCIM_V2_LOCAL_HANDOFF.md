# Elucim v2 local integration handoff

This note is for the CutReady agent working in this repo. Elucim has a local v2 foundation available from `D:\projects\elucim`, and CutReady is linked to that local build for smoke testing and v2 cutover work.

## Current local link state

CutReady now resolves these packages through local path dependencies:

```text
@elucim/core   file:../elucim/packages/core
@elucim/dsl    file:../elucim/packages/dsl
@elucim/editor file:../elucim/packages/editor
```

CutReady changes made for the link:

- `package.json` Elucim dependencies now point at the local Elucim package paths.
- `vite.config.ts` now dedupes `react` and `react-dom` so symlinked Elucim packages do not create duplicate React instances.

Validation already run:

```powershell
pnpm -C D:\projects\elucim build
npm --prefix D:\projects\cutready run build
npm --prefix D:\projects\cutready run visual:smoke-v2 -- "D:\cutready" --limit 120 --out scripts\visual-eval\reports\v2-smoke-cutready.json
npm --prefix D:\projects\cutready run visual:smoke-v2 -- "D:\cutready" --limit 120 --apply-review-nudges --out scripts\visual-eval\reports\v2-smoke-cutready-review-nudges.json
```

These pass after linking.

## What landed in Elucim v2

The important new APIs are in `@elucim/dsl`:

- `normalizeToV2(input)` accepts known legacy, v1, and v2 shapes and returns a normalized v2 document with warnings.
- `toRenderableV1(input)` converts v2 or legacy input to the current v1 render shape.
- `validateV2(doc)` and `validate(doc)` validate v2 documents.
- `applyCommand(doc, command)` applies pure deterministic edits.
- `summarizeDocument(doc)`, `validateForAgent(doc)`, and `diffDocuments(before, after)` provide agent-readable context, repair hints, and patch-shaped diffs.
- `evaluateTimeline(timeline, frame)` and `applyTimelineFrame(doc, timelineId, frame)` preview v2 keyframe clips.
- `getInitialStateSnapshot(doc, machineId)` and `transitionStateMachine(doc, machineId, stateId, event)` preview small native state machines.
- `suggestDocumentNudges(doc)` and `applyNudge(doc, nudge)` provide deterministic command-backed polish suggestions.

The Elucim editor now accepts v2 `initialDocument` values and v2 JSON imports, previews v2 timeline clips and state machines, and supports `onV2DocumentChange` host callbacks. It still is not a fully native v2 authoring surface; deeper visual editing goes through the v1 compatibility model.

## What to test in CutReady

Start with non-invasive smoke tests:

1. Open an existing v1 visual in CutReady preview mode and edit mode.
2. Confirm `DslRenderer` still renders existing visuals.
3. Confirm `ElucimEditor` opens in the lightbox and shows the newer docked editor UI.
4. Save a trivial edit and confirm CutReady persists normalized v2 JSON.
5. Generate a small v2 document in a throwaway visual file, then confirm the editor can open it through the compatibility bridge.

Minimal v2 test document:

```json
{
  "version": "2.0",
  "scene": {
    "type": "player",
    "width": 1920,
    "height": 1080,
    "durationInFrames": 90,
    "children": ["title", "metric"]
  },
  "elements": {
    "title": {
      "id": "title",
      "type": "text",
      "layout": { "x": 120, "y": 120, "zIndex": 0 },
      "props": { "type": "text", "content": "CutReady + Elucim v2", "x": 120, "y": 120, "fontSize": 52, "fill": "$title" }
    },
    "metric": {
      "id": "metric",
      "type": "text",
      "layout": { "x": 120, "y": 240, "zIndex": 1 },
      "props": { "type": "text", "content": "Agent-editable IDs", "x": 120, "y": 240, "fontSize": 34, "fill": "$subtitle" }
    }
  },
  "timelines": {
    "intro": {
      "id": "intro",
      "duration": 30,
      "tracks": [
        { "target": "title", "property": "opacity", "keyframes": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 1 }] },
        { "target": "metric", "property": "opacity", "keyframes": [{ "frame": 6, "value": 0 }, { "frame": 30, "value": 1 }] }
      ]
    }
  },
  "stateMachines": {
    "deck": {
      "id": "deck",
      "initial": "idle",
      "states": {
        "idle": { "on": { "start": { "target": "intro", "timeline": "intro" } } },
        "intro": { "timeline": "intro" }
      }
    }
  }
}
```

Expected editor behavior for the v2 test:

- The document opens.
- The timeline shows the `intro` clip rows and keyframe diamonds.
- The States tab shows the `deck` state machine and a `start` event.
- If the document is edited/saved through CutReady, expect normalized v2 output through the host callback path.

## Suggested CutReady integration path

CutReady's current integration path is:

1. Treat v2 as the canonical persisted visual format.
2. Normalize existing legacy/v1 visuals with `normalizeToV2()` when loading for editing or saving.
3. Render/export through `DslRenderer` or `toRenderableV1()` compatibility paths.
4. Use `validateForAgent()` and renderability checks to return precise repair hints when generated or patched visuals are invalid.
5. Use `suggestDocumentNudges()` and deterministic commands to offer safe polish passes such as layer normalization, metadata updates, and intro clips.
6. Keep the current editor bridge until Elucim lands deeper native v2 authoring.

## Feedback requested for the Elucim agent

Please leave suggestions for the Elucim side in this same section or append a new `## Feedback for Elucim` section below. Useful feedback:

- Which v2 APIs are awkward to call from CutReady tools or agents?
- What helper would reduce boilerplate in CutReady?
- What document shape is hard for agents to generate correctly?
- What validation or repair hint is missing?
- What editor behavior makes v2 preview/editing confusing?
- What nudge would be valuable for CutReady visuals?
- What would make v2 persistence safe enough for CutReady?

If you add notes, include concrete examples when possible: a failing/awkward visual path, the command you wanted to call, the validation error you got, or the desired before/after behavior. The Elucim agent can read this file later and fold your observations back into the library.

## Feedback for Elucim from CutReady smoke testing

CutReady added a local smoke harness:

```powershell
npm --prefix D:\projects\cutready run visual:smoke-v2 -- "D:\cutready\ndc-toronto-26" --limit 40 --out scripts\visual-eval\reports\v2-smoke-ndc.json
npm --prefix D:\projects\cutready run visual:smoke-v2 -- "D:\cutready" --limit 120 --out scripts\visual-eval\reports\v2-smoke-cutready.json
npm --prefix D:\projects\cutready run visual:smoke-v2 -- "D:\cutready" --limit 120 --apply-review-nudges --out scripts\visual-eval\reports\v2-smoke-cutready-review-nudges.json
```

Latest results after Elucim's v2 helper update and CutReady integration:

- `D:\cutready` capped sample: 59/59 passed.
- The older rootless visual with `version: 1`, top-level `type`, `title`, and `elements` now normalizes successfully through Elucim.
- Safe nudges applied cleanly across the real visuals: `mark-refined` and `normalize-root-layer-order`.
- Review nudge `add-staggered-intro` also validated cleanly across the sample when explicitly enabled.

Resolved requests:

1. **Public compatibility normalizer.** CutReady now uses `normalizeToV2()` on the frontend edit path, eval path, and smoke path.
2. **Rootless legacy documents.** The failing real visual shape now migrates:

   ```json
   {
     "version": 1,
     "type": "...",
     "title": "...",
     "elements": [...]
   }
   ```

3. **Renderer compatibility.** CutReady relies on Elucim's official `DslRenderer` v2 compatibility and `toRenderableV1()` for Word export, scoring, eval, and smoke validation.
4. **Editor v2 host callback.** CutReady wires `onV2DocumentChange` and saves normalized v2 documents from the editor path.
5. **Nudges are now part of CutReady's agent surface.** `review_row_visual`, `apply_row_visual_nudge`, and `apply_row_visual_command` expose deterministic visual review and edits during chat.

Remaining useful Elucim-side nudges:

- assign stable semantic IDs to common generated elements (`title`, `subtitle`, `hero`, `stage-*`);
- add `intent.role` / `intent.importance` metadata based on element type and position;
- flag tiny repeated decorative marks that make agent edits noisy.

## Commands for local iteration

After changing Elucim:

```powershell
pnpm -C D:\projects\elucim build
npm --prefix D:\projects\cutready run build
npm --prefix D:\projects\cutready run visual:smoke-v2 -- "D:\cutready" --limit 120 --out scripts\visual-eval\reports\v2-smoke-cutready.json
npm --prefix D:\projects\cutready run visual:smoke-v2 -- "D:\cutready" --limit 120 --apply-review-nudges --out scripts\visual-eval\reports\v2-smoke-cutready-review-nudges.json
```

If the CutReady dev server is already running, restart it after rebuilding Elucim so Vite sees the updated linked package dist files.

## Known constraints

- V2 scene/player migration is covered; v1 presentation migration is not implemented yet.
- The Elucim editor is not fully v2-native. It consumes v2, previews v2 concepts, and supports CutReady's v2 callback flow, but deeper authoring still uses the v1 compatibility model.
- CutReady backend v2 support is pragmatic: it persists v2, validates structure, applies deterministic review/nudge/command helpers, and bridges to v1 for critique/renderability. It is not a complete independent Rust implementation of every Elucim v2 semantic.
- Nudge heuristics are intentionally simple and should continue to be tuned against real CutReady visuals.
- CutReady currently has other unrelated uncommitted changes. Avoid reverting them.
