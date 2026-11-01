// IPC ratchet (architecture v3 F2). Components, hooks and stores should
// reach the backend through typed wrappers in src/ipc/ (F4), not raw
// `invoke`. Files that import `invoke` today are capped at their current
// number of calls in scripts/ipc-imports.json; new files may not import it.
// Caps only go down: run `node scripts/check-ipc-imports.mjs --update` after
// moving calls into src/ipc/.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CAP_FILE = "scripts/ipc-imports.json";

/** The wrapper itself, its plumbing, typed IPC modules, generated code and tests. */
export function isExempt(path) {
  return (
    path === "src/services/tauri.ts" ||
    path === "src/services/auditaur.ts" ||
    path === "src/devMock.ts" ||
    path.startsWith("src/ipc/") ||
    path.startsWith("src/contracts/") ||
    path.startsWith("src/test/") ||
    /\.test\.tsx?$/.test(path)
  );
}

const IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const NAMESPACE_IMPORT = /import\s*\*\s*as\s+(\w+)\s+from\s*["']([^"']+)["']/g;

function isTauriCore(specifier) {
  return specifier === "@tauri-apps/api/core" || /(^|\/)(services\/)?tauri$/.test(specifier);
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Local names `invoke` is imported as, or [] when the file doesn't import it. */
export function invokeNames(text) {
  const names = [];
  for (const [, specifiers, from] of stripComments(text).matchAll(IMPORT)) {
    if (!isTauriCore(from)) continue;
    for (const specifier of specifiers.split(",")) {
      const match = /^\s*invoke(?:\s+as\s+(\w+))?\s*$/.exec(specifier);
      if (match) names.push(match[1] ?? "invoke");
    }
  }
  for (const [, namespace, from] of stripComments(text).matchAll(NAMESPACE_IMPORT)) {
    if (isTauriCore(from)) names.push(`${namespace}.invoke`);
  }
  return names;
}

/** Number of raw `invoke(` / `invoke<T>(` calls, or null when `invoke` isn't imported. */
export function countInvokes(text) {
  const names = invokeNames(text);
  if (names.length === 0) return null;
  const code = stripComments(text);
  return names.reduce(
    (total, name) =>
      total + [...code.matchAll(new RegExp(`\\b${name.replace(".", "\\s*\\.\\s*")}\\s*[<(]`, "g"))].length,
    0,
  );
}

/** Problems for `counts` ({path: calls}, importers only) against `caps` ({path: max}). */
export function checkIpcImports(counts, caps) {
  const problems = [];
  for (const [path, calls] of Object.entries(counts)) {
    const cap = caps[path];
    if (cap === undefined) {
      problems.push(`${path}: imports invoke; add a typed wrapper in src/ipc/ and call that instead`);
    } else if (calls > cap) {
      problems.push(`${path}: ${calls} invoke calls, over its cap of ${cap}; add them to src/ipc/ instead`);
    } else if (calls < cap) {
      problems.push(`${path}: ${calls} invoke calls, under its cap of ${cap}; run --update to lower it`);
    }
  }
  for (const path of Object.keys(caps)) {
    if (!(path in counts)) problems.push(`${path}: capped but no longer imports invoke; run --update to drop it`);
  }
  return problems;
}

/** Lowers caps to current counts and drops files that stopped importing invoke. Never raises one. */
export function updateCaps(counts, caps) {
  const next = {};
  for (const [path, cap] of Object.entries(caps)) {
    if (path in counts) next[path] = Math.min(cap, counts[path]);
  }
  return next;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

export function measure(cwd = process.cwd()) {
  const counts = {};
  for (const full of walk(join(cwd, "src"))) {
    const path = relative(cwd, full).split(sep).join("/");
    if (!/\.tsx?$/.test(path) || isExempt(path)) continue;
    const calls = countInvokes(readFileSync(full, "utf8"));
    if (calls !== null) counts[path] = calls;
  }
  return counts;
}

function serialize(caps) {
  return `${JSON.stringify(Object.fromEntries(Object.entries(caps).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;
}

function main() {
  const caps = JSON.parse(readFileSync(CAP_FILE, "utf8"));
  const counts = measure();
  if (process.argv.includes("--update")) {
    writeFileSync(CAP_FILE, serialize(updateCaps(counts, caps)));
    console.log(`Updated ${CAP_FILE}.`);
    return;
  }
  const problems = checkIpcImports(counts, caps);
  if (problems.length > 0) {
    console.error("Raw invoke ratchet:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const total = Object.values(counts).reduce((sum, calls) => sum + calls, 0);
  console.log(`IPC imports OK: ${Object.keys(counts).length} files, ${total} raw invoke calls.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
