#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  applyNudge,
  diffDocuments,
  normalizeToV2,
  summarizeDocument,
  suggestDocumentNudges,
  toRenderableV1,
  validateForAgent,
} from "@elucim/dsl";
import { formatConsoleReport, scoreVisual } from "./score-visuals.mjs";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const DEFAULT_BRIEFS = path.join(SCRIPT_DIR, "briefs.json");
const RUNS_DIR = path.join(SCRIPT_DIR, "runs");
const DEFAULT_API_VERSION = "2024-10-21";

const PROMPT_VARIANTS = {
  baseline: {
    label: "Current Designer-style baseline",
    guidance: [
      "Create a polished 16:9 Elucim player visual for the brief.",
      "Use a clear title, subtitle, and one strong center composition.",
      "Use CutReady semantic tokens only for colors.",
      "Prefer 3-5 main objects or stages.",
    ],
  },
  hero: {
    label: "Hero metaphor",
    guidance: [
      "Create one dominant hero metaphor that explains the brief at a glance.",
      "Use at most 3-4 labeled stages and avoid secondary labels.",
      "Keep the entire slide to 10-12 visible text labels when possible.",
      "Avoid repeated chips, grids, probability bars, decorative micro-marks, and large nested groups.",
      "Use large shapes and generous whitespace.",
    ],
  },
  minimal: {
    label: "Minimal slide",
    guidance: [
      "Create the simplest slide that still explains the brief.",
      "Target 20-32 flattened nodes and no more than 12 text labels.",
      "Prefer one title, one subtitle, 3 large visual objects, and 1-2 arrows.",
      "Do not include token strips, small grids, repeated chip rows, or large groups of tiny children.",
    ],
  },
};

function parseArgs(argv) {
  const options = {
    briefs: DEFAULT_BRIEFS,
    outDir: path.join(RUNS_DIR, timestamp()),
    variants: ["baseline", "hero", "minimal"],
    count: 1,
    briefIds: [],
    sketch: null,
    sketchDir: null,
    rows: [],
    rowsPerSketch: 1,
    maxSketches: Number.POSITIVE_INFINITY,
    maxBriefs: Number.POSITIVE_INFINITY,
    temperature: 0.4,
    repairRounds: 0,
    targetScore: 85,
    applyReviewNudges: false,
    listBriefs: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--briefs") {
      options.briefs = argv[++i];
    } else if (arg === "--sketch") {
      options.sketch = argv[++i];
    } else if (arg === "--sketch-dir") {
      options.sketchDir = argv[++i];
    } else if (arg === "--rows") {
      options.rows = parseRows(argv[++i]);
    } else if (arg === "--rows-per-sketch") {
      options.rowsPerSketch = Number.parseInt(argv[++i], 10);
    } else if (arg === "--max-sketches") {
      options.maxSketches = Number.parseInt(argv[++i], 10);
    } else if (arg === "--out-dir") {
      options.outDir = argv[++i];
    } else if (arg === "--variant") {
      options.variants = argv[++i].split(",").map((value) => value.trim()).filter(Boolean);
    } else if (arg === "--count") {
      options.count = Number.parseInt(argv[++i], 10);
    } else if (arg === "--brief") {
      options.briefIds.push(argv[++i]);
    } else if (arg === "--max-briefs") {
      options.maxBriefs = Number.parseInt(argv[++i], 10);
    } else if (arg === "--temperature") {
      options.temperature = Number.parseFloat(argv[++i]);
    } else if (arg === "--repair-rounds") {
      options.repairRounds = Number.parseInt(argv[++i], 10);
    } else if (arg === "--target-score") {
      options.targetScore = Number.parseInt(argv[++i], 10);
    } else if (arg === "--apply-review-nudges") {
      options.applyReviewNudges = true;
    } else if (arg === "--list-briefs") {
      options.listBriefs = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const variant of options.variants) {
    if (!PROMPT_VARIANTS[variant]) {
      throw new Error(`Unknown variant '${variant}'. Available: ${Object.keys(PROMPT_VARIANTS).join(", ")}`);
    }
  }

  return options;
}

function parseRows(value) {
  return value
    .split(",")
    .flatMap((part) => {
      const trimmed = part.trim();
      if (!trimmed) {
        return [];
      }
      const range = trimmed.match(/^(\d+)-(\d+)$/);
      if (range) {
        const start = Number.parseInt(range[1], 10);
        const end = Number.parseInt(range[2], 10);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
          throw new Error(`Invalid row range: ${trimmed}`);
        }
        return Array.from({ length: end - start + 1 }, (_, index) => start + index);
      }
      const row = Number.parseInt(trimmed, 10);
      if (!Number.isInteger(row) || row < 1) {
        throw new Error(`Invalid row number: ${trimmed}`);
      }
      return [row];
    });
}

function printHelp() {
  console.log(`Usage: npm run visual:eval -- [options]

Generate Elucim visual candidates from fixed briefs or real sketch rows, score them, and write a ranked report.

Options:
  --brief <id>              Run only a specific brief. Can be repeated.
  --max-briefs <n>          Limit number of briefs after filtering.
  --sketch <path>           Load briefs from a CutReady .sk file instead of fixed briefs.
  --sketch-dir <path>       Recursively sample .sk files from a directory.
  --rows <rows>             1-based sketch rows, comma/range syntax: 2,3,5-7.
  --rows-per-sketch <n>     Deterministic row sample per sketch when --rows is omitted. Default: 1
  --max-sketches <n>        Limit sketches loaded from --sketch-dir.
  --variant <a,b,c>         Prompt variants: ${Object.keys(PROMPT_VARIANTS).join(", ")}
  --count <n>               Candidates per brief/variant. Default: 1
  --temperature <n>         Model temperature. Default: 0.4
  --repair-rounds <n>       Optional scorer-guided repair passes for low-scoring candidates. Default: 0
  --target-score <n>        Stop repair when score reaches this value. Default: 85
  --apply-review-nudges     Include review-confidence Elucim nudges in agentic eval. Safe nudges always apply.
  --list-briefs             Print loaded briefs and exit without model calls.
  --out-dir <path>          Output run directory.
  --briefs <path>           Briefs JSON path.

Environment:
  Azure OpenAI: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_CHAT_DEPLOYMENT
  OpenAI-compatible: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function loadDotEnv(file) {
  if (!existsSync(file)) {
    return;
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const [key, ...rest] = trimmed.split("=");
    if (process.env[key]) {
      continue;
    }
    process.env[key] = rest.join("=").replace(/^['"]|['"]$/g, "");
  }
}

function getProviderConfig() {
  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_CHAT_DEPLOYMENT) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, "");
    const deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? DEFAULT_API_VERSION;
    return {
      kind: "azure_openai",
      model: deployment,
      url: `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
      headers: {
        "api-key": process.env.AZURE_OPENAI_API_KEY,
        "content-type": "application/json",
      },
    };
  }

  const apiKey = process.env.OPENAI_API_KEY || process.env.DIRECT_OPENAI_API_KEY;
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.OPENAI_MODEL;
  if (apiKey && model) {
    return {
      kind: "openai",
      model,
      url: `${baseUrl}/chat/completions`,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
    };
  }

  throw new Error("Missing model env vars. Expected Azure OpenAI or OpenAI-compatible configuration in .env.");
}

function loadBriefs(file, options) {
  if (options.sketchDir) {
    return loadSketchDirBriefs(options.sketchDir, options);
  }

  if (options.sketch) {
    return loadSketchBriefs(options.sketch, options);
  }

  const allBriefs = JSON.parse(readFileSync(file, "utf8"));
  const filtered = options.briefIds.length > 0
    ? allBriefs.filter((brief) => options.briefIds.includes(brief.id))
    : allBriefs;

  const unknown = options.briefIds.filter((id) => !allBriefs.some((brief) => brief.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown brief id(s): ${unknown.join(", ")}`);
  }

  return filtered.slice(0, options.maxBriefs);
}

function loadSketchDirBriefs(dir, options) {
  const sketches = collectSketchFiles(dir)
    .slice(0, options.maxSketches);
  if (sketches.length === 0) {
    throw new Error(`No .sk files found under: ${dir}`);
  }

  const briefs = [];
  for (const sketch of sketches) {
    briefs.push(...loadSketchBriefs(sketch, options));
    if (briefs.length >= options.maxBriefs) {
      break;
    }
  }
  return briefs.slice(0, options.maxBriefs);
}

function collectSketchFiles(dir) {
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !existsSync(current)) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".sk")) {
        results.push(full);
      }
    }
  }
  return results.sort((a, b) => {
    const byMtime = statSync(b).mtimeMs - statSync(a).mtimeMs;
    return byMtime || a.localeCompare(b);
  });
}

function loadSketchBriefs(file, options) {
  const sketch = JSON.parse(readFileSync(file, "utf8"));
  const rows = Array.isArray(sketch.rows) ? sketch.rows : [];
  if (rows.length === 0) {
    throw new Error(`Sketch has no rows: ${file}`);
  }

  const requestedRows = options.rows.length > 0
    ? options.rows
    : sampleRows(rows, options.rowsPerSketch);
  const invalidRows = requestedRows.filter((rowNumber) => rowNumber < 1 || rowNumber > rows.length);
  if (invalidRows.length > 0) {
    throw new Error(`Sketch row(s) out of range for ${file}: ${invalidRows.join(", ")}. Valid rows: 1-${rows.length}`);
  }

  const flow = rows
    .map((row, index) => `${index + 1}. ${compact(row.narrative)} / ${compact(row.demo_actions)}`)
    .join("\n");
  const sketchTitle = sketch.title ?? path.basename(file, path.extname(file));
  const sketchDescription = typeof sketch.description === "string"
    ? sketch.description
    : sketch.description == null
      ? ""
      : JSON.stringify(sketch.description);

  return requestedRows
    .map((rowNumber) => {
      const rowIndex = rowNumber - 1;
      const row = rows[rowIndex];
      const previous = rows[rowIndex - 1];
      const next = rows[rowIndex + 1];
      return {
        id: `${slugify(path.basename(file, path.extname(file)))}-row-${rowNumber}`,
        title: `${sketchTitle} - row ${rowNumber}`,
        brief: `Create a polished CutReady framing visual for the selected sketch row. The visual must support the row narrative and demo actions, not a generic concept diagram.`,
        sourceSketch: file,
        rowNumber,
        rowIndex,
        narrative: row.narrative ?? "",
        demoActions: row.demo_actions ?? "",
        screenshot: row.screenshot ?? null,
        existingDesignPlan: row.design_plan ?? null,
        previousRow: previous
          ? { narrative: previous.narrative ?? "", demoActions: previous.demo_actions ?? "" }
          : null,
        nextRow: next
          ? { narrative: next.narrative ?? "", demoActions: next.demo_actions ?? "" }
          : null,
        rowContext: [
          `Sketch title: ${sketchTitle}`,
          sketchDescription ? `Sketch description: ${sketchDescription}` : null,
          `Target row number: ${rowNumber}`,
          `Target row index: ${rowIndex}`,
          `Target row narrative: ${row.narrative ?? ""}`,
          `Target row demo actions: ${row.demo_actions ?? ""}`,
          `Existing screenshot: ${row.screenshot ?? "none"}`,
          `Existing design plan: ${row.design_plan ?? "none"}`,
          `Previous row: ${previous ? `narrative="${compact(previous.narrative)}" actions="${compact(previous.demo_actions)}"` : "none"}`,
          `Next row: ${next ? `narrative="${compact(next.narrative)}" actions="${compact(next.demo_actions)}"` : "none"}`,
          `Sketch high-level flow:\n${flow}`,
        ].filter(Boolean).join("\n"),
      };
    })
    .slice(0, options.maxBriefs);
}

function sampleRows(rows, count) {
  const candidates = rows
    .map((row, index) => ({ row, rowNumber: index + 1 }))
    .filter(({ row }) => compact(row.narrative).length > 0 || compact(row.demo_actions).length > 0);
  if (candidates.length === 0) {
    return rows.map((_, index) => index + 1).slice(0, count);
  }
  if (count >= candidates.length) {
    return candidates.map(({ rowNumber }) => rowNumber);
  }
  if (count <= 1) {
    return [candidates[Math.floor((candidates.length - 1) / 2)].rowNumber];
  }

  const picked = new Set();
  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (candidates.length - 1)) / (count - 1));
    picked.add(candidates[index].rowNumber);
  }
  return [...picked].sort((a, b) => a - b);
}

function compact(value, max = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "sketch";
}

function buildMessages(brief, variantName) {
  const variant = PROMPT_VARIANTS[variantName];
  const system = `You are evaluating CutReady Designer prompt quality. Generate exactly one valid Elucim DSL v2 JSON document and no markdown.

Canvas and schema:
- Root document: { "version": "2.0", "scene": { "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 90, "background": "$background", "children": ["title", "hero"] }, "elements": { "title": { "id": "title", "type": "text", "props": { ... } } } }
- Scene children are top-level element IDs. Elements are keyed by stable semantic IDs like title, subtitle, hero, step-1, and step-2.
- Each element is { "id": "...", "type": "...", "parentId"?: "...", "children"?: ["..."], "layout"?: {}, "props": { ...render fields... } }.
- Put render fields in props. Text elements use props.content for real visible copy and props.fill for color. Never use text or color.
- Rect elements use props.rx for rounded corners. Never use radius.
- Animation fields in props are numbers only: "fadeIn": 4, "draw": 20, or "fadeOut": 80. Never use animation objects.

Presentation polish rules:
- Use $background for scene background, "$title" as the fill color for the main title, and "$subtitle" as the fill color for the subtitle.
- Do not write "$title" or "$subtitle" as visible text content. Use actual slide copy.
- Use $foreground, $muted, $surface, $border, $accent, $secondary, $tertiary, $success, $warning, $error for all colors.
- Do not use hardcoded hex/rgb/rgba colors.
- Do not add a full-canvas background rect or inner slide card.
- Avoid repeated small marks, chip rows, token strips, tiny grids, and crowded labels.
- Keep text inside the safe area and avoid overlap.
- Prefer a slide someone would present, not a dense technical worksheet.
- Score-aware targets: 20-32 flattened nodes, 12-14 or fewer text labels, 18px minimum readable text, 4 or fewer arrows, no chip-like token strips, and one dominant hero object/metaphor.
- Copy budget: title + subtitle + at most 3-4 short stage labels. Avoid explanatory sentences, duplicate labels, axis labels, legends, and captions unless essential to the row.
- Group nodes are only for moving 2-5 related elements together. Avoid groups with many children or deep nested groups; place simple top-level nodes directly when possible.
- Prefer abstract hero metaphors over literal end-to-end architecture or probability worksheets unless the row explicitly requires those details.

Variant: ${variant.label}
${variant.guidance.map((line) => `- ${line}`).join("\n")}`;

  const user = `Brief id: ${brief.id}
Title: ${brief.title}
Brief: ${brief.brief}
${brief.rowContext ? `
Required row context:
${brief.rowContext}

Grounding requirement:
- The visual must be specific to the target row narrative and demo actions.
- Use the previous/next row only to create continuity, not to change the target.
- If the existing design plan conflicts with the row narrative/actions, improve it instead of following it blindly.
` : ""}

Return only the JSON document.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function buildRepairMessages(brief, variantName, visual, score, round) {
  const findings = score.findings
    .slice(0, 8)
    .map((finding) => `- ${finding.code}: ${finding.message}`)
    .join("\n");
  const metrics = [
    `flattened nodes: ${score.metrics.flattenedNodeCount}`,
    `text labels: ${score.metrics.textCount}`,
    `rects: ${score.metrics.rectCount}`,
    `arrows: ${score.metrics.arrowCount}`,
    `groups: ${score.metrics.groupCount}`,
  ].join(", ");

  const messages = buildMessages(brief, variantName);
  return [
    ...messages,
    {
      role: "assistant",
      content: JSON.stringify(visual),
    },
    {
      role: "user",
    content: `Repair round ${round}: improve this visual using the scorer feedback below. Keep the same row-specific meaning and CutReady DSL v2 schema. Return only the full replacement JSON document.

Current score: ${score.score}
Current metrics: ${metrics}
Findings to address:
${findings || "- No specific findings, improve presentation polish without adding detail."}

General repair priorities:
1. Preserve the target row narrative and demo actions.
2. Reduce density before adding anything: remove labels, repeated chips, extra arrows, decorative primitives, and nested decorative groups.
3. Use $title and $subtitle for title hierarchy.
4. Create one larger hero object/metaphor plus at most 3-4 labeled stages.
5. Cut copy to title + subtitle + 3-4 short labels. Merge or delete captions, legends, axis labels, and duplicate labels first.
6. Keep readable text at 18px or larger and avoid small labels.
7. Flatten unnecessary groups: keep groups only when a small related cluster needs shared positioning or animation.
8. Do not over-optimize for this one score if it would make the visual less meaningful.`,
    },
  ];
}

async function callModel(provider, messages, options) {
  const body = {
    model: provider.kind === "openai" ? provider.model : undefined,
    messages,
    temperature: options.temperature,
    response_format: { type: "json_object" },
  };

  if (body.model === undefined) {
    delete body.model;
  }

  const response = await fetch(provider.url, {
    method: "POST",
    headers: provider.headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Model request failed (${response.status}): ${redact(text).slice(0, 1000)}`);
  }

  const payload = JSON.parse(text);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Model response did not include message content: ${redact(text).slice(0, 1000)}`);
  }
  return content;
}

function redact(value) {
  return value
    .replaceAll(process.env.AZURE_OPENAI_API_KEY ?? "__NO_AZURE_KEY__", "[redacted]")
    .replaceAll(process.env.OPENAI_API_KEY ?? "__NO_OPENAI_KEY__", "[redacted]")
    .replaceAll(process.env.DIRECT_OPENAI_API_KEY ?? "__NO_DIRECT_KEY__", "[redacted]");
}

function parseVisual(content) {
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(trimmed);
  const normalized = normalizeToV2(parsed);
  const validation = validateForAgent(normalized.document);
  if (!validation.valid) {
    const hints = validation.repairHints?.length > 0
      ? ` Repair hints: ${validation.repairHints.join("; ")}`
      : "";
    throw new Error(`Generated JSON is not a valid Elucim v2 agent document: ${validation.errors.join("; ")}.${hints}`);
  }
  toRenderableV1(normalized.document);
  return normalized.document;
}

function evaluateAgenticDocument(visual, options) {
  const normalized = normalizeToV2(visual);
  let current = normalized.document;
  const initialValidation = validateForAgent(current);
  const result = {
    inputFormat: normalized.inputFormat,
    migrated: normalized.migrated,
    warnings: normalized.warnings,
    validInitial: initialValidation.valid,
    validFinal: false,
    validationErrors: initialValidation.errors ?? [],
    repairHints: initialValidation.repairHints ?? [],
    nudgeCount: 0,
    appliedNudges: [],
    diffCount: 0,
    elementCount: 0,
    timelineCount: 0,
    stateMachineCount: 0,
    renderable: false,
  };

  if (!initialValidation.valid) {
    return result;
  }

  const nudges = suggestDocumentNudges(current);
  result.nudgeCount = nudges.length;
  const selectedNudges = nudges.filter((nudge) => nudge.confidence === "safe" || options.applyReviewNudges);
  for (const nudge of selectedNudges) {
    const before = current;
    const nudgeResult = applyNudge(current, nudge);
    current = nudgeResult.document;
    const patch = diffDocuments(before, current);
    result.appliedNudges.push({
      id: nudge.id,
      confidence: nudge.confidence,
      diffCount: patch.length,
      summaries: nudgeResult.summaries,
    });
    result.diffCount += patch.length;
  }

  const finalValidation = validateForAgent(current);
  result.validFinal = finalValidation.valid;
  result.validationErrors = finalValidation.errors ?? [];
  result.repairHints = finalValidation.repairHints ?? [];
  if (finalValidation.valid) {
    const summary = summarizeDocument(current);
    result.elementCount = summary.elementCount;
    result.timelineCount = summary.timelines.length;
    result.stateMachineCount = summary.stateMachines.length;
    toRenderableV1(current);
    result.renderable = true;
  }
  return result;
}

async function main() {
  loadDotEnv(path.join(process.cwd(), ".env"));
  const options = parseArgs(process.argv.slice(2));
  const briefs = loadBriefs(options.briefs, options);

  if (options.listBriefs) {
    for (const brief of briefs) {
      console.log(`${brief.id}\t${brief.sourceSketch ?? "fixed-brief"}\trow ${brief.rowNumber ?? "-"}\t${brief.title}`);
    }
    return;
  }

  const provider = getProviderConfig();

  mkdirSync(options.outDir, { recursive: true });
  const candidateDir = path.join(options.outDir, "candidates");
  mkdirSync(candidateDir, { recursive: true });

  console.log(`Visual eval run`);
  console.log(`Provider: ${provider.kind}`);
  console.log(`Model/deployment: ${provider.model}`);
  console.log(`Briefs: ${briefs.map((brief) => brief.id).join(", ")}`);
  console.log(`Variants: ${options.variants.join(", ")}`);
  console.log(`Count: ${options.count}`);
  console.log(`Repair rounds: ${options.repairRounds}`);
  console.log("");

  const results = [];
  const errors = [];

  for (const brief of briefs) {
    for (const variant of options.variants) {
      for (let index = 0; index < options.count; index += 1) {
        const id = `${brief.id}__${variant}__${index + 1}`;
        const file = path.join(candidateDir, `${id}.json`);
        process.stdout.write(`Generating ${id}... `);
        try {
          const content = await callModel(provider, buildMessages(brief, variant), options);
          let bestVisual = parseVisual(content);
          writeFileSync(file, `${JSON.stringify(bestVisual, null, 2)}\n`, "utf8");
          let bestScore = scoreVisual(file);
          let bestAgentic = evaluateAgenticDocument(bestVisual, options);
          const attempts = [{
            round: 0,
            file,
            score: bestScore.score,
            rating: bestScore.rating,
            findings: bestScore.findings.map((finding) => finding.code),
            agentic: bestAgentic,
          }];

          for (let round = 1; round <= options.repairRounds && bestScore.score < options.targetScore; round += 1) {
            process.stdout.write(`repair ${round}... `);
            const repairContent = await callModel(
              provider,
              buildRepairMessages(brief, variant, bestVisual, bestScore, round),
              { ...options, temperature: Math.min(options.temperature, 0.2) },
            );
            const repairedVisual = parseVisual(repairContent);
            const repairFile = path.join(candidateDir, `${id}__repair${round}.json`);
            writeFileSync(repairFile, `${JSON.stringify(repairedVisual, null, 2)}\n`, "utf8");
            const repairedScore = scoreVisual(repairFile);
            const repairedAgentic = evaluateAgenticDocument(repairedVisual, options);
            attempts.push({
              round,
              file: repairFile,
              score: repairedScore.score,
              rating: repairedScore.rating,
              findings: repairedScore.findings.map((finding) => finding.code),
              agentic: repairedAgentic,
            });
            if (repairedScore.score >= bestScore.score) {
              bestVisual = repairedVisual;
              bestScore = repairedScore;
              bestAgentic = repairedAgentic;
            }
          }

          results.push({
            ...bestScore,
            briefId: brief.id,
            variant,
            sourceSketch: brief.sourceSketch,
            rowNumber: brief.rowNumber,
            rowIndex: brief.rowIndex,
            narrative: brief.narrative,
            demoActions: brief.demoActions,
            agentic: bestAgentic,
            attempts,
          });
          console.log(`score ${bestScore.score}, nudges ${bestAgentic.nudgeCount}, renderable ${bestAgentic.renderable ? "yes" : "no"}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push({ id, briefId: brief.id, variant, message });
          console.log(`error: ${message}`);
        }
      }
    }
  }

  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const variantSummary = summarizeBy(results, "variant");
  const briefSummary = summarizeBy(results, "briefId");
  const report = {
    generatedAt: new Date().toISOString(),
    provider: provider.kind,
    model: provider.model,
    options: {
      briefs: briefs.map((brief) => brief.id),
      sketch: options.sketch,
      sketchDir: options.sketchDir,
      rows: options.rows,
      rowsPerSketch: options.rowsPerSketch,
      maxSketches: options.maxSketches,
      variants: options.variants,
      count: options.count,
      temperature: options.temperature,
      repairRounds: options.repairRounds,
      targetScore: options.targetScore,
      applyReviewNudges: options.applyReviewNudges,
    },
    summary: {
      generated: results.length,
      errors: errors.length,
      averageScore: results.length > 0 ? results.reduce((sum, result) => sum + result.score, 0) / results.length : 0,
      bestScore: results[0]?.score ?? null,
      renderable: results.filter((result) => result.agentic?.renderable).length,
      averageNudgeCount: results.length > 0 ? results.reduce((sum, result) => sum + (result.agentic?.nudgeCount ?? 0), 0) / results.length : 0,
    },
    variantSummary,
    briefSummary,
    results,
    errors,
  };

  const reportFile = path.join(options.outDir, "report.json");
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("");
  console.log("Variant summary:");
  for (const item of variantSummary) {
    console.log(`  ${item.key}: avg ${item.averageScore.toFixed(1)}, best ${item.bestScore}, worst ${item.worstScore}, count ${item.count}`);
  }
  console.log("");
  console.log(formatConsoleReport(results, candidateDir));
  if (errors.length > 0) {
    console.log("");
    console.log("Generation errors:");
    for (const error of errors) {
      console.log(`  ${error.id}: ${error.message}`);
    }
  }
  console.log("");
  console.log(`Wrote ${reportFile}`);
}

function summarizeBy(results, key) {
  const groups = new Map();
  for (const result of results) {
    const value = result[key] ?? "unknown";
    const group = groups.get(value) ?? [];
    group.push(result);
    groups.set(value, group);
  }

  return [...groups.entries()]
    .map(([value, group]) => {
      const scores = group.map((result) => result.score);
      return {
        key: value,
        count: group.length,
        averageScore: scores.reduce((sum, score) => sum + score, 0) / scores.length,
        bestScore: Math.max(...scores),
        worstScore: Math.min(...scores),
      };
    })
    .sort((a, b) => b.averageScore - a.averageScore || a.key.localeCompare(b.key));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
