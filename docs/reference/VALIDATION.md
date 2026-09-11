# Validation

CutReady has two validation lanes: deterministic scorer drills for automation and human-gated app drills for flows that need judgment or credentials.

## Deterministic Auditaur scorer drills

Run all deterministic scorers locally:

```bash
npm run auditaur:score
```

The aggregate command runs:

| Scorer | Default fixture input | Report |
| --- | --- | --- |
| `score-visuals` | `docs/examples/cutready-demo-project/.cutready/visuals` | `target/auditaur-scorers/visuals.json` |
| `score-copy` | `docs/examples/cutready-demo-project` | `target/auditaur-scorers/copy.json` |
| `score-instructions` | `scripts/agent-eval/instruction-cases.json` | `target/auditaur-scorers/instructions.json` |

Each scorer can still be run directly with an explicit input:

```bash
npm run visual:score -- docs/examples/cutready-demo-project/.cutready/visuals
npm run agent:score-copy -- docs/examples/cutready-demo-project
npm run agent:score-instructions -- scripts/agent-eval/instruction-cases.json
```

The `Auditaur scorers` GitHub Actions workflow runs these deterministic checks on pull requests and pushes to `main`.

The workflow is currently a scorer health gate: it fails when a scorer crashes or fixture inputs disappear. Score threshold enforcement should be added only after the fixture expectations are explicit, so a green workflow does not imply subjective quality approval.

## Human-gated drills

Keep OAuth device flow, subjective visual review, and any taste/perception acceptance criteria out of the deterministic scorer workflow. Those belong in manual Auditaur drills or app click-through sessions where a person can approve the credential or judgment step.
