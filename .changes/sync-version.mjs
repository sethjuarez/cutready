/**
 * Postversion hook for Covector.
 *
 * Reads the version from src-tauri/Cargo.toml (source of truth after
 * covector bumps it) and syncs it to package.json and
 * src-tauri/tauri.conf.json. Also moves the CHANGELOG to the repo root
 * if covector created it in src-tauri/.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Read version from Cargo.toml
const cargoPath = resolve(root, "src-tauri", "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const match = cargo.match(/^version\s*=\s*"([^"]+)"/m);
if (!match) {
  console.error("Could not find version in Cargo.toml");
  process.exit(1);
}
const version = match[1];
console.log(`Syncing version ${version} to package.json and tauri.conf.json`);

// Update package.json
const pkgPath = resolve(root, "package.json");
const pkg = readFileSync(pkgPath, "utf8");
writeFileSync(pkgPath, pkg.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));

// Update tauri.conf.json
const tauriPath = resolve(root, "src-tauri", "tauri.conf.json");
const tauri = readFileSync(tauriPath, "utf8");
writeFileSync(tauriPath, tauri.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));

// Merge CHANGELOG from src-tauri/ into root if covector created one there
const subChangelog = resolve(root, "src-tauri", "CHANGELOG.md");
const rootChangelog = resolve(root, "CHANGELOG.md");
if (existsSync(subChangelog)) {
  const newContent = readFileSync(subChangelog, "utf8");
  if (existsSync(rootChangelog)) {
    // Append new entries after the root changelog header
    const existing = readFileSync(rootChangelog, "utf8");
    // Extract everything after "# Changelog" header from new content
    const newEntries = newContent.replace(/^# Changelog\s*\n*/i, "");
    // Extract everything after the header from existing
    const existingEntries = existing.replace(/^# Changelog\s*\n*/i, "");
    writeFileSync(rootChangelog, `# Changelog\n\n${newEntries}\n${existingEntries}`);
  } else {
    renameSync(subChangelog, rootChangelog);
  }
  if (existsSync(subChangelog)) unlinkSync(subChangelog);
  console.log("Merged CHANGELOG.md to repo root.");
}

console.log("Version sync complete.");
