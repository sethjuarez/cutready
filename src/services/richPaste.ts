/**
 * Rich Paste — converts clipboard HTML (from Word, web pages, etc.) to Markdown.
 *
 * Uses Turndown for HTML→Markdown conversion. Handles Word-specific cruft
 * (mso-* styles, <o:p> tags, <style> blocks) and optionally extracts
 * embedded base64 images, saving them to the project's screenshots directory.
 */
import TurndownService from "turndown";
// @ts-expect-error — no type declarations for turndown-plugin-gfm
import { gfm } from "turndown-plugin-gfm";
import { invoke } from "@tauri-apps/api/core";

// ─── Turndown instance (singleton) ──────────────────────────────────

let _turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (_turndown) return _turndown;

  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
  });

  // Enable GFM (tables, strikethrough, task lists)
  td.use(gfm);

  // Remove Word-specific junk elements
  td.remove(["style", "meta", "link", "title"]);

  // Strip <o:p> tags (Word XML namespace) — keep inner content
  td.addRule("wordOp", {
    filter: (node) => node.nodeName.toLowerCase() === "o:p",
    replacement: (_content, node) => (node as HTMLElement).textContent ?? "",
  });

  // Strip <span> with mso-* styles that add no semantic value
  td.addRule("wordSpans", {
    filter: (node) => {
      if (node.nodeName.toLowerCase() !== "span") return false;
      const style = (node as HTMLElement).getAttribute("style") ?? "";
      // Keep spans that have meaningful formatting; skip pure-Word ones
      return style.includes("mso-") && !style.includes("font-weight") && !style.includes("font-style");
    },
    replacement: (_content, node) => (node as HTMLElement).textContent ?? "",
  });

  _turndown = td;
  return td;
}

// ─── Word HTML cleanup (pre-Turndown) ──────────────────────────────

function cleanWordHtml(html: string): string {
  let cleaned = html;

  // Remove everything before <body> (Word dumps <html><head>...)
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) cleaned = bodyMatch[1];

  // Strip XML namespace declarations
  cleaned = cleaned.replace(/<\?xml[^>]*\?>/gi, "");
  cleaned = cleaned.replace(/<\/?o:[^>]*>/gi, ""); // <o:p>, </o:p>
  cleaned = cleaned.replace(/<\/?v:[^>]*>/gi, ""); // VML shapes
  cleaned = cleaned.replace(/<\/?w:[^>]*>/gi, ""); // Word-specific

  // Strip <style>...</style> blocks
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Strip class attributes (Word generates class="MsoNormal" etc.)
  cleaned = cleaned.replace(/\s+class="[^"]*"/gi, "");

  // Strip mso-* inline styles but keep the rest
  cleaned = cleaned.replace(/\s*mso-[^;:"]+:[^;"]+(;?)/gi, "");

  // Remove empty style attributes left after stripping
  cleaned = cleaned.replace(/\s+style="\s*"/gi, "");

  // Collapse excessive <br> tags
  cleaned = cleaned.replace(/(<br\s*\/?>){3,}/gi, "<br><br>");

  // Strip all remaining style attributes (Word leaves border/padding cruft
  // that prevents Turndown GFM from recognizing tables)
  cleaned = cleaned.replace(/\s+style="[^"]*"/gi, "");

  // Normalize Word tables for Turndown GFM compatibility:
  // Turndown requires <thead>/<th> to convert tables to Markdown.
  // Word uses <td><b>Header</b></td> for the first row instead.
  cleaned = normalizeWordTables(cleaned);

  return cleaned.trim();
}

/**
 * Normalize Word-style tables so Turndown's GFM plugin can convert them.
 *
 * Word tables use <td> for all cells (no <thead>/<th>). The GFM plugin
 * requires a <thead> with <th> elements to recognize a Markdown table.
 *
 * Strategy: Use DOMParser to find tables without <thead>, promote the first
 * row to <thead> with <th> cells, and wrap remaining rows in <tbody>.
 */
function normalizeWordTables(html: string): string {
  // Quick check — no tables means nothing to do
  if (!/<table/i.test(html)) return html;

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const tables = doc.querySelectorAll("table");

  for (const table of tables) {
    // Skip tables that already have a proper thead
    if (table.querySelector("thead")) continue;

    const rows = table.querySelectorAll("tr");
    if (rows.length < 2) continue; // Need at least header + 1 data row

    const firstRow = rows[0];

    // Check if first row already has <th> elements
    const existingTh = firstRow.querySelectorAll("th");
    const existingTd = firstRow.querySelectorAll("td");

    // Create <thead> with <th> cells from the first row
    const thead = doc.createElement("thead");
    const headerRow = doc.createElement("tr");

    if (existingTh.length > 0) {
      // First row already uses <th> — just move them into thead
      for (const th of existingTh) {
        headerRow.appendChild(th.cloneNode(true));
      }
    } else if (existingTd.length > 0) {
      // First row uses <td> — convert to <th>
      for (const cell of existingTd) {
        const th = doc.createElement("th");
        th.innerHTML = cell.innerHTML;
        headerRow.appendChild(th);
      }
    } else {
      continue; // No cells found, skip
    }

    thead.appendChild(headerRow);

    // Create <tbody> with remaining rows
    const tbody = doc.createElement("tbody");
    for (let i = 1; i < rows.length; i++) {
      tbody.appendChild(rows[i].cloneNode(true));
    }

    // Replace table contents
    table.innerHTML = "";
    table.appendChild(thead);
    table.appendChild(tbody);
  }

  // Extract the processed HTML from our wrapper div
  const wrapper = doc.querySelector("div");
  return wrapper?.innerHTML ?? html;
}

// ─── Image extraction ──────────────────────────────────────────────

interface ExtractedImage {
  /** The original src (data URI or URL) to find/replace in markdown */
  originalSrc: string;
  /** Base64 data (without the data:... prefix) */
  base64: string;
  /** Extension: png, jpg, gif, webp */
  extension: string;
}

function extractBase64Images(html: string): ExtractedImage[] {
  const images: ExtractedImage[] = [];
  const regex = /<img[^>]+src="(data:image\/([^;]+);base64,([^"]+))"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    images.push({
      originalSrc: match[1],
      base64: match[3],
      extension: match[2].split("+")[0], // handle svg+xml → svg
    });
  }
  return images;
}

// ─── Public API ────────────────────────────────────────────────────

export interface RichPasteResult {
  markdown: string;
  hadHtml: boolean;
}

/**
 * Convert HTML clipboard content to Markdown.
 * If `saveImages` is true, base64 images are saved to the project's
 * screenshots directory and replaced with relative Markdown links.
 */
export async function htmlToMarkdown(
  html: string,
  options: { saveImages?: boolean } = {},
): Promise<RichPasteResult> {
  let workingHtml = html;
  const imagePaths: Map<string, string> = new Map();

  // Extract and save images BEFORE cleaning (DOMParser may alter data URIs)
  if (options.saveImages) {
    const images = extractBase64Images(workingHtml);
    let imgIndex = 0;
    for (const img of images) {
      try {
        const relativePath = await invoke<string>("save_pasted_image", {
          base64Data: img.base64,
          extension: img.extension,
        });
        // Replace data URI with a placeholder in the HTML before Turndown
        const placeholder = `__PASTED_IMG_${imgIndex}__`;
        workingHtml = workingHtml.split(img.originalSrc).join(relativePath);
        imagePaths.set(placeholder, relativePath);
        imgIndex++;
      } catch (e) {
        console.warn("Failed to save pasted image:", e);
      }
    }
  }

  const cleaned = cleanWordHtml(workingHtml);
  const td = getTurndown();
  let md = td.turndown(cleaned);

  // Post-processing cleanup
  md = md
    // Ensure blank line before headings (except at start of document)
    .replace(/([^\n])\n(#{1,6}\s)/g, "$1\n\n$2")
    // Collapse 3+ consecutive blank lines to 2
    .replace(/\n{3,}/g, "\n\n")
    // Trim trailing whitespace on each line
    .replace(/[ \t]+$/gm, "")
    .trim();

  return { markdown: md, hadHtml: true };
}

/**
 * Check if clipboard data contains HTML.
 */
export function clipboardHasHtml(clipboardData: DataTransfer): boolean {
  return clipboardData.types.includes("text/html");
}

/**
 * Extract an image blob from clipboard items (for screenshots/snips).
 * Returns null if no image is found.
 */
export function getClipboardImageBlob(clipboardData: DataTransfer): File | null {
  for (let i = 0; i < clipboardData.items.length; i++) {
    const item = clipboardData.items[i];
    if (item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }
  return null;
}

/**
 * Convert a File/Blob to base64 string (without the data:... prefix).
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip "data:image/png;base64," prefix
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
