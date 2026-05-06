# Elucim Visuals: CutReady Follow-up Work

This note captures CutReady-specific follow-up ideas from the Elucim visual polish work. The goal is to keep CutReady's AI-generated Elucim visuals moving toward polished, presentation-grade slide replacements without mixing that work into the Elucim library roadmap.

## Current state

- CutReady can render Elucim visuals in sketch rows.
- CutReady now maps Elucim presentation tokens such as `$title`, `$subtitle`, `$accent`, `$secondary`, `$surface`, and `$border`.
- The Designer agent guidance now prefers branded semantic tokens, valid Elucim DSL fields, hero-style compositions, and lower visual density.
- `set_row_visual` now validates and critiques generated DSL before saving.
- A dev-only visual eval harness exists under `scripts/visual-eval/`.

Useful commands:

```powershell
npm run visual:score -- D:\cutready\ndc-toronto-26\session\.cutready\visuals --limit 8
npm run visual:eval -- --max-briefs 3 --variant baseline,hero,minimal --count 1 --temperature 0.25
```

Generated eval artifacts are intentionally ignored:

```text
scripts/visual-eval/reports/
scripts/visual-eval/runs/
```

## What the eval loop showed

The targeted eval loop showed that the **hero** prompt variant is currently the strongest direction. It tends to produce cleaner slide-like visuals than prompts that encourage literal technical detail.

The most common remaining quality issues are:

- Too much grouped complexity.
- Too many small labels.
- Too many repeated small marks, chips, grids, or token strips.
- Too many arrows in architecture-style flows.
- Occasional schema drift when prompts are not explicit enough.

The most important prompt lesson is:

> Prefer one dominant hero metaphor plus 3-4 labeled stages over literal micro-detail.

## Recommended CutReady next steps

### 1. Move built-in agent prompts out of `ChatPanel.tsx`

The built-in Writer, Editor, and Designer prompts currently live inside the chat UI component. That makes prompt iteration harder and couples UI rendering to agent behavior.

Suggested target:

```text
src/agents/builtInAgents.ts
```

or:

```text
src/lib/agents/builtInAgents.ts
```

`ChatPanel.tsx` should import the agent definitions instead of owning them.

### 2. Make Designer row context automatic

CutReady currently passes the active sketch path into the system prompt, and the Designer prompt tells the agent to call `read_sketch`. That gives the model access to all rows, but only if it follows the instruction.

Improve this by injecting row-specific context whenever a visual is requested for a row:

- target row index
- target row narrative
- target row demo actions
- existing screenshot path, if any
- existing design plan, if any
- previous row narrative/actions
- next row narrative/actions
- sketch title and high-level flow

This should make visuals feel more connected to the actual demo story instead of generic concept diagrams.

### 3. Make `design_plan` echo row context

`design_plan` should return the saved plan plus the row context it was created for. That gives the agent a second chance to notice if the plan is disconnected from the row.

Example response shape:

```text
Design plan saved for row 4.

Row context:
- Narrative: ...
- Demo actions: ...
- Previous row: ...
- Next row: ...

Now generate DSL JSON based on this plan.
```

### 4. Add real sketch rows to visual eval

The current eval harness uses generic briefs. The next version should optionally load real `.sk` files and generate eval briefs from actual rows.

Suggested command shape:

```powershell
npm run visual:eval -- --sketch D:\cutready\ndc-toronto-26\session\some-sketch.sk --rows 2,3,4 --variant hero,minimal --count 2
```

Each generated candidate should include:

- source sketch path
- row index
- row narrative/actions
- prompt variant
- score
- findings

### 5. Render screenshot reports

Scoring is useful, but a side-by-side screenshot report will catch aesthetics that heuristics miss.

Suggested output:

```text
scripts/visual-eval/runs/<timestamp>/
  report.json
  index.html
  candidates/
    inference-pipeline__hero__1.json
    inference-pipeline__hero__1.png
```

The HTML report should sort by score and show:

- rendered image
- score
- findings
- prompt variant
- node/text metrics

### 6. Tighten critique around repeated marks

The current scorer detects repeated small marks and chip rows. The backend `set_row_visual` critique should eventually reject obvious repeated-mark anti-patterns, not just score them in eval.

Candidate critique codes:

- `REPEATED_SMALL_MARKS`
- `REPEATED_CHIP_ROW`
- `TOO_MANY_ARROWS`
- `NO_HERO_OBJECT`

Keep the blocker thresholds conservative so useful data charts are not accidentally rejected.

### 7. Promote the hero variant into the Designer default

The eval loop showed hero-style guidance is strongest. The Designer prompt should continue moving toward:

- one dominant visual metaphor
- 3-4 labeled stages
- fewer arrows
- fewer small labels
- no token strips unless the row is specifically about tokenization
- no probability worksheets unless the row specifically requires probabilities

### 8. Consider model/prompt regression tracking

The eval harness should keep enough metadata to compare prompt/model changes over time:

- model/deployment
- prompt variant
- temperature
- brief or row source
- generated timestamp
- score
- findings

This would let CutReady track whether prompt changes actually improve average visual quality.

## What should stay in Elucim

Elucim should remain the rendering and DSL foundation:

- stable theme tokens
- presentation-grade primitives
- deterministic renderer behavior
- schema validation
- reusable layout/render helpers
- docs for public visual APIs

CutReady should own:

- Designer prompts
- row-aware context injection
- visual eval prompts and reports
- model-specific prompt tuning
- CutReady-specific critique thresholds

