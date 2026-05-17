import { useState, useCallback } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";

interface ProjectImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  /** Relative path within the project (e.g. ".cutready/screenshots/img.png") */
  relativePath: string;
  /** Explicit project root override. If omitted, reads from store. */
  projectRoot?: string | null;
}

/**
 * Renders a project-relative image with automatic fallback.
 * First tries the Tauri asset protocol; if it fails (macOS),
 * falls back to reading via backend command (data URL).
 */
export function ProjectImage({ relativePath, projectRoot: explicitRoot, ...imgProps }: ProjectImageProps) {
  const storeRoot = useAppStore((s) => s.currentProject?.root ?? null);
  const root = explicitRoot !== undefined ? explicitRoot : storeRoot;
  const [src, setSrc] = useState<string | null>(() =>
    root ? convertFileSrc(`${root}/${relativePath}`) : null
  );
  const [triedFallback, setTriedFallback] = useState(false);

  const handleError = useCallback(async () => {
    if (triedFallback || !root) return;
    setTriedFallback(true);
    try {
      const dataUrl = await invoke<string>("read_project_image", { relativePath });
      setSrc(dataUrl);
    } catch {
      setSrc(null);
    }
  }, [triedFallback, root, relativePath]);

  if (!src) return null;

  return <img {...imgProps} src={src} onError={handleError} />;
}
