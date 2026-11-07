// Reads the system clipboard as HTML, plain text and an image, whichever it holds.

export interface ClipboardContent {
  html: string;
  plain: string;
  image: Blob | null;
  imageExtension: string;
}

function clipboardItemType(item: ClipboardItem, mimeType: string) {
  return item.types.find((type) => type.toLowerCase() === mimeType);
}

export async function readClipboardText() {
  if (!navigator.clipboard?.readText) throw new Error("Clipboard text access is unavailable");
  return navigator.clipboard.readText();
}

/** Every format the clipboard offers; falls back to plain text when rich reads are unavailable or refused. */
export async function readClipboardContent(): Promise<ClipboardContent> {
  const content: ClipboardContent = { html: "", plain: "", image: null, imageExtension: "png" };
  if (navigator.clipboard?.read) {
    try {
      for (const item of await navigator.clipboard.read()) {
        const htmlType = clipboardItemType(item, "text/html");
        if (htmlType && !content.html) content.html = await (await item.getType(htmlType)).text();
        const textType = clipboardItemType(item, "text/plain");
        if (textType && !content.plain) content.plain = await (await item.getType(textType)).text();
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (imageType && !content.image) {
          content.image = await item.getType(imageType);
          content.imageExtension = imageType.split("/")[1] || "png";
        }
      }
      return content;
    } catch {
      // Rich reads can be refused while plain text is still allowed.
    }
  }
  content.plain = await readClipboardText();
  return content;
}
