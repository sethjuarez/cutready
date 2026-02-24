# CutReady — Feature Guidance

> _Everything CutReady can do, organized by workflow phase._

---

## Overview

CutReady follows a **record-first** philosophy. The primary entry point is performing the demo yourself — the app captures your interactions and an AI agent refines them into a production-ready script. Manual script authoring is an alternative path, not the default.

The workflow phases are:

1. [Record](#phase-1-record)
2. [Refine (Agent)](#phase-2-refine-agent)
3. [Review & Edit](#phase-3-review--edit)
4. [Produce (Replay + Recording)](#phase-4-produce-replay--recording)
5. [Motion Animations](#phase-5-motion-animations)
6. [Export & Packaging](#phase-6-export--packaging)

---

## Phase 1: Record

The user performs the demo manually while CutReady observes and captures every interaction as a structured, replayable action sequence.

### Two Recording Modes

#### Record-Then-Replay (Free-Form)

- Click **Record Steps** and perform the demo naturally — browse websites, click through native apps, type, scroll, navigate.
- CutReady captures all interactions in real time.
- When finished, the captured interactions appear as an ordered list of actions in the script table.
- Auto-screenshots are taken at each interaction point.
- Best for: getting a rough first draft quickly.

#### Step-by-Step Capture

- Click **Capture Step**, perform a single interaction, and CutReady captures it and pauses.
- A confirmation popup shows the captured action (e.g., _"Clicked button 'Submit' at selector `#submit-btn`"_) with fields to annotate: narrative text, timing, notes.
- Confirm or discard, then capture the next step.
- Produces a fully annotated script row per step.
- Best for: precise, pre-annotated demos where you know exactly what to show.

### What Gets Captured

For each interaction, CutReady records:

| Data | Browser | Native App |
| ------ | --------- | ------------ |
| **Action type** | Click, type, navigate, scroll, select, hover | Click, type, select, invoke, expand/collapse |
| **Target element** | Multiple selector strategies (CSS, XPath, `aria-label`, `data-testid`, text content) | AutomationId, Name, ControlType, UIA tree path |
| **Value / Input** | Typed text, selected option, URL | Typed text, selected value |
| **Screenshot** | Full page or viewport capture | Screen region around the target element |
| **Context snapshot** | DOM snippet around the interacted element | UIA subtree around the interacted element |
| **Timing** | Timestamp relative to session start | Timestamp relative to session start |

### Post-Capture Processing

- **Noise filtering**: Accidental clicks, redundant hovers, rapid back-and-forth navigations are auto-detected and flagged (not removed — the user decides).
- **Action deduplication**: Repeated scrolls collapsed, rapid repeated clicks merged.
- **Selector healing**: Multiple selector strategies captured per action so replay can fall back if the primary selector breaks.
- **Export**: Captured steps can be exported as JSON for version control, sharing, or external editing.
- **Partial re-record**: Re-record individual steps without redoing the entire sequence.

---

## Phase 2: Refine (Agent)

After recording, an AI agent analyzes the raw session and produces a refined script. Each refinement task generates suggestions the user can accept, reject, or edit.

### Refinement Tasks

#### Action Cleanup

- Remove accidental clicks, hesitation pauses, and back-and-forth navigation.
- Optimize the action path: if the user navigated Home → Settings → Back → Settings → Theme, the agent suggests just Home → Settings → Theme.
- Flag suspicious actions for human review rather than silently removing them.

#### Selector Stabilization

- Upgrade fragile selectors (e.g., `div > div:nth-child(3) > button`) to robust alternatives (`[data-testid="submit"]`, `aria-label="Submit"`).
- Uses the captured DOM/UIA context snapshots to identify better targeting strategies.
- May use the LLM to reason about which selector is most semantically stable.

#### Narrative Generation

- Draft voiceover text for each script segment based on the action sequence and screenshots.
- Tone: clear, professional, conversational — suitable for a product demo.
- _"In this step, we navigate to the Azure portal and select the resource group we created earlier."_
- Estimates word count and reading time per segment to inform timing.

#### Timing Estimation

- Suggest duration for each segment based on: narrative reading time, action execution time, and natural pauses for viewer comprehension.
- Insert appropriate wait durations between segments.
- Flag segments that feel too rushed or too slow.

#### Animation Suggestions

- Identify steps where a visual concept explainer would improve understanding.
- _"This transition between the API call and the database write could benefit from a diagram showing the data flow."_
- Generate a natural-language animation description that can be sent to the animation engine (Phase 5).

### Iterative Refinement

- The user can re-run refinement after making manual edits.
- Individual steps can be refined independently.
- The agent's suggestions are always non-destructive — the raw recorded session is preserved.

---

## Phase 3: Review & Edit

The script table is the central artifact. After recording and refinement, the user reviews and fine-tunes it.

### The Script Table

| Column | Content | Editable |
| -------- | --------- | ---------- |
| **Time** | Segment duration (e.g., `0:45`) | Yes |
| **Narrative** | Voiceover text for this segment | Yes (rich text) |
| **Demo** | Ordered list of actions to perform | Yes (action editor) |
| **Screenshot** | Reference image captured during recording | Yes (replace, crop, annotate) |

### Editing Capabilities

- **Drag-and-drop reordering** of script rows.
- **Split / merge** segments.
- **Inline action editor**: modify selectors, change target elements, adjust wait times, add/remove actions within a segment.
- **Side-by-side diff view**: raw recording vs. agent-refined version, with per-item accept/reject.
- **Preview**: dry-run a single segment's actions without recording (see the automation execute in real time).
- **Import / export**: scripts as Markdown tables or JSON for version control.
- **Manual authoring**: create script rows from scratch as an alternative to recording — the same table, just a different starting point.

---

## Phase 4: Produce (Replay + Recording)

The finalized script drives an automated replay of the demo while the user reads the voiceover.

### Automation Replay

- **Browser actions** execute via Playwright (headful mode — the user sees the real browser).
- **Native app actions** execute via Windows UI Automation.
- Actions follow the script table's sequence and timing.
- If an action fails, the **self-healing agent** inspects the current state and attempts to find the target element via alternative selectors or LLM-assisted reasoning. If it can't recover, it pauses and prompts the user.

### Recording

- **Screen capture**: Lossless video via FFmpeg (`gdigrab` → FFV1 codec in MKV container). Full desktop or a selected window/region.
- **Microphone audio**: Captured as a separate PCM/WAV track via FFmpeg (`dshow`). Clean narration — no system sounds mixed in.
- **System audio** (optional): Captured as a third separate track via Stereo Mix or virtual audio device.
- **Multi-track output**: All tracks in a single MKV, or as separate files — configurable.
- **Start/stop**: Global hotkey support for hands-free control.

### Teleprompter

- A dedicated panel displays the current segment's narrative text in large, readable font.
- Auto-advances as the automation progresses through script segments.
- Configurable scroll speed, font size, and position (dockable or floating window).
- Optional: highlights the current word/sentence for pacing guidance.

### Recording Controls

- **Pause / resume**: Pause automation and recording, adjust something, resume.
- **Retake segment**: Re-record a single segment without restarting the entire session.
- **Audio monitoring**: Real-time VU meter / waveform display for microphone input.

---

## Phase 5: Motion Animations

Generate programmatic animations for concept explanations — architecture diagrams, data flow visualizations, process illustrations.

### Workflow

1. **Describe** the concept in natural language: _"Show three microservices communicating through a message queue, with messages flowing left to right."_
2. **Generate**: The LLM produces ManimCE (Manim Community Edition) Python code that renders the described animation.
3. **Preview**: CutReady renders the animation and displays it in an inline video player. The user can iterate on the description or edit the generated code directly.
4. **Render**: Final render at project quality settings (resolution, frame rate) to a video file.
5. **Place**: The rendered animation clip is added to the script table at the appropriate position and included in the export package.

### Capabilities

- Architectural diagrams with animated transitions.
- Data flow visualizations (arrows, nodes, labels).
- Step-by-step process breakdowns.
- Math/equation animations (Manim's core strength).
- Text animations (bullet points appearing, highlighting, callouts).
- Custom animations via direct ManimCE code editing.

### Safety

- LLM-generated Python code runs in a **sandboxed environment**: restricted imports (only `manim` and standard library), AST validation before execution, resource limits (timeout, memory).
- Generated code is always shown to the user before execution.

---

## Phase 6: Export & Packaging

CutReady produces an organized, edit-ready package.

### Output Structure

```text
project-name/
├── video/
│   └── screen-recording.mkv          # Lossless FFV1 video
├── audio/
│   ├── narration.wav                  # Microphone track (PCM)
│   └── system-audio.wav              # System audio track (optional)
├── animations/
│   ├── concept-01.mp4                 # Rendered Manim animation
│   └── concept-02.mp4
├── screenshots/
│   ├── step-01.png                    # Per-segment reference screenshots
│   ├── step-02.png
│   └── ...
├── timeline.fcpxml                    # FCPXML 1.9 timeline for DaVinci Resolve
├── script.json                        # Machine-readable script with all metadata
└── script.md                          # Human-readable Markdown script table
```

### FCPXML Timeline

- **Version**: FCPXML 1.9 (compatible with DaVinci Resolve 17, 18, 19).
- **Tracks**:
  - V1: Screen recording video, split at segment boundaries.
  - A1: Narration audio, aligned to corresponding video segments.
  - A2: System audio (if captured).
  - V2: Animation clips placed at their designated script positions.
- **Markers**: At each script segment boundary for easy navigation in the Resolve timeline.
- **Asset references**: Relative paths to the media files in the output folder.

### Import into DaVinci Resolve

1. Open DaVinci Resolve.
2. File → Import → Timeline → Select `timeline.fcpxml`.
3. All clips appear on the timeline, pre-placed and aligned. Start editing.

---

## Alternative Entry Point: Manual Script Authoring

For users who prefer to plan before recording, CutReady supports creating the script table from scratch:

- Add rows manually with narrative text and demo action descriptions.
- Use the LLM to expand brief action descriptions into full `Action` sequences (e.g., _"navigate to Azure portal, create a resource group"_ → concrete browser actions with URLs and selectors).
- Attach reference screenshots manually or generate them via a dry-run.
- Proceed to Phase 4 (Produce) with the hand-authored script.

---

## Future / Stretch Goals

- **Multi-take management**: Record multiple takes per segment, compare and select the best.
- **AI-assisted editing suggestions**: Cut points, pacing improvements, B-roll recommendations.
- **Template library**: Common demo patterns (portal walkthrough, CLI demo, API call + response) as reusable script templates.
- **Collaborative editing**: Multiple users edit the same script in real time.
- **Additional NLE export**: Premiere Pro (FCPXML), CapCut, OpenTimelineIO.
- **Voice synthesis**: Generate the narration audio from the script text (for drafts / reviews before the final human recording).
- **Multi-platform**: macOS support (Tauri is cross-platform; native automation would use macOS Accessibility APIs).
