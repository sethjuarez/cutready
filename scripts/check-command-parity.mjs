// Keeps CutReady's supported Tauri command set explicit. Fails when
// `generate_handler!` in src-tauri/src/lib.rs and src-tauri/commands.json
// disagree, when an unsupported command is registered again, or when
// frontend code invokes a command that isn't supported.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Command names registered in the `generate_handler![...]` block. */
export function registeredCommands(libRs) {
  const start = libRs.indexOf("generate_handler![");
  if (start < 0) throw new Error("generate_handler! not found in lib.rs");
  const end = libRs.indexOf("])", start);
  if (end < 0) throw new Error("end of generate_handler! not found in lib.rs");
  // Attributes such as #[cfg(feature = "...")] gate entries; the entries still count.
  const block = libRs
    .slice(start + "generate_handler![".length, end)
    .replace(/#\[[^\]]*\]/g, "")
    .replace(/\/\/.*$/gm, "");
  return [...block.matchAll(/(?:\w+::)*(\w+)\s*(?:,|$)/g)].map((m) => m[1]);
}

/** Literal command names passed to `invoke("...")` / `invoke<T>("...")`. */
export function invokedCommands(source) {
  return [...source.matchAll(/\binvoke\s*(?:<[^>()]*>)?\s*\(\s*["'`](\w+)["'`]/g)].map((m) => m[1]);
}

/**
 * @param {{ registered: string[], supported: string[], unsupported: Record<string, string>,
 *   invoked: { file: string, name: string }[] }} input
 * @returns {string[]} problems; empty when the sets agree
 */
export function checkParity({ registered, supported, unsupported, invoked }) {
  const problems = [];
  const reg = new Set(registered);
  const sup = new Set(supported);
  for (const name of registered.filter((n, i) => registered.indexOf(n) !== i)) {
    problems.push(`${name}: registered twice in generate_handler!`);
  }
  for (const name of supported.filter((n, i) => supported.indexOf(n) !== i)) {
    problems.push(`${name}: listed twice in supported`);
  }
  for (const name of reg) {
    if (name in unsupported) problems.push(`${name}: registered but listed as unsupported`);
    else if (!sup.has(name)) problems.push(`${name}: registered but missing from supported`);
  }
  for (const name of sup) {
    if (name in unsupported) problems.push(`${name}: listed as both supported and unsupported`);
    if (!reg.has(name)) problems.push(`${name}: supported but not registered in generate_handler!`);
  }
  for (const { file, name } of invoked) {
    if (!sup.has(name)) problems.push(`${name}: invoked in ${file} but not a supported command`);
  }
  return problems;
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { supported, unsupported } = JSON.parse(readFileSync(join(root, "src-tauri/commands.json"), "utf8"));
  const registered = registeredCommands(readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8"));
  const invoked = sourceFiles(join(root, "src"))
    .filter((path) => !path.endsWith("devMock.ts"))
    .flatMap((path) => {
      const file = relative(root, path).replaceAll("\\", "/");
      return invokedCommands(readFileSync(path, "utf8")).map((name) => ({ file, name }));
    });
  const problems = checkParity({ registered, supported, unsupported, invoked });
  if (problems.length > 0) {
    console.error("Command parity failed (src-tauri/commands.json):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Command parity OK: ${supported.length} supported, ${Object.keys(unsupported).length} unsupported.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
