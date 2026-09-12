# Scenecast resolved-demo fixture

`resolved-demo.json` pins the Scenecast resolved-demo wire shape that CutReady consumes during video export.

The fixture is based on Scenecast commit `aa7e14fc9d3faa94f01a1e72770aa3c845d1a3a3`, which added resolved-demo export support. Regenerate it when Scenecast intentionally changes that contract:

```bash
cargo run -p scenecast-cli -- export-resolved-demo <bundle.scenecast> <output-dir>
```

Then copy `<output-dir>/resolved-demo.json` here and run CutReady's resolved-demo tests plus `npm run test:e2e:video-export`.
