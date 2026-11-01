// Guards cutready-core's dependency graph so the core stays host-neutral and
// keeps building for iOS (architecture v3 §5), and keeps cutready-versioning
// free of the desktop shell. `cargo tree -p` resolves
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

export const VERSIONING_PACKAGE = "cutready-versioning";

export const VERSIONING_FORBIDDEN = [
  { pattern: /^tauri/, reason: "versioning must not depend on the desktop shell" },
  { pattern: /^cutready$/, reason: "versioning must not depend on the app" },
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
  return findForbidden(packages, FORBIDDEN, FORBIDDEN_FEATURES);
}

export function checkVersioningDeps(packages) {
  return findForbidden(packages, VERSIONING_FORBIDDEN, []);
}

function findForbidden(packages, forbidden, forbiddenFeatures) {
  const problems = [];
  for (const [name, features] of packages) {
    const rule = forbidden.find(({ pattern }) => pattern.test(name));
    if (rule) problems.push(`${name}: ${rule.reason}`);
    for (const banned of forbiddenFeatures) {
      if (banned.name === name && features.has(banned.feature)) {
        problems.push(`${name} feature "${banned.feature}": ${banned.reason}`);
      }
    }
  }
  return problems;
}

function tree(pkg) {
  const output = execFileSync(
    "cargo",
    ["tree", "-p", pkg, "-e", "normal,build", "--target", "all", "--prefix", "none", "-f", TREE_FORMAT, "--locked", "--color", "never"],
    { encoding: "utf8" },
  );
  const packages = parseTree(output);
  if (!packages.has(pkg)) {
    console.error(`check-core-deps: ${pkg} not found in cargo tree output.`);
    process.exit(1);
  }
  return packages;
}

function main() {
  let failed = false;
  for (const [pkg, check, label] of [
    [CORE_PACKAGE, checkCoreDeps, "Core"],
    [VERSIONING_PACKAGE, checkVersioningDeps, "Versioning"],
  ]) {
    const packages = tree(pkg);
    const problems = check(packages);
    if (problems.length > 0) {
      console.error(`${pkg} has forbidden dependencies:`);
      for (const problem of problems) console.error(`  - ${problem}`);
      failed = true;
    } else {
      console.log(`${label} dependencies OK: ${packages.size} packages.`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
