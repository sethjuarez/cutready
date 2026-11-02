// Guards the single document write path (architecture v3 §4.7): app code
// writes sketches, storyboards and notes through engine/document_writer.rs.
// Callers that still use the legacy project::write_* helpers are listed below
// until their own units move them. Byte-preserving moves and copies
// (project::rename_project_asset, commands/project.rs transfer_asset, agent
// project copies) aren't
// edits; they join multi-file transactions in 4.9.
// Writes serialize on the repository file lock (engine/write_lock.rs, 4.9c);
// the old in-process workspace mutex must not come back.
// Every write states what it expects on disk (4.13, ADR 0002 "App saves"):
// `Expected::Unchecked` appears only in document_writer::import_document, and
// only the import functions listed below may call that. Raw filesystem writes
// in document code are marked `// asset write`, and only the asset helpers
// listed below may carry the mark.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_ROOT = "src-tauri/src";

/** Files that may still call project::write_sketch/write_storyboard/write_note. */
export const LEGACY_WRITERS = new Map([["engine/document_goldens.rs", "test-only goldens"]]);

/** The writer itself, whose write_* functions are the way in. */
export const WRITER = "engine/document_writer.rs";

/** The one function that may write without checking what's on disk. */
export const UNCHECKED_ENTRY = "import_document";

/** Functions that may call it, by file: importing a document replaces whatever is there. */
export const IMPORTERS = new Map([
  [
    "commands/import.rs",
    ["import_docx", "import_pdf", "import_pptx", "import_markdown", "import_sketch", "import_storyboard"],
  ],
  ["engine/video_import.rs", ["import_video_from_sidecar_with_progress"]],
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
  "delete_sketch",
  "delete_storyboard",
  "delete_note",
  "save_upgraded_storyboard",
];

export const ASSET_MARKER = "// asset write";

/** Functions whose raw filesystem writes are asset writes (images, visuals, copies), by file. */
export const ASSET_WRITERS = new Map([
  ["commands/sketch.rs", ["write_visual_doc"]],
  ["commands/note.rs", ["save_pasted_image", "delete_project_image", "delete_orphaned_images", "import_image"]],
  ["engine/agent/tools.rs", ["copy_optional_project_asset", "copy_project_file", "exec_write_note"]],
  ["engine/project.rs", ["delete_note"]],
]);

/** The in-process write mutex that engine/write_lock.rs replaced. */
const IN_PROCESS_LOCK = /\b(workspace_write_lock|ProjectLock)\b/g;

const LEGACY_CALL =
  /(?<!\bfn\s+|document_writer::)\b(?:project::)?(write_sketch|write_storyboard|write_note)\s*\(/g;
const UNCHECKED = /\bUnchecked\b/g;
const UNCHECKED_CALL = new RegExp(`(?<!\\bfn\\s+)\\b${UNCHECKED_ENTRY}\\s*\\(`, "g");
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

const TEST_FILE = /_tests\.rs$/;

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

function fnBody(code, name) {
  const decl = new RegExp(`\\bfn ${name}\\b`).exec(code);
  if (!decl) return null;
  const open = code.indexOf("{", decl.index);
  return { start: open, end: matchBrace(code, open) };
}

/** Bodies of the named functions in `code`, as offset ranges. */
function fnBodies(code, names = []) {
  return names.map((name) => fnBody(code, name)).filter(Boolean);
}

const within = (ranges, index) => ranges.some((range) => index > range.start && index < range.end);

/**
 * 1-based lines in [from, to] that mutate the filesystem without an asset
 * marker, or whose marker sits outside the allowed asset helpers (`assetBodies`).
 */
function unmarkedMutations(code, lines, assetBodies, from = 1, to = Infinity) {
  const found = [];
  let offset = 0;
  code.split("\n").forEach((line, index) => {
    const number = index + 1;
    const start = offset;
    offset += line.length + 1;
    if (number < from || number > to || !FS_MUTATION.test(line)) return;
    const marked = [lines[index], lines[index - 1] ?? ""].some((l) => l.includes(ASSET_MARKER));
    if (!marked) found.push({ line: number, marked });
    else if (!within(assetBodies, start + line.search(FS_MUTATION))) found.push({ line: number, marked });
  });
  return found;
}

function mutationProblem(path, { line, marked }, unmarked) {
  return marked
    ? `${path}:${line}: "${ASSET_MARKER}" is only for the asset helpers in ASSET_WRITERS; use engine::document_writer or add the helper there`
    : `${path}:${line}: ${unmarked}`;
}

/**
 * @param {{ path: string, text: string }[]} files paths relative to SOURCE_ROOT, `/`-separated
 * @returns {string[]} problems
 */
export function checkDocumentWrites(files) {
  const problems = [];
  for (const { path, text } of files) {
    const normalized = text.replace(/\r\n/g, "\n");
    // A `*_tests.rs` file is a `#[cfg(test)]` module split out of its parent.
    const code = TEST_FILE.test(path) ? "" : maskTests(maskNonCode(normalized));

    if (!LEGACY_WRITERS.has(path) && path !== WRITER) {
      for (const call of code.matchAll(LEGACY_CALL)) {
        problems.push(
          `${path}:${lineOf(code, call.index)}: ${call[1]} bypasses the document writer; use engine::document_writer`,
        );
      }
    }

    for (const use of maskNonCode(normalized).matchAll(IN_PROCESS_LOCK)) {
      problems.push(
        `${path}:${lineOf(normalized, use.index)}: ${use[1]} is gone; take engine::write_lock::lock(root)`,
      );
    }

    const entry = path === WRITER ? fnBody(code, UNCHECKED_ENTRY) : null;
    for (const use of code.matchAll(UNCHECKED)) {
      if (entry && use.index > entry.start && use.index < entry.end) continue;
      problems.push(
        `${path}:${lineOf(code, use.index)}: Expected::Unchecked overwrites edits made since the read; pass Expected::Version or Expected::Absent`,
      );
    }
    if (path !== WRITER) {
      const importers = fnBodies(code, IMPORTERS.get(path));
      for (const call of code.matchAll(UNCHECKED_CALL)) {
        if (within(importers, call.index)) continue;
        problems.push(
          `${path}:${lineOf(code, call.index)}: ${UNCHECKED_ENTRY} is for importing documents only; use document_writer::save or edit`,
        );
      }
    }

    const lines = normalized.split("\n");
    const assetBodies = fnBodies(code, ASSET_WRITERS.get(path));
    if (DOCUMENT_COMMANDS.includes(path)) {
      for (const found of unmarkedMutations(code, lines, assetBodies)) {
        problems.push(
          mutationProblem(path, found, `raw filesystem write in a document command; use engine::document_writer or mark an asset write with "${ASSET_MARKER}"`),
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
        for (const found of unmarkedMutations(code, lines, assetBodies, lineOf(code, body.start), lineOf(code, body.end))) {
          problems.push(mutationProblem(path, found, `${name} writes the filesystem directly; delegate to engine::document_writer`));
        }
      }
    }
  }
  const writer = files.find((file) => file.path === WRITER);
  if (writer && !fnBody(maskTests(maskNonCode(writer.text.replace(/\r\n/g, "\n"))), UNCHECKED_ENTRY)) {
    problems.push(`${WRITER}: ${UNCHECKED_ENTRY} is missing; update scripts/check-document-writes.mjs`);
  }
  return problems;
}

/** Allowlisted importer and asset-helper functions that no longer exist. */
export function missingAllowlisted(files) {
  const problems = [];
  for (const [path, names] of [...IMPORTERS, ...ASSET_WRITERS]) {
    const file = files.find((candidate) => candidate.path === path);
    if (!file) continue;
    const code = maskTests(maskNonCode(file.text.replace(/\r\n/g, "\n")));
    for (const name of names) {
      if (!fnBody(code, name)) problems.push(`${path}: ${name} is missing; update scripts/check-document-writes.mjs`);
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
  const problems = [...checkDocumentWrites(files), ...missingAllowlisted(files)];
  for (const required of [...LEGACY_WRITERS.keys(), WRITER, ...IMPORTERS.keys(), ...DOCUMENT_COMMANDS]) {
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
