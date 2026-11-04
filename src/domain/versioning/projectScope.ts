function normalizeProjectPath(path: string | undefined): string {
  return (path ?? "").replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "").toLowerCase();
}

/** Whether a repository-relative file lives in a project folder ("" or "." means the whole repo). */
export function fileBelongsToProject(filePath: string, projectPath: string): boolean {
  const project = normalizeProjectPath(projectPath);
  if (!project || project === ".") return true;
  const file = normalizeProjectPath(filePath);
  return file === project || file.startsWith(`${project}/`);
}
