# Try the narrated video pieces

These commands run each narrated video piece from a fresh `main` checkout. They use PowerShell syntax; in bash, use `export NAME=value` instead of `$env:NAME = "value"`. All output is gitignored.

## Setup

```powershell
npm ci
npm ci --prefix playwright-sidecar
npx --prefix playwright-sidecar playwright install chromium

# Azure Speech (TTS and STT). The default tenant is rejected; use the devrel subscription.
$env:SPEECH_ENDPOINT = "https://seth-foundry-dev.services.ai.azure.com"
$env:SPEECH_TOKEN = az account get-access-token --resource https://cognitiveservices.azure.com `
  --subscription sethjuarez-devrel --query accessToken -o tsv
```

You also need `ffmpeg` and `ffprobe`, either on `PATH` or pointed to by `CUTREADY_FFMPEG` and `CUTREADY_FFPROBE` (the calibration spike needs `PATH`). The token expires after about an hour. TTS results are cached, so reruns of the same narration don't need a token. The audit's transcription does need one, unless you pass `--no-stt`.

## Live narrated take

```powershell
# Local fixture page
cargo run -p cutready --example live_take -- src-tauri/examples/live-take-scripts/fixture.json

# The real playwright.dev site
cargo run -p cutready --example live_take -- src-tauri/examples/live-take-scripts/playwright-dev.json
```

- Options: `--out DIR`, `--headful` (watch the browser), `--max-takes N` (default 3), `--sidecar DIR`, `--no-stt`.
- Other scripts in `src-tauri/examples/live-take-scripts/` are `fixture-tight.json`, `fixture-silence.json` and `playwright-dev-tiny-roi.json`.
- Exit codes: `0` audit passed, `2` failed, `3` uncertain, `1` pipeline error, `64` bad arguments.

Each take goes to `.live-take-out/<script>-<timestamp>/`:

| File | What it is |
| --- | --- |
| `take.mp4` | The rendered narrated take |
| `take.json` | Script, timing plan, EDL and the take's own audit |
| `audit.json` | The independent audit (`cutready.take-audit.v1`) |
| `contact-sheet.png` | One row per cue: frames around the cue word, for a human to check |
| `stt.json` | The Azure STT transcript with word timings |

The TTS cache is `.live-take-out/tts-cache/`. Takes that were rejected and retaken keep their folder and get a `rejected.txt`.

## Audit and contact sheet

A live take audits itself at the end. To re-audit an existing take, which also rewrites `audit.json` and `contact-sheet.png`, run:

```powershell
cargo run -p cutready --example live_take -- --audit-only .live-take-out/<take>
cargo run -p cutready --example live_take -- --audit-only .live-take-out/<take> --no-stt
```

Open `contact-sheet.png` to check what was on screen at each cue. `docs/video/audit.md` explains the verdicts and the problem codes.

## Calibration spike

The spike's media helpers call `ffmpeg` and `ffprobe` directly, so both must be on `PATH`; `CUTREADY_FFMPEG` and `CUTREADY_FFPROBE` don't apply here.

```powershell
Push-Location playwright-sidecar
node spike/calibrate.mjs --repeat 3 --headful
Pop-Location
```

Output goes to `.spike-out/calibration/` at the repository root, including `results.json`. See `docs/video/calibration-spike.md`.

## Elucim frame export

The app renders Elucim visuals through `playwright-sidecar/elucim-frames.mjs`, which uses the pinned `@elucim/cli`. To run that same path by hand, pass it a JSON payload on stdin:

```powershell
$payload = @{
  visualPath = (Resolve-Path src-tauri/examples/elucim/hello.json).Path
  outputDir  = "$PWD/.elucim-out/hello"
  theme      = "light"   # or "dark"; resolves $accent-style tokens
} | ConvertTo-Json -Compress
$payload | node playwright-sidecar/elucim-frames.mjs
```

This writes `frame-000000.png` and the frames after it, plus a `frames.json` manifest, to `.elucim-out/hello/`. It prints `{manifestPath, frameCount, sourceFps, totalFrames}`. To find the sidecar in a packaged build, set `CUTREADY_SIDECAR_DIR`.

You can also call the Elucim CLI directly. Theme tokens such as `$accent` are only resolved by the sidecar renderer.

```powershell
Push-Location playwright-sidecar
npx elucim export-frames ../src-tauri/examples/elucim/hello.json --out-dir ../.elucim-out/cli --fps 30 --count 5 --json
Pop-Location
```
