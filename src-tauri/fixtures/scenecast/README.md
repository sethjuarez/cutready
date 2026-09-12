# Scenecast resolved-demo fixture

`resolved-demo.json` pins the Scenecast resolved-demo wire shape that CutReady consumes during video export.
`minimal.scenecast/manifest.json` pins the Scenecast bundle input shape that CutReady produces before invoking the Scenecast CLI.

The fixture is based on Scenecast commit `aa7e14fc9d3faa94f01a1e72770aa3c845d1a3a3`, which added resolved-demo export support. Regenerate it when Scenecast intentionally changes that contract:

```bash
cargo run -p scenecast-cli -- export-resolved-demo <bundle.scenecast> <output-dir>
```

Then copy `<output-dir>/resolved-demo.json` here and run CutReady's resolved-demo tests plus `npm run test:e2e:video-export`.

`minimal.scenecast` mirrors Scenecast's core `interactive.scenecast` fixture, but also includes exact-case files under `captures/` so it can be used for CLI validation. Bundle manifests intentionally use snake_case (`schema_version`, `start_scene`, `guide_marks`) while resolved-demo output uses camelCase (`schemaVersion`, `startSceneId`).
