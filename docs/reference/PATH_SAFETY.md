# Path Safety

Every caller-provided or model-supplied path must be confined before file access. Use `project::safe_resolve(root, relative_path)` unless the surface needs a stricter domain helper.

## Checklist for path-taking surfaces

Before adding a Tauri command, agent tool, import path, screenshot path, or asset-copy path:

1. Treat the path as untrusted, even when it came from project content.
2. Reject or normalize only after routing through `project::safe_resolve()` or a stricter helper.
3. Never use `root.join(untrusted_path)` directly for reads, writes, copies, deletes, or model image encoding.
4. Test `..`, Windows prefixes like `C:\Windows\file.txt`, drive-less root paths like `/etc/passwd`, and nested-root escapes where the target file exists outside the source root.
5. Mutation-check one guard when adding a new path surface by temporarily breaking the production guard and confirming the regression test fails.

## Human review note

OAuth device flows and subjective visual review remain human-gated. Path-confinement checks should be deterministic Rust tests or deterministic Auditaur scorer/drill fixtures, not manual taste checks.
