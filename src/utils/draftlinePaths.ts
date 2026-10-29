import type { ProjectView } from "../types/project";

/**
 * Draftline reports paths relative to the git work-tree root (`git_root`).
 * For standalone projects that is the folder CutReady opened (`repo_root`);
 * for hybrid projects (a CutReady folder inside a code repository) it is the
 * enclosing repo, so Draftline paths carry the folder prefix (`cutready/intro.sk`).
 *
 * Path kinds used here:
 * - Draftline path: relative to `git_root`.
 * - Repo path: relative to `repo_root` (manifest `.cutready/projects.json` paths).
 * - Project path: relative to the active project `root`.
 */
/** Branch namespace CutReady uses for variations inside a developer's code repository. */
export const CUTREADY_VARIATION_NAMESPACE = "cutready/";

/** Mirror of the backend's hybrid prefixing so UI collision checks match the created branch. */
export function hybridVariationName(name: string): string {
  return name.startsWith(CUTREADY_VARIATION_NAMESPACE) ? name : `${CUTREADY_VARIATION_NAMESPACE}${name}`;
}

type DraftlineProject = Pick<ProjectView, "root" | "repo_root" | "git_root">;

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeAbsolutePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** `path` relative to `base` (case-insensitive), "" when equal, null when outside. */
function relativeTo(base: string, path: string): string | null {
  const normalizedBase = normalizeAbsolutePath(base);
  const normalizedPath = normalizeAbsolutePath(path);
  if (normalizedPath.toLowerCase() === normalizedBase.toLowerCase()) return "";
  const prefix = `${normalizedBase}/`;
  if (!normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  return normalizeRelativePath(normalizedPath.slice(prefix.length));
}

function stripPrefix(path: string, prefix: string): string | null {
  if (!prefix) return path;
  if (path.toLowerCase() === prefix.toLowerCase()) return "";
  const withSlash = `${prefix}/`;
  return path.toLowerCase().startsWith(withSlash.toLowerCase()) ? path.slice(withSlash.length) : null;
}

/** Absolute root Draftline paths are relative to. */
export function draftlineBase(project: DraftlineProject): string {
  return project.git_root || project.repo_root;
}

/** `repo_root` relative to the git work tree: "cutready" for hybrid, "" otherwise. */
export function hybridPathPrefix(project: DraftlineProject | null | undefined): string {
  if (!project) return "";
  return relativeTo(draftlineBase(project), project.repo_root) ?? "";
}

/** Active project folder relative to the git work tree, or null when it is the root. */
export function draftlineProjectScope(project: DraftlineProject | null | undefined): string | null {
  if (!project) return null;
  const scope = relativeTo(draftlineBase(project), project.root);
  return scope ? scope : null;
}

/** Draftline path -> repo (manifest-relative) path. Paths outside the folder are returned unchanged. */
export function draftlineToRepoPath(path: string, project: DraftlineProject | null | undefined): string {
  const normalized = normalizeRelativePath(path);
  return stripPrefix(normalized, hybridPathPrefix(project)) ?? normalized;
}

/** Repo (manifest-relative) path -> Draftline path. */
export function repoToDraftlinePath(path: string, project: DraftlineProject | null | undefined): string {
  const normalized = normalizeRelativePath(path);
  const prefix = hybridPathPrefix(project);
  if (!prefix) return normalized;
  return normalized ? `${prefix}/${normalized}` : prefix;
}

/**
 * Resolve a path that may be either a Draftline path or an active-project path
 * into both forms. Used when a UI action (discard, open) can be triggered from
 * the changes list (Draftline paths) or an editor tab (project paths).
 */
export function draftlinePathVariants(filePath: string, project: DraftlineProject | null | undefined) {
  const normalized = normalizeRelativePath(filePath);
  const scope = draftlineProjectScope(project);
  if (!scope) {
    return { draftlinePath: normalized, projectPath: normalized };
  }
  const projectPath = stripPrefix(normalized, scope);
  if (projectPath !== null) {
    return { draftlinePath: normalized, projectPath };
  }
  return { draftlinePath: `${scope}/${normalized}`, projectPath: normalized };
}

/** Draftline path -> active-project path, or null when the file is outside the active project. */
export function draftlineToProjectPath(path: string, project: DraftlineProject | null | undefined): string | null {
  const normalized = normalizeRelativePath(path);
  const scope = draftlineProjectScope(project);
  return scope ? stripPrefix(normalized, scope) : normalized;
}

/** Active-project path -> Draftline path. */
export function projectToDraftlinePath(path: string, project: DraftlineProject | null | undefined): string {
  const normalized = normalizeRelativePath(path);
  const scope = draftlineProjectScope(project);
  if (!scope) return normalized;
  return normalized ? `${scope}/${normalized}` : scope;
}
