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
- `release-please-config.json` excludes `ios`, `.github/workflows`, and `.github/instructions` from desktop release parsing. Release-please exclude paths are directory prefixes, not glob patterns.

## Architecture

- Use native SwiftUI for the app surface. Do not try to reuse the desktop React UI on iOS.
- Preserve CutReady's design language through SwiftUI theme tokens: warm surfaces, soft borders, purple accent, compact chrome, and icon-first controls.
- Use native drill-down navigation on iPhone: workspace -> projects -> project contents -> item detail.
- Treat the workspace menu as workspace-level chrome. It should show current/recent workspaces and open/home actions, not project navigation.
- Use durable platform storage for app state: Keychain for tokens and `UserDefaults` for recent workspaces or reader layout preferences.
- GitHub-backed workspaces should load from local app-managed storage, not refetch `.sb`, `.sk`, `.md`, screenshots, visuals, or narration from GitHub on every open.
- Draftline owns mobile workspace versioning/sync semantics through its native mobile bridge. CutReady owns the Swift wrapper, Keychain token plumbing, app-specific content policy, structured edit UI, and file-format models.

## Data and Editing

- Share CutReady file formats where possible: `.sb`, `.sk`, `.md`, plus approved `.cutready` asset directories.
- Prefer structured edits over arbitrary file mutation for mobile writes.
- Keep decoders tolerant of real project history. Mobile readers should handle legacy or partially populated files where desktop models allow optional fields.
- Scope GitHub-backed workspace reads/writes through mobile policy helpers instead of allowing arbitrary repository paths.
- Do not hand-roll Git/GitHub commit, push, pull, or merge semantics in Swift. Route those through Draftline's mobile bridge; Swift should pass CutReady's content policy and credentials into Draftline.

## Rendering

- Render markdown previews with the established Swift package `MarkdownUI`; do not maintain a custom Markdown parser for normal note/sketch prose previews.
- Match desktop note behavior: note titles come from the `.md` file stem, while `---` frontmatter key/value pairs are parsed as note properties and rendered separately from the markdown body.
- Keep iPhone reader layouts compact and full-width. Avoid desktop-style multi-pane density on small screens.
- Sketch rows should default to Assets -> Narration -> Narrative -> Actions and use durable settings for section visibility/order.
- Narration playback should read approved `.cutready/narration` assets from the local Draftline-backed workspace. Use native/WebKit audio controls for mobile playback rather than refetching narration on every row render.
- Elucim visuals are not natively rendered yet. Surface attached visuals clearly until a native renderer, SVG bridge, or shared rendering path is selected.

## Local iPhone and TestFlight Deployment

Keep all Apple account identifiers, team identifiers, emails, phone numbers, and OAuth values out of committed docs and source. Use placeholders such as `<APPLE_TEAM_ID>` and read local-only values from ignored files or the developer's Xcode account.

## CutReady-Specific iOS App Notes

- The companion bundle ID is `com.cutready.companion`. The desktop/macOS app bundle ID remains separate.
- The TestFlight/App Store Connect app record should be for the iOS companion, not the existing direct-distributed macOS app.
- Keep the Mac app on direct signed/notarized distribution unless product strategy changes; App Store Connect/TestFlight is required for practical iOS distribution.
- The iOS companion app name shown to users is CutReady/CutReady Companion depending on the generated display name and product name settings.
- Do not enable extra Apple App ID capabilities by default. Current GitHub device auth, Keychain token storage, local app storage, and GitHub/Draftline sync do not require optional capability checkboxes.
- App Store Connect may offer platform records for macOS/tvOS/visionOS because the App ID platform family is broad. For this companion, configure iOS/TestFlight first and leave unrelated platform submission metadata alone.
- TestFlight external tester public links will not accept testers until the external group is enabled and Apple Beta App Review approves the build. Use internal testing for immediate installs on team Apple IDs.
- TestFlight and Xcode-installed builds share the same bundle ID. Delete the Xcode-sideloaded app before installing the TestFlight build when validating clean tester behavior.
- Use the existing app icon source from the desktop app, but iOS App Store assets must be opaque PNGs. Flatten generated icons before upload because App Store Connect rejects icons with alpha channels.
- The GitHub sign-in flow uses the GitHub device code flow. The device-code sheet should keep a tap/copy affordance for the user code because testers often need to move the code between phone and desktop browser.
- Apple encryption documentation for the current app should reflect that the app does not implement proprietary/custom encryption algorithms; it uses normal platform networking to GitHub over HTTPS.
- The app-specific Beta App Review description can be: `CutReady Companion lets testers sign in with GitHub, open CutReady repositories, rehearse demo storyboards and sketches, review notes, make small edits, and sync changes.`
- If Apple requires review credentials, use a disposable GitHub account with access to a sample CutReady repository. Do not use a personal account for review.
- Until Auditaur publishes a stable SwiftPM release/tag for `AuditaurAppleCore`, keep CutReady's iOS diagnostics portable and avoid local absolute package paths. When Auditaur is ready, prefer a Git URL/tag dependency rather than a local `path` dependency.

### GitHub OAuth client ID

- The iOS app can read `CUTREADY_GITHUB_OAUTH_CLIENT_ID` from the launch environment for simulator/dev launches.
- Device/TestFlight-style builds cannot rely on shell environment variables.
- `ios/scripts/embed-local-config.sh` reads only `CUTREADY_GITHUB_OAUTH_CLIENT_ID` from the repository root `.env` file at build time and writes a bundled `CutReadyConfig.plist`.
- Do not commit `.env`, `CutReadyConfig.plist`, OAuth client secrets, GitHub tokens, App Store Connect API keys, certificates, or provisioning profiles.
- A GitHub OAuth **client ID** is public app configuration, but still avoid hardcoding it in source so worktrees and builds stay environment-specific.

### Local iPhone sideloading

Use Xcode/devicectl sideloading for quick device smoke tests before TestFlight:

1. Enable Developer Mode on the phone: Settings -> Privacy & Security -> Developer Mode.
2. Unlock the phone and trust the Mac if prompted.
3. Confirm the device is available:

   ```bash
   xcrun devicectl list devices --timeout 10
   ```

4. Discover the local Apple team identifier from Xcode accounts or signing identities. Do not write the value into docs:

   ```bash
   security find-identity -v -p codesigning
   ```

5. Build for the connected phone with automatic provisioning:

   ```bash
   GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all \
   xcodebuild \
     -project ios/CutReadyCompanion.xcodeproj \
     -scheme CutReadyCompanionApp \
     -destination 'id=<DEVICE_ID>' \
     -derivedDataPath /tmp/cutready-companion-phone-dd \
     -allowProvisioningUpdates \
     -allowProvisioningDeviceRegistration \
     DEVELOPMENT_TEAM=<APPLE_TEAM_ID> \
     CODE_SIGN_STYLE=Automatic \
     build
   ```

6. Install and launch the built app:

   ```bash
   APP_PATH=$(find /tmp/cutready-companion-phone-dd/Build/Products -path '*iphoneos/CutReady Companion.app' -type d | head -n 1)
   xcrun devicectl device install app --device <DEVICE_IDENTIFIER> "$APP_PATH"
   xcrun devicectl device process launch --device <DEVICE_IDENTIFIER> --terminate-existing com.cutready.companion
   ```

7. If launch fails because the device is locked, unlock the phone and retry the launch command.

Development-signed builds stay installed like normal apps until deleted, overwritten, or their provisioning profile/signing expires. For repeatable non-cabled distribution, use TestFlight.

### TestFlight archive and upload

Use TestFlight for internal/external iOS beta distribution. Keep the desktop macOS app on its existing direct signed/notarized distribution path unless the product strategy changes.

1. Ensure App Store Connect has an app record for bundle ID `com.cutready.companion`.
2. Keep the iOS marketing version aligned with the App Store Connect version before archiving.
3. Increment `CURRENT_PROJECT_VERSION` for each new upload to the same version.
4. Confirm app icons are opaque PNGs. App Store Connect rejects large icons with alpha channels.
5. Confirm supported orientations are present in the generated Info.plist settings for iPhone/iPad.
6. Archive with automatic signing:

   ```bash
   rm -rf /tmp/cutready-companion.xcarchive
   GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all \
   xcodebuild \
     -project ios/CutReadyCompanion.xcodeproj \
     -scheme CutReadyCompanionApp \
     -destination 'generic/platform=iOS' \
     -archivePath /tmp/cutready-companion.xcarchive \
     -allowProvisioningUpdates \
     DEVELOPMENT_TEAM=<APPLE_TEAM_ID> \
     CODE_SIGN_STYLE=Automatic \
     archive
   ```

7. Export/upload to App Store Connect with `method` set to `app-store-connect` and `destination` set to `upload` in an export options plist.
8. Wait for Apple processing before looking for the build in App Store Connect -> TestFlight.

### App Store Connect and tester setup

- For **Internal Testing**, add the Apple ID in App Store Connect -> Users and Access, create/select an internal group, add the tester, and attach the build. Internal testing usually does not wait for Beta App Review.
- For **External Testing**, create an external group, attach the build, fill Test Information, and submit for Beta App Review. Public links do not accept testers until Apple approves the beta build and the group/public link is enabled.
- If App Store Connect asks for app encryption documentation for the current app, the expected answer is that CutReady Companion does not implement proprietary/custom encryption algorithms. It uses normal platform networking and GitHub HTTPS.
- Use a beta app description like: `CutReady Companion lets testers sign in with GitHub, open CutReady repositories, rehearse demo storyboards and sketches, review notes, make small edits, and sync changes.`
- Provide reviewer/contact information in App Store Connect only. Do not commit personal contact details into the repository.
- If Apple requires sign-in credentials for external review, create a disposable GitHub test account and sample CutReady repository rather than using a personal account.
- The TestFlight iOS app is installed from the App Store. For clean validation, delete any Xcode-sideloaded CutReady Companion app before installing the TestFlight build.

## Validation

Run the Swift package tests for iOS changes:

```bash
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all swift test --package-path ios
```

When validating the simulator app, use the existing Xcode project and scheme:

```bash
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all xcodebuild -project ios/CutReadyCompanion.xcodeproj -scheme CutReadyCompanionApp -destination 'id=30332794-A6DC-4B0B-A762-C31F84A0AC5B' -derivedDataPath /tmp/cutready-companion-github-dd build
```
