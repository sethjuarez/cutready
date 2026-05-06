#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const REPORT_DIR = path.join(process.cwd(), "scripts", "agent-eval", "reports");
const DEFAULT_TARGET = "D:\\cutready";

const ARTIFACT_PATTERNS = [
  { code: "DASH_ARTIFACT", points: 10, pattern: /[—–]/g, message: "uses em/en dash; use plain punctuation" },
  { code: "SMART_QUOTES", points: 4, pattern: /[“”]/g, message: "uses smart quotes" },
  { code: "GENERIC_POWER_WORD", points: 6, pattern: /\b(powerful|seamless(?:ly)?|robust|innovative|cutting-edge|game-changing|transformative|rich|frictionless)\b/gi, message: "generic AI-marketing adjective" },
  { code: "HYPE_VERB", points: 6, pattern: /\b(unlock|unleash|elevate|revolutionize|supercharge|empower|streamline|leverage|harness|optimize)\b/gi, message: "hype verb that can sound synthetic" },
  { code: "AI_CLICHE", points: 12, pattern: /\b(in today'?s (?:fast-paced|digital|ever-changing) world|delve into|dive into|at the end of the day|it'?s important to note|not just .* but|more than just|whether you'?re .* or)\b/gi, message: "common LLM-style phrase" },
  { code: "VAGUE_SPEED_CLAIM", points: 5, pattern: /\b(in seconds|in minutes|instantly|with ease|without friction)\b/gi, message: "vague speed/ease claim" },
];

const ABSTRACT_NOUN_RE = /\b(experience|workflow|solution|capability|productivity|efficiency|innovation|insights|platform|ecosystem)\b/gi;

function parseArgs(argv) {
  const options = {
    target: DEFAULT_TARGET,
    out: path.join(REPORT_DIR, "copy-report.json"),
    json: false,
    limit: Number.POSITIVE_INFINITY,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      options.out = argv[++i];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--limit") {
      options.limit = Number.parseInt(argv[++i], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("--")) {
      options.target = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run agent:score-copy -- [sketch-file-or-directory] [--out report.json] [--json] [--limit n]

Scores CutReady sketch narrative/actions for AI-style artifacts and spoken-demo copy quality.

Default target:
  ${DEFAULT_TARGET}`);
}

function collectSketchFiles(target) {
  if (!existsSync(target)) {
    throw new Error(`Target does not exist: ${target}`);
  }

  if (statSync(target).isFile()) {
    return target.endsWith(".sk") ? [target] : [];
  }

  const files = [];
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".sk")) {
        files.push(full);
      }
    }
  }

  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b));
}

function scoreText(text) {
  const findings = [];
  let score = 100;
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return { score: 100, findings: [], metrics: { wordCount: 0, longestLineWords: 0 } };
  }

  for (const rule of ARTIFACT_PATTERNS) {
    const matches = [...normalized.matchAll(rule.pattern)];
    if (matches.length > 0) {
      const unique = [...new Set(matches.map((match) => match[0].toLowerCase()))].slice(0, 8);
      const points = Math.min(rule.points * matches.length, rule.points * 4);
      score -= points;
      findings.push({
        code: rule.code,
        points,
        count: matches.length,
        examples: unique,
        message: rule.message,
      });
    }
  }

  const abstractMatches = [...normalized.matchAll(ABSTRACT_NOUN_RE)];
  if (abstractMatches.length >= 3) {
    const examples = [...new Set(abstractMatches.map((match) => match[0].toLowerCase()))].slice(0, 8);
    const points = Math.min(abstractMatches.length * 3, 15);
    score -= points;
    findings.push({
      code: "ABSTRACT_NOUN_STACK",
      points,
      count: abstractMatches.length,
      examples,
      message: "several abstract nouns can make demo copy sound generic",
    });
  }

  const lines = normalized.split(/\r?\n/).map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
  const wordCounts = lines.map((line) => line.split(/\s+/).filter(Boolean).length);
  const longestLineWords = Math.max(0, ...wordCounts);
  if (longestLineWords > 28) {
    const points = Math.min(20, (longestLineWords - 28) * 2);
    score -= points;
    findings.push({
      code: "LONG_SPOKEN_LINE",
      points,
      count: 1,
      examples: [`${longestLineWords} words`],
      message: "line is long for spoken demo narration",
    });
  }

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return {
    score: Math.max(0, Math.round(score)),
    findings: findings.sort((a, b) => b.points - a.points),
    metrics: { wordCount, longestLineWords },
  };
}

function scoreSketch(file) {
  const sketch = JSON.parse(readFileSync(file, "utf8"));
  const rows = Array.isArray(sketch.rows) ? sketch.rows : [];
  const rowResults = [];

  for (const [index, row] of rows.entries()) {
    for (const field of ["narrative", "demo_actions"]) {
      const scored = scoreText(row[field]);
      if (scored.findings.length > 0) {
        rowResults.push({
          rowNumber: index + 1,
          field,
          score: scored.score,
          metrics: scored.metrics,
          findings: scored.findings,
          text: row[field] ?? "",
        });
      }
    }
  }

  const allScores = rowResults.map((result) => result.score);
  const averageIssueScore = allScores.length > 0
    ? allScores.reduce((sum, value) => sum + value, 0) / allScores.length
    : 100;
  return {
    file,
    title: sketch.title ?? path.basename(file),
    rowCount: rows.length,
    issueCount: rowResults.length,
    averageIssueScore: Math.round(averageIssueScore),
    rowResults,
  };
}

function formatConsoleReport(results, target) {
  const issueRows = results.flatMap((result) => result.rowResults.map((row) => ({ ...row, file: result.file, title: result.title })));
  const totalRows = results.reduce((sum, result) => sum + result.rowCount, 0);
  const codeCounts = new Map();
  for (const row of issueRows) {
    for (const finding of row.findings) {
      codeCounts.set(finding.code, (codeCounts.get(finding.code) ?? 0) + finding.count);
    }
  }

  const lines = [];
  lines.push("Agent copy quality report");
  lines.push(`Target: ${target}`);
  lines.push(`Sketches: ${results.length}`);
  lines.push(`Rows scanned: ${totalRows}`);
  lines.push(`Rows/fields with findings: ${issueRows.length}`);
  lines.push("");

  lines.push("Common findings:");
  [...codeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .forEach(([code, count]) => lines.push(`  ${count}x ${code}`));
  lines.push("");

  for (const row of issueRows.sort((a, b) => a.score - b.score).slice(0, 20)) {
    lines.push(`${path.basename(row.file)} row ${row.rowNumber} ${row.field}   score ${row.score}`);
    for (const finding of row.findings.slice(0, 5)) {
      lines.push(`  - ${finding.code}: ${finding.message}${finding.examples.length ? ` (${finding.examples.join(", ")})` : ""}`);
    }
  }

  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = collectSketchFiles(options.target).slice(0, options.limit);
  const results = files.map(scoreSketch);
  const report = {
    generatedAt: new Date().toISOString(),
    target: options.target,
    summary: {
      sketchCount: results.length,
      rowCount: results.reduce((sum, result) => sum + result.rowCount, 0),
      issueCount: results.reduce((sum, result) => sum + result.issueCount, 0),
    },
    results,
  };

  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatConsoleReport(results, options.target));
    console.log("");
    console.log(`Wrote ${options.out}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
