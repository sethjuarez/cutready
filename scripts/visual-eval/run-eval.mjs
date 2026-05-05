#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
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
      "Use at most 4 labeled stages and avoid secondary labels.",
      "Avoid repeated chips, grids, probability bars, or decorative micro-marks.",
      "Use large shapes and generous whitespace.",
    ],
  },
  minimal: {
    label: "Minimal slide",
    guidance: [
      "Create the simplest slide that still explains the brief.",
      "Target 20-35 flattened nodes and no more than 14 text labels.",
      "Prefer one title, one subtitle, 3 large visual objects, and 1-2 arrows.",
      "Do not include token strips, small grids, or repeated chip rows.",
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
    maxBriefs: Number.POSITIVE_INFINITY,
    temperature: 0.4,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--briefs") {
      options.briefs = argv[++i];
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

function printHelp() {
  console.log(`Usage: npm run visual:eval -- [options]

Generate Elucim visual candidates from fixed briefs, score them, and write a ranked report.

Options:
  --brief <id>              Run only a specific brief. Can be repeated.
  --max-briefs <n>          Limit number of briefs after filtering.
  --variant <a,b,c>         Prompt variants: ${Object.keys(PROMPT_VARIANTS).join(", ")}
  --count <n>               Candidates per brief/variant. Default: 1
  --temperature <n>         Model temperature. Default: 0.4
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

function buildMessages(brief, variantName) {
  const variant = PROMPT_VARIANTS[variantName];
  const system = `You are evaluating CutReady Designer prompt quality. Generate exactly one valid Elucim DSL JSON document and no markdown.

Canvas and schema:
- Root document: { "version": "1.0", "root": { "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 90, "background": "$background", "children": [...] } }
- Supported nodes: text, rect, circle, line, arrow, group, polygon.
- Text nodes use "content" for real visible copy and "fill" for color. Never use "text" or "color".
- Rect nodes use "rx" for rounded corners. Never use "radius".
- Animation fields are numbers only: "fadeIn": 4, "draw": 20, or "fadeOut": 80. Never use animation objects.

Presentation polish rules:
- Use $background for root background, "$title" as the fill color for the main title, and "$subtitle" as the fill color for the subtitle.
- Do not write "$title" or "$subtitle" as visible text content. Use actual slide copy.
- Use $foreground, $muted, $surface, $border, $accent, $secondary, $tertiary, $success, $warning, $error for all colors.
- Do not use hardcoded hex/rgb/rgba colors.
- Do not add a full-canvas background rect or inner slide card.
- Avoid repeated small marks, chip rows, token strips, tiny grids, and crowded labels.
- Keep text inside the safe area and avoid overlap.
- Prefer a slide someone would present, not a dense technical worksheet.

Variant: ${variant.label}
${variant.guidance.map((line) => `- ${line}`).join("\n")}`;

  const user = `Brief id: ${brief.id}
Title: ${brief.title}
Brief: ${brief.brief}

Return only the JSON document.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
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
  const visual = JSON.parse(trimmed);
  if (!visual.root || !Array.isArray(visual.root.children)) {
    throw new Error("Generated JSON is not an Elucim document with root.children.");
  }
  return visual;
}

async function main() {
  loadDotEnv(path.join(process.cwd(), ".env"));
  const options = parseArgs(process.argv.slice(2));
  const provider = getProviderConfig();
  const briefs = loadBriefs(options.briefs, options);

  mkdirSync(options.outDir, { recursive: true });
  const candidateDir = path.join(options.outDir, "candidates");
  mkdirSync(candidateDir, { recursive: true });

  console.log(`Visual eval run`);
  console.log(`Provider: ${provider.kind}`);
  console.log(`Model/deployment: ${provider.model}`);
  console.log(`Briefs: ${briefs.map((brief) => brief.id).join(", ")}`);
  console.log(`Variants: ${options.variants.join(", ")}`);
  console.log(`Count: ${options.count}`);
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
          const visual = parseVisual(content);
          writeFileSync(file, `${JSON.stringify(visual, null, 2)}\n`, "utf8");
          const score = scoreVisual(file);
          results.push({ ...score, briefId: brief.id, variant });
          console.log(`score ${score.score}`);
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
      variants: options.variants,
      count: options.count,
      temperature: options.temperature,
    },
    summary: {
      generated: results.length,
      errors: errors.length,
      averageScore: results.length > 0 ? results.reduce((sum, result) => sum + result.score, 0) / results.length : 0,
      bestScore: results[0]?.score ?? null,
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
