---
name: "iOS Companion"
description: "SwiftUI companion app conventions and release boundaries"
applyTo: "ios/**"
---

# iOS Companion

## Product Boundary

The iOS app is a **CutReady companion**, not a desktop replacement. It is for viewing, rehearsing, small edits to storyboards/sketches/notes, and GitHub-backed push/sync. Desktop CutReady remains responsible for recording, replay automation, FCPXML/video export, heavy conflict resolution, and advanced history operations.

## Release Boundary

iOS work must stay separate from the desktop release-please train unless the user explicitly asks to change release strategy.

- Keep iOS CI/CD in iOS-specific workflows such as `.github/workflows/ios-companion.yml`.
- Keep iOS-only commits scoped as `chore(ios): ...` unless they intentionally belong in the desktop changelog.
- Do not add iOS files to the root release-please package or desktop version extra-files.
- `release-please-config.json` excludes `ios/**`, `.github/workflows/ios-companion.yml`, and this instruction file from desktop release parsing.

## Architecture

- Use native SwiftUI for the app surface. Do not try to reuse the desktop React UI on iOS.
- Preserve CutReady's design language through SwiftUI theme tokens: warm surfaces, soft borders, purple accent, compact chrome, and icon-first controls.
- Use native drill-down navigation on iPhone: workspace -> projects -> project contents -> item detail.
- Treat the workspace menu as workspace-level chrome. It should show current/recent workspaces and open/home actions, not project navigation.
- Use durable platform storage for app state: Keychain for tokens and `UserDefaults` for recent workspaces or reader layout preferences.

## Data and Editing

- Share CutReady file formats where possible: `.sb`, `.sk`, `.md`, plus approved `.cutready` asset directories.
- Prefer structured edits over arbitrary file mutation for mobile writes.
- Keep decoders tolerant of real project history. Mobile readers should handle legacy or partially populated files where desktop models allow optional fields.
- Scope GitHub-backed workspace reads/writes through mobile policy helpers instead of allowing arbitrary repository paths.

## Rendering

- Render markdown previews with the established Swift package `MarkdownUI`; do not maintain a custom Markdown parser for normal note/sketch prose previews.
- Keep iPhone reader layouts compact and full-width. Avoid desktop-style multi-pane density on small screens.
- Sketch rows should default to Assets -> Narrative -> Actions and use durable settings for section visibility/order.
- Elucim visuals are not natively rendered yet. Surface attached visuals clearly until a native renderer, SVG bridge, or shared rendering path is selected.

## Validation

Run the Swift package tests for iOS changes:

```bash
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all swift test --package-path ios
```

When validating the simulator app, use the existing Xcode project and scheme:

```bash
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all xcodebuild -project ios/CutReadyCompanion.xcodeproj -scheme CutReadyCompanionApp -destination 'platform=iOS Simulator,name=iPhone 16' -derivedDataPath /tmp/cutready-companion-github-dd build
```
