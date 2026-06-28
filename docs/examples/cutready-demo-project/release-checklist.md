# Release Confidence Checklist

- Run TypeScript, Vitest, Rust tests, and build.
- Run `npm run test:e2e` to execute the Auditaur drill against the real Tauri app.
- Review Draftline changed files before committing.
- Confirm `.cutready/screenshots` and `.cutready/visuals` assets are included in snapshots.
- Confirm local runtime state does not dirty normal project snapshots.
