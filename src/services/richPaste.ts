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

  return cleaned.trim();
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
  const cleaned = cleanWordHtml(html);
  const td = getTurndown();

  let processedHtml = cleaned;
  const imagePaths: Map<string, string> = new Map();

  // Extract and save images if requested
  if (options.saveImages) {
    const images = extractBase64Images(cleaned);
    for (const img of images) {
      try {
        const relativePath = await invoke<string>("save_pasted_image", {
          base64Data: img.base64,
          extension: img.extension,
        });
        imagePaths.set(img.originalSrc, relativePath);
      } catch (e) {
        console.warn("Failed to save pasted image:", e);
        // Leave the base64 in place — user can still see the markdown
      }
    }
  }

  let md = td.turndown(processedHtml);

  // Replace any saved image data URIs with local paths
  for (const [dataUri, localPath] of imagePaths) {
    // Turndown converts <img src="..."> to ![](...)
    // The data URI will be URL-encoded by Turndown, so match both forms
    md = md.split(dataUri).join(localPath);
  }

  // Post-processing cleanup
  md = md
    // Collapse 3+ consecutive blank lines to 2
    .replace(/\n{4,}/g, "\n\n\n")
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
