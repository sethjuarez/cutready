// IPC ratchet (architecture v3 F2). Components, hooks and stores should
// reach the backend through typed wrappers in src/ipc/ (F4), not raw
// `invoke`. Files that import `invoke` today are capped at their current
// number of calls in scripts/ipc-imports.json; new files may not import it.
// Caps only go down: run `node scripts/check-ipc-imports.mjs --update` after
// moving calls into src/ipc/.
//
// Events follow the same rule without caps (F4): only src/ipc/events.ts may
// import `listen`/`once`/`emit`/`emitTo`; everyone else uses its typed
// `listenEvent`/`emitEvent`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

function isTauriCore(specifier) {
  return specifier === "@tauri-apps/api/core" || /(^|\/)(services\/)?tauri$/.test(specifier);
}

const EVENT_FUNCTIONS = new Set(["listen", "once", "emit", "emitTo"]);

/** Files that hand raw `listen` to a library rather than naming events. */
export const EVENT_IMPORT_ALLOWLIST = {
  "src/services/draftlineVersioning.ts": "passes listen to the Draftline client, which names its own events",
};

function isEventModule(specifier) {
  return specifier === "@tauri-apps/api/event" || /(^|\/)(services\/)?tauri$/.test(specifier);
}

/**
 * Files that may import raw event functions: the typed event module and the
 * same plumbing/test exemptions as invoke. Other src/ipc/ modules may not.
 */
export function isEventExempt(path) {
  return path === "src/ipc/events.ts" || (isExempt(path) && !path.startsWith("src/ipc/"));
}

function moduleName(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function isDynamicLoad(node) {
  return (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
    isEventModule(moduleName(node.arguments[0]) ?? "")
  );
}

function unwrap(node) {
  while (node && (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression;
  return node;
}

/**
 * Raw event functions a file imports or re-exports (`listen`, `emit`, …),
 * `ns.*` for namespace imports and `*` for star re-exports. Covers static
 * imports, re-exports, `import x = require()`, and `import()`/`require()`
 * calls (destructured names, or `*` when the whole module is kept).
 */
export function eventImports(text) {
  const source = ts.createSourceFile("file.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const named = (elements) => {
    for (const element of elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && EVENT_FUNCTIONS.has(imported)) found.push(imported);
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && isEventModule(moduleName(node.moduleSpecifier) ?? "")) {
      const clause = node.importClause;
      const bindings = clause && !clause.isTypeOnly ? clause.namedBindings : undefined;
      if (bindings && ts.isNamespaceImport(bindings)) found.push(`${bindings.name.text}.*`);
      else if (bindings) named(bindings.elements);
      return;
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && isEventModule(moduleName(node.moduleSpecifier) ?? "")) {
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) found.push("*");
      else named(node.exportClause.elements);
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isEventModule(moduleName(node.moduleReference.expression) ?? "")
    ) {
      found.push(`${node.name.text}.*`);
      return;
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isDynamicLoad(unwrap(node.initializer))) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const imported = element.propertyName ?? element.name;
          if (ts.isIdentifier(imported) && EVENT_FUNCTIONS.has(imported.text)) found.push(imported.text);
        }
      } else {
        found.push("*");
      }
      return;
    }
    if (isDynamicLoad(node)) {
      found.push("*");
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Problems for `imports` ({path: [names]}, files with raw event imports only). */
export function checkEventImports(imports, allowlist = EVENT_IMPORT_ALLOWLIST) {
  return Object.entries(imports)
    .filter(([path]) => !(path in allowlist))
    .map(([path, names]) => `${path}: imports ${names.join(", ")}; use listenEvent/emitEvent from src/ipc/events.ts`);
}

/** Local names `invoke` is imported as, or [] when the file doesn't import it. */
export function invokeNames(text) {
  const source = ts.createSourceFile("file.tsx", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const names = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!isTauriCore(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      names.push(`${bindings.name.text}.invoke`);
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "invoke") names.push(element.name.text);
    }
  }
  return names;
}
/**
 * `text` with comments and string/template text blanked (template `${…}`
 * code kept), so calls are only counted in code. Offsets are preserved.
 */
export function maskCode(text) {
  const out = [...text];
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  // Each entry is "`" (inside template text) or a brace depth inside `${…}`.
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const inTemplate = stack.at(-1) === "`";
    if (inTemplate) {
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
      } else if (c === "`") {
        stack.pop();
        i++;
      } else if (c === "$" && text[i + 1] === "{") {
        stack.push(0);
        i += 2;
      } else {
        blank(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else if (c === "`") {
      stack.push("`");
      i++;
    } else if (c === "{" && stack.length) {
      stack[stack.length - 1]++;
      i++;
    } else if (c === "}" && stack.length) {
      if (stack.at(-1) === 0) stack.pop();
      else stack[stack.length - 1]--;
      i++;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Number of raw `invoke(` / `invoke<T>(` calls, or null when `invoke` isn't imported. */
export function countInvokes(text) {
  const names = invokeNames(text);
  if (names.length === 0) return null;
  const code = maskCode(text);
  return names.reduce(
    (total, name) =>
      total +
      [...code.matchAll(new RegExp(`(?<![\\w$])(?<!\\.\\s*)${name.replace(/\$/g, "\\$").replace(".", "\\s*\\.\\s*")}\\s*[<(]`, "g"))]
        .length,
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
  const events = {};
  for (const full of walk(join(cwd, "src"))) {
    const path = relative(cwd, full).split(sep).join("/");
    if (!/\.tsx?$/.test(path)) continue;
    const text = readFileSync(full, "utf8");
    if (!isExempt(path)) {
      const calls = countInvokes(text);
      if (calls !== null) counts[path] = calls;
    }
    if (isEventExempt(path)) continue;
    const names = eventImports(text);
    if (names.length > 0) events[path] = names;
  }
  return { counts, events };
}

function serialize(caps) {
  return `${JSON.stringify(Object.fromEntries(Object.entries(caps).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;
}

function main() {
  const caps = JSON.parse(readFileSync(CAP_FILE, "utf8"));
  const { counts, events } = measure();
  if (process.argv.includes("--update")) {
    writeFileSync(CAP_FILE, serialize(updateCaps(counts, caps)));
    console.log(`Updated ${CAP_FILE}.`);
    return;
  }
  const problems = [...checkIpcImports(counts, caps), ...checkEventImports(events)];
  if (problems.length > 0) {
    console.error("Raw IPC ratchet:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const total = Object.values(counts).reduce((sum, calls) => sum + calls, 0);
  console.log(`IPC imports OK: ${Object.keys(counts).length} files, ${total} raw invoke calls.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
