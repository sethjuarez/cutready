#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Resvg } from "@resvg/resvg-js";
import { renderToSvgString, themeToVars, toRenderableDocument } from "@elucim/dsl";

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

function extractSvg(markup) {
  const start = markup.indexOf("<svg");
  const end = markup.lastIndexOf("</svg>");
  if (start < 0 || end < 0) throw new Error("Elucim render did not produce an SVG");
  return markup.slice(start, end + "</svg>".length);
}

function injectTheme(svg, theme, themeName) {
  const vars = themeToVars(theme);
  let resolved = svg;
  for (let pass = 0; pass < 4; pass += 1) {
    resolved = resolved.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_match, name, fallback = "") => (
      vars[name] ?? (fallback.trim() || "none")
    ));
  }
  return resolved.replace(/light-dark\(\s*([^,]+)\s*,\s*([^)]+)\)/g, themeName === "dark" ? "$2" : "$1");
}

function resolvePaint(value, theme, themeName, fallback = "none") {
  if (typeof value !== "string" || value.trim() === "" || value.trim() === "transparent") return fallback;
  const trimmed = value.trim();
  if (trimmed.startsWith("$")) {
    return theme[trimmed.slice(1)] ?? fallback;
  }
  return injectTheme(trimmed, theme, themeName) || fallback;
}

function injectBackground(svg, renderable, theme, themeName, width, height) {
  const fill = resolvePaint(renderable.root?.background ?? renderable.scene?.background, theme, themeName, theme.background);
  const rect = `<rect width="${width}" height="${height}" fill="${fill}"></rect>`;
  return svg.replace(/<svg\b([^>]*)>/, `<svg$1>${rect}`);
}

function frameSamples(totalFrames, maxFrames) {
  const total = Math.max(1, Math.floor(totalFrames));
  const max = Math.max(1, Math.floor(maxFrames));
  if (total <= max) return Array.from({ length: total }, (_, index) => index);
  if (max === 1) return [0];
  const samples = new Set();
  for (let index = 0; index < max; index += 1) {
    samples.add(Math.round((index * (total - 1)) / (max - 1)));
  }
  return [...samples].sort((left, right) => left - right);
}

async function main() {
  const payload = JSON.parse(await readStdin());
  const visualPath = payload.visualPath;
  const outputDir = payload.outputDir;
  if (!visualPath || !outputDir) throw new Error("visualPath and outputDir are required");

  const document = JSON.parse(await readFile(visualPath, "utf8"));
  const renderable = toRenderableDocument(document);
  const root = renderable.root ?? {};
  const width = Number(root.width) || Number(renderable.scene?.width) || 960;
  const height = Number(root.height) || Number(renderable.scene?.height) || 540;
  const sourceFps = Number(root.fps) || Number(payload.fps) || 30;
  const totalFrames = Number(root.durationInFrames) || 1;
  const samples = frameSamples(totalFrames, payload.maxFrames ?? 180);
  const themeName = payload.theme === "dark" ? "dark" : "light";
  const theme = themeName === "dark" ? CUTREADY_DARK : CUTREADY_LIGHT;
  const scale = Number(payload.scale) || 2;

  await mkdir(outputDir, { recursive: true });
  const frames = [];
  for (let index = 0; index < samples.length; index += 1) {
    const frame = samples[index];
    const svg = injectBackground(
      injectTheme(extractSvg(renderToSvgString(renderable, frame, { width, height })), theme, themeName),
      renderable,
      theme,
      themeName,
      width,
      height,
    );
    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: Math.max(1, Math.round(width * scale)) },
    }).render().asPng();
    const fileName = `frame-${String(index).padStart(4, "0")}.png`;
    await writeFile(path.join(outputDir, fileName), png);
    const nextFrame = samples[index + 1];
    frames.push({
      path: fileName,
      durationMs: nextFrame == null ? 0 : Math.max(1, Math.round(((nextFrame - frame) * 1000) / sourceFps)),
      terminal: nextFrame == null,
    });
  }

  const manifestPath = path.join(outputDir, "frames.json");
  await writeFile(manifestPath, `${JSON.stringify({ frames }, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ manifestPath, frameCount: frames.length, sourceFps, totalFrames }));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
