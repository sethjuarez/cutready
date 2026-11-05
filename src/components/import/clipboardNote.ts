// Creates a note from whatever is on the clipboard (rich HTML becomes markdown).
import { documentsIpc } from "../../ipc/documents";
import { readClipboardContent } from "../../services/clipboardContent";
import { transferConflictPath } from "../../services/commandErrors";
import { htmlToMarkdown } from "../../services/richPaste";
import { noteNameCandidates } from "./importRouting";

/** Markdown for the clipboard's contents, or "" when it holds no text. */
export async function clipboardMarkdown() {
  const { html, plain } = await readClipboardContent();
  if (html) {
    const { markdown } = await htmlToMarkdown(html, { saveImages: true });
    if (markdown.trim()) return markdown.trim();
  }
  return plain.trim();
}

/** Writes `content` to the first free `stem[-n].md`; returns its path. */
export async function createUniqueNote(stem: string, content: string) {
  for (const path of noteNameCandidates(stem)) {
    try {
      await documentsIpc.createCopy(path, content);
      return path;
    } catch (err) {
      if (transferConflictPath(err) === null) throw err;
    }
  }
  throw new Error(`Couldn't find a free name for ${stem}.md`);
}
