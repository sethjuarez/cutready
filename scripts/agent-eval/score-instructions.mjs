#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const DEFAULT_CASES = path.join(SCRIPT_DIR, "instruction-cases.json");
const DEFAULT_OUT = path.join(SCRIPT_DIR, "reports", "instruction-report.json");

const AI_VOICE_PATTERNS = [
  { code: "AI_CLICHE", points: 12, pattern: /\b(in today'?s (?:fast-paced|digital|ever-changing) world|delve into|dive into|at the end of the day|it'?s important to note|not just .* but|more than just)\b/gi, message: "uses a common AI-style phrase" },
  { code: "HYPE_WORD", points: 8, pattern: /\b(unlock|unleash|elevate|revolutionize|supercharge|empower|leverage|harness|powerful|seamless(?:ly)?|robust|game-changing|transformative)\b/gi, message: "uses synthetic marketing language" },
  { code: "VAGUE_EASE_CLAIM", points: 5, pattern: /\b(in seconds|instantly|with ease|without friction)\b/gi, message: "uses a vague speed/ease claim" },
];

function parseArgs(argv) {
  const options = {
    cases: DEFAULT_CASES,
    out: DEFAULT_OUT,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      options.out = argv[++i];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("--")) {
      options.cases = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run agent:score-instructions -- [cases.json] [--out report.json] [--json]

Scores agent outputs for user-instruction following: requested format, concision, conversational tone, required phrases, and forbidden phrases.

Case shape:
  {
    "id": "case-id",
    "agent": "writer",
    "instruction": "Use bullets instead of narrative.",
    "source": "Optional source text for concision ratio checks.",
    "output": "Candidate agent output.",
    "expected": {
      "format": "bullets|numbered|narrative|table",
      "minBullets": 2,
      "maxBullets": 4,
      "maxWords": 60,
      "maxWordsRatio": 0.7,
      "conversational": true,
      "required": ["phrase"],
      "forbidden": ["phrase"]
    }
  }`);
}

function loadCases(file) {
  if (!existsSync(file)) {
    throw new Error(`Cases file does not exist: ${file}`);
  }

  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Instruction cases file must contain a JSON array.");
  }

  return parsed;
}

function inferExpected(testCase) {
  const instruction = String(testCase.instruction ?? "").toLowerCase();
  const explicit = testCase.expected ?? {};
  const expected = { ...explicit };

  if (!expected.format) {
    if (/\b(markdown\s+)?table\b/.test(instruction)) {
      expected.format = "table";
    } else if (/\bnumbered\b|\bnumbered list\b/.test(instruction)) {
      expected.format = "numbered";
    } else if (/\bbullets?\b|\bbullet list\b|\blist\b/.test(instruction) && !/\bnot a list\b/.test(instruction)) {
      expected.format = "bullets";
    } else if (/\bnarrative\b|\bparagraph\b|\bscript\b/.test(instruction)) {
      expected.format = "narrative";
    }
  }

  if (expected.maxWords === undefined && expected.maxWordsRatio === undefined && /\b(concise|short|brief|tighten|shorter)\b/.test(instruction)) {
    expected.maxWordsRatio = testCase.source ? 0.75 : undefined;
    expected.maxWords = testCase.source ? undefined : 80;
  }

  if (expected.conversational === undefined && /\b(conversational|natural|spoken|human|presenter)\b/.test(instruction)) {
    expected.conversational = true;
  }

  if (expected.requirePlainPunctuation === undefined && /\b(plain punctuation|ascii|no em dash|no smart quote|straight quote)\b/.test(instruction)) {
    expected.requirePlainPunctuation = true;
  }

  return expected;
}

function scoreCase(testCase) {
  const expected = inferExpected(testCase);
  const output = String(testCase.output ?? "").trim();
  const source = String(testCase.source ?? "").trim();
  const findings = [];
  let score = 100;

  if (!output) {
    return {
      id: testCase.id ?? "(unnamed)",
      agent: testCase.agent ?? "unknown",
      score: 0,
      pass: false,
      expected,
      metrics: { wordCount: 0, bulletCount: 0, paragraphCount: 0 },
      findings: [{ code: "EMPTY_OUTPUT", points: 100, message: "output is empty" }],
    };
  }

  score -= scoreFormat(output, expected, findings);
  score -= scoreConcision(output, source, expected, findings);
  score -= scoreConversational(output, expected, findings);
  score -= scoreRequiredAndForbidden(output, expected, findings);
  score -= scorePunctuation(output, expected, findings);

  const metrics = textMetrics(output);
  const roundedScore = Math.max(0, Math.round(score));
  return {
    id: testCase.id ?? "(unnamed)",
    agent: testCase.agent ?? "unknown",
    instruction: testCase.instruction ?? "",
    score: roundedScore,
    pass: roundedScore >= 85 && findings.length === 0,
    expected,
    metrics,
    findings: findings.sort((a, b) => b.points - a.points),
  };
}

function scoreFormat(output, expected, findings) {
  if (!expected.format) {
    return 0;
  }

  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bulletCount = lines.filter((line) => /^[-*]\s+\S/.test(line)).length;
  const numberedCount = lines.filter((line) => /^\d+[.)]\s+\S/.test(line)).length;
  const tableLike = lines.length >= 2 && lines.some((line) => /^\|.*\|$/.test(line)) && lines.some((line) => /^\|\s*:?-{3,}:?\s*\|/.test(line));
  const paragraphCount = output.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).length;

  if (expected.format === "bullets") {
    let points = 0;
    if (bulletCount === 0) {
      points += 30;
      findings.push({ code: "MISSING_BULLETS", points: 30, message: "instruction asked for bullets but output is not a bullet list" });
    }
    if (expected.minBullets !== undefined && bulletCount < expected.minBullets) {
      points += 10;
      findings.push({ code: "TOO_FEW_BULLETS", points: 10, message: `expected at least ${expected.minBullets} bullets, got ${bulletCount}` });
    }
    if (expected.maxBullets !== undefined && bulletCount > expected.maxBullets) {
      points += 10;
      findings.push({ code: "TOO_MANY_BULLETS", points: 10, message: `expected at most ${expected.maxBullets} bullets, got ${bulletCount}` });
    }
    return points;
  }

  if (expected.format === "numbered" && numberedCount === 0) {
    findings.push({ code: "MISSING_NUMBERED_LIST", points: 30, message: "instruction asked for a numbered list" });
    return 30;
  }

  if (expected.format === "table" && !tableLike) {
    findings.push({ code: "MISSING_TABLE", points: 30, message: "instruction asked for a markdown table" });
    return 30;
  }

  if (expected.format === "narrative" && (bulletCount > 0 || numberedCount > 0 || paragraphCount > 2)) {
    findings.push({ code: "NOT_NARRATIVE", points: 25, message: "instruction asked for narrative/paragraph prose" });
    return 25;
  }

  return 0;
}

function scoreConcision(output, source, expected, findings) {
  const wordCount = countWords(output);
  const sourceWords = countWords(source);
  const maxWordsFromRatio = expected.maxWordsRatio && sourceWords > 0 ? Math.floor(sourceWords * expected.maxWordsRatio) : undefined;
  const maxWords = Math.max(1, Math.min(
    expected.maxWords ?? Number.POSITIVE_INFINITY,
    maxWordsFromRatio ?? Number.POSITIVE_INFINITY,
  ));

  if (!Number.isFinite(maxWords) || wordCount <= maxWords) {
    return 0;
  }

  const overBy = wordCount - maxWords;
  const points = Math.min(30, 10 + overBy * 2);
  findings.push({ code: "TOO_LONG", points, message: `expected ${maxWords} words or fewer, got ${wordCount}` });
  return points;
}

function scoreConversational(output, expected, findings) {
  if (!expected.conversational) {
    return 0;
  }

  let points = 0;
  for (const rule of AI_VOICE_PATTERNS) {
    const matches = [...output.matchAll(rule.pattern)];
    if (matches.length > 0) {
      const penalty = Math.min(rule.points * matches.length, rule.points * 3);
      points += penalty;
      findings.push({
        code: rule.code,
        points: penalty,
        message: `${rule.message}: ${[...new Set(matches.map((match) => match[0].toLowerCase()))].slice(0, 5).join(", ")}`,
      });
    }
  }

  const metrics = textMetrics(output);
  if (metrics.longestSentenceWords > 28) {
    const penalty = Math.min(18, (metrics.longestSentenceWords - 28) * 2);
    points += penalty;
    findings.push({ code: "LONG_SENTENCE", points: penalty, message: `longest sentence has ${metrics.longestSentenceWords} words` });
  }

  return points;
}

function scoreRequiredAndForbidden(output, expected, findings) {
  const lowered = output.toLowerCase();
  let points = 0;

  for (const phrase of expected.required ?? []) {
    if (!lowered.includes(String(phrase).toLowerCase())) {
      points += 12;
      findings.push({ code: "MISSING_REQUIRED_PHRASE", points: 12, message: `missing required phrase: ${phrase}` });
    }
  }

  for (const phrase of expected.forbidden ?? []) {
    if (lowered.includes(String(phrase).toLowerCase())) {
      points += 12;
      findings.push({ code: "FORBIDDEN_PHRASE", points: 12, message: `contains forbidden phrase: ${phrase}` });
    }
  }

  return points;
}

function scorePunctuation(output, expected, findings) {
  if (!expected.requirePlainPunctuation && !/[—–“”]/.test(output)) {
    return 0;
  }

  const matches = [...output.matchAll(/[—–“”]/g)];
  if (matches.length === 0) {
    return 0;
  }

  const points = Math.min(20, matches.length * 4);
  findings.push({ code: "NON_PLAIN_PUNCTUATION", points, message: "uses em/en dashes or smart quotes" });
  return points;
}

function countWords(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function textMetrics(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bulletCount = lines.filter((line) => /^[-*]\s+\S/.test(line)).length;
  const numberedCount = lines.filter((line) => /^\d+[.)]\s+\S/.test(line)).length;
  const paragraphCount = String(text ?? "").split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean).length;
  const sentences = String(text ?? "").split(/[.!?]+/).map((part) => part.trim()).filter(Boolean);
  const sentenceWordCounts = sentences.map(countWords);

  return {
    wordCount: countWords(text),
    bulletCount,
    numberedCount,
    paragraphCount,
    longestSentenceWords: Math.max(0, ...sentenceWordCounts),
  };
}

function formatConsoleReport(report) {
  const lines = [];
  lines.push("Agent instruction-following report");
  lines.push(`Cases: ${report.summary.caseCount}`);
  lines.push(`Pass rate: ${report.summary.passRate}%`);
  lines.push(`Average score: ${report.summary.averageScore}`);
  lines.push("");

  const counts = new Map();
  for (const result of report.results) {
    for (const finding of result.findings) {
      counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
    }
  }

  lines.push("Common findings:");
  if (counts.size === 0) {
    lines.push("  none");
  } else {
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([code, count]) => lines.push(`  ${count}x ${code}`));
  }
  lines.push("");

  for (const result of report.results.sort((a, b) => a.score - b.score)) {
    lines.push(`${result.pass ? "PASS" : "FAIL"} ${result.id} (${result.agent})   score ${result.score}`);
    for (const finding of result.findings.slice(0, 5)) {
      lines.push(`  - ${finding.code}: ${finding.message}`);
    }
  }

  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const cases = loadCases(options.cases);
  const results = cases.map(scoreCase);
  const passCount = results.filter((result) => result.pass).length;
  const averageScore = results.length > 0
    ? results.reduce((sum, result) => sum + result.score, 0) / results.length
    : 100;
  const report = {
    generatedAt: new Date().toISOString(),
    cases: options.cases,
    summary: {
      caseCount: results.length,
      passCount,
      passRate: results.length > 0 ? Math.round((passCount / results.length) * 100) : 100,
      averageScore: Math.round(averageScore),
    },
    results,
  };

  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatConsoleReport(report));
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
