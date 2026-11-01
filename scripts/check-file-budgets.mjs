// File-size ratchet (architecture v3 F2). Source files may not grow past
// LIMIT lines; files already over it are pinned at their current size in
// scripts/file-budgets.json. Budgets only go down: when a split lands, run
// `node scripts/check-file-budgets.mjs --update` to lower them. Raising one
// is an explicit, reviewed edit of the JSON file.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BUDGET_FILE = "scripts/file-budgets.json";

const SOURCE = [
  { root: "src", ext: /\.tsx?$/ },
  { root: "src-tauri/src", ext: /\.rs$/ },
  { root: "crates", ext: /\.rs$/, under: "/src/" },
];

/** Generated code and test-only files are exempt. */
export function isBudgeted(path) {
  if (path.startsWith("src/contracts/generated/")) return false;
  if (path.startsWith("crates/cutready-contracts/")) return false;
  if (path.startsWith("src/test/") || /\.test\.tsx?$/.test(path)) return false;
  if (/_tests?\.rs$/.test(path) || /\/tests\//.test(path)) return false;
  return SOURCE.some(
    ({ root, ext, under }) => path.startsWith(`${root}/`) && ext.test(path) && (!under || path.includes(under)),
  );
}

export function countLines(text) {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** Problems for `sizes` ({path: lines}) against `config` ({limit, budgets}). */
export function checkFileBudgets(sizes, { limit, budgets }) {
  const problems = [];
  for (const [path, lines] of Object.entries(sizes)) {
    const budget = budgets[path];
    if (budget === undefined) {
      if (lines > limit) {
        problems.push(`${path}: ${lines} lines, over the ${limit}-line limit for new files; split it`);
      }
    } else if (lines > budget) {
      problems.push(`${path}: ${lines} lines, over its budget of ${budget}; split it rather than raise the budget`);
    } else if (lines < budget) {
      problems.push(`${path}: ${lines} lines, under its budget of ${budget}; run --update to lower it`);
    }
  }
  for (const path of Object.keys(budgets)) {
    if (!(path in sizes)) problems.push(`${path}: budgeted but missing; run --update to drop it`);
  }
  return problems;
}

/** Lowers budgets to current sizes and drops files back under the limit. Never raises one. */
export function updateBudgets(sizes, { limit, budgets }) {
  const next = {};
  for (const [path, budget] of Object.entries(budgets)) {
    const lines = sizes[path];
    if (lines !== undefined && lines > limit) next[path] = Math.min(budget, lines);
  }
  return { limit, budgets: next };
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "target") return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

export function measure(cwd = process.cwd()) {
  const sizes = {};
  for (const { root } of SOURCE) {
    for (const full of walk(join(cwd, root))) {
      const path = relative(cwd, full).split(sep).join("/");
      if (isBudgeted(path)) sizes[path] = countLines(readFileSync(full, "utf8"));
    }
  }
  return sizes;
}

function sorted(config) {
  const budgets = Object.fromEntries(Object.entries(config.budgets).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({ limit: config.limit, budgets }, null, 2)}\n`;
}

function main() {
  const config = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
  const sizes = measure();
  if (process.argv.includes("--update")) {
    writeFileSync(BUDGET_FILE, sorted(updateBudgets(sizes, config)));
    console.log(`Updated ${BUDGET_FILE}.`);
    return;
  }
  const problems = checkFileBudgets(sizes, config);
  if (problems.length > 0) {
    console.error("File budgets:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `File budgets OK: ${Object.keys(sizes).length} files, ${Object.keys(config.budgets).length} pinned over ${config.limit} lines.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
