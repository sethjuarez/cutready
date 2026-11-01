// Guards CLI/MCP output (architecture v3 §4.12c): every result the CLI prints
// or an MCP tool returns is a Typra model from contracts/cli.tsp, emitted via
// the sealed `Output` trait in crates/cutready-cli/src/output.rs. Building,
// serializing or printing JSON by hand is only allowed for MCP protocol
// framing (JSON-RPC envelopes, initialize, tool schemas, the tool-result
// wrapper, the stdio stream) marked `// mcp framing`, and plain-text
// --help/--version and stderr diagnostics marked `// plain text`, on the line or the one above.
// Tests assert every output round-trips through its model.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { maskNonCode, maskTests } from "./check-document-writes.mjs";

export const SOURCE_ROOT = "crates/cutready-cli/src";

/** The typed-output boundary itself. */
export const OUTPUT_MODULE = "output.rs";

export const FRAMING_MARKER = "// mcp framing";
export const PLAIN_TEXT_MARKER = "// plain text";

/** Which markers each file may use. */
export const MARKERS = {
  "mcp.rs": [FRAMING_MARKER],
  "main.rs": [FRAMING_MARKER, PLAIN_TEXT_MARKER],
};

const HAND_BUILT = [
  [/\bjson!/g, "json!"],
  [/\bValue::(Object|Array)\s*\(/g, "Value::Object/Array"],
  [/\b(?:serde_json::)?Map::(new|with_capacity)\b/g, "serde_json::Map"],
  [/\bserde_json::(to_value|to_string|to_string_pretty|to_vec|to_vec_pretty|to_writer|to_writer_pretty)\b/g, "serde_json serialization"],
  [/#\[derive\([^)]*\bSerialize\b/g, "derive(Serialize)"],
  [/\bserde_json::Serializer\b|\bSerializer::(new|pretty|with_formatter)\b/g, "serde_json::Serializer"],
  [/\be?print(ln)?!/g, "print!/println!/eprint!/eprintln!"],
  [/\bstd(out|err)\s*\(/g, "stdout()/stderr()"],
  // Display impls write to their Formatter `f`; any other sink is an output path.
  [/\bwrite(ln)?!\s*\((?!\s*f\s*,)/g, "write!/writeln!"],
  [/\bWrite\b/g, "io::Write"],
  [/\.write_all\s*\(/g, "write_all"],
  [/\.to_output\s*\(/g, "to_output()"],
  [/\bimpl\b[^{;]*\bOutput\s+for\b/g, "impl Output"],
];
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Problems for `files` ({path, text}, paths relative to SOURCE_ROOT). */
export function checkCliOutput(files) {
  const problems = [];
  for (const { path, text } of files) {
    if (path === OUTPUT_MODULE) continue;
    const lines = text.split("\n");
    const code = maskTests(maskNonCode(text));
    const markers = MARKERS[path] ?? [];
    const marked = (line) =>
      [lines[line - 1], lines[line - 2]].some((raw) => markers.some((marker) => raw?.includes(marker)));
    for (const [pattern, name] of HAND_BUILT) {
      for (const match of code.matchAll(pattern)) {
        const line = lineOf(code, match.index);
        if (marked(line)) continue;
        problems.push(
          `${path}:${line}: ${name} outside output.rs; return a contracts/cli.tsp model through output::Output` +
            (markers.length ? ` (or mark ${markers.map((marker) => `\`${marker}\``).join(" / ")})` : ""),
        );
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
  const problems = checkCliOutput(files);
  for (const required of [OUTPUT_MODULE, ...Object.keys(MARKERS)]) {
    if (!files.some((file) => file.path === required)) {
      problems.push(`${required} not found; update scripts/check-cli-output.mjs`);
    }
  }
  if (problems.length > 0) {
    console.error("CLI and MCP results must be contract models:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`CLI output OK: ${files.length} Rust files checked.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
