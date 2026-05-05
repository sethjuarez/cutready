#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_TARGET = "D:\\cutready\\ndc-toronto-26\\session\\.cutready\\visuals";
const REPORT_DIR = path.join(process.cwd(), "scripts", "visual-eval", "reports");
const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 540;

function parseArgs(argv) {
  const options = {
    target: DEFAULT_TARGET,
    out: path.join(REPORT_DIR, "latest-report.json"),
    json: false,
    limit: Number.POSITIVE_INFINITY,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--out") {
      options.out = argv[++i];
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
  console.log(`Usage: npm run visual:score -- [visual-file-or-directory] [--out report.json] [--json] [--limit n]

Scores Elucim visual JSON files with deterministic presentation-polish heuristics.

Default target:
  ${DEFAULT_TARGET}`);
}

function collectFiles(target) {
  if (!existsSync(target)) {
    throw new Error(`Target does not exist: ${target}`);
  }

  const info = statSync(target);
  if (info.isFile()) {
    return [target];
  }

  return readdirSync(target)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(target, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function flattenNodes(nodes = [], offsetX = 0, offsetY = 0, depth = 0) {
  const flattened = [];
  for (const node of nodes) {
    const withMeta = {
      ...node,
      __x: numberOr(node.x, 0) + offsetX,
      __y: numberOr(node.y, 0) + offsetY,
      __depth: depth,
    };
    flattened.push(withMeta);

    if (Array.isArray(node.children)) {
      flattened.push(...flattenNodes(node.children, withMeta.__x, withMeta.__y, depth + 1));
    }
  }
  return flattened;
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function colorValues(nodes) {
  return nodes.flatMap((node) => [node.fill, node.stroke, node.background]).filter(Boolean);
}

function isToken(value) {
  return typeof value === "string" && value.startsWith("$");
}

function isHardcodedColor(value) {
  return typeof value === "string" && /^(#|rgb|hsl)/i.test(value);
}

function isHardcodedBrandLike(value) {
  if (typeof value !== "string") {
    return false;
  }
  const lower = value.toLowerCase();
  return (
    lower.includes("#38bdf8") ||
    lower.includes("56,189,248") ||
    lower.includes("#a78bfa") ||
    lower.includes("167,139,250")
  );
}

function shapeArea(node) {
  if (node.type === "rect") {
    return numberOr(node.width, 0) * numberOr(node.height, 0);
  }
  if (node.type === "circle") {
    const r = numberOr(node.r, 0);
    return Math.PI * r * r;
  }
  return 0;
}

function repeatedSmallRects(rects) {
  const smallRects = rects.filter((node) => numberOr(node.width, 0) <= 48 && numberOr(node.height, 0) <= 48);
  if (smallRects.length < 6) {
    return null;
  }

  const buckets = new Map();
  for (const node of smallRects) {
    const key = [
      Math.round(numberOr(node.width, 0) / 4) * 4,
      Math.round(numberOr(node.height, 0) / 4) * 4,
      node.fill ?? "",
      node.stroke ?? "",
    ].join("|");
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  const largest = Math.max(...buckets.values());
  return largest >= 6 ? { count: largest, total: smallRects.length } : null;
}

function repeatedChipRows(rects) {
  const chipRects = rects.filter((node) => {
    const width = numberOr(node.width, 0);
    const height = numberOr(node.height, 0);
    return width >= 30 && width <= 140 && height >= 24 && height <= 48;
  });

  const rows = new Map();
  for (const node of chipRects) {
    const row = Math.round(numberOr(node.__y, 0) / 12) * 12;
    rows.set(row, (rows.get(row) ?? 0) + 1);
  }

  const largest = rows.size > 0 ? Math.max(...rows.values()) : 0;
  return largest >= 5 ? { count: largest } : null;
}

function scoreVisual(file) {
  const raw = readFileSync(file, "utf8");
  const visual = JSON.parse(raw);
  const root = visual.root ?? {};
  const topLevel = Array.isArray(root.children) ? root.children : [];
  const nodes = flattenNodes(topLevel);
  const texts = nodes.filter((node) => node.type === "text");
  const rects = nodes.filter((node) => node.type === "rect");
  const arrows = nodes.filter((node) => node.type === "arrow");
  const groups = nodes.filter((node) => node.type === "group");
  const colors = colorValues(nodes);
  const tokenColors = colors.filter(isToken);
  const hardcodedColors = colors.filter(isHardcodedColor);
  const hardcodedBrandColors = colors.filter(isHardcodedBrandLike);
  const maxShapeArea = Math.max(0, ...nodes.map(shapeArea));
  const repeatedMarks = repeatedSmallRects(rects);
  const chipRows = repeatedChipRows(rects);

  let score = 100;
  const strengths = [];
  const findings = [];

  const deduct = (points, code, message) => {
    score -= points;
    findings.push({ code, points, message });
  };

  const add = (code, message) => {
    strengths.push({ code, message });
  };

  if (root.width === CANVAS_WIDTH && root.height === CANVAS_HEIGHT) {
    add("CANVAS", "uses 960x540 presentation canvas");
  } else {
    deduct(15, "CANVAS", `expected 960x540 canvas, got ${root.width ?? "?"}x${root.height ?? "?"}`);
  }

  if (root.background === "$background") {
    add("BACKGROUND", "uses $background root token");
  } else {
    deduct(15, "BACKGROUND", "root background should be $background");
  }

  const hasTitle = texts.some((node) => node.fill === "$title");
  const hasSubtitle = texts.some((node) => node.fill === "$subtitle");
  if (hasTitle && hasSubtitle) {
    add("TITLE_HIERARCHY", "uses $title and $subtitle");
  } else {
    deduct(20, "TITLE_HIERARCHY", "missing $title/$subtitle hierarchy");
  }

  if (hardcodedBrandColors.length === 0) {
    add("BRAND_TOKENS", "avoids hardcoded cyan/purple accents");
  } else {
    deduct(30, "HARDCODED_BRAND_ACCENTS", `${hardcodedBrandColors.length} hardcoded cyan/purple color values`);
  }

  if (colors.length > 0) {
    const ratio = tokenColors.length / colors.length;
    if (ratio >= 0.9) {
      add("TOKEN_USAGE", `${Math.round(ratio * 100)}% of color values are semantic tokens`);
    } else if (ratio < 0.75) {
      deduct(20, "LOW_TOKEN_USAGE", `${Math.round(ratio * 100)}% of color values are semantic tokens`);
    }
  }

  if (hardcodedColors.length > 0) {
    deduct(10, "HARDCODED_COLORS", `${hardcodedColors.length} hardcoded color value(s)`);
  }

  if (nodes.length > 55) {
    deduct(30, "TOO_MANY_ELEMENTS", `${nodes.length} flattened nodes; hard target is <=55, polish target is <=35`);
  } else if (nodes.length > 45) {
    deduct(12, "ELEMENT_COUNT", `${nodes.length} flattened nodes; polish target is <=35`);
  } else if (nodes.length > 35) {
    deduct(6, "ELEMENT_COUNT", `${nodes.length} flattened nodes; ideal is <=35`);
  } else {
    add("ELEMENT_COUNT", `${nodes.length} flattened nodes`);
  }

  if (texts.length > 22) {
    deduct(28, "TEXT_DENSITY", `${texts.length} text labels; hard target is <=22, polish target is <=14`);
  } else if (texts.length > 18) {
    deduct(12, "TEXT_DENSITY", `${texts.length} text labels; polish target is <=14`);
  } else if (texts.length > 14) {
    deduct(6, "TEXT_DENSITY", `${texts.length} text labels; ideal is <=14`);
  } else {
    add("TEXT_DENSITY", `${texts.length} text labels`);
  }

  if (rects.length > 18) {
    deduct(6, "RECT_DENSITY", `${rects.length} rects; repeated boxes/chips make slides feel busy`);
  }

  if (arrows.length > 4) {
    deduct(5, "ARROW_DENSITY", `${arrows.length} arrows; prefer one clear visual path`);
  }

  if (groups.length > 0 && nodes.length - topLevel.length > 20) {
    deduct(10, "GROUPED_COMPLEXITY", `${nodes.length - topLevel.length} nested nodes; groups should not hide visual density`);
  }

  if (repeatedMarks) {
    deduct(10, "REPEATED_SMALL_MARKS", `${repeatedMarks.count} repeated small marks; replace grids/chips with a stronger metaphor`);
  }

  if (chipRows) {
    deduct(8, "REPEATED_CHIP_ROW", `${chipRows.count} chip-like rects in one row; combine or simplify token strips`);
  }

  if (maxShapeArea < CANVAS_WIDTH * CANVAS_HEIGHT * 0.035) {
    deduct(12, "NO_HERO_OBJECT", "no dominant visual anchor; use one large central shape/metaphor");
  }

  const smallReadableTexts = texts.filter((node) => numberOr(node.fontSize, 0) > 0 && numberOr(node.fontSize, 0) < 18);
  if (smallReadableTexts.length > 4) {
    deduct(8, "SMALL_TEXT", `${smallReadableTexts.length} text labels below 18px`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    file,
    name: path.basename(file),
    score,
    rating: score >= 85 ? "pass" : score >= 70 ? "review" : "fail",
    metrics: {
      flattenedNodeCount: nodes.length,
      topLevelCount: topLevel.length,
      textCount: texts.length,
      rectCount: rects.length,
      arrowCount: arrows.length,
      groupCount: groups.length,
      tokenColorCount: tokenColors.length,
      colorCount: colors.length,
      maxShapeArea: Math.round(maxShapeArea),
    },
    strengths,
    findings: findings.sort((a, b) => b.points - a.points),
  };
}

function formatConsoleReport(results, target) {
  const average = results.length > 0 ? results.reduce((sum, result) => sum + result.score, 0) / results.length : 0;
  const passRate = results.length > 0 ? results.filter((result) => result.rating === "pass").length / results.length : 0;
  const commonFindings = new Map();
  for (const result of results) {
    for (const finding of result.findings) {
      commonFindings.set(finding.code, (commonFindings.get(finding.code) ?? 0) + 1);
    }
  }

  const lines = [];
  lines.push("Visual quality report");
  lines.push(`Target: ${target}`);
  lines.push(`Visuals: ${results.length}`);
  lines.push(`Average score: ${average.toFixed(1)}`);
  lines.push(`Pass rate: ${Math.round(passRate * 100)}%`);
  lines.push("");

  for (const result of results) {
    lines.push(`${result.name}   score ${result.score}   ${result.rating}`);
    for (const strength of result.strengths.slice(0, 3)) {
      lines.push(`  + ${strength.message}`);
    }
    for (const finding of result.findings.slice(0, 6)) {
      lines.push(`  - ${finding.code}: ${finding.message}`);
    }
    lines.push("");
  }

  if (commonFindings.size > 0) {
    lines.push("Common findings:");
    [...commonFindings.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([code, count]) => {
        lines.push(`  ${count}x ${code}`);
      });
  }

  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = collectFiles(options.target).slice(0, options.limit);
  const results = files.map(scoreVisual).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const report = {
    generatedAt: new Date().toISOString(),
    target: options.target,
    summary: {
      visualCount: results.length,
      averageScore: results.length > 0 ? results.reduce((sum, result) => sum + result.score, 0) / results.length : 0,
      passCount: results.filter((result) => result.rating === "pass").length,
      reviewCount: results.filter((result) => result.rating === "review").length,
      failCount: results.filter((result) => result.rating === "fail").length,
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

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
