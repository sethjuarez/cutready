import { useState, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "@tauri-apps/api/core";

/**
 * Hook that resolves a project-relative image path to a displayable src URL.
 * Tries the asset protocol first; on load failure, falls back to a data URL
 * served by the backend (works on macOS where asset protocol is unreliable).
 */
export function useProjectImage(projectRoot: string | null, relativePath: string | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!projectRoot || !relativePath) {
      setSrc(null);
      return;
    }

    let cancelled = false;
    const assetUrl = convertFileSrc(`${projectRoot}/${relativePath}`);

    // Try loading via asset protocol first
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setSrc(assetUrl);
    };
    img.onerror = async () => {
      // Fallback: read via backend command
      if (cancelled) return;
      try {
        const dataUrl = await invoke<string>("read_project_image", { relativePath });
        if (!cancelled) setSrc(dataUrl);
      } catch {
        if (!cancelled) setSrc(null);
      }
    };
    img.src = assetUrl;

    return () => { cancelled = true; };
  }, [projectRoot, relativePath]);

  return src;
}
