// Guards the single document write path (architecture v3 §4.7): app code
// writes sketches, storyboards and notes through engine/document_writer.rs.
// Callers that still use the legacy project::write_* helpers are listed below
// until their own units move them. Byte-preserving moves and copies
// (project::rename_project_asset, commands/project.rs transfer_asset, agent
// project copies) aren't
// edits; they join multi-file transactions in 4.9.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_ROOT = "src-tauri/src";

/** Files that may still call project::write_sketch/write_storyboard/write_note. */
export const LEGACY_WRITERS = new Map([
  ["engine/project.rs", "defines the helpers, which delegate to the writer"],
  ["engine/document_goldens.rs", "test-only goldens"],
]);

/** Document command files: raw fs mutations there must be marked asset writes. */
export const DOCUMENT_COMMANDS = [
  "commands/sketch.rs",
  "commands/storyboard.rs",
  "commands/note.rs",
  "engine/agent/tools.rs",
  "engine/agent/document_ops.rs",
];

/** project.rs helpers that must stay thin wrappers over the writer. */
export const DELEGATING_HELPERS = [
  "write_sketch",
  "write_storyboard",
  "write_note",
  "delete_sketch",
  "delete_storyboard",
  "delete_note",
  "save_upgraded_storyboard",
];

export const ASSET_MARKER = "// asset write";

const LEGACY_CALL = /(?<!\bfn\s+)\b(?:project::)?(write_sketch|write_storyboard|write_note)\s*\(/g;
const FS_MUTATION =
  /\b(?:std::)?fs::(write|remove_file|remove_dir|remove_dir_all|rename|copy|create_dir|create_dir_all|File::create|OpenOptions)\b|\bFile::create\b|\bOpenOptions::new\b/;

/**
 * Blanks string literals, char literals and comments so brace matching and
 * pattern checks only see code. Keeps offsets and newlines.
 */
export function maskNonCode(text) {
  const out = text.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i, i + 3);
    if (rest.startsWith("//")) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (rest.startsWith("/*")) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (/^b?r#*"/.test(text.slice(i, i + 32)) && !/\w/.test(text[i - 1] ?? "")) {
      const [prefix] = /^b?r(#*)"/.exec(text.slice(i, i + 32));
      const hashes = prefix.length - prefix.indexOf("r") - 2;
      const close = `"${"#".repeat(hashes)}`;
      const end = text.indexOf(close, i + prefix.length);
      const stop = end === -1 ? text.length : end + close.length;
      blank(i, stop);
      i = stop;
    } else if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      blank(i, j + 1);
      i = j + 1;
    } else if (text[i] === "'" && /^'(\\.|[^\\'])'/.test(text.slice(i, i + 4))) {
      const len = text[i + 1] === "\\" ? 4 : 3;
      blank(i, i + len);
      i += len;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

function matchBrace(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}" && --depth === 0) return i;
  }
  return code.length - 1;
}

/** Masks every `#[cfg(test)]` item, so test fixtures may write freely. */
export function maskTests(code) {
  const out = code.split("");
  const attr = /#\[cfg\(test\)\]/g;
  let match;
  while ((match = attr.exec(code))) {
    const brace = code.indexOf("{", match.index);
    const semi = code.indexOf(";", match.index);
    const end = semi !== -1 && (brace === -1 || semi < brace) ? semi : matchBrace(code, brace);
    for (let i = match.index; i <= end; i += 1) if (out[i] !== "\n") out[i] = " ";
    attr.lastIndex = end + 1;
  }
  return out.join("");
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** 1-based lines in [from, to] that mutate the filesystem without the asset marker. */
function unmarkedMutations(code, lines, from = 1, to = Infinity) {
  const found = [];
  code.split("\n").forEach((line, index) => {
    const number = index + 1;
    if (number < from || number > to || !FS_MUTATION.test(line)) return;
    if (![lines[index], lines[index - 1] ?? ""].some((l) => l.includes(ASSET_MARKER))) found.push(number);
  });
  return found;
}

function fnBody(code, name) {
  const decl = new RegExp(`\\bfn ${name}\\b`).exec(code);
  if (!decl) return null;
  const open = code.indexOf("{", decl.index);
  return { start: open, end: matchBrace(code, open) };
}

/**
 * @param {{ path: string, text: string }[]} files paths relative to SOURCE_ROOT, `/`-separated
 * @returns {string[]} problems
 */
export function checkDocumentWrites(files) {
  const problems = [];
  for (const { path, text } of files) {
    const normalized = text.replace(/\r\n/g, "\n");
    const code = maskTests(maskNonCode(normalized));

    if (!LEGACY_WRITERS.has(path)) {
      for (const call of code.matchAll(LEGACY_CALL)) {
        problems.push(
          `${path}:${lineOf(code, call.index)}: ${call[1]} bypasses the document writer; use engine::document_writer`,
        );
      }
    }

    const lines = normalized.split("\n");
    if (DOCUMENT_COMMANDS.includes(path)) {
      for (const line of unmarkedMutations(code, lines)) {
        problems.push(
          `${path}:${line}: raw filesystem write in a document command; use engine::document_writer or mark an asset write with "${ASSET_MARKER}"`,
        );
      }
    }

    if (path === "engine/project.rs") {
      for (const name of DELEGATING_HELPERS) {
        const body = fnBody(code, name);
        if (!body) {
          problems.push(`${path}: ${name} is missing; update DELEGATING_HELPERS`);
          continue;
        }
        for (const line of unmarkedMutations(code, lines, lineOf(code, body.start), lineOf(code, body.end))) {
          problems.push(`${path}:${line}: ${name} writes the filesystem directly; delegate to engine::document_writer`);
        }
      }
    }
  }
  return problems;
}

function rustFiles(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return rustFiles(full, root);
    if (!entry.name.endsWith(".rs")) return [];
    return [{ path: relative(root, full).split(sep).join("/"), text: readFileSync(full, "utf8") }];
  });
}

function main() {
  const files = rustFiles(SOURCE_ROOT);
  const problems = checkDocumentWrites(files);
  for (const required of [...LEGACY_WRITERS.keys(), ...DOCUMENT_COMMANDS]) {
    if (!files.some((file) => file.path === required)) {
      problems.push(`${required} not found; update scripts/check-document-writes.mjs`);
    }
  }
  if (problems.length > 0) {
    console.error("Document writes must go through engine/document_writer.rs:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Document writes OK: ${files.length} Rust files checked.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
