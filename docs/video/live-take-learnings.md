# Live take: learnings from the first end-to-end run

This slice takes a small JSON demo script and produces an MP4 in which Playwright drives a real web page and every action lands on its cue word. It also writes a `take.json` with an audit that is re-measured from the final MP4. It builds on the calibration spike (`docs/video/calibration-spike.md`) and the pure timing core in `src-tauri/src/engine/demo_timing/`.

Status: it works. The local fixture and playwright.dev both pass, with a worst-case drift of 17.5 ms against a 40 ms (one frame at 25 fps) tolerance.

## How to run it

```bash
# Azure Speech needs a token from the devrel subscription (the default tenant is rejected).
SPEECH_ENDPOINT=https://seth-foundry-dev.services.ai.azure.com
SPEECH_TOKEN=$(az account get-access-token --resource https://cognitiveservices.azure.com \
  --subscription sethjuarez-devrel --query accessToken -o tsv)

cargo run -p cutready --example live_take -- \
  src-tauri/examples/live-take-scripts/playwright-dev.json \
  [--out DIR] [--headful] [--sidecar DIR] [--max-takes N]
```

- Output goes to `.live-take-out/<name>-<timestamp>/` (gitignored), with `take.mp4`, `take.json` and the intermediate take files.
- Exit codes: `0` audit passed, `2` audit failed, `1` pipeline error, `64` bad arguments.
- TTS results are cached in `.live-take-out/tts-cache/`, keyed by voice and narration, so reruns don't need a token.
- `--max-takes` (default 3) controls automatic retakes when a take is rejected; rejected take folders are kept with a `rejected.txt`.

## Script format

`cutready.live-take-script.v1` is deliberately small and is not coupled to the sketch model yet:

```json
{
  "schema": "cutready.live-take-script.v1",
  "name": "playwright-dev",
  "narration": "This is the Playwright home page. Let's get started with the docs. ...",
  "voice": "en-US-AvaMultilingualNeural",
  "url": "https://playwright.dev/",
  "ready": { "selector": "h1" },
  "viewport": { "width": 1280, "height": 720 },
  "steps": [
    {
      "id": "get-started",
      "kind": "click",
      "selectors": ["a.getStarted_Sjon", "a:has-text('Get started')"],
      "cue": { "tokens": ["get", "started"] },
      "postcondition": { "url": "/docs/intro" }
    }
  ]
}
```

- `kind` is one of `navigate`, `click`, `type` or `scroll`. Type steps use `text`, navigate steps use `url`, and scroll steps use `dx`/`dy`.
- `selectors` are tried in order. For scroll steps, the first selector that matches is where the pointer is placed before the wheel event.
- `cue.tokens` is a phrase (normalized words). `occurrence` (0-based, counted after the previous step's match) picks a repeated phrase, `anchor` is `wordStart` (default) or `wordEnd`, and `offsetMs` nudges the landing point.
- `postcondition` is a selector state, a URL substring or `scrollYAtLeast`. It must hold before the next step is armed.
- `observe` overrides the region of interest used to detect the action's first visible frame.

The scripts used in this slice are in `src-tauri/examples/live-take-scripts/`:

| Script | Purpose |
| --- | --- |
| `fixture.json` | Deterministic local page from the spike: click, type, click |
| `fixture-tight.json` | Cues close together, so the planner has to compress dead time |
| `fixture-silence.json` | A long typed greeting that can't fit, which forces `InsertSilence` |
| `playwright-dev.json` | The real public site: click Get started, scroll, click Writing tests |

## Pipeline

`src-tauri/src/engine/live_take/` does the orchestration and IO. The sidecar does TTS and the browser.

1. **Narrate.** The sidecar synthesizes WAV PCM with WordBoundary events. Ticks are converted to `Micros` relative to the first audio sample, and leading silence is kept in the timeline, not trimmed.
2. **Record a take.** A fresh `recordVideo` context records the page. Each step is armed (hover or pointer placement), then the sidecar waits for network quiet and shows magenta pre and post markers around the dispatch. Every action logs hrtime dispatch, input effect, postcondition time and the target's bounding box.
3. **Analyze.** Marker runs are detected in the take (25 fps CFR), matched to the log, and `fit_epoch` maps hrtime to video time. The first visibly changed frame in the action's ROI is the observed landmark. A take whose dispatch frame falls under a marker run is rejected and recorded again.
4. **Plan.** `anchor_actions` and `plan_timing` produce an EDL of play, freeze and drop segments. When the plan needs `InsertSilence`, real silence is spliced into the WAV at the planned sample and later words are shifted.
5. **Render.** The EDL becomes a frame map: one source frame index per output frame. One ffmpeg process decodes the take to raw frames, Rust writes the mapped frames in order to a second ffmpeg that encodes H.264 at exactly the take fps and muxes the WAV as AAC. Every output frame is a copy of a decoded source frame, so timing is frame-exact without depending on filter-graph rounding (`trim`/`tpad`/`select`).
6. **Audit.** Action frames are detected again in the **final MP4**, and word times come from the final audio timeline. Each cue's drift is the observed frame time minus the cue time.
7. **Write `take.json`.** It holds the script, words, action log, epoch fit, plan, EDL, splices, observed landmarks, audit and stage timings.

### Hiding the markers

Marker frames are replaced with the most recent clean frame before render, not cropped or overlaid outside the viewport. Why this works:

- Markers only flash while the page is settled (after network quiet and before dispatch, or after the postcondition), so the last clean frame is visually identical to what the marker covered.
- It keeps the recorded viewport exactly the page size, with no crop maths and no extra canvas to hide.
- The masked-dispatch guard rejects the one case where it would be wrong: an action that becomes visible under a marker.

All 43 marker frames in the fixture take were substituted. The rendered MP4 had zero magenta frames.

## Results

All runs use 25 fps and a 40 ms tolerance. Drift is observed minus expected, per cue in step order.

| Run | Result | Drift per cue (ms) | Notes |
| --- | --- | --- | --- |
| fixture | pass | −12.5 / +17.5 / −15.0 | Epoch from 9 inliers, residual max 16.8 ms; 43 marker frames hidden |
| fixture-tight | pass | −12.5 / −5.0 / +5.0 | Planner dropped dead footage rather than inserting silence |
| fixture-silence | pass | −12.5 / −5.0 / +5.0 | 1.6 s of silence inserted after "greeting," (sample 74100) |
| playwright.dev, 5 runs after fixes | 5/5 pass | +17.5 / +2.5 / −15.0 | Identical every run; epoch residual max 11.7–32.5 ms |
| playwright.dev, auto-retake | pass on take 2 | +17.5 / +2.5 / −15.0 | Take 1 rejected: a marker stalled over the scroll dispatch |

The remaining drift is frame quantization. A cue time falls somewhere inside a 40 ms frame and the action can only appear at a frame start, so ±20 ms is the floor. A pass means the action was re-detected on exactly the frame the plan put it on.

### Stage timings

Typical times on this machine, from `take.json` `stages`:

| Stage | Time |
| --- | --- |
| Sidecar spawn | ~10 ms |
| TTS (uncached) | 2.3–4.7 s |
| Browser take | 8.2–11.1 s (playwright.dev ~9.5 s) |
| Analyze take (markers, epoch) | ~350–410 ms |
| Detect actions | 6–21 ms |
| Plan | <1 ms |
| Render | ~355–430 ms |
| Audit (re-detect in the MP4) | ~770–940 ms |

The browser take dominates. Everything after it (analysis, render and audit) adds about 1.7 s.

## What broke, and the fixes

- **Scrolling scrolled the wrong thing.** `mouse.wheel` scrolls whatever is under the pointer, and the pointer was still parked on the previous click target. Scroll steps now hover their selector when given, or move to the viewport centre.
- **A marker froze over an action.** On playwright.dev, after a hover or an SPA navigation, headless Chromium's recording sometimes held a marker frame for 0.7–0.9 s after the page had acknowledged marker-off. In one take the `pre:get-started` run lasted 23 frames and the click became visible underneath it. Two changes:
  - Before each pre-marker the sidecar waits for network quiet (300 ms with no requests in flight, at most 3 s). This is logged as `pre_quiet_ms`. Playwright's `waitForLoadState('networkidle')` can't do this because it resolves immediately once the page has been idle once.
  - A take is rejected if marker frames cover the dispatch frame or the frame after it, and the pipeline records another take.

  Before these changes, about 2 in 3 real-site takes stalled. Afterwards, 5 of 5 runs were clean, with the longest marker run at 5 frames. The root cause isn't proven; network quiet correlates with the fix.
- **Detection was late with a tiny ROI.** For the sidebar "Writing tests" link, the ROI was the link's own box. The link changes a few frames after the page does, so detection was 3–7 frames late. Clicks with a URL postcondition and no `observe` override now use the full frame.
- **The audit shared that blind spot.** The audit re-detects with the same detector and ROI as analysis. So the late-detection take still passed, because the audit was consistently late in the same way. The audit proves that render matches the plan; it doesn't prove the plan was based on the right landmark. See the recommendations.

## What was flaky on the real site

- Marker stalls, as above. They're now rare and caught.
- The epoch fit residual on playwright.dev reached 32.5 ms in one run, close to the one-frame limit. The fixture stayed under 17 ms. The real site produces more screencast jitter.
- The detection latency from dispatch to first changed frame was 1–4 frames on playwright.dev and a steady 2 frames on the fixture. Because the observed frame is used, not the dispatch time, this doesn't cause drift. It does mean dispatch time alone is not a usable landmark.
- Hashed CSS class selectors (`a.getStarted_Sjon`) will break when the site rebuilds. The text-based fallback is the one that will survive.
- There's no cursor in headless video. Clicks just happen, and the hover pre-arm makes hover styles appear before the cue.

## Recommendations

### (i) The step and cue model for sketch rows

When CutReady sketch rows grow an automation part, each actionable row should carry:

| Field | Why |
| --- | --- |
| Stable step `id` | take.json, retakes and review all refer to steps by id, not index |
| `kind` (navigate, click, type, scroll, ...) | Each kind needs a different arm, dispatch and observe strategy |
| Ordered selector fallbacks | Prefer role, text or test id first; hashed classes last |
| Pointer target for scroll | Wheel events go to whatever is under the pointer |
| `cue` with tokens, occurrence, anchor and offset | A phrase in the narration, not a time. Times change on every TTS or edit |
| Postcondition | Gates the next step and shows the action really happened |
| Optional observe region | The default ROI is wrong for small controls that change the whole page |

The narration stays one text per take (or per scene). Cues refer into it, so editing the words re-resolves the cues instead of invalidating hand-entered times. This maps onto the existing `Action`/`SelectorStrategy` with an adapter: selectors become the fallback list, and cue, postcondition and observe are new fields.

### (ii) Scenecast versus CutReady

| Belongs in Scenecast (capture and timing engine) | Belongs in CutReady (authoring and review) |
| --- | --- |
| Browser take with markers, action log, network-quiet wait | Script authoring: narration, steps, cue picking in the text |
| Marker detection, epoch fit, first-changed-frame detection | Selector capture and repair UX |
| `demo_timing` planning, EDL, silence splice | Choosing voice, reviewing words and cues |
| Frame-exact render, marker hiding, audit | Showing the audit and take.json, deciding retakes |
| Retake policy for rejected takes | Storing accepted takes in the project |

The rule of thumb: anything that needs frame or sample accuracy and has no opinion about the content goes in Scenecast. Anything a person edits or judges stays in CutReady.

### (iii) Next slices

1. **An independent audit.** Audit with a different detector or a full-frame ROI, so it can't share the analysis detector's blind spot, and report both numbers.
2. **The marker stall's root cause.** Try CDP `Page.startScreencast` with explicit frame acks, or a headful capture, to see if the stall is in the recorder. Track the stall rate across more sites.
3. **A cursor overlay.** Render a synthetic cursor from the logged pointer positions, so clicks read naturally on screen.
4. **A sketch adapter.** Generate this script from sketch rows once they carry the fields above. Narration is joined from the rows and cues come from the row narrative.
5. **UI.** Run a take from the app, show progress per stage, and show the audit next to the video.
6. **More step kinds.** Hover-only reveals, keyboard shortcuts, select and drag, each with an observe strategy.
7. **A MAI voice.** Revisit MAI-Voice-2 once it has word boundaries, or align its words with forced alignment.
