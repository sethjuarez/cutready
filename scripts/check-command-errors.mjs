// Command error ratchet (architecture v3 F7, ADR 0003). Tauri commands
// should reject with the typed `CmdError` envelope, not a bare `String`.
// Command modules that still have `Result<_, String>` commands are capped at
// their current number in scripts/command-errors.json; other modules may not
// add any. Caps only go down: run `node scripts/check-command-errors.mjs
// --update` after converting commands.
//
// project.rs and agent.rs are fully converted. Their only String commands are
// the sign-in/token commands named in STRING_ALLOWLIST, which need separate
// sign-off before they change.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { maskNonCode, maskTests } from "./check-document-writes.mjs";

export const CAP_FILE = "scripts/command-errors.json";
export const COMMANDS_DIR = "src-tauri/src/commands";

/** Files where only the listed commands may still return `Result<_, String>`. */
export const STRING_ALLOWLIST = {
  "src-tauri/src/commands/project.rs": [],
  "src-tauri/src/commands/agent.rs": [
    "copilot_sign_in",
    "azure_device_code_start",
    "azure_device_code_poll",
    "azure_token_refresh",
    "azure_browser_auth_start",
    "azure_browser_auth_complete",
    "list_azure_subscriptions",
    "list_azure_ai_resources",
    "list_foundry_projects",
  ],
};

const COMMAND_ATTR = /#\[\s*(?:tauri::command|auditaur_command)\b/g;

/** Index just past the bracket that closes the one at `open`, or -1. */
function closeOf(code, open, pairs = { "(": ")", "<": ">", "[": "]", "{": "}" }) {
  const stack = [];
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === "-" && code[i + 1] === ">") {
      i += 1;
      continue;
    }
    if (c in pairs) stack.push(pairs[c]);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Top-level comma-separated generic arguments of `Name<...>` in `type`, or null. */
export function genericArgs(type, name) {
  const match = new RegExp(`^(?:[\\w:]*::)?${name}\\s*<`).exec(type);
  if (!match) return null;
  const open = match[0].length - 1;
  const end = closeOf(type, open, { "<": ">", "(": ")", "[": "]" });
  if (end === -1) return null;
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < end - 1; i += 1) {
    const c = type[i];
    if (c === "-" && type[i + 1] === ">") {
      i += 1;
    } else if ("<([".includes(c)) depth += 1;
    else if (">)]".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) {
      args.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(type.slice(start, end - 1).trim());
  return args.filter(Boolean);
}

/** True when a return type is `Result<T, String>`. */
export function returnsStringError(returnType) {
  const args = genericArgs(returnType.trim(), "Result");
  return args !== null && args.length === 2 && /^(?:(?:std::)?string::)?String$/.test(args[1]);
}

/** Every `#[tauri::command]`/`#[auditaur_command]` fn outside tests: `{ name, returnType }`. */
export function commands(text) {
  const code = maskTests(maskNonCode(text));
  const found = [];
  let match;
  COMMAND_ATTR.lastIndex = 0;
  while ((match = COMMAND_ATTR.exec(code))) {
    const fn = /\bfn\s+(\w+)/g;
    fn.lastIndex = match.index;
    const name = fn.exec(code);
    if (!name) break;
    const params = code.indexOf("(", name.index);
    const paramsEnd = closeOf(code, params, { "(": ")" });
    if (paramsEnd === -1) break;
    const body = code.indexOf("{", paramsEnd);
    let signature = code.slice(paramsEnd, body === -1 ? code.length : body);
    signature = signature.split(/\bwhere\b/)[0];
    const arrow = signature.indexOf("->");
    found.push({ name: name[1], returnType: arrow === -1 ? "()" : signature.slice(arrow + 2).trim() });
    COMMAND_ATTR.lastIndex = body === -1 ? code.length : body;
  }
  return found;
}

/** Names of commands in `text` that still return `Result<_, String>`. */
export function stringCommands(text) {
  return commands(text)
    .filter((command) => returnsStringError(command.returnType))
    .map((command) => command.name);
}

/**
 * Problems for `found` ({path: [String-returning command names]}, every
 * command module) against `caps` ({path: max}) and the per-file allowlist.
 */
export function checkCommandErrors(found, caps, allowlist = STRING_ALLOWLIST) {
  const problems = [];
  for (const [path, names] of Object.entries(found)) {
    const allowed = allowlist[path];
    if (allowed) {
      for (const name of names) {
        if (!allowed.includes(name)) {
          problems.push(`${path}: ${name} returns Result<_, String>; return CmdError instead (ADR 0003)`);
        }
      }
    }
    const cap = caps[path] ?? 0;
    if (names.length > cap) {
      problems.push(
        `${path}: ${names.length} commands return Result<_, String>, over its cap of ${cap}; return CmdError instead (ADR 0003)`,
      );
    } else if (names.length < cap) {
      problems.push(`${path}: ${names.length} String-error commands, under its cap of ${cap}; run --update to lower it`);
    }
  }
  for (const path of Object.keys(caps)) {
    if (!(path in found) && caps[path] > 0) {
      problems.push(`${path}: capped but has no String-error commands; run --update to drop it`);
    }
  }
  return problems;
}

/** Lowers caps to current counts and drops files that reached zero. Never raises one. */
export function updateCaps(found, caps) {
  const next = {};
  for (const [path, cap] of Object.entries(caps)) {
    const count = Math.min(cap, found[path]?.length ?? 0);
    if (count > 0) next[path] = count;
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

/** {path: [names]} for every command module with String-error commands. */
export function measure(cwd = process.cwd()) {
  const found = {};
  for (const full of walk(join(cwd, COMMANDS_DIR))) {
    const path = relative(cwd, full).split(sep).join("/");
    if (!path.endsWith(".rs")) continue;
    const names = stringCommands(readFileSync(full, "utf8"));
    if (names.length > 0) found[path] = names;
  }
  return found;
}

function serialize(caps) {
  return `${JSON.stringify(Object.fromEntries(Object.entries(caps).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;
}

function main() {
  const caps = JSON.parse(readFileSync(CAP_FILE, "utf8"));
  const found = measure();
  if (process.argv.includes("--update")) {
    writeFileSync(CAP_FILE, serialize(updateCaps(found, caps)));
    console.log(`Updated ${CAP_FILE}.`);
    return;
  }
  const problems = checkCommandErrors(found, caps);
  if (problems.length > 0) {
    console.error("Command error ratchet:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const total = Object.values(found).reduce((sum, names) => sum + names.length, 0);
  console.log(`Command errors OK: ${total} String-error commands in ${Object.keys(found).length} files.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
