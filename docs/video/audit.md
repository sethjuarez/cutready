# Live take: the independent audit

A live take passes only if **each action is visible on its spoken cue word**, as measured from the final `take.mp4`. Every fact the audit checks comes from a different source than the one the planner used, so the planner isn't marking its own work.

| Fact | Planner's source | Audit's source |
| --- | --- | --- |
| When the cue word is spoken | TTS WordBoundary events | Azure AI Speech fast transcription of the final MP4 audio, aligned to the script |
| When the action becomes visible | One change detector inside the step's ROI on the raw take | Two full-frame detectors on the final MP4: a coarse grid (D1) and per-frame SSIM (D2) |
| That the page really changed then | (none) | A page-side DOM witness logged by the sidecar, mapped to raw frames through the marker epoch fit |
| That the frame shows the right thing | (none) | A contact sheet for a human to check |

The previous audit is still computed during the pipeline, now called **render consistency** (`take.json` → `renderConsistency`, schema `cutready.live-take.v2`). It proves the render matches the plan. The independent audit (`audit.json`, schema `cutready.take-audit.v1`) checks whether the plan itself was right.

## Running it

The CLI runs it by default after every recording. It can also run on its own against an existing take folder:

```bash
cargo run -p cutready --example live_take -- SCRIPT.json [--out DIR] [--no-stt]
cargo run -p cutready --example live_take -- --audit-only .live-take-out/<take> [--no-stt]
```

- STT uses `SPEECH_ENDPOINT` and `SPEECH_TOKEN`, the same as TTS (see `live-take-learnings.md`). Transcripts are cached in `<out>/stt-cache/`, keyed by the audio hash.
- `--no-stt` skips the network. Word evidence then falls back to the plan's own times, which only place the search window. Each cue's word is marked `sttSkipped`, so the best a cue can get is **uncertain**, never pass.
- Exit codes:
  - `0`: pass.
  - `2`: fail, or render consistency failed.
  - `3`: uncertain.
  - `1`: pipeline error.
  - `64`: bad arguments.
- Outputs go next to `take.mp4`:
  - `audit.json`
  - `stt.json`, the raw transcript
  - `contact-sheet.png`

## What each stage measures

### Words

1. Decode the final MP4 audio to 16 kHz mono WAV and send it to Azure fast transcription with word timestamps.
2. Align the recognized words to the script narration using normalized token edit-distance alignment. This tolerates STT errors.
3. Report WER and content problems: words that are missing, substituted or inserted.
4. Locate each cue phrase (`tokens`, `occurrence`, `anchor`, `offsetMs`) in the aligned transcript. If the cue word itself wasn't recognized, the cue gets `wordNotHeard`. The audit doesn't invent a time for it.

STT word starts are biased in a way that can be measured. They were calibrated against TTS WordBoundary on Ava (`en-US-AvaMultilingualNeural`):

| Word position | STT − TTS | Correction | Uncertainty |
| --- | --- | --- | --- |
| Mid-phrase | median +47.5 ms | −47.5 ms | ±25 ms |
| After a pause (≥100 ms gap) | median −25 ms, range −117..+37 ms | none | ±120 ms |
| `wordEnd` anchors | n/a | none | ±120 ms |

The corrected time is `expectedMs`, and the uncertainty widens the tolerance for that cue.

### Visual onset

The detectors search a window of `expectedMs ± 2000 ms`, clipped to the midpoints between neighbouring cues. The window is deliberately wide: the regression this audit exists for was an action about 1 s early.

- **D1, grid.** Gray frames are split into a 32×18 grid. A cell is "net changed" when the window's last frame differs from its first frame. The onset is the first frame from which at least 25% of the net-changed cells stay changed until the window ends. That threshold was raised from 10% because a caret that blinked off just before a retime hold froze 2 of 16 cells and produced a false early onset.
- **D2, SSIM.** This is the per-frame dissimilarity from the first frame. The onset is the first frame past 10% of the final dissimilarity. D2 abstains when the final change is within noise.
- **Locality.** The net-changed box is compared with the target's bounding box (`atTarget`, `global`, `elsewhere`).
- `inProgressAtStart` (reason `changeInProgressAtWindowStart`) flags a window that already starts changing, so its onset can't be trusted.

### DOM witness

The sidecar installs an init script in every document. It reports:

- Input events: `pointerdown`, `keydown`, `wheel`.
- The first effect per animation frame after an input: a DOM mutation, an `input` value or a scroll.
- Each new document.

Each event carries its page-clock time and its next `requestAnimationFrame` time. A clock probe before and after each step maps page time to host time (min-RTT of 3). The marker epoch fit then maps host time to a raw-take frame.

For each step, the audit takes the **span** of fitting effects. If the step navigated (a new document, or the URL changed between its events), the span runs from the first fitting effect to the last one before the post marker. Otherwise it is the first effect alone, so unrelated later page activity can't widen it. The witness **agrees** when the pixel onset, converted to the raw frame it shows, falls in `[first − 1, last + 2]`. The comparison uses raw frames because a retime hold repeats one raw frame for many output frames, which would otherwise magnify a one-frame difference. The span is needed for route changes: playwright.dev's Get started changes the URL (first mutation) about 2–3 frames before the new page paints.

### Verdict

Each cue is `pass`, `fail` or `uncertain`, with a list of reasons.

| Outcome | When |
| --- | --- |
| **pass** | The word is from the transcript, `abs(drift) + u ≤ 80 ms`, D2 doesn't abstain and agrees with D1 within one frame, the witness agrees (or doesn't apply) and locality is `atTarget` or `global` |
| **fail** | Nothing changed visibly (`noVisibleChange`), or D1 drift is beyond the band (`abs(drift) − u ≥ 80 ms`: `actionEarly` or `actionLate`), D2 doesn't contradict it and the change is not away from the target |
| **uncertain** | Anything between those two, or missing or contradicting evidence: `sttSkipped`, `wordNotHeard`, `driftWithinUncertainty`, `detectorsDisagree`, `witnessConflicts`, `witnessAbsent`, `witnessNoEffect`, `witnessClockLoose`, `changeAwayFromTarget`, `targetUnknown`, `changeInProgressAtWindowStart`, `noPersistentOnset`, `secondDetectorAbstained` |

Here `u` is the word's uncertainty and drift is the D1 onset minus `expectedMs`.

The take fails on any failed cue. Otherwise it is uncertain if any of these hold:

- A cue is uncertain.
- There are no cues.
- A step has no cue word (`uncuedSteps`).
- The contact sheet couldn't be written.

The 80 ms base tolerance is two frames at 25 fps: ±20 ms of frame quantization on each side plus the residual STT error.

### Contact sheet

`contact-sheet.png` has one row per cue. Each row shows frames from −3 to +3 around the cue word, plus the onset frame and the frame before it. Overlays:

- The target box is outlined in yellow.
- The word frame is outlined in cyan and the onset frame in magenta.
- Captions show WORD, ONSET and DOM tags.

A reviewer can confirm in seconds that the postcondition is on screen at the word.

## Results

All runs are at 25 fps. Drift is the pixel onset minus the corrected word time. "Old" is render consistency.

| Take | Cue | Old drift | New D1 / D2 | Witness Δ (raw) | New verdict |
| --- | --- | --- | --- | --- | --- |
| fixture (`fixture-20261107-220933`) | open-panel | −12.5 ms | −22 / −22 ms | 0 | pass |
| | type-greeting | +17.5 ms | +18 / +18 ms | 0 | pass |
| | scroll-footer | −15.0 ms | −22 / −22 ms | 0 | pass |
| playwright.dev (`playwright-dev-20261107-220907`) | get-started | +17.5 ms | −22 / −22 ms | 2 (span 85–87) | pass |
| | scroll-guide | +2.5 ms | +18 / +18 ms | −1 | pass |
| | writing-tests | −15.0 ms | +18 / +18 ms | 0 | pass |
| **tiny ROI** (`playwright-dev-tiny-roi-20261107-220920`) | writing-tests | −15.0 ms, **pass** | **−1022 / −1022 ms** | 0 | **fail** (`actionEarly`) |
| **tiny ROI, pre-fix** (`existing/playwright-dev-20261107-141848`) | writing-tests | −15.0 ms, **pass** | **−1302 / −1302 ms** | n/a (no witness) | **fail** |

WER was 0% on every take, and the transcript-to-timeline audio offset was 0 ms.

### Regression proof

`playwright-dev-tiny-roi.json` reproduces the blind spot from learning #2 by forcing the planner's ROI onto the sidebar link (`observe: nav.menu a[href='/docs/writing-tests']`).

The real failure mode differs from the "3–7 frames late" description. The click navigates the page about **1.0–1.3 s before** "writing" is spoken. The planner instead anchored on the link's **active-highlight repaint**, which arrives that much later, and placed it on the word. The old check uses the same ROI and detector, so it passed at −15 ms. The new audit's full-frame detectors and the DOM witness all agree that the page changed 1022 ms before the word, so it fails.

### Cost and time

| Stage | Time |
| --- | --- |
| Decode the final video (gray frames) | ~145 ms |
| Transcribe (cached / fresh) | ~140 ms / 0.9–1.3 s |
| Align words | <10 ms |
| Detect (D1, D2, witness, verdict) | 450–830 ms |
| Contact sheet | 550–970 ms |
| **Total** | **~1.5–3 s per take** |

Azure fast transcription bills about 9–12 s of audio per take, which is negligible.

## Known blind spots

- **The STT bias is calibrated on one voice.** The correction and uncertainty come from Ava TTS. Other voices or human narration need recalibration. Until then, the after-pause ±120 ms band is the honest bound.
- **The witness clock excludes the epoch residual.** `clockUncertaintyMs` covers probe RTT and offset drift (<1 ms). The host-to-raw epoch fit has a residual RMS of 10–13 ms (max 21–32 ms), which is not added. The `−1..+2` frame band absorbs it today.
- **The witness span is generous for navigations.** For steps that changed URL, it accepts any onset up to 2 frames after the last effect before the post marker. The events aren't causally tied to the dispatched input, so background activity on a navigating page could widen the span. A late visible repaint of an early action would then agree with the witness, but the D1/D2 timing against the word would still fail it.
- **Stream offsets come from ffprobe.** A missing or malformed `start_time` is an error rather than a silent zero.
- **Content is not checked automatically.** No OCR and no DOM screenshot hash is compared. The contact sheet is the content check, and a human has to look at it.
- **Small progressive changes.** A 25% onset fraction can place the onset late for changes that grow gradually, such as a slow fade or a typed string where the first characters cover few cells. D2 usually disagrees with D1 in that case, which gives uncertain, not pass.
- **Takes recorded before the witness** can only be `uncertain` (`witnessAbsent`), even when both detectors and the word agree.
- **Only Azure STT is wired.** Local Whisper was not installed. A second engine would let words be cross-checked too.
