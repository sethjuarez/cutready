#!/usr/bin/env node
// Renders an Elucim visual to a PNG frame sequence plus a `frames.json`
// manifest for video export. Reads a JSON payload on stdin:
//   { document? | visualPath, outputDir, theme?: "light" | "dark", fps?, maxFrames?, scale? }
// `document` (already normalized to version 2.0) wins over `visualPath`.
// and prints { manifestPath, frameCount, sourceFps, totalFrames } on stdout.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { exportFrames, planFrameExport } from "@elucim/cli";
import { themeToVars } from "@elucim/dsl";

const CUTREADY_LIGHT = {
  foreground: "#2c2925",
  background: "#fbfaf8",
  title: "#2c2925",
  subtitle: "#706a62",
  accent: "#6f63e8",
  muted: "#706a62",
  surface: "#f3f0ec",
  border: "#ded8cf",
  primary: "#6f63e8",
  secondary: "#7c3aed",
  tertiary: "#db2777",
  success: "#16a34a",
  warning: "#d97706",
  error: "#dc2626",
};

const CUTREADY_DARK = {
  foreground: "#eee9e2",
  background: "#272421",
  title: "#eee9e2",
  subtitle: "#b4aca2",
  accent: "#aaa0ff",
  muted: "#b4aca2",
  surface: "#312d29",
  border: "#49433d",
  primary: "#aaa0ff",
  secondary: "#a78bfa",
  tertiary: "#f472b6",
  success: "#34d399",
  warning: "#fbbf24",
  error: "#f87171",
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function resolveThemeString(value, theme, vars, themeName) {
  const token = /^\$([\w-]+)$/.exec(value.trim());
  if (token) return theme[token[1]] ?? value;
  let resolved = value;
  for (let pass = 0; pass < 4 && resolved.includes("var("); pass += 1) {
    resolved = resolved.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (match, name, fallback) => (
      vars[name] ?? (fallback?.trim() || match)
    ));
  }
  return resolved.replace(/light-dark\(\s*([^,()]+?)\s*,\s*([^()]+?)\s*\)/g, themeName === "dark" ? "$2" : "$1");
}

// The headless renderer has no theme input, so bake CutReady's palette into
// `$token`, `var(--…)` and `light-dark()` paints before rendering.
export function applyTheme(value, theme, themeName = "light", vars = themeToVars(theme)) {
  if (typeof value === "string") return resolveThemeString(value, theme, vars, themeName);
  if (Array.isArray(value)) return value.map((item) => applyTheme(item, theme, themeName, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, applyTheme(item, theme, themeName, vars)]),
    );
  }
  return value;
}

// Video frames have no page behind them, so a missing or transparent scene
// background would encode as black; paint the theme background instead.
export function prepareDocument(raw, theme, themeName, fallbackFps) {
  if (!raw || typeof raw !== "object" || !raw.scene || typeof raw.scene !== "object") {
    throw new Error("Elucim visual must be a version 2.0 document with a `scene`; normalize legacy visuals first");
  }
  const document = applyTheme(raw, theme, themeName);
  const background = typeof document.scene.background === "string" ? document.scene.background.trim() : "";
  const scene = { ...document.scene };
  if (!background || background === "transparent" || background === "none") scene.background = theme.background;
  if (!(Number(scene.fps) > 0) && Number(fallbackFps) > 0) scene.fps = Number(fallbackFps);
  return { ...document, scene };
}

// Evenly samples `count` frame indices from 0..count-1, keeping both ends.
export function frameSamples(count, maxFrames) {
  const total = Math.max(1, Math.floor(count));
  const max = Math.max(1, Math.floor(maxFrames));
  if (total <= max) return Array.from({ length: total }, (_, index) => index);
  if (max === 1) return [0];
  const samples = new Set();
  for (let index = 0; index < max; index += 1) {
    samples.add(Math.round((index * (total - 1)) / (max - 1)));
  }
  return [...samples].sort((left, right) => left - right);
}

export async function renderFrameManifest(payload) {
  const { visualPath, outputDir } = payload;
  if ((!visualPath && !payload.document) || !outputDir) {
    throw new Error("outputDir and either document or visualPath are required");
  }

  const themeName = payload.theme === "dark" ? "dark" : "light";
  const theme = themeName === "dark" ? CUTREADY_DARK : CUTREADY_LIGHT;
  const raw = payload.document ?? JSON.parse(await readFile(visualPath, "utf8"));
  const document = prepareDocument(raw, theme, themeName, payload.fps);
  // Render at the document's own rate; the plan covers frames 0..duration, so
  // the last sample is the timeline's final state.
  const plan = planFrameExport(document);
  const samples = frameSamples(plan.frames.length, payload.maxFrames ?? 180);
  const scale = Number(payload.scale) || 2;
  const result = await exportFrames(document, {
    outDir: outputDir,
    frames: samples,
    width: Math.max(1, Math.round((Number(document.scene?.width) || 960) * scale)),
  });

  const frames = result.files.map((file, index) => {
    const next = samples[index + 1];
    return {
      path: path.basename(file),
      durationMs: next == null ? 0 : Math.max(1, Math.round(((next - samples[index]) * 1000) / plan.documentFps)),
      terminal: next == null,
    };
  });
  const manifestPath = path.join(outputDir, "frames.json");
  await writeFile(manifestPath, `${JSON.stringify({ frames }, null, 2)}\n`, "utf8");
  return { manifestPath, frameCount: frames.length, sourceFps: plan.documentFps, totalFrames: plan.frames.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readStdin()
    .then((input) => renderFrameManifest(JSON.parse(input)))
    .then((output) => process.stdout.write(JSON.stringify(output)))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exit(1);
    });
}
