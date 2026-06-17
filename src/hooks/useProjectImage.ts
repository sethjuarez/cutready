import { useState, useEffect } from "react";
import { fetchProjectImageDataUrl } from "../utils/projectImage";

/**
 * Hook that resolves a project-relative image path to a displayable src URL.
 * Resolves through the backend image command to avoid asset-protocol scope
 * differences across macOS, Windows, and Linux.
 */
export function useProjectImage(projectRoot: string | null, relativePath: string | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!projectRoot || !relativePath) {
      setSrc(null);
      return;
    }

    let cancelled = false;
    setSrc(null);
    fetchProjectImageDataUrl(relativePath)
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl);
      })
      .catch((error: unknown) => {
        console.error("[useProjectImage] failed to load project image", { relativePath, error });
        if (!cancelled) setSrc(null);
      });

    return () => {
      cancelled = true;
    };
  }, [projectRoot, relativePath]);

  return src;
}
