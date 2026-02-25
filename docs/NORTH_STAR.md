# CutReady: From Script to Screen in One Click

> _The press release — written from the future, looking back._

---

## FOR IMMEDIATE RELEASE

**CutReady eliminates the chaos of producing product demo videos. Record your demo once — roughly, imperfectly — and let an AI agent turn it into a production-ready recording package.**

---

### The Problem

Producing a polished product demo video is a multi-day ordeal. You write a script in one tool, manually walk through the demo while screen-recording in another (inevitably fumbling a click or losing your place in the narrative), re-record the voiceover separately because the first take had background noise, then spend hours in a video editor stitching it all together. When the product UI changes a week later, you start over.

Developer advocates, product managers, and technical marketers face this cycle constantly. The tools exist — screen recorders, video editors, teleprompters — but they don't talk to each other, and none of them understand what you're actually trying to demonstrate.

The result: people who should be spending their time crafting great explanations are instead debugging OBS settings and re-recording the same 3-minute demo for the fifth time because they forgot to click the right button at the 2:17 mark.

### The Solution

**CutReady** is a desktop application that collapses the entire demo video production process into a single, intelligent workflow:

1. **Sketch** — Plan your demo in a Notion-style block editor. Structure it with titled sections and 4-column planning tables (Time, Narrative Bullets, Demo Actions, Screenshots). Capture reference screenshots directly from a browser. Every edit is versioned — browse history, compare versions, restore any previous state.

2. **Record** — Walk through the demo yourself in a browser or native Windows app, guided by your sketch. CutReady watches every click, navigation, and keystroke, capturing them as a replayable action sequence with automatic screenshots at each step. Your sketch rows are enriched with real captured data.

3. **Refine** — An AI agent analyzes your raw recording and makes it production-ready: cleaning up accidental clicks, stabilizing element selectors for reliable replay, drafting voiceover narration for each segment, estimating natural timing, and even suggesting motion animations for concept explanations.

4. **Review & Adjust** — See a side-by-side view of your raw recording versus the agent's refined version. Accept, tweak, or re-record individual steps. The script table — with columns for Time, Narrative, Demo Actions, and Screenshots — is always fully editable.

5. **Produce** — Hit Play. The automation replays the polished demo while you read the refined script from CutReady's built-in teleprompter. Lossless video and clean narration audio are captured as separate tracks. The output is an organized package with an FCPXML timeline, ready to import directly into DaVinci Resolve with clips pre-placed on your editing timeline.

CutReady doesn't ask you to become a scriptwriter or an automation engineer. Just do the demo once and let the agent handle the rest.

### Key Differentiators

- **Sketch-first planning.** Start with a structured plan: a Notion-style editor with planning tables, reference screenshots, and automatic version history. The sketch guides your recording and evolves into the final script.

- **Record-first workflow.** Or, jump straight into recording without any planning. The script is an output of recording + AI refinement, not just an input. Both paths converge on the same production pipeline.

- **Agentic refinement.** The AI doesn't just transcribe what you did. It cleans, stabilizes, narrates, times, and suggests — turning a rough walkthrough into a production-ready script with a single refinement pass.

- **Self-healing replay.** When a replayed action fails because the UI changed, the agent inspects the current page state, finds the most likely matching element, and suggests a fix — or auto-retries with an alternative selector strategy.

- **Edit-ready output.** Not just raw footage. An FCPXML timeline with video, narration audio, system audio, and animation clips on separate tracks, with markers at each script segment boundary. Import into DaVinci Resolve and start editing immediately.

- **Motion animations from natural language.** Describe a concept ("show data flowing from the API gateway to three microservices") and the AI generates a Manim animation, rendered to video and placed on your timeline.

- **Browser and native app support.** Playwright-driven browser automation and Windows UI Automation in the same script, seamlessly interleaved.

### Customer Quote

> _"I used to spend three days producing a five-minute demo video. Most of that time was re-recording because I clicked the wrong thing, or re-doing the voiceover because of background noise. With CutReady, I sketched the demo plan first — sections, talking points, the key actions — then recorded it guided by the sketch. The agent cleaned everything up, the replay was perfect, I read the script from the teleprompter, and I had a Resolve-ready package in under an hour. Now I spend my time on creative editing, not reshooting."_
>
> — Internal beta user

### How to Get Started

1. Install CutReady on Windows.
2. Click **New Project** and then **New Document** to start a sketch.
3. Plan your demo with sections, planning tables, and reference screenshots.
4. Click **Record from Sketch** — walk through the demo guided by your plan.
5. Click **Refine** and review the agent's suggestions.
6. Click **Produce** to replay the polished demo while reading the teleprompter.
7. Open the exported FCPXML in DaVinci Resolve. Your clips are already on the timeline.

### What This Is Not

- CutReady is **not a video editor**. It produces the raw materials — perfectly — so you can focus your editing time on creativity, not correction.
- CutReady is **not a testing framework**. While it shares DNA with browser automation tools, its purpose is producing demo videos, not validating software.
- CutReady is **not a slide deck tool**. It automates live product demos with real interactions, not static screenshots.

---

_CutReady: Stop re-recording. Start producing._
