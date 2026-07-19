export type ClipboardImage = {
  base64Data: string;
  extension: string;
};

export async function readClipboardImage(): Promise<ClipboardImage | null> {
  if (!navigator.clipboard?.read) {
    throw new Error("Image clipboard access is unavailable in this window.");
  }

  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (!imageType) continue;

    return {
      base64Data: await blobToBase64(await item.getType(imageType)),
      extension: imageExtension(imageType),
    };
  }

  return null;
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Clipboard image could not be encoded."));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Clipboard image could not be read."));
    reader.readAsDataURL(blob);
  });
}
