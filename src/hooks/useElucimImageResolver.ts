/**
 * Shared image resolver for elucim components.
 *
 * Elucim 0.14.0 added `imageResolver` — a callback that converts an opaque
 * `ref` string stored in an ImageNode into a renderable URL. CutReady stores
 * image refs as project-relative paths (e.g. ".cutready/screenshots/abc.png"),
 * so the resolver loads them through the backend image command.
 */
import { useCallback } from "react";
import { useAppStore } from "../stores/appStore";
import { fetchProjectImageDataUrl, isProjectRelativeImagePath } from "../utils/projectImage";
import type { ImageResolverFn } from "@elucim/core";

/** Returns a stable imageResolver callback for DslRenderer / ElucimEditor. */
export function useElucimImageResolver(): ImageResolverFn | undefined {
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? null);

  const resolver: ImageResolverFn = useCallback(
    (ref: string) => {
      if (!projectRoot) return ref;
      if (!isProjectRelativeImagePath(ref)) {
        return ref;
      }
      return fetchProjectImageDataUrl(ref);
    },
    [projectRoot],
  );

  // Only provide the resolver when we have a project root
  return projectRoot ? resolver : undefined;
}
