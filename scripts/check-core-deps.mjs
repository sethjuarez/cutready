// Guards cutready-core's dependency graph so the core stays host-neutral and
// keeps building for iOS (architecture v3 §5). `cargo tree -p` resolves
// features for core alone, unlike workspace-unified `cargo metadata`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CORE_PACKAGE = "cutready-core";

export const FORBIDDEN = [
  { pattern: /^tauri/, reason: "Tauri belongs to the desktop shell" },
  { pattern: /^windows/, reason: "platform APIs belong in host I/O crates" },
  { pattern: /^(git2|libgit2-sys)$/, reason: "versioning goes through a host port" },
  { pattern: /^(rusqlite|libsqlite3-sys)$/, reason: "storage goes through the OpLogStore port" },
  { pattern: /^reqwest$/, reason: "network access belongs to hosts" },
  { pattern: /^(draftline|cutready)$/, reason: "core must not depend on the app or Draftline" },
];

const FORBIDDEN_FEATURES = [
  { name: "tokio", feature: "process", reason: "core never spawns processes" },
];

export const TREE_FORMAT = "{p}|{f}|";

/**
 * Parses `cargo tree --prefix none -f "{p}|{f}|"` output into packages.
 * Throws on any line it can't read, so a format change can't hide a package.
 */
export function parseTree(output) {
  const packages = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(\S+) v[^|]*\|([^|]*)\|( \(\*\))?$/.exec(line.trim());
    if (!match) throw new Error(`check-core-deps: unreadable cargo tree line: ${line}`);
    const [, name, features] = match;
    const set = packages.get(name) ?? new Set();
    for (const feature of features.split(",").filter(Boolean)) set.add(feature);
    packages.set(name, set);
  }
  return packages;
}

export function checkCoreDeps(packages) {
  const problems = [];
  for (const [name, features] of packages) {
    const rule = FORBIDDEN.find(({ pattern }) => pattern.test(name));
    if (rule) problems.push(`${name}: ${rule.reason}`);
    for (const banned of FORBIDDEN_FEATURES) {
      if (banned.name === name && features.has(banned.feature)) {
        problems.push(`${name} feature "${banned.feature}": ${banned.reason}`);
      }
    }
  }
  return problems;
}

function main() {
  const output = execFileSync(
    "cargo",
    ["tree", "-p", CORE_PACKAGE, "-e", "normal,build", "--target", "all", "--prefix", "none", "-f", TREE_FORMAT, "--locked", "--color", "never"],
    { encoding: "utf8" },
  );
  const packages = parseTree(output);
  if (!packages.has(CORE_PACKAGE)) {
    console.error(`check-core-deps: ${CORE_PACKAGE} not found in cargo tree output.`);
    process.exit(1);
  }
  const problems = checkCoreDeps(packages);
  if (problems.length > 0) {
    console.error(`${CORE_PACKAGE} has forbidden dependencies:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Core dependencies OK: ${packages.size} packages.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
