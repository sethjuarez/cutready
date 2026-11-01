// Keeps CutReady's supported Tauri command set explicit. Fails when
// `generate_handler!` in src-tauri/src/lib.rs and src-tauri/commands.json
// disagree, when an unsupported command is registered again, or when
// frontend code reaches a command that isn't supported, either directly
// (`invoke("x")`) or through a @draftline/client method.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Replaces Rust `//` and `/* *\/` comments with spaces, leaving string literals intact. */
export function stripComments(source) {
  let out = "";
  for (let i = 0; i < source.length; ) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (source.startsWith("//", i)) {
      const j = source.indexOf("\n", i);
      i = j < 0 ? source.length : j;
    } else if (source.startsWith("/*", i)) {
      const j = source.indexOf("*/", i + 2);
      const end = j < 0 ? source.length : j + 2;
      out += source.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Command names registered in the `generate_handler![...]` block. */
export function registeredCommands(libRs) {
  // Rust lifetimes ('a) would read as char literals; lib.rs has none inside the macro,
  // so strip comments from the macro onward only.
  const anchor = libRs.indexOf("generate_handler![");
  if (anchor < 0) throw new Error("generate_handler! not found in lib.rs");
  const code = stripComments(libRs.slice(anchor));
  const open = "generate_handler![".length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "[" || code[i] === "(") depth += 1;
    else if (code[i] === "]" || code[i] === ")") depth -= 1;
    if (depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) throw new Error("end of generate_handler! not found in lib.rs");
  // Attributes such as #[cfg(feature = "...")] gate entries; the entries still count.
  const block = code.slice(open + 1, close).replace(/#\[[^\]]*\]/g, "");
  return [...block.matchAll(/(?:\w+::)*(\w+)\s*(?:,|$)/g)].map((m) => m[1]);
}

/** Callees whose first argument is a Tauri command name. */
const COMMAND_CALLEES = ["invoke", "importWithConflict"];

/**
 * Literal command names passed to `invoke("...")`, `invoke<T>("...")`, any alias
 * such as `import { invoke as rawInvoke }`, and the helpers in COMMAND_CALLEES.
 */
export function invokedCommands(source) {
  const aliases = [...source.matchAll(/\binvoke\s+as\s+(\w+)/g)].map((m) => m[1]);
  const callees = [...new Set([...COMMAND_CALLEES, ...aliases])].join("|");
  const call = new RegExp(`(?<![\\w.])(?:${callees})\\s*(?:<[^>()]*>)?\\s*\\(\\s*["'\`](\\w+)["'\`]`, "g");
  return [...source.matchAll(call)].map((m) => m[1]);
}

/**
 * Maps @draftline/client method names to the Tauri commands they run: client
 * methods (`name: (...) => run('command'`) and host-facade methods (which call
 * `client.method(...)`).
 */
export function draftlineMethodCommands(clientJs) {
  const clientMethods = new Map(
    [...clientJs.matchAll(/(\w+):\s*\([^)]*\)\s*=>\s*run\(\s*['"](\w+)['"]/g)].map((m) => [m[1], m[2]]),
  );
  const methods = new Map([...clientMethods].map(([name, command]) => [name, new Set([command])]));
  const facadeStart = clientJs.indexOf("export function createDraftlineHostFacade");
  let current = null;
  for (const line of facadeStart < 0 ? [] : clientJs.slice(facadeStart).split("\n")) {
    const key = /^\s{8}(\w+):/.exec(line);
    if (key) current = key[1];
    if (!current) continue;
    for (const m of line.matchAll(/\bclient\.(\w+)\(/g)) {
      const command = clientMethods.get(m[1]);
      if (!command) continue;
      if (!methods.has(current)) methods.set(current, new Set());
      methods.get(current).add(command);
    }
  }
  if (clientMethods.size === 0) throw new Error("no Draftline client methods found; update draftlineMethodCommands");
  return methods;
}

/** Draftline facade/client method names called as `.method(` in a source file. */
export function calledMethods(source, methodNames) {
  return [...new Set([...source.matchAll(/\.(\w+)\s*\(/g)].map((m) => m[1]))].filter((name) => methodNames.has(name));
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
  const draftline = draftlineMethodCommands(
    readFileSync(join(root, "node_modules/@draftline/client/dist/index.js"), "utf8"),
  );
  const invoked = sourceFiles(join(root, "src"))
    .filter((path) => !path.endsWith("devMock.ts"))
    .flatMap((path) => {
      const file = relative(root, path).replaceAll("\\", "/");
      const source = readFileSync(path, "utf8");
      const direct = invokedCommands(source).map((name) => ({ file, name }));
      const viaDraftline = calledMethods(source, draftline).flatMap((method) =>
        [...draftline.get(method)].map((name) => ({ file: `${file} (Draftline .${method}())`, name })),
      );
      return [...direct, ...viaDraftline];
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
