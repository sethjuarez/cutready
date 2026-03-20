/**
 * Shared image resolver for elucim components.
 *
 * Elucim 0.14.0 added `imageResolver` — a callback that converts an opaque
 * `ref` string stored in an ImageNode into a renderable URL. CutReady stores
 * image refs as project-relative paths (e.g. ".cutready/screenshots/abc.png"),
 * so the resolver joins them with the project root and converts to a Tauri
 * asset URL via `convertFileSrc`.
 */
import { useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";
import type { ImageResolverFn } from "@elucim/core";

/** Returns a stable imageResolver callback for DslRenderer / ElucimEditor. */
export function useElucimImageResolver(): ImageResolverFn | undefined {
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? null);

  const resolver: ImageResolverFn = useCallback(
    (ref: string) => {
      if (!projectRoot) return ref;
      // If ref is already absolute or a URL, pass through
      if (ref.startsWith("http") || ref.startsWith("file:") || ref.startsWith("/")) {
        return ref;
      }
      return convertFileSrc(`${projectRoot}/${ref}`);
    },
    [projectRoot],
  );

  // Only provide the resolver when we have a project root
  return projectRoot ? resolver : undefined;
}
