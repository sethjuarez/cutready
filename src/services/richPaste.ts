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
    replacement: (content) => content,
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

  // Strip conditional comments: <!--[if ...]>...<![endif]-->
  cleaned = cleaned.replace(/<!--\[if[^>]*\]>[\s\S]*?<!\[endif\]-->/gi, "");
  // Strip non-comment conditionals: <![if !supportLists]>...<![endif]>
  cleaned = cleaned.replace(/<!\[if[^>]*\]>/gi, "");
  cleaned = cleaned.replace(/<!\[endif\]>/gi, "");
  // Strip <!--StartFragment--> / <!--EndFragment-->
  cleaned = cleaned.replace(/<!--(Start|End)Fragment-->/gi, "");
  // Strip remaining HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/gi, "");

  // Strip XML-namespaced elements and their content
  cleaned = cleaned.replace(/<o:[^>]*>[\s\S]*?<\/o:[^>]*>/gi, "");
  cleaned = cleaned.replace(/<\/?o:[^>]*>/gi, "");
  cleaned = cleaned.replace(/<v:[^>]*>[\s\S]*?<\/v:[^>]*>/gi, "");
  cleaned = cleaned.replace(/<\/?v:[^>]*>/gi, "");
  cleaned = cleaned.replace(/<w:[^>]*>[\s\S]*?<\/w:[^>]*>/gi, "");
  cleaned = cleaned.replace(/<\/?w:[^>]*>/gi, "");
  cleaned = cleaned.replace(/<m:[^>]*>[\s\S]*?<\/m:[^>]*>/gi, "");
  cleaned = cleaned.replace(/<\/?m:[^>]*>/gi, "");

  // Strip <style>...</style> blocks
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Convert Word list paragraphs to proper <li> BEFORE stripping classes
  cleaned = convertWordLists(cleaned);

  // Strip class attributes — Word uses both class="X" and class=X (unquoted)
  cleaned = cleaned.replace(/\s+class=("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Strip ALL style attributes — Word uses both style="..." and style='...'
  cleaned = cleaned.replace(/\s+style=("[^"]*"|'[^']*')/gi, "");

  // Collapse excessive <br> tags
  cleaned = cleaned.replace(/(<br\s*\/?>){3,}/gi, "<br><br>");

  // Strip layout attributes (width, height, valign, border, cellspacing, etc.)
  cleaned = cleaned.replace(/\s+(width|height|valign|border|cellspacing|cellpadding|lang|link|vlink)=("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Normalize Word tables for Turndown GFM compatibility
  cleaned = normalizeWordTables(cleaned);

  // Clean up &nbsp; runs (Word uses these for list indentation)
  cleaned = cleaned.replace(/(&nbsp;\s*){3,}/gi, " ");

  return cleaned.trim();
}

/**
 * Convert Word's MsoListParagraph paragraphs to proper HTML list items.
 *
 * Word doesn't use <ul>/<li> — it uses <p class="MsoListParagraph"> with
 * inline dashes/numbers and conditional comments for list markers.
 * This converts them to proper <ul><li> or <ol><li> structures.
 */
function convertWordLists(html: string): string {
  let result = html;

  // Convert individual list paragraphs to <li> elements.
  // Word list paragraph classes: MsoListParagraph, MsoListParagraphCxSpFirst,
  // MsoListParagraphCxSpMiddle, MsoListParagraphCxSpLast
  // Word uses both class="MsoListParagraph" and class=MsoListParagraph (unquoted)
  result = result.replace(
    /<p\s+[^>]*class=["']?MsoListParagraph[^"'>\s]*["']?[^>]*>([\s\S]*?)<\/p>/gi,
    (_match, content) => {
      let text = content.trim();
      // Remove leftover span wrappers from list marker conditional comments
      text = text.replace(/^<span[^>]*><span[^>]*>[-•·]\s*<span[^>]*>[^<]*<\/span><\/span><\/span>/i, "");
      text = text.replace(/^<span[^>]*>[-•·]\s*<\/span>/i, "");
      text = text.replace(/^\s*[-•·]\s+/, "");
      text = text.replace(/^\s*\d+[.)]\s+/, "");
      return `<li>${text.trim()}</li>`;
    }
  );

  // Wrap consecutive <li> elements in <ul> tags,
  // but only if they are NOT already inside a <ul> or <ol>
  result = result.replace(
    /(<li>[\s\S]*?<\/li>\s*)+/gi,
    (match, _p1, offset) => {
      // Check if this <li> group is already inside a <ul> or <ol>
      const before = result.slice(Math.max(0, offset - 200), offset);
      // Find the last opening <ul>/<ol> and last closing </ul>/</ol> before this match
      const lastOpenUl = Math.max(before.lastIndexOf("<ul"), before.lastIndexOf("<ol"));
      const lastCloseUl = Math.max(before.lastIndexOf("</ul>"), before.lastIndexOf("</ol>"));
      if (lastOpenUl > lastCloseUl) {
        // Already inside a list — don't wrap
        return match;
      }
      return `<ul>${match}</ul>`;
    }
  );

  return result;
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
  // Match both double-quoted and single-quoted src attributes
  const regex = /<img[^>]+src=["'](data:image\/([^;]+);base64,([^"']+))["']/gi;
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

export interface RichPasteOptions {
  saveImages?: boolean;
  /** AI provider config — if provided, the pasted markdown is refined by the model. */
  aiConfig?: {
    provider: string;
    endpoint: string;
    api_key: string;
    model: string;
    bearer_token: string | null;
  };
  /** Optional callback for status updates (shown in activity panel). */
  onStatus?: (message: string, level: "info" | "warn" | "error" | "success") => void;
}

const AI_PASTE_PROMPT = `You are a document conversion assistant. The user pasted content from a Word document that was automatically converted from HTML to Markdown. The conversion has issues:

- Tables may be malformed or have pipe characters in the wrong places
- Some formatting may be lost or garbled
- Lists may not be properly structured
- Images references (like ![](path)) should be preserved exactly as-is

Clean up the markdown to be well-structured and readable. Rules:
1. Preserve ALL content — do not add, remove, or rephrase anything
2. Fix table formatting so tables render correctly in markdown
3. Ensure proper heading hierarchy
4. Fix list formatting (bulleted and numbered)
5. Preserve all image references exactly as they appear
6. Remove any garbled formatting artifacts
7. Return ONLY the cleaned markdown — no explanations or commentary`;

const AI_COMPLEX_PASTE_PROMPT = `You are an expert document conversion assistant. Convert the following HTML content into clean, well-structured Markdown.

The HTML comes from a clipboard paste (likely from Word, a web page, or a rich text editor). It may contain formatting artifacts, inline styles, and messy structure.

Rules:
1. Preserve ALL text content exactly — do not add, remove, or rephrase anything
2. Create proper Markdown structure: headings, lists, tables, bold, italic, links
3. Tables must use proper Markdown pipe syntax with header separator rows
4. Preserve all image references exactly as they appear (![](path) or <img> tags → ![](src))
5. Remove all HTML artifacts, inline styles, and formatting cruft
6. Use ATX-style headings (# H1, ## H2, etc.)
7. Use - for bullet lists, 1. for numbered lists
8. Return ONLY the cleaned Markdown — no explanations, no code fences`;

// ─── Paste complexity detection ────────────────────────────────────

interface PasteComplexity {
  score: number;
  hasTables: boolean;
  hasImages: boolean;
  hasNestedLists: boolean;
  hasMultipleHeadings: boolean;
  elementCount: number;
}

export { detectPasteComplexity, splitMarkdownChunks };
export type { PasteComplexity };

function detectPasteComplexity(html: string): PasteComplexity {
  const hasTables = /<table[\s>]/i.test(html);
  const hasImages = /<img[\s>]/i.test(html);
  const hasNestedLists = /<[uo]l[\s>][\s\S]*?<[uo]l[\s>]/i.test(html);
  const headingCount = (html.match(/<h[1-6][\s>]/gi) || []).length;
  const hasMultipleHeadings = headingCount >= 2;

  // Count structural elements
  const tableCount = (html.match(/<table[\s>]/gi) || []).length;
  const imageCount = (html.match(/<img[\s>]/gi) || []).length;
  const listCount = (html.match(/<[uo]l[\s>]/gi) || []).length;
  const elementCount = tableCount + imageCount + listCount + headingCount;

  // Complexity score (0-10 scale)
  let score = 0;
  if (hasTables) score += 3;
  if (tableCount > 1) score += 1;
  if (hasImages) score += 2;
  if (imageCount > 2) score += 1;
  if (hasNestedLists) score += 2;
  if (hasMultipleHeadings) score += 1;
  if (html.length > 5000) score += 1;

  return { score, hasTables, hasImages, hasNestedLists, hasMultipleHeadings, elementCount };
}

/**
 * Convert HTML clipboard content to Markdown.
 * If `saveImages` is true, base64 images are saved to the project's
 * screenshots directory and replaced with relative Markdown links.
 * Complex pastes (tables, images, nested formatting) use AI-first conversion.
 * Simple pastes use Turndown with optional AI cleanup.
 */
export async function htmlToMarkdown(
  html: string,
  options: RichPasteOptions = {},
): Promise<RichPasteResult> {
  const log = options.onStatus ?? (() => {});
  let workingHtml = html;

  log("Rich paste: converting HTML to Markdown…", "info");

  // Extract and save images BEFORE cleaning (DOMParser may alter data URIs)
  if (options.saveImages) {
    const images = extractBase64Images(workingHtml);
    if (images.length > 0) {
      log(`Rich paste: found ${images.length} embedded image(s), saving…`, "info");
    }
    let savedCount = 0;
    for (const img of images) {
      try {
        const relativePath = await invoke<string>("save_pasted_image", {
          base64Data: img.base64,
          extension: img.extension,
        });
        workingHtml = workingHtml.split(img.originalSrc).join(relativePath);
        savedCount++;
      } catch (e) {
        log(`Rich paste: failed to save image — ${e}`, "warn");
      }
    }
    if (savedCount > 0) {
      log(`Rich paste: saved ${savedCount} image(s) to project`, "success");
    }
  } else {
    // Even when not saving, strip base64 data URIs to avoid huge markdown
    workingHtml = workingHtml.replace(
      /<img[^>]+src=["']data:image\/[^"']+["'][^>]*\/?>/gi,
      ""
    );
  }

  const cleaned = cleanWordHtml(workingHtml);
  const complexity = detectPasteComplexity(cleaned);

  let md: string;

  // Complex pastes: AI-first conversion from cleaned HTML
  if (complexity.score >= 4 && options.aiConfig) {
    const features = [
      complexity.hasTables && "tables",
      complexity.hasImages && "images",
      complexity.hasNestedLists && "nested lists",
      complexity.hasMultipleHeadings && "multiple headings",
    ].filter(Boolean).join(", ");
    log(`Rich paste: complex content detected (${features}) — using AI conversion`, "info");

    // Turndown first (deterministic baseline), then AI refines in chunks
    const turndownResult = turndownConvert(cleaned);

    try {
      md = await refineMarkdownWithAi(turndownResult, AI_COMPLEX_PASTE_PROMPT, options.aiConfig, log);
      if (md !== turndownResult) {
        log("Rich paste: AI conversion complete ✓", "success");
      }
    } catch (e) {
      log(`Rich paste: AI conversion failed, using Turndown — ${e}`, "warn");
      md = turndownResult;
    }
  } else {
    // Simple pastes: Turndown conversion with optional AI cleanup
    md = turndownConvert(cleaned);

    // AI refinement for simple pastes (chunked for large content)
    if (options.aiConfig && md.length > 0) {
      log(`Rich paste: refining with AI model (${options.aiConfig.model})…`, "info");
      try {
        const refined = await refineMarkdownWithAi(md, AI_PASTE_PROMPT, options.aiConfig, log);
        if (refined !== md) {
          md = refined;
          log("Rich paste: AI refinement complete ✓", "success");
        }
      } catch (e) {
        log(`Rich paste: AI refinement failed, using basic conversion — ${e}`, "warn");
      }
    } else if (!options.aiConfig) {
      log("Rich paste: no AI model configured, using basic conversion", "info");
    }
  }

  log("Rich paste: done ✓", "success");

  return { markdown: md, hadHtml: true };
}

// ─── Chunked AI refinement ─────────────────────────────────────────

/** Max chars per chunk sent to AI. Keeps well under typical output token limits. */
const AI_CHUNK_CHAR_LIMIT = 12000;

/**
 * Split markdown into chunks at natural boundaries (headings, blank lines).
 * Each chunk stays under `maxChars`. Chunks never split mid-table or mid-list.
 */
function splitMarkdownChunks(md: string, maxChars: number = AI_CHUNK_CHAR_LIMIT): string[] {
  if (md.length <= maxChars) return [md];

  const lines = md.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLen = line.length + 1; // +1 for newline

    // Check if adding this line exceeds the limit
    if (currentLen + lineLen > maxChars && current.length > 0) {
      // Try to find a good split point — prefer blank lines or headings
      let splitIdx = current.length;

      // Walk backward from end looking for a blank line or heading
      for (let j = current.length - 1; j >= Math.max(0, current.length - 20); j--) {
        const l = current[j];
        if (l.trim() === "" || /^#{1,6}\s/.test(l)) {
          splitIdx = j + 1;
          break;
        }
      }

      // If we found a good split point, split there and carry remainder forward
      if (splitIdx < current.length) {
        const kept = current.slice(0, splitIdx);
        const remainder = current.slice(splitIdx);
        const keptText = kept.join("\n").trim();
        if (keptText) chunks.push(keptText);
        current = [...remainder, line];
        currentLen = current.reduce((sum, l) => sum + l.length + 1, 0);
      } else {
        // No good split point — flush current chunk as-is
        const flushed = current.join("\n").trim();
        if (flushed) chunks.push(flushed);
        current = [line];
        currentLen = lineLen;
      }
    } else {
      current.push(line);
      currentLen += lineLen;
    }
  }

  if (current.length > 0) {
    const text = current.join("\n").trim();
    if (text) chunks.push(text);
  }

  return chunks;
}

/**
 * Refine markdown via AI, chunking large content to avoid truncation.
 * Returns the original markdown if AI fails or truncates.
 */
async function refineMarkdownWithAi(
  md: string,
  systemPrompt: string,
  config: NonNullable<RichPasteOptions["aiConfig"]>,
  log: (msg: string, level: "info" | "warn" | "error" | "success") => void,
): Promise<string> {
  const chunks = splitMarkdownChunks(md);

  if (chunks.length === 1) {
    // Single chunk — straightforward
    const result = await refineChunk(chunks[0], systemPrompt, config);
    if (result === null) return md; // AI failed, keep original
    // Truncation guard
    if (md.length > 200 && result.length < md.length * 0.5) {
      log(`Rich paste: AI output looks truncated (${result.length} vs ${md.length} chars) — keeping original`, "warn");
      return md;
    }
    return result;
  }

  // Multi-chunk: refine each independently
  log(`Rich paste: large content — processing in ${chunks.length} chunks…`, "info");
  const chunkPrompt = systemPrompt + "\n\nIMPORTANT: This is one section of a larger document. Preserve the content exactly — do not add introductions, conclusions, or summaries.";

  const results: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    log(`Rich paste: refining chunk ${i + 1}/${chunks.length}…`, "info");
    const result = await refineChunk(chunks[i], chunkPrompt, config);

    if (result === null) {
      // AI failed on this chunk — use original
      log(`Rich paste: AI failed on chunk ${i + 1}, using original text`, "warn");
      results.push(chunks[i]);
    } else if (chunks[i].length > 100 && result.length < chunks[i].length * 0.4) {
      // Truncated — use original chunk
      log(`Rich paste: chunk ${i + 1} truncated by AI, using original text`, "warn");
      results.push(chunks[i]);
    } else {
      results.push(result);
    }
  }

  return results.join("\n\n");
}

/** Send a single chunk to the AI for refinement. Returns null on failure. */
async function refineChunk(
  chunk: string,
  systemPrompt: string,
  config: NonNullable<RichPasteOptions["aiConfig"]>,
): Promise<string | null> {
  try {
    const refined = await invoke<{ role: string; content: string | null }>("agent_chat", {
      config,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: chunk },
      ],
    });
    if (refined.content && refined.content.trim().length > 0) {
      return stripCodeFence(refined.content.trim());
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Turndown conversion ──────────────────────────────────────────

/** Run Turndown conversion with post-processing cleanup. */
function turndownConvert(cleanedHtml: string): string {
  const td = getTurndown();
  let md = td.turndown(cleanedHtml);

  // Post-processing cleanup
  md = md
    // Ensure blank line before headings (except at start of document)
    .replace(/([^\n])\n(#{1,6}\s)/g, "$1\n\n$2")
    // Collapse 3+ consecutive blank lines to 2
    .replace(/\n{3,}/g, "\n\n")
    // Trim trailing whitespace on each line
    .replace(/[ \t]+$/gm, "")
    .trim();

  return md;
}

/** Strip markdown code fence wrapper from AI response. */
function stripCodeFence(text: string): string {
  let result = text;
  if (result.startsWith("```markdown")) {
    result = result.slice("```markdown".length);
  } else if (result.startsWith("```md")) {
    result = result.slice("```md".length);
  } else if (result.startsWith("```")) {
    result = result.slice(3);
  }
  if (result.endsWith("```")) {
    result = result.slice(0, -3);
  }
  return result.trim();
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
