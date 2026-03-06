# Change Files

This directory contains [Covector](https://github.com/jbolda/covector)
change files that describe unreleased changes.

## Adding a Change File

When you make a change that should be included in the next release, create a
markdown file in this directory (any name ending in `.md`, except `README.md`):

```markdown
---
"cutready": patch
---

Fixed note preview mode not persisting across tab switches.
```

The frontmatter specifies the package name and the semver bump type:

- **patch** — bug fixes, small improvements
- **minor** — new features
- **major** — breaking changes

The body is a human-readable description that will appear in the CHANGELOG.

## What Happens Next

On push to `main`, CI runs `covector version-or-publish`:

1. If change files exist → bumps version, updates CHANGELOG, opens a PR
2. If no change files → creates a git tag and GitHub Release
3. The tag triggers the build workflows (Windows, Linux, macOS)

## Multiple Changes

You can create multiple change files for separate changes. They will all be
consumed together during the next version bump.
