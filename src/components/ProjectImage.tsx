import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { fetchProjectImageDataUrl } from "../utils/projectImage";
import { useAppStore } from "../stores/appStore";

interface ProjectImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  /** Relative path within the project (e.g. ".cutready/screenshots/img.png") */
  relativePath: string;
  /** Explicit project root override. If omitted, reads from store. */
  projectRoot?: string | null;
}

/**
 * Renders a project-relative image through the backend image command.
 * This avoids Tauri asset-protocol scope issues for cloned workspaces.
 */
export function ProjectImage({ relativePath, projectRoot: explicitRoot, ...imgProps }: ProjectImageProps) {
  const storeRoot = useAppStore((s) => s.currentProject?.root ?? null);
  const root = explicitRoot !== undefined ? explicitRoot : storeRoot;
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!root || !relativePath) {
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
        console.error("[ProjectImage] failed to load project image", { relativePath, error });
        if (!cancelled) setSrc(null);
      });

    return () => {
      cancelled = true;
    };
  }, [root, relativePath]);

  if (!src) return null;

  return <img {...imgProps} src={src} />;
}
