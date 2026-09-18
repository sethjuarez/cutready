# Scenecast resolved-demo fixture

`resolved-demo.json` pins the Scenecast resolved-demo wire shape that CutReady consumes during video export.
`minimal.scenecast/manifest.json` pins the Scenecast bundle input shape that CutReady produces before invoking the Scenecast CLI.

The current external contract baseline is Scenecast commit `731d9df` on branch `sethjuarez/add-resolved-demo-export`, which added `scenecast-cli export-resolved-demo` and CutReady-compatible camelCase resolved-demo output. Regenerate this fixture when Scenecast intentionally changes that contract:

```bash
cargo run -p scenecast-cli -- export-resolved-demo <bundle.scenecast> <output-dir>
```

Then copy `<output-dir>/resolved-demo.json` here and run CutReady's resolved-demo tests plus `npm run test:e2e:video-export`.

`minimal.scenecast` mirrors Scenecast's core `interactive.scenecast` fixture, but also includes exact-case files under `captures/` so it can be used for CLI validation. Bundle manifests intentionally use snake_case (`schema_version`, `start_scene`, `guide_marks`) while resolved-demo output uses camelCase (`schemaVersion`, `startSceneId`).

Generated CutReady bundles use stable row-derived scene IDs with the `cutready-row-` prefix.
Interactive `demo_steps` with screenshot-pixel `target_bounds` compile to Scenecast hotspots
that point at the following screenshot scene. Resolved demos may also include `sourceRowId`
and `sourceRowOrder`; CutReady treats them as optional metadata today, but validates them when
present to detect stale generated artifacts after sketch rows are inserted, deleted, or reordered.
