# Video recorder calibration spike

This spike measures timing for the live video recorder before the timing contract is frozen. The target pipeline follows the scenecast model:

1. **Voice first.** Synthesize the narration and get a time for each word.
2. **Scheduler.** Map each action to its cue word.
3. **Real-time recording.** Playwright drives the real web app, records video and logs each action.
4. **Retime.** Freeze or drop footage so each action lands on its word.
5. **Compose and audit.**

Each section below answers one question with measured numbers. Recommendations for the contract are at the end.

## What was built

| Piece | Location | Purpose |
| --- | --- | --- |
| `tts.synthesize` | `playwright-sidecar/lib/tts.js` | Azure Speech JS SDK synthesis. It returns the audio path plus the WordBoundary, PunctuationBoundary and SentenceBoundary events. |
| `browser.take` | `playwright-sidecar/lib/take.js` | Records a take in a fresh `recordVideo` context, logs each step with `process.hrtime.bigint()` and flashes magenta calibration markers. |
| Timing helpers | `playwright-sidecar/lib/timing.js` | Pure helpers for stats, cadence, marker detection, retime planning, the ffmpeg filter and WAV parsing. Unit-tested in `playwright-sidecar/test/timing.test.mjs`. |
| ffmpeg wrappers | `playwright-sidecar/lib/media.js` | ffprobe stream and frame PTS, raw frame decode, audio conversion. |
| Calibration driver | `playwright-sidecar/spike/calibrate.mjs` | Runs everything below and writes `results.json`. |
| Fixture page | `playwright-sidecar/spike/fixture.html` | A static, deterministic page with a button, panel, input and footer. |

Both RPCs are wired into the sidecar dispatcher in `playwright-sidecar/index.js`.

### Step log

Each step in a take logs these hrtime instants, in ms relative to `t0` (the moment the page was created):

| Field | Meaning |
| --- | --- |
| `dispatched_at` | Just before the Playwright input call. |
| `input_effect_at` | When the Playwright call resolves (click, `pressSequentially`, `mouse.wheel`, `goto`). |
| `postcondition_at` | When an explicit expected state holds: a selector state or value, a URL regex, or `scrollY`. |
| `selector` | The candidate that matched. All candidates are polled together every 50 ms, so a missing first candidate costs nothing. |
| `status` | `ok`, or an error. |

Each step is wrapped in a magenta pre-marker and post-marker. Each marker logs four instants: `on_requested`, `on_ack` (after two `requestAnimationFrame`s), `off_requested` and `off_ack`. A marker holds for 160 ms, then the page stays idle for 240 ms so back-to-back markers remain separate runs in the video.

## Environment

| Item | Value |
| --- | --- |
| OS | Windows 11 x64 |
| Node | v26.13.0 |
| Playwright | 1.58.2, Chromium 145.0.7632.6 (headless and headful) |
| Viewport and video size | 1280×720, `deviceScaleFactor: 1` |
| Speech SDK | `microsoft-cognitiveservices-speech-sdk` 1.53.0 |
| Speech resource | CutReady's configured Foundry resource, keyless Entra token |
| Takes | 3× headless fixture, 1× headful fixture, 1× headless `playwright.dev` (navigate, then click **Get started**) |

## Video format: CFR, 25 fps, 1 ms time base

| Take | Codec | `time_base` | `r_frame_rate` | Frames | Frame deltas | Duplicate frames |
| --- | --- | --- | --- | --- | --- | --- |
| fixture headless 1 | VP8 | 1/1000 | 25/1 | 288 | all 40.0 ms | 48 |
| fixture headless 2 | VP8 | 1/1000 | 25/1 | 293 | all 40.0 ms | 51 |
| fixture headless 3 | VP8 | 1/1000 | 25/1 | 290 | all 40.0 ms | 48 |
| fixture headful | VP8 | 1/1000 | 25/1 | 294 | all 40.0 ms | 52 |
| playwright.dev headless | VP8 | 1/1000 | 25/1 | 592 | all 40.0 ms | 168 |

- Playwright's webm is **strictly CFR at 25 fps**: every PTS delta is exactly 40 ms.
- The screencast itself is event-driven. Playwright pads it to CFR by **duplicating frames**, which accounts for 17 to 28 % of frames in these takes.
- Consequence: the frame carrying an action is the first frame after the compositor painted the change, on the 40 ms grid. The video cannot resolve anything finer than 40 ms.

## Epoch transform: video PTS vs host clock

A marker's **onset offset** is the PTS of the first magenta frame minus the marker's host `on_ack`, both relative to `t0`. The start marker is excluded: it is painted before the screencast's first frame and gets clamped to PTS 0. Including it biases the fitted slope to about 0.998.

| Take | Markers matched | Offset vs `on_ack` mean (ms) | Std (ms) | Offset vs `on_requested` mean (ms) | Fit slope | Drift (ppm) | Fit residual std / max (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fixture headless 1 | 12/12 | −134.6 | 12.3 | −124.4 | 1.00007 | +67 | 12.3 / 21.3 |
| fixture headless 2 | 12/12 | −139.3 | 10.8 | −121.8 | 0.99832 | −1682 | 9.0 / 19.3 |
| fixture headless 3 | 12/12 | −201.1 | 12.1 | −189.6 | 0.99959 | −410 | 12.0 / 21.5 |
| fixture headful | 12/12 | −715.7 | 15.7 | −688.7 | 1.00426 | +4264 | 3.3 / 5.4 |
| playwright.dev headless | 7/7 | −132.0 | 8.6 | −118.2 | 0.99960 | −404 | 8.0 / 11.9 |

Findings:

- **The offset is a per-take constant and must be measured per take.**
  - Headless takes range from −132 to −201 ms.
  - The headful take is −716 ms.
  - The offset is roughly when the screencast's first frame arrives relative to page creation, and it varies with browser startup.
- **Jitter is frame quantization, not clock noise.**
  - Within a take, the offset std is 9 to 16 ms.
  - That matches the std of a uniform error over one 40 ms frame (40/√12 ≈ 11.5 ms).
  - No residual exceeds 21.5 ms (about half a frame).
- **No measurable drift.**
  - Spans were 10 to 22 s.
  - The fitted slope changes sign across takes, and its error bar is about ±1 frame over the span (±4000 ppm at 10 s).
  - Drift on longer takes is unproven. Measure it with markers at both ends of the take (see the recommendations).
- **Use `on_ack` over `on_requested`.** `on_requested` sits 8 to 27 ms earlier: the page still has to apply the style and present a frame. `on_ack` (after two rAFs) is closer to what the compositor hands to the screencast.
- **All 55 markers were detected**, with no false positives (4 to 5 frames per marker).

## Action latency: dispatch to visible effect

Here, **visible** means the first non-marker frame whose mean absolute RGB difference from the pre-action frame exceeds 0.25, measured on 160×90 thumbnails. Its PTS is mapped back to the host clock with that take's offset. Fixture values are medians of the 4 fixture takes, with the range in brackets. All values are ms.

| Step | Dispatch → input effect | Dispatch → postcondition | Dispatch → visible | Input effect → visible |
| --- | --- | --- | --- | --- |
| navigate (local file) | 22 [16, 64] | 38 [33, 92] | 39 [26, 64] | 13 [0, 18] |
| click (opens panel) | 29 [26, 31] | 32 [28, 34] | 55 [36, 77] | 26 [6, 50] |
| type "hello" (40 ms/key) | 214 [210, 224] | 225 [221, 239] | 31 [5, 52] | −187 [−208, −161] |
| scroll (wheel 1200 px) | 1.6 [1.3, 6.2] | 15 [7, 26] | 26 [3, 33] | 22 [2, 31] |
| playwright.dev navigate | 2922 | 2985 | 2881 | −41 |
| playwright.dev click **Get started** | 25 | 26 | 183 | 158 |

What this shows:

- **On a local page, an action becomes visible 25 to 75 ms after dispatch** (one or two frames). That is the same order as the frame grid.
- **`input_effect_at` is the wrong anchor for multi-part inputs.** `pressSequentially` resolves after the last key (about 214 ms), while the first character is visible about 30 ms after dispatch.
- **On a real site, visible effect is decoupled from dispatch.**
  - The navigate to playwright.dev took about 2.9 s and painted about 40 ms before `goto` resolved: Playwright waits for `load`, which comes after first paint.
  - Clicking **Get started** resolved in 25 ms but painted about 180 ms later, because of client-side routing.
- The postcondition tracks the DOM, not pixels. It can land before or after the paint.

## Narration: word boundary precision

The narration is two sentences: _First we open the panel. Then we type a greeting, and finally we scroll down to the footer._

| Item | Value |
| --- | --- |
| Voice | `en-US-AvaMultilingualNeural` |
| Output format | `Riff24Khz16BitMonoPcm` (WAV, PCM16, 24 kHz) |
| Boundary types received | WordBoundary, PunctuationBoundary, SentenceBoundary |
| Words | 18 |
| `audioOffset` grid | 125 000 ticks = **12.5 ms** (the GCD of all offsets) |
| SDK `audioDuration` vs WAV samples | 5325 ms vs 5325 ms (127 800 samples), exact |
| Leading silence (first sample above about −40 dBFS) | 160.0 ms |
| First word boundary | 175 ms, so the boundary trails audible onset by 15 ms |
| Word onset vs energy onset, after a gap (n=6) | median 7.5 ms, p95 195 ms (the outlier is the detector firing mid-phrase) |
| Last word end, trailing silence | 5025 ms, 300 ms |
| `textOffset` | Indexes the **SSML** string (the first word is at 167), not the narration text. `alignWordsToText` re-anchors it to `plainOffset`. |

### WAV vs MP3

| Item | WAV (PCM) | MP3 (`Audio24Khz160KBitRateMonoMp3`) |
| --- | --- | --- |
| Word timings | Same | Same, the SDK reports identical offsets |
| Container start time | n/a | 0.000 (no priming compensation signalled) |
| Decoded length | 127 800 samples | 129 024 samples (5.376 s) |
| Lag vs PCM (cross-correlation) | 0 | **+1105 samples = 46.0 ms** |

MP3 adds a 46 ms encoder delay that the container does not declare, so MP3 word offsets are **46 ms early** relative to the decoded audio. The spike uses WAV/PCM.

### Voice support

| Voice | Boundary events | Duration (ms) |
| --- | --- | --- |
| `en-US-Harper:MAI-Voice-2` (CutReady's configured voice) | **0** | 5436 |
| `en-US-AvaMultilingualNeural` | 18 words | 5325 |
| `en-US-AndrewMultilingualNeural` | 23 (words plus punctuation) | 5588 |
| `en-US-JennyNeural` | 23 (words plus punctuation) | 6475 |

**MAI-Voice-2 emits no word boundaries.** If CutReady keeps MAI voices, cue words need forced alignment (for example Azure speech-to-text with word timestamps on the synthesized WAV, or a local aligner).

## Retime: making an action land on a word

The planner (`planRetime`) works on the 25 fps grid:

- If an action comes **too early**, it **freezes** the frame just before the action.
- If an action comes **too late**, it **drops** a source range that ends 600 ms before the action, so the cut falls in idle footage.

`retimeFilter` renders the plan as an ffmpeg `trim`/`setpts`/`tpad`/`concat`/`fps` chain. The narration is mixed in with `adelay` at a chosen lead. The dispatch plan used a 1040 ms freeze followed by drops of 360 ms and 3200 ms.

The cues come from the fixture take (headless 1): **open** → _open_, **type** → _type_, **scroll** → _scroll_. Each output was measured by decoding the rendered MP4 and finding the frame where the change appears. All values are ms.

| Anchor mode | Cue | Word time in output | Planned | Landed | Error vs word | Error vs plan |
| --- | --- | --- | --- | --- | --- | --- |
| dispatch (log-derived) | open | 3877.5 | 3880 | 3920 | +42.5 | +40 |
| dispatch | type | 5215 | 5200 | 5240 | +25 | +40 |
| dispatch | scroll | 6990 | 7000 | 6960 | −30 | −40 |
| visible frame | open | 3917.5 | 3920 | 3920 | **+2.5** | 0 |
| visible frame | type | 5255 | 5240 | 5240 | **−15** | 0 |
| visible frame | scroll | 7030 | 7040 | 7000 | **−30** | −40 |

| Check | Expected (ms) | Measured (ms) | Error (ms) |
| --- | --- | --- | --- |
| Narration first audible sample (dispatch render) | 3399.96 | 3399.96 | 0 |
| Narration first audible sample (visible render) | 3439.96 | 3440.79 | 0.8 |

Findings:

- **The edit model works.** With a freeze plus drops, every action landed within about one frame (≤ 42.5 ms) of its word.
- **Anchoring on the visible frame is more precise.** Error vs plan was 0 for 2 of 3 cues. Anchoring on dispatch was always one frame off, because dispatch happens one or two frames before the paint.
- **One cue still missed by a frame.** The scroll landed one frame early in both modes. The cause was not isolated: it is either the change detector picking a small-diff frame near the 0.25 threshold, or frame selection at a cut boundary.
- **Audio placement via `adelay` is exact.** The measured first audible sample in the AAC output is within 1 ms of plan.

## Recommendations for the timing contract

| Decision | Recommendation | Why (evidence) |
| --- | --- | --- |
| Host clock | `process.hrtime.bigint()` in the sidecar. The contract ships it as **integer microseconds relative to the take epoch `t0` (page created)**. | Monotonic, ns resolution. Microseconds keep sub-frame precision without floats or 64-bit ns overflow worries in JSON. |
| Video epoch transform | `video_pts_us = host_us + offset_us`. `offset_us` is **calibrated per take** as the median onset offset of the steady-state markers (ignore the start marker). Store it in the take log. | The offset varies −132 to −716 ms between takes, so it cannot be a constant. Jitter is ±½ frame. |
| Drift | Model a constant offset. Always flash an **end marker** (and, for takes over 60 s, a marker every ~30 s), then fit `pts = a + b·host`. Fail the take if \|b−1\| exceeds 1000 ppm or a residual exceeds 1 frame. | No drift resolvable over 10 to 22 s. Longer takes are unmeasured. |
| CFR vs PTS-based editing | **Edit in PTS on the native 25 fps CFR grid**, and **normalize the output to CFR** at render (`fps=` at the end of the filter graph). Don't re-time to 30/60 fps before editing. | The source is already strict CFR (40 ms). Editing on its grid keeps freezes and drops frame-exact. |
| Action timestamp to anchor on | **The first visibly-changed frame** (pixel diff after the action, before the post-marker), mapped through the epoch transform. Fall back to `dispatched_at + per-type latency` when no change is detected. Keep `input_effect_at` and `postcondition_at` as audit fields only. | Visible anchoring gave 0 frame error for 2 of 3 cues, dispatch anchoring always gave 1 frame. `input_effect_at` is about 190 ms late for typing and about 40 ms after paint for a real navigation. |
| Timing units in the contract | Integer **microseconds** for all host instants and word times (`audioOffset` ticks / 10). Integer **frame indices at a declared fps** for edit decisions. Never float seconds. | Word times sit on a 12.5 ms grid and video on a 40 ms grid. Both are exact in µs. |
| Precision budget | Target **±1 output frame** (±40 ms at 25 fps) per action. This is achievable. Sub-frame would need a higher capture fps, which `recordVideo` does not offer. | Measured landing errors were 2.5 to 42.5 ms. |
| Word-boundary pipeline | **WAV/PCM output** (`Riff24Khz16BitMonoPcm`), a **neural voice** that emits WordBoundary, words **re-anchored to plain text** (`plainOffset`), and an optional energy-onset refinement. For **MAI-Voice-2**, run forced alignment on the WAV. | MP3 shifts audio 46 ms. MAI-Voice-2 has no boundaries. Boundaries trail audible onset by about 15 ms. |
| Marker design | Full-viewport `#ff00ff` overlay, 160 ms hold, 240 ms gap, `on_ack` after 2 rAFs. In the product, either trim marker frames out at render or flash them only at the start and end of the take. | 4 to 5 frames per marker; 55/55 detected, none false. |

## How to reproduce

```bash
cd playwright-sidecar
npm install
npm test

# Keyless token for the Foundry speech resource. Use the subscription that
# belongs to the resource's tenant, and never commit the token.
export SPEECH_ENDPOINT="https://<resource>.services.ai.azure.com"
export SPEECH_AZ_SUBSCRIPTION="<subscription name or id>"
# or: export SPEECH_TOKEN="$(az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv)"

node spike/calibrate.mjs --repeat 3 --headful
# flags: --out <dir> (default .spike-out/calibration), --skip-public, --skip-tts
```

The script calls these ffmpeg tools:

```bash
# Stream facts
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,time_base,r_frame_rate,avg_frame_rate,width,height,start_time,duration,nb_frames -of json take.webm

# Every frame's PTS
ffprobe -v error -select_streams v:0 -show_entries frame=best_effort_timestamp_time -of csv=p=0 take.webm

# Raw thumbnails for marker and change detection
ffmpeg -v error -i take.webm -fps_mode passthrough -vf scale=160:90:flags=area -f rawvideo -pix_fmt rgb24 -

# Retime render (filter from retimeFilter, narration delayed by the lead)
ffmpeg -y -i take.webm -i narration.wav -filter_complex "<trim/setpts/tpad/concat/fps chain>;[1:a]adelay=<lead>:all=1[aout]" -map "[vout]" -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 18 -r 25 -map "[aout]" -c:a aac -b:a 160k retime.mp4
```

Results go to `<out>/results.json`. Takes, the narration WAV/MP3 and the retimed MP4s are written beside it. `.spike-out/` is gitignored.

## Open questions

- **Drift on long takes** (over 2 minutes) and under CPU load is still unmeasured.
- **Capture rate.** Playwright fixes `recordVideo` at 25 fps. If ±40 ms isn't good enough, CDP `Page.startScreencast` with our own timestamps would be the next experiment.
- **Visible-change detection** on real apps needs a region of interest (the target element's bounding box) rather than a whole-frame diff. Animations, cursors and spinners will otherwise trigger early.
- **Forced alignment for MAI voices.** Azure STT word timestamps vs a local aligner: cost and precision.
