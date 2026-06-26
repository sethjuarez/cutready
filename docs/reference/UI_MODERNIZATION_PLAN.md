# CutReady UI Modernization Plan

## Goal

Modernize CutReady incrementally without changing the product model. Keep the app focused on demo production: notes, sketches, storyboards, screenshots and visuals, assistant refinement, history, and export.

The guiding principle is:

> Keep CutReady's current workflows intact. Make them feel clearer, calmer, and more modern.

Confluo's loop model is useful as a pressure test, not a blueprint. CutReady should not expose generic loop terminology or try to become a super app.

## Product framing

CutReady's durable workflow should remain:

```text
Notes -> Sketches -> Storyboards -> Refine -> Export
```

Important constraints:

- Notes can become sketches.
- Sketches can become storyboard entries.
- Multiple sketches compose a storyboard.
- Storyboards can be refined, previewed, and exported.
- Recording is a later-phase feature and should not drive near-term UI modernization.
- Keep **Sketch** and **Storyboard** as product nouns; do not rename them to generic business labels.

## What changes now

### 1. Visual shell polish

Low-risk polish across existing surfaces:

- Refine titlebar spacing, command palette affordance, and project breadcrumb.
- Calm the activity bar and sidebar active states.
- Reduce heavy borders where surfaces already separate clearly.
- Improve tab bar hierarchy and selected-tab contrast.
- Make the status bar more useful or quieter.
- Preserve existing navigation structure.

Definition of done:

- App feels less dated without changing where anything lives.
- No major behavior changes.
- Existing tests still pass.

### 2. Sidebar and asset language

Make existing concepts more readable:

- Keep Storyboards, Sketches, and Notes.
- Consider renaming **Assets** to **Screenshots & visuals** in user-facing UI.
- Add better empty states for each section.
- Show useful metadata: row count, screenshot count, used-by references, and changed state.

Definition of done:

- Business users can understand what each section is for.
- Technical file extensions remain available where useful but are not the first thing users see.

### 3. Editor header polish

Improve the top of Sketch, Storyboard, and Note editors:

- Clear title and description hierarchy.
- Keep lock, present, export, and refine actions visible.
- Rework toolbar grouping so primary actions are obvious.
- Add lightweight state language where helpful: draft, needs visual, ready to export.

Definition of done:

- The selected document tells the user what it is, what state it is in, and what they can do next.
- No actions are removed; hidden menus become clearer, not less capable.

### 4. Contextual assistant entry point

Add discoverability for the existing assistant without replacing Chat.

Recommended pattern:

```text
Ask CutReady about this [storyboard/sketch/note]

What do you want to make or improve?
[Create sketch from note]
[Refine selected sketch]
[Find storyboard gaps]
[Create missing visuals]
[Make export checklist]
```

The assistant should support two mental modes:

| Mode | Purpose |
| --- | --- |
| Ask about this | Help with the selected sketch, storyboard, note, or asset |
| Create from... | Create the next CutReady object from selected source material |

Creation rules:

| Source | Assistant can create |
| --- | --- |
| Note | Sketch |
| Screenshot or visual | Sketch row material |
| Sketch | Refined sketch or storyboard entry |
| Multiple sketches | Storyboard |
| Storyboard | Refined storyboard or export draft/checklist |

Definition of done:

- Users can ask for help from where they are.
- Chat remains available for deeper work.
- Assistant actions are contextual and concrete, not generic AI branding.

### 5. Debug and advanced surfaces

Keep these capabilities, but make them feel intentionally advanced:

- Agent runs
- Agent state database
- Terminal
- Auditaur debug
- Raw diagnostics

Definition of done:

- Core users are not exposed to debug surfaces unless they ask for them.
- Power users and development workflows retain access.

### 6. History and trust polish

Improve the Changes/History experience without changing Draftline/versioning behavior:

- Separate **save snapshot** from advanced sync/history operations visually.
- Clarify changed files and snapshot state.
- Keep diffs and history graph available.
- Make merge/conflict states feel like recovery workflows, not normal editing.

Definition of done:

- Versioning feels safer and less technical.
- No data-model or storage changes are introduced.

## What not to do yet

- Do not perform a dashboard-first redesign.
- Do not rename Sketch/Storyboard in the data model.
- Do not make Confluo loop terminology visible in CutReady.
- Do not make Recording primary navigation yet.
- Do not build a full new IA around **Runs** or **AI**.
- Do not hide existing power features before confirming replacement access.

## Suggested PR sequence

### PR 1: Visual shell polish

Scope:

- TitleBar
- Sidebar / activity bar
- TabBar
- StatusBar
- Global color and spacing adjustments

Risk: low.

### PR 2: Sidebar and editor header polish

Scope:

- StoryboardList
- AssetList labels and empty states
- SketchForm header/toolbar
- StoryboardView header/toolbar
- NoteEditor header/toolbar

Risk: medium.

### PR 3: Contextual assistant discoverability

Scope:

- Add or adapt secondary/right panel assistant entry point.
- Add quick prompts based on selected tab type.
- Route quick prompts into existing ChatPanel/appStore flows.
- Preserve full Chat as a dedicated surface.

Risk: medium-high.

### PR 4: History/debug polish

Scope:

- ChangesPanel clarity
- OutputPanel/Debug/Terminal access model
- AgentRunInspector and DatabaseViewer discoverability

Risk: medium.

## Validation checklist

- Run TypeScript check/build.
- Run Rust tests if backend-adjacent code changes.
- Run focused Vitest tests for touched components.
- Use Auditaur smoke testing for any real app validation.
- Verify key screens visually:
  - Home
  - Project with StoryboardList
  - Sketch editor
  - Storyboard editor
  - Note editor
  - Assets
  - Changes/History
  - Settings
  - Chat / assistant

## Success criteria

The modernization is working if:

- CutReady feels like a focused demo-production workspace.
- Business users can understand the workflow without learning file extensions first.
- Existing users do not lose familiar objects or actions.
- The assistant is easier to ask for help, create sketches from notes, refine sketches, find storyboard gaps, and generate visuals.
- The design feels calmer and more modern without becoming decorative or generic.
