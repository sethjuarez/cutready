# Changelog

## \[0.6.0]

### What's Changed

- [`e2a317c`](https://github.com/sethjuarez/cutready/commit/e2a317c0f9f01fa1870b0d21eaa44247d272a2a8) Added Covector-based version management with automated changelog generation and CI release workflow.

Covector manages this changelog. Do not edit manually.
Each release section is generated from `.changes/*.md` files.

## [0.18.0](https://github.com/sethjuarez/cutready/compare/v0.17.1...v0.18.0) (2026-03-21)


### Features

* replace OS file dialog with project image picker in Elucim editor ([1be6980](https://github.com/sethjuarez/cutready/commit/1be6980d99da360b1df1900d62d61820ff2936c4))

## [0.17.1](https://github.com/sethjuarez/cutready/compare/v0.17.0...v0.17.1) (2026-03-21)


### Bug Fixes

* add ErrorBoundary to catch visual rendering crashes ([2fc0867](https://github.com/sethjuarez/cutready/commit/2fc0867cb090faf3d519a8953e99e93ff35c9339))
* protect markdown rendering and other crash vectors with error boundaries ([a0fc683](https://github.com/sethjuarez/cutready/commit/a0fc68340f21463991a2baa5b3f78ef07fa387dc))

## [0.17.0](https://github.com/sethjuarez/cutready/compare/v0.16.0...v0.17.0) (2026-03-20)


### Features

* add sort controls to Assets pane — type, reference, or recency ([bf08e81](https://github.com/sethjuarez/cutready/commit/bf08e81c63b57137fa4e6f5c6381d3210c2081ab))
* restructure sidebar into Documents, Assets, and Explorer panes ([5fea472](https://github.com/sethjuarez/cutready/commit/5fea472ea36c981c7f826349b9460db4fa4cc990))
* upgrade elucim to 0.14.0 and wire image asset resolver ([98e4cc5](https://github.com/sethjuarez/cutready/commit/98e4cc5fa80d9b1bc34d5cba2dbdbc826ed3eeb6))


### Bug Fixes

* asset picker clears competing field, fix invalid Tailwind classes, improve tool schemas ([1044885](https://github.com/sethjuarez/cutready/commit/10448857c82f21163ee74ecccd2946a723bd5c25))
* asset tab icons and colors — PhotoIcon for images, FilmIcon for visuals ([2e724eb](https://github.com/sethjuarez/cutready/commit/2e724ebbfeb441497368e3e4a25359af8c21083f))
* auto-detect Copilot CLI and auto-load models on provider switch ([dbed553](https://github.com/sethjuarez/cutready/commit/dbed55335ed911acc0634d8187efceb1867d0015))
* filter visual JSON files from image picker ([f2cd975](https://github.com/sethjuarez/cutready/commit/f2cd975bff20c73e254f583bd52af49d3cc18d05))
* graceful fallback for missing tool arguments ([f95c215](https://github.com/sethjuarez/cutready/commit/f95c2153805f574e01f755a1c4eb9613fe2c3ede))
* lightbox close icon and save icon ([e79252e](https://github.com/sethjuarez/cutready/commit/e79252e55ca66cc861a513beb4d05817f5b5dbca))
* move sort controls inline with Assets header ([5b25f27](https://github.com/sethjuarez/cutready/commit/5b25f27a8015e5bf9d54c9f3b054f3725e7a9b20))
* open full editor lightbox for visuals in Assets pane ([0483f75](https://github.com/sethjuarez/cutready/commit/0483f75aee0b1aef0c0082d0bbb659c0c978472c))
* render visual thumbnails in asset picker ([a182e8d](https://github.com/sethjuarez/cutready/commit/a182e8dfa42a0d653eaafb7a0cffc63b6df4d003))
* replace hardcoded colors with design tokens and extract shared patterns ([5d6a8cf](https://github.com/sethjuarez/cutready/commit/5d6a8cf4fa56b26ba5d10f525175491ef0c84e22))

## [0.16.0](https://github.com/sethjuarez/cutready/compare/v0.15.0...v0.16.0) (2026-03-20)


### Features

* add GitHub Copilot SDK as alternative AI provider ([6897a43](https://github.com/sethjuarez/cutready/commit/6897a439ee5ba8f5a9f9fb9ab829678b0f5171da))
* surface Copilot lifecycle events as status messages ([026e804](https://github.com/sethjuarez/cutready/commit/026e804bca06dd70d84f8ee2c5365ff445aba9ee))


### Bug Fixes

* add CLI version check, vision validation, and suppress unknown SDK events ([d4e79de](https://github.com/sethjuarez/cutready/commit/d4e79de35767275f083c8c736aecacacecce2dce))
* improve Copilot event tracing and empty message handling ([fdef5dd](https://github.com/sethjuarez/cutready/commit/fdef5dd5f48d921213851f95f7695a7832ca9162))
* replace polling timers with event-driven patterns ([64fe954](https://github.com/sethjuarez/cutready/commit/64fe95430d52a53f0cd1bee715176147430429f4))
* resolve tool name in ToolExecutionComplete for sidebar refresh ([a715a52](https://github.com/sethjuarez/cutready/commit/a715a52c139a0b1c2c278610919d66e3f3a69596))
* route all AI callsites through provider setting ([729deb9](https://github.com/sethjuarez/cutready/commit/729deb96e173940a3507d7085d3cdd3773e51d93))
* suppress intermediate turn text and route rich paste through provider ([06f0a95](https://github.com/sethjuarez/cutready/commit/06f0a95d760002862c9cc5d61215c85fb4b4368c))
* trace Copilot events and fix delta interleaving ([19908bb](https://github.com/sethjuarez/cutready/commit/19908bb8726a41cab717db5fead95c8ef65badc2))

## [0.15.0](https://github.com/sethjuarez/cutready/compare/v0.14.0...v0.15.0) (2026-03-19)


### Features

* 3-pass designer workflow with persisted design plans ([944fd48](https://github.com/sethjuarez/cutready/commit/944fd4863ffb49cf32b1a6bd3cec1fe7ae2989e8))
* activity panel logging for rich paste pipeline ([fb8e066](https://github.com/sethjuarez/cutready/commit/fb8e0660697171224ab73248c3d3e6632644b0dd))
* add 'Show AI Changes' button to re-view last diff highlights ([e6418d0](https://github.com/sethjuarez/cutready/commit/e6418d0a1b233520e744c45ac5792c18993cd50a))
* add Covector version management ([e2a317c](https://github.com/sethjuarez/cutready/commit/e2a317c0f9f01fa1870b0d21eaa44247d272a2a8))
* add critique_visual tool for Designer agent self-improvement ([725d407](https://github.com/sethjuarez/cutready/commit/725d4076e64b6c86482ce2a7d954f5a391d98782))
* add CutReady-specific elucim themes with concrete hex values ([e882ea9](https://github.com/sethjuarez/cutready/commit/e882ea971aeed6a26339b9b8dff86b30cea454f6))
* add description sparkle to storyboard ([f02a1fc](https://github.com/sethjuarez/cutready/commit/f02a1fcb21e732ff4bc75c835a474f5e68bfce03))
* add Export Logs command to command palette ([f18ddc0](https://github.com/sethjuarez/cutready/commit/f18ddc050238442b9b043d9283247bf79e15ea9b))
* add feedback history tab in settings ([0a2a644](https://github.com/sethjuarez/cutready/commit/0a2a6440d4a8649f594c7f85ba4739f94958fe9d))
* add feedback popover to title bar ([55840da](https://github.com/sethjuarez/cutready/commit/55840da289ec747dd9430cb86734a0836da914ed))
* add optional title and description to set_planning_rows ([a2dd004](https://github.com/sethjuarez/cutready/commit/a2dd004d3785e393fb74bf74ada0eebf91b4229e))
* add Responses API support for codex and pro models ([8865e4c](https://github.com/sethjuarez/cutready/commit/8865e4c6653d1eeafd379543b68416d318d5667b))
* add save_feedback as an AI agent tool ([06b0a67](https://github.com/sethjuarez/cutready/commit/06b0a67971e2d129c0abb26d437f68b6d7a94531))
* add screenshot support to sketch tools for note-to-sketch images ([636a3b0](https://github.com/sethjuarez/cutready/commit/636a3b0ae4a31aeef62ff7b9af1d97c250319f51))
* add snapshot/versioning tools to AI agent ([5b55ecc](https://github.com/sethjuarez/cutready/commit/5b55eccb8927be940ed42c052c39747f20d9a0b1))
* add update_storyboard AI tool for title/description updates ([fc071b8](https://github.com/sethjuarez/cutready/commit/fc071b8258e50ec0da723d897bbc3b6660be9da0))
* add validate_dsl tool and fix visual refresh race condition ([43b13ed](https://github.com/sethjuarez/cutready/commit/43b13ed3d4bd5d851799662fadb9618f698f69ce))
* add Visual agent and ✨ Generate Visual button ([c0ae278](https://github.com/sethjuarez/cutready/commit/c0ae27808a221e44adc7a428ebda52567da9ab08))
* add visual generation instructions popup and tool panic safety ([49e01d3](https://github.com/sethjuarez/cutready/commit/49e01d37c9dc58da997a7ecb671d60fa86a318e6))
* add Windows ARM64 (aarch64) build target to release workflow ([6c82df2](https://github.com/sethjuarez/cutready/commit/6c82df29978dc259a82382e19382ff88c58fd2f9)), closes [#19](https://github.com/sethjuarez/cutready/issues/19)
* agent selector with prompt presets and tabbed settings ([eabf002](https://github.com/sethjuarez/cutready/commit/eabf002941fdc193c47a5c5ddcc90a05e48a59d0))
* AI change highlighting with inline diffs and undo support ([c450ce0](https://github.com/sethjuarez/cutready/commit/c450ce01ce22a22f4d880cac423c9d3ab665545c))
* AI edit flash indicator + file browser for image picker ([639ffda](https://github.com/sethjuarez/cutready/commit/639ffda59a9af4388d4bba5c9af36667d8103f64))
* AI-enhanced smart paste for Word→Markdown conversion ([7516ca4](https://github.com/sethjuarez/cutready/commit/7516ca4d543ee0bb58ec539c06e045bfc551b18f))
* API-reported context window + beforeunload archival ([cfeb62c](https://github.com/sethjuarez/cutready/commit/cfeb62cc22c2e309450cc6d4828eac2b1f4df0c8))
* attach debug log to feedback via toggle ([53fad36](https://github.com/sethjuarez/cutready/commit/53fad3658084d7a48c74455261a4c6f2be445f28))
* auto-open sketch after agent creates/updates it ([bc5481f](https://github.com/sethjuarez/cutready/commit/bc5481f61d0e5a7011b292ab7effae54fe25b455))
* auto-open Word document after export ([d559bda](https://github.com/sethjuarez/cutready/commit/d559bda7362b657dd0cce538a5b4ab326f0236f4))
* auto-reference active note in chat context ([e90c869](https://github.com/sethjuarez/cutready/commit/e90c869cc44e0883ef6e6dbb75bb43e9948d36c5))
* auto-refresh OAuth token on app startup ([f22fffc](https://github.com/sethjuarez/cutready/commit/f22fffc9d6b2726fc44237a685b34abd74b9a11e))
* auto-resolve GitHub token from gh CLI for clone ([8353afc](https://github.com/sethjuarez/cutready/commit/8353afc1bb089e2a5d9b26aaa0ef8f49ef4cd2c4))
* change note accent color from amber to rose/pink ([7ef963b](https://github.com/sethjuarez/cutready/commit/7ef963b86218d777fc50ac2c18ec438c248daa23))
* chat history tab in secondary panel ([78de47c](https://github.com/sethjuarez/cutready/commit/78de47c302c3e6135099f97ad04817c699b1ce1a))
* chunked AI paste refinement for large documents ([c58dbde](https://github.com/sethjuarez/cutready/commit/c58dbde6bad3ff674edc0e2f0bc3faed2b6bd2af))
* **ci:** add Azure Trusted Signing for Windows code signing ([7c654d6](https://github.com/sethjuarez/cutready/commit/7c654d6ee96293cbc827eac61c8a5fade1d01a44))
* click 'Unsaved changes' to view working tree diff ([155e0bb](https://github.com/sethjuarez/cutready/commit/155e0bb18a2eccb7f25c5bc42eefc8ca4719572b))
* clipboard fallback for DRM-protected document import ([7a6ba87](https://github.com/sethjuarez/cutready/commit/7a6ba8764d527db3b8c3a77a5434b3ab6e0d5e3f))
* Clone Repository button on home screen ([ce01190](https://github.com/sethjuarez/cutready/commit/ce0119069e1429967c53e5aff5de9472fd555d12))
* colorize file references in agent markdown responses ([b4a8bba](https://github.com/sethjuarez/cutready/commit/b4a8bbab38b2116d0c3873dfddfa0d2c6b4c755b))
* compaction UI pill and user message border ([4f20725](https://github.com/sethjuarez/cutready/commit/4f20725116549e1edafca9318062e4bbc31f3b51))
* complete multi-project support with versioning, migration, and recent projects ([cb817e1](https://github.com/sethjuarez/cutready/commit/cb817e1997191bef7d1caae3cfe3fafc389f38a6))
* create GitHub issue from feedback with LLM formatting ([7198a5a](https://github.com/sethjuarez/cutready/commit/7198a5a5674b978f51f12c2e99db3701fb66cdc2))
* Ctrl+Z undo for planning table, delete confirmation ([c424e57](https://github.com/sethjuarez/cutready/commit/c424e577f2484e93800a7b82b7b4ef07ae6c8ae1))
* deep link support for cutready://gh/owner/repo URLs ([255d5b8](https://github.com/sethjuarez/cutready/commit/255d5b8eb48c4502fe0afe5ed7bef165cda406f4))
* Designer agent uses gpt-5.1-codex model + auto-validates DSL ([0bb7317](https://github.com/sethjuarez/cutready/commit/0bb7317b2510a97b3dd44efa82a6dde0b5b955cb))
* dev-mode diagnostic trace logger ([810f70a](https://github.com/sethjuarez/cutready/commit/810f70ab665d29285bcd0331c9cdcef069990ec3))
* **display:** font family selector in settings ([8edea92](https://github.com/sethjuarez/cutready/commit/8edea9255ec7fcab00a0ba4656e716815e252f4f))
* document import (.docx, .pdf, .pptx) ([4b930cb](https://github.com/sethjuarez/cutready/commit/4b930cb386c020a4a184fab290386a20584b6a40))
* embed screenshots in Word export ([62a7563](https://github.com/sethjuarez/cutready/commit/62a756398771ca3c453cf23b12719182f982ba76))
* encrypt secrets at rest with Tauri Stronghold ([41971a4](https://github.com/sethjuarez/cutready/commit/41971a42de66bfa89d997e3227d2f8e0d08af1bf))
* enforce linear-only mode when no remote configured ([32611e0](https://github.com/sethjuarez/cutready/commit/32611e04293014b909c78b629b216cda85241b29))
* enlarge screenshot column in planning table (96-&gt;180px, 64x48-&gt;160x96 thumbnails) ([7f9c8c9](https://github.com/sethjuarez/cutready/commit/7f9c8c9ad176a1a5feabf8ab045766d8ba59c900))
* expandable activity entries — click or 'expand' link to see full content ([b12bd85](https://github.com/sethjuarez/cutready/commit/b12bd8554ab03d973973e2a50d8ecd806bcfc3aa))
* export activity log to clipboard and .log file ([c500c82](https://github.com/sethjuarez/cutready/commit/c500c82db112c9def8cc14194d72261acd4cb6d9))
* export notes to Word (.docx) ([ca38242](https://github.com/sethjuarez/cutready/commit/ca38242c06503133be6c87b841e1ad4de23b59e0))
* extract images from imported .docx and .pptx ([738abae](https://github.com/sethjuarez/cutready/commit/738abae197173be353ee96d239d2368c14c33559))
* feedback batch — 9 UX improvements ([31c1448](https://github.com/sethjuarez/cutready/commit/31c14488997a782d7fde1ef47e56548839ea83fd))
* feedback delete with confirm, user message styling + delete ([5e0a484](https://github.com/sethjuarez/cutready/commit/5e0a484e8163e44d6377b8f80227c4184119c5c1))
* filter chat panel models to chat-capable only ([1a560a5](https://github.com/sethjuarez/cutready/commit/1a560a5a1c773f0874a9b188dd70f162f3b7722d))
* GitHub remote collaboration — SyncBar, TimelineSelector, snapshot search, E2E tests ([c1c456c](https://github.com/sethjuarez/cutready/commit/c1c456c0a612b1b43a44862eaaf54bb376ce1bfe))
* grouped collapsible sections in image manager ([9fe4a1b](https://github.com/sethjuarez/cutready/commit/9fe4a1b4c3405783ea3ae0dfef16e5093672b0b1))
* identity prompt dialog when git identity is unresolved ([99291d1](https://github.com/sethjuarez/cutready/commit/99291d15fa26da53f3c86eb92e3309b5c37e63f9))
* import .sk and .sb files into the current project ([6733a14](https://github.com/sethjuarez/cutready/commit/6733a14ff3dc1079b28e6d3be686ac28b669603e))
* import conflict dialog — overwrite, keep both, or cancel ([cf1b077](https://github.com/sethjuarez/cutready/commit/cf1b077ab04eabf391025ba085136496eacc165d))
* improve migration UX and add project rename ([ada6ce1](https://github.com/sethjuarez/cutready/commit/ada6ce182401d9b2221a1e872e4f354c5e0610d0))
* include app version in GitHub issue feedback ([8d0c85c](https://github.com/sethjuarez/cutready/commit/8d0c85c8ce81218350057b242ae048db71177eb7))
* include visuals in image manager for orphan detection and cleanup ([aa54efb](https://github.com/sethjuarez/cutready/commit/aa54efb64f4c566f6cd4007d127088d2190562ae))
* integrate Elucim visual editor in expanded lightbox ([2b98e39](https://github.com/sethjuarez/cutready/commit/2b98e39a3b506786992b076c9d66c98610b3eb14))
* integrate elucim visual system into sketch rows ([5107f46](https://github.com/sethjuarez/cutready/commit/5107f46e6074a644e30e517c19c563ea6c18d3e5))
* live-update standalone preview when sketch data changes ([1933c86](https://github.com/sethjuarez/cutready/commit/1933c86800baf08b67d43d8aeca5265ab1d17043))
* LLM-powered compaction for dropped conversation messages ([52a9452](https://github.com/sethjuarez/cutready/commit/52a9452015d4ac8caed9fdb5d382ffdb3aaa7f7c))
* Memory management UI in Settings ([2e4dccd](https://github.com/sethjuarez/cutready/commit/2e4dccd60746e63eb163969b4c995c40da861748))
* memory system with recall, save, and session archival ([cfff65b](https://github.com/sethjuarez/cutready/commit/cfff65b1647ec732eef72acf4b16a6e208ef6c1c))
* multi-project per repo backend + frontend foundation ([8231c42](https://github.com/sethjuarez/cutready/commit/8231c42a89041b893ecf1b9caa8d4f4d7c6561e0))
* **notes:** add Edit/Preview toggle for rendered markdown ([e209e32](https://github.com/sethjuarez/cutready/commit/e209e322f284d62fd8a9f4f8ec69ff91e215bff7))
* pending message stack, activity panel, and sub-agent delegation ([5e49632](https://github.com/sethjuarez/cutready/commit/5e4963262dc9e55c10e77d2bc0d4c3238e7be25a))
* persist feedback to app data directory ([5d5de13](https://github.com/sethjuarez/cutready/commit/5d5de136f8f1ae65f8b0489b8747510fd08f1999))
* Phase 1 timeline switcher — solo mode, promote to main, test plan ([44097ec](https://github.com/sethjuarez/cutready/commit/44097ecf262a982c0288b0cec23ff5095d58cfb1))
* plain markdown editor, chat versioning, image cleanup & manager ([ac70ec1](https://github.com/sethjuarez/cutready/commit/ac70ec1e66bb1dbea99462d9ea2277120301c301))
* portrait/landscape orientation picker for Word export ([a4e90be](https://github.com/sethjuarez/cutready/commit/a4e90be5fb2a9699fdce0c14d69fcb0015d5ecf2))
* preview mode visual improvements — theme, responsive SVG, mini player ([026c208](https://github.com/sethjuarez/cutready/commit/026c20876c756c091796797e3c68ca0cc0004ca0))
* **preview:** render narrative and actions as markdown ([6a6edb5](https://github.com/sethjuarez/cutready/commit/6a6edb540e11033f08e0de484c5ed47a4cdfd652))
* refresh visual thumbnails after editor save ([be1f483](https://github.com/sethjuarez/cutready/commit/be1f4836190e92b06e405e0066cce5ccd980de5f))
* rename Problems tab to Debug with log capture ([36df84f](https://github.com/sethjuarez/cutready/commit/36df84f8973714fadd0f034882f8ee337b01a5ba))
* rename Saves to Snapshots, add draggable tab reorder ([844aaa1](https://github.com/sethjuarez/cutready/commit/844aaa1958d8c4fe97518337f7f4a518180d4b17))
* rename Visual agent to Designer with improved creative prompt ([96985e2](https://github.com/sethjuarez/cutready/commit/96985e2a15c586134b3c6096942e9cdc519563b8))
* render visual thumbnails in image manager with DslRenderer ([ef3c1e2](https://github.com/sethjuarez/cutready/commit/ef3c1e225f784386f6d289b1abb16c558ddd7e1c))
* replace covector with release-please for automated versioning ([331ed46](https://github.com/sethjuarez/cutready/commit/331ed461be96b9ea32fef6a16af10cf7529b9004))
* replace hand-rolled markdown with react-markdown + GFM ([68bde84](https://github.com/sethjuarez/cutready/commit/68bde8462098786d961c2805a627ffd8e8696802))
* reverse activity log + agent identification events ([e6ee63d](https://github.com/sethjuarez/cutready/commit/e6ee63d15c2533057ad4415f1673ac0fb3b3b3e0))
* rewrite History graph with d3 DAG layout + vertical/horizontal toggle ([7784019](https://github.com/sethjuarez/cutready/commit/7784019cf84f69098cd4aba34270d2de1679e76c))
* semantic color tokens for theme-adaptive visuals ([dad498a](https://github.com/sethjuarez/cutready/commit/dad498a40302412ec6bc80059c567cc47c0ca645))
* show -dev suffix on version in dev mode ([a118e78](https://github.com/sethjuarez/cutready/commit/a118e78e69b9de03c0598df3cc5c9bc66325859a))
* show all project files in explorer tree view ([33611da](https://github.com/sethjuarez/cutready/commit/33611da5ab81d785b52b7653c8c762dedc5af1ec))
* show project name in title bar, app version in status bar ([3e84606](https://github.com/sethjuarez/cutready/commit/3e846067bf8b1971655ae339d103b0244d709abe))
* show toast notification after Word export ([bf4b00f](https://github.com/sethjuarez/cutready/commit/bf4b00fb007d0067be163c2fea432078157aee62))
* show workspace / project breadcrumb in title bar ([0d8eec3](https://github.com/sethjuarez/cutready/commit/0d8eec3787ef8892fde258e5ee40c42d94ce25de))
* simplify web references — #https://... instead of #web:https://... ([30e740b](https://github.com/sethjuarez/cutready/commit/30e740b11b5d4dc18aaa9a860dbcb6bdeec4c449))
* smart paste with complexity detection and AI-first conversion ([40b76a1](https://github.com/sethjuarez/cutready/commit/40b76a1db18c9bfdcba776e89d0adfcf886a30ab))
* snapshot diff, bookmarks, collaborator info, PR button, clone, large-file guard, offline resilience ([86d1ae9](https://github.com/sethjuarez/cutready/commit/86d1ae95a516c077b9a5d26cfc5a75c0defc17e1))
* sparkle actions are silent — activity-only, no chat clutter ([35ee24b](https://github.com/sethjuarez/cutready/commit/35ee24b621e42d51a2b722b3a7ccbc3bb7c63417))
* sparkle buttons for AI-assisted editing ([2caecd2](https://github.com/sethjuarez/cutready/commit/2caecd25b56341e54e3a878ea475da450d93f21e))
* sparkle buttons on sketch title and description ([0f9af66](https://github.com/sethjuarez/cutready/commit/0f9af66d2fc9baa5899aa183ba5b35e1f54386a0))
* split editor — right-click tab to open side-by-side preview ([df11fb8](https://github.com/sethjuarez/cutready/commit/df11fb818fe3aa3d66b75580bc40c2ab571efc4f))
* split settings into global and workspace with sidebar reorganization ([b0b3288](https://github.com/sethjuarez/cutready/commit/b0b328861d5bdbbcdcdc988123e9f27ba6865bb4))
* streaming chat responses with real-time UI updates ([510ea0e](https://github.com/sethjuarez/cutready/commit/510ea0e363fca54dcb13f701c3261afbad6aa39b))
* structured dev trace logger (dev-trace.jsonl) ([b0e8d5b](https://github.com/sethjuarez/cutready/commit/b0e8d5bb1cf28d283e6572aaf32a25cd3727ba40))
* styled web reference chips in chat — expandable code-block preview on click ([5957fd9](https://github.com/sethjuarez/cutready/commit/5957fd9735160d4e776f0c34e0419e6f13ac891b))
* submit feedback as GitHub issues via gh CLI ([0e85596](https://github.com/sethjuarez/cutready/commit/0e85596640c364a5d766ef33499f2755aebdad63))
* support old .doc format import with binary text extraction ([88bdd95](https://github.com/sethjuarez/cutready/commit/88bdd952c70e07143d1f93a9e8c6fdc0c902ce64))
* tangled tree layout for History graph with metro-style edge bundling ([450c94a](https://github.com/sethjuarez/cutready/commit/450c94ab35f733c39f833610f784821510f84c01))
* type-specific colors for chat reference chips and tool calls ([250b4f5](https://github.com/sethjuarez/cutready/commit/250b4f53531ee9f919c44024c0f82aab49765ca9))
* uniform reference chips, AI sparkle button, icon-only note controls ([f179316](https://github.com/sethjuarez/cutready/commit/f17931634cf28b5c6d6a9a20dd31a556ad4873f2))
* upgrade [@elucim](https://github.com/elucim) packages to 0.9.0 ([59ea145](https://github.com/sethjuarez/cutready/commit/59ea145a486b4b5d902e3f99cf6f8227a601366c))
* upgrade [@elucim](https://github.com/elucim) to 0.10.0, simplify editor integration ([8ef2e42](https://github.com/sethjuarez/cutready/commit/8ef2e426b425205bfe66fbdd78979acf35baff0e))
* upgrade [@elucim](https://github.com/elucim) to 0.11.0, major integration cleanup ([6ae69f2](https://github.com/sethjuarez/cutready/commit/6ae69f2752f1b9cefbed1fa5b66e1781a88e4fba))
* upgrade elucim to 0.13.1 — canvas scene now uses content theme ([5fa0606](https://github.com/sethjuarez/cutready/commit/5fa06063ad33b2caa181148e883453804c708f92))
* upgrade to elucim 0.12.0, remove workaround code ([1a31f55](https://github.com/sethjuarez/cutready/commit/1a31f55c0676b1f7c526b790fa79b5772a07ee31))
* upgrade to elucim 0.13.0 ([9ed35a0](https://github.com/sethjuarez/cutready/commit/9ed35a006f906857c9176d0ec6e501a636a231ed))
* upgrade to elucim 0.4.0 with poster, ref API, and frame capture ([26043e6](https://github.com/sethjuarez/cutready/commit/26043e6593768538d7eba99e12ad0221d82038fe))
* UX polish — card rows, display settings, chat bubbles, and more ([606394d](https://github.com/sethjuarez/cutready/commit/606394d1ad671a3d97e80b4000b8a06912259ee4))
* **ux:** inline markdown preview for sketch description ([8da2ee9](https://github.com/sethjuarez/cutready/commit/8da2ee9b53537f04ae6cfddae5710eedc1d5028d))
* **ux:** modal snapshot dialog for save (Ctrl+S) ([9e53c8c](https://github.com/sethjuarez/cutready/commit/9e53c8c912265d7750a6570c58e37afb470fb5d3))
* vision/multimodal image support for AI ([78f019e](https://github.com/sethjuarez/cutready/commit/78f019ee62ddfc9a808c35f5b9a545528c0acfd6))
* visual preview lightbox with nudge-to-edit ([6cf4385](https://github.com/sethjuarez/cutready/commit/6cf43852069b36cec35aa1a5844ada0d0b643a81))
* web content preview + auto-refresh OAuth token ([4546f9f](https://github.com/sethjuarez/cutready/commit/4546f9f2c3d8743f0425a012fd71f09708c118db))
* web fetch tool and [@web](https://github.com/web): reference for pulling URLs into context ([898c72a](https://github.com/sethjuarez/cutready/commit/898c72aeea686ff917ad62b18d9cce5be63cbbc6))
* wire ChatPanel to Zustand store with disk persistence ([edf6af1](https://github.com/sethjuarez/cutready/commit/edf6af1840b50537575adb434d5d995030e78281))
* Word (.docx) export for sketches and storyboards ([94b1aa1](https://github.com/sethjuarez/cutready/commit/94b1aa1bd86fd245a984a3ab84cffb7fefd60726))


### Bug Fixes

* activity panel chronological order with auto-scroll ([c06bed6](https://github.com/sethjuarez/cutready/commit/c06bed62e5afb1f464f71f3206dd5b62f94c2361))
* activity panel icons no longer inherit row color ([a31de6f](https://github.com/sethjuarez/cutready/commit/a31de6f0086c02ed35c7ac18cad7bc52cc47bb8e))
* activity panel logs all chat events (send, response, errors) ([a212938](https://github.com/sethjuarez/cutready/commit/a212938b18dc36f0d3764cdb7aa09a4dfcbeeb24))
* activity panel newest-on-top without bottom gap ([5834d98](https://github.com/sethjuarez/cutready/commit/5834d9822edafe504167c148ceb326f5af573c94))
* activity panel shows newest entries at top ([f4da6c9](https://github.com/sethjuarez/cutready/commit/f4da6c92ddaa951f22bd306be24b53286be4e466))
* add connector line to origin badge, match branch label style ([86bc0d2](https://github.com/sethjuarez/cutready/commit/86bc0d2161331d9e6ab35c76c2ce25e255ae5e79))
* add CREATE_NO_WINDOW flag to all subprocess spawns ([223c063](https://github.com/sethjuarez/cutready/commit/223c0632dac3a9f8f362a64f90dfd5e2f6aa1e2a))
* add dialog:allow-save and fs:allow-write-file permissions for Word export ([81290e9](https://github.com/sethjuarez/cutready/commit/81290e938bb06c1aef20b8b35e00ab972981293e))
* add fs:allow-read-file permission for screenshot export ([1ae30d7](https://github.com/sethjuarez/cutready/commit/1ae30d70fbb2004205585b2e947c2c3299ad241a))
* add get_visual mock for visual thumbnail rendering in web mode ([42de3e0](https://github.com/sethjuarez/cutready/commit/42de3e0d60e5d004144cb6f3a9d852cbe7370d58))
* add HTTP timeouts to prevent hanging on slow models ([c137ba5](https://github.com/sethjuarez/cutready/commit/c137ba5f0764dbe89d5d362c787c7e8b0d282d09))
* add missing index sync to discard_changes and pop_stash ([5d5c0c8](https://github.com/sethjuarez/cutready/commit/5d5c0c8b6a67f2bea8617e6e081451a1798521e1))
* add opener:allow-open-path permission for file opening ([bd5e800](https://github.com/sethjuarez/cutready/commit/bd5e800a9d097bc847472314660c612592378f1e))
* add snapshot tools to chat available tools list ([0d25b24](https://github.com/sethjuarez/cutready/commit/0d25b2463f809fe7392e23ca7c3e0a36770bdaec))
* add visual mock data to devMock for web mode testing ([92080a7](https://github.com/sethjuarez/cutready/commit/92080a7d8ab3b0bc527de443b8389bfbe2a2fbf9))
* add wildcard path scope to opener:allow-open-path ([2de1b2f](https://github.com/sethjuarez/cutready/commit/2de1b2f459b4f990a231fe8e4e378e039df09225))
* AI row highlight using background-color instead of box-shadow ([bd1e800](https://github.com/sethjuarez/cutready/commit/bd1e80050614bfe5b63775335eb7a77cb64deeb8))
* align chat chip colors with explorer sidebar selection styles ([f5eceb6](https://github.com/sethjuarez/cutready/commit/f5eceb6010665fa8b7a2462fa6e9792d832fec93))
* apply model override for agent-triggered visual generation ([4231ca3](https://github.com/sethjuarez/cutready/commit/4231ca3de25122e2f9153d4e6ac602bd977995b7))
* auto-parse stringified DSL in validate/critique/set_row tools ([234b68d](https://github.com/sethjuarez/cutready/commit/234b68d1c2eececdc5cc878de7f1024d99eb7128))
* chat session load gracefully falls back when file is missing ([0204089](https://github.com/sethjuarez/cutready/commit/02040896f7af8ce0dc196ebab3060fbeb0421a9e))
* **ci:** add actions:write permission for build dispatch ([f464232](https://github.com/sethjuarez/cutready/commit/f464232898097597423fa77b63e632ea5a77bc94))
* clarify 'Delete all orphaned' button label ([cb80c1b](https://github.com/sethjuarez/cutready/commit/cb80c1b4df88cc0986a85909f755de6e5a646d77))
* clear error message for protected/encrypted .docx files ([e901282](https://github.com/sethjuarez/cutready/commit/e901282c213af0831e2782251724e1ce18c22ace))
* clear feedback form immediately on submit ([b0d8fc5](https://github.com/sethjuarez/cutready/commit/b0d8fc5162f7f2519d41ceaa9514c55f741f5d93))
* collapse dot-prefixed folders by default in tree view ([2c23a4f](https://github.com/sethjuarez/cutready/commit/2c23a4fad2829dd3ee7191239afe1c1757a14543))
* complete editor theme tokens and hide nudge bar in edit mode ([4fd5c4e](https://github.com/sethjuarez/cutready/commit/4fd5c4e7a25ec38976c2fe7ccaa713bfa4cfe235))
* comprehensive Word HTML cleanup for rich paste ([d30a6ab](https://github.com/sethjuarez/cutready/commit/d30a6ab2acaa030ab968e29e053e59e55b42e23d))
* correct command palette shortcut hint (Ctrl+Shift+P, not Ctrl+K) ([d5d2718](https://github.com/sethjuarez/cutready/commit/d5d2718df13fc572063a1bc4df08db6bbe72226e))
* correct DSL property names and add E2E visual rendering tests ([0a1be59](https://github.com/sethjuarez/cutready/commit/0a1be5952bf921c186bd7c0003973d6f924fdc8f))
* correct Tauri command names in split pane and allow splitting active tab ([8cfe5a5](https://github.com/sethjuarez/cutready/commit/8cfe5a5a1a5ccde0a16bbe0b0def1a72d2a2a66b))
* **css:** match list left indent to container right padding (1rem) ([0cc3660](https://github.com/sethjuarez/cutready/commit/0cc3660ff93d976c0c1271360e285e4145623036))
* **css:** restore list-style-type for prose-desc (Tailwind preflight strips it) ([9d37a6a](https://github.com/sethjuarez/cutready/commit/9d37a6ab6c805405bb594ed1cedc3af75d3611ac))
* **css:** show list bullets/numbers with list-style-position: inside ([252a8dc](https://github.com/sethjuarez/cutready/commit/252a8dc22a0d28f912fa495228d84452884a1b63))
* **css:** use list-style-position: outside for aligned list text ([89ce52f](https://github.com/sethjuarez/cutready/commit/89ce52fc982741310e77fa5a81d6dd97bed5d7d8))
* deduplicate @elucim/core via Vite alias ([fa7c29a](https://github.com/sethjuarez/cutready/commit/fa7c29a579b509c2aa9b954323a23d5ceb836018))
* deep DSL validation and 400 error diagnostics ([a80618e](https://github.com/sethjuarez/cutready/commit/a80618e4b9c5e6deed65363cefd2361294df7b83))
* Designer prompt rewrite + 960x540 canvas + semantic token verification ([80c43bd](https://github.com/sethjuarez/cutready/commit/80c43bd42f33d5a801ca35c6810ed94b504ec8f0))
* detect DRM-protected .docx and show clear error ([c22859f](https://github.com/sethjuarez/cutready/commit/c22859f5a62f670ed027014ddc8a081f8475e80a))
* detect image type and use pixel dimensions for screenshot word export ([610a137](https://github.com/sethjuarez/cutready/commit/610a1371f216e60adf9a925c3104fa250e708658))
* disable HTTP connection pooling for LLM requests ([1373952](https://github.com/sethjuarez/cutready/commit/1373952a492ae32f87cdf34ca71065747df457b7))
* **docs:** point installation link to latest release ([0813425](https://github.com/sethjuarez/cutready/commit/08134253bd24effabbcecfbfbfb793059c5876b3))
* downgrade TEXT_OVERLAP and MARGIN_VIOLATION to suggestions ([00b9e11](https://github.com/sethjuarez/cutready/commit/00b9e1102db194a6ec066cc33e621187cd976697))
* escape non-ASCII in JSON bodies to prevent API parse failures ([01ce5b3](https://github.com/sethjuarez/cutready/commit/01ce5b334ce764d0ac65111322a14178e8f4638e))
* exportToWord test flakiness on Windows CI ([0dc4559](https://github.com/sethjuarez/cutready/commit/0dc4559f94a27a35eb5fdc47cd52fde30a1992a8))
* extra brace in SettingsPanel onClick handler ([f5b8fb4](https://github.com/sethjuarez/cutready/commit/f5b8fb4a0d1c73bf891d564d41bdc5752c32d16d))
* feedback buttons to ghost style + add clear all ([db7c3f3](https://github.com/sethjuarez/cutready/commit/db7c3f36498fe3cd778ef23e8eb312031a1490e8))
* feedback popover always saves to app data + copies to clipboard ([2eb27e0](https://github.com/sethjuarez/cutready/commit/2eb27e0936b97d47fb80fcd857bf01c29d1a4234))
* Foundry — strip /api/projects/... and use OpenAI-compatible path ([b4a8345](https://github.com/sethjuarez/cutready/commit/b4a834541111e563d2889cf33d2afcd80e14e328))
* Foundry api-version — use 2025-03-01-preview for chat and models ([6aeef2c](https://github.com/sethjuarez/cutready/commit/6aeef2cab3ee60bbbb5b3cec4696b01f39b36283))
* Foundry auth — revert scope to ai.azure.com, use deployments URL path ([599b5f9](https://github.com/sethjuarez/cutready/commit/599b5f934d4af3a5b5a25596a0bfb3e9ccca3b8f))
* Foundry chat URL — use /models/chat/completions with api-version=2024-05-01-preview ([0a3e95a](https://github.com/sethjuarez/cutready/commit/0a3e95a1b2efa6d493cc7e8f8cfbfd7bc65d8c4d))
* Foundry URL — model name in path, api-version=2024-05-01-preview ([9fd679d](https://github.com/sethjuarez/cutready/commit/9fd679d21ae22815305bf92f051d9614c0eab3e4))
* Foundry uses /openai/models, not /openai/deployments ([b9d9ccf](https://github.com/sethjuarez/cutready/commit/b9d9ccfc3bb70edd9ea7a9e9d8fb5e98272c3c0f))
* global Escape key cancels all creation/rename actions ([a8c8164](https://github.com/sethjuarez/cutready/commit/a8c8164eae7a329d47cea605f0e5dc61b97b9ebf))
* guard against Azure gateway body size limit ([10e2eb7](https://github.com/sethjuarez/cutready/commit/10e2eb7d279caa9320fcd3fa655660dd23a94b0a))
* handle flattened DSL args in validate/critique tools ([653abbf](https://github.com/sethjuarez/cutready/commit/653abbf72dec53ef646ecaeab0ae72ad09a950a7))
* handle inline images in note-to-Word export ([735724b](https://github.com/sethjuarez/cutready/commit/735724b6e147e95b6091b883bb356a6cbe433911))
* handle multimodal content parts in chat message rendering ([910e0ea](https://github.com/sethjuarez/cutready/commit/910e0ea7c46a4c6a667b8976ed69f1a669693d74))
* harden against 400 JSON errors with validation and broader retry ([8895dc2](https://github.com/sethjuarez/cutready/commit/8895dc2778be78737c521c774031cd9d21f85c4e))
* horizontal history graph now reads left-to-right (oldest to newest) ([367d591](https://github.com/sethjuarez/cutready/commit/367d59148a3f499a3f7f1f4e69eb9d876a7b438a))
* import error handling and file path extraction ([b2a12c4](https://github.com/sethjuarez/cutready/commit/b2a12c4d663a45ccfaf21b05722da14152050902))
* import icon arrow points down instead of up ([fe4bd0e](https://github.com/sethjuarez/cutready/commit/fe4bd0e7e5541adf4ae93c495ce80770e884c60a))
* import sketch/notes now copies referenced visuals and screenshots ([59ad9b2](https://github.com/sethjuarez/cutready/commit/59ad9b249e757c4e133671c8531e3a6052c004af))
* improve chip contrast with stronger background tinge ([5171b86](https://github.com/sethjuarez/cutready/commit/5171b8640cda61a73db9c634495bb8db5df96534))
* improve Designer visual quality — fill canvas, relax limits, overflow detection ([d14c0e6](https://github.com/sethjuarez/cutready/commit/d14c0e6253503bf5ed7afacbadf19be8f1e38a7e))
* improve orphaned image detection and add deletion safeguards ([fa0e69d](https://github.com/sethjuarez/cutready/commit/fa0e69de5e1709bfd258cd41297aae814e46e183))
* include Responses API models (codex/pro) in model dropdown ([db6794a](https://github.com/sethjuarez/cutready/commit/db6794a62c9bbcc39c916d0d8e25c23bb3d5dbf9))
* inline debug toggle and send button on same row ([9323a1a](https://github.com/sethjuarez/cutready/commit/9323a1a1a4fd0f07711caf3bc67f265767e722fc))
* keep #web:URL text in chat input instead of stripping it ([08b004b](https://github.com/sethjuarez/cutready/commit/08b004b27d223739c45316e3597d7b851c5d3d5c))
* lazy-load elucim to fix React 19 ReactCurrentDispatcher crash ([06b16e7](https://github.com/sethjuarez/cutready/commit/06b16e75d1296f68c281623e4dfc97f6f03e0424))
* light-mode visuals and 200px thumbnail size in Word export ([c5e0e73](https://github.com/sethjuarez/cutready/commit/c5e0e73c5d0fac6da29b4a948bf943357370be9f))
* lightbox now appends to &lt;body&gt; to escape Starlight nav stacking context ([bf0d37d](https://github.com/sethjuarez/cutready/commit/bf0d37d20f87fe2579535d6db48b9507a2be0686))
* list deployed models instead of all available models ([c916435](https://github.com/sethjuarez/cutready/commit/c9164357880287958cd20adaeec2550062ca1f33))
* lower body size limit for Responses API to prevent 400 errors ([bca0214](https://github.com/sethjuarez/cutready/commit/bca0214ce5613716a8ecae0cdfcef9a2a33154fe))
* lower Responses API compaction threshold from 1MB to 128KB ([a6b0a1f](https://github.com/sethjuarez/cutready/commit/a6b0a1fd1c900027fb620dd3267719449ccb15cf))
* lower Responses API compaction to 64KB (server rejects at ~79KB) ([ac6755c](https://github.com/sethjuarez/cutready/commit/ac6755c684aff10eec23fa70d8d698f631326c07))
* make Actions prominent in visual generation prompt ([f70bd74](https://github.com/sethjuarez/cutready/commit/f70bd74e18b1a216552ad0b49ad8da799107e722))
* make sparkle buttons always visible instead of hover-only ([0fdb65c](https://github.com/sethjuarez/cutready/commit/0fdb65c65e8b158f38d7792e0081e3bb81f4d470))
* make visual preview discoverable with expand button ([c0e7622](https://github.com/sethjuarez/cutready/commit/c0e762294d57c06c09206fa5b71cfd6b574f48e3))
* match feedback icon in settings tab and add title bar separator ([0b48f4e](https://github.com/sethjuarez/cutready/commit/0b48f4eccbf181244930079171013a0302b1ffad))
* model-aware context window compaction ([b8eb49e](https://github.com/sethjuarez/cutready/commit/b8eb49ee206756daadfd01bcf5b8fa69ad4fc610))
* move ephemeral UI state to .git/cutready/, fix dirty detection ([255624f](https://github.com/sethjuarez/cutready/commit/255624f50bbb597881fbeb05d3fc4e6cefcf8150))
* move project switcher above explorer header ([3f56f5d](https://github.com/sethjuarez/cutready/commit/3f56f5db5057d21b7414f25a6a17687657f6577f))
* move project switcher below explorer header ([16c6f2d](https://github.com/sethjuarez/cutready/commit/16c6f2d06c32dd89d8f6dc275555553d78aa6f78))
* multi-project migration now moves screenshots and visuals ([2a0f112](https://github.com/sethjuarez/cutready/commit/2a0f1128c393c384058e87f463c3131a5b9b97ba))
* nested button in chat session history ([327d6c8](https://github.com/sethjuarez/cutready/commit/327d6c8c2f5e3081772ba769600cd54fe2d7d972))
* **notes:** match preview container to edit container layout ([482b207](https://github.com/sethjuarez/cutready/commit/482b207bc142846df9a7bc93be62db42a1d27198))
* **notes:** separate prose-desc from centering wrapper ([37945ba](https://github.com/sethjuarez/cutready/commit/37945baaa6d8efaca13c963f36b1b894cfd29386))
* OAuth scope — use cognitiveservices.azure.com instead of ai.azure.com ([7589010](https://github.com/sethjuarez/cutready/commit/7589010f334e1a0a026bbadcc981de738725422f))
* orphaned images now checks sketch files for screenshot references ([796f5f5](https://github.com/sethjuarez/cutready/commit/796f5f525a917aeee21569ad47a3693fe2818d9a))
* override editor canvas background with CutReady warm colors ([8b0dc05](https://github.com/sethjuarez/cutready/commit/8b0dc0541a76151b001c2dd63af757bc4805e0ba))
* pass DSL content tokens to editor theme for canvas  resolution ([8fb39b4](https://github.com/sethjuarez/cutready/commit/8fb39b4fad3c9a06f1b30d47c266a34c6585a78a))
* pass explicit colorScheme to ElucimEditor for correct light/dark chrome ([7fba225](https://github.com/sethjuarez/cutready/commit/7fba225b58d19d294035f2bdc965866bb19e1652))
* persist chat session across app restarts ([6c37cae](https://github.com/sethjuarez/cutready/commit/6c37caec7ba1b0006ffb94e2e2ba606b456dbd5f))
* persist note preview mode across tab switches ([2b4409a](https://github.com/sethjuarez/cutready/commit/2b4409a397cfb718a86c184ca9654e313eeee8ce))
* persist open tabs across app restarts via localStorage ([bb06f1e](https://github.com/sethjuarez/cutready/commit/bb06f1e7f36db3c05d91ae7ca573d6c20e5d388e))
* planner agent now recommends changes instead of applying them ([53222b6](https://github.com/sethjuarez/cutready/commit/53222b6079408a329c0d887f47915100c1d271a6))
* position toast above status bar and log export to activity ([0894628](https://github.com/sethjuarez/cutready/commit/0894628976ed250c645545dd3b06d90c86c11cc6))
* preserve tool_call/tool_result message ordering ([7da23bb](https://github.com/sethjuarez/cutready/commit/7da23bba51d03d1609df9fbf91d324f32839c5aa))
* preserve visual/design_plan when frontend saves rows ([e65b7af](https://github.com/sethjuarez/cutready/commit/e65b7af6c4c07c5eace6326925a3a812aac99fcd))
* prevent AI paste refinement from truncating content ([fca1d2d](https://github.com/sethjuarez/cutready/commit/fca1d2d83ab16f382e54c40d416ac71e4ae2b39c))
* prevent chat dropdowns from clipping and going off-screen ([80c364b](https://github.com/sethjuarez/cutready/commit/80c364b3b579fcd00c285aadb47f53fe6ef67913))
* prevent JSON decode errors from control chars and UTF-8 truncation ([55db898](https://github.com/sethjuarez/cutready/commit/55db8981fa706bdcfb60074aec15a100e7dee789))
* preview mode — fill space, theme vars, replay in header ([4b50186](https://github.com/sethjuarez/cutready/commit/4b5018663ddcaa76a326313740bc3d9fdf880fa3))
* **preview:** align text panel padding with tab headers ([017eb57](https://github.com/sethjuarez/cutready/commit/017eb57f0e50ce86bb1d4357acd6d679e82ba4fd))
* **preview:** reset all prose-desc margin/padding to fix left offset ([e78fd06](https://github.com/sethjuarez/cutready/commit/e78fd0695964d259ae862895f8f3ca5489d11425))
* prioritize user instructions in visual generation ([8639d91](https://github.com/sethjuarez/cutready/commit/8639d912d7f6474ef1519919bdd2baab2a2eb9ad))
* raise Responses API body limit to 1MB and improve error classification ([dbdd2d9](https://github.com/sethjuarez/cutready/commit/dbdd2d953785f1e6473dd64c464a09f0770ff484))
* reduce empty screenshot button height from h-12 to h-7 ([af52e25](https://github.com/sethjuarez/cutready/commit/af52e2573286fd2efebf8ee57053aabfff57e010))
* reduce note editor active-line highlight to prevent masking selections ([d9cff83](https://github.com/sethjuarez/cutready/commit/d9cff83d5dc5ddc8a67d7b7d9319534c5370dc37))
* refresh currentProject after rename so switcher label updates ([cd91e65](https://github.com/sethjuarez/cutready/commit/cd91e65f2e12c569a3fb5ce75c2dff3f18d39404))
* refresh OAuth token before smart paste AI call ([0611252](https://github.com/sethjuarez/cutready/commit/0611252467d6cc61c293227bf577ffc0164ba2b1))
* refresh snapshot timeline after fetch and push ([ebd187f](https://github.com/sethjuarez/cutready/commit/ebd187fa17647341f48417a0500337372ea84f46))
* refresh sync status after saving snapshot ([23ad734](https://github.com/sethjuarez/cutready/commit/23ad7348eb3d9e509ed07abb4dd90beef523c52d))
* reliable session archival via Rust-side CloseRequested ([84a3245](https://github.com/sethjuarez/cutready/commit/84a324545daafe15c97833eb7d4eca594746e492))
* reload sketch after set_row_visual tool so visuals appear in UI ([561ce02](https://github.com/sethjuarez/cutready/commit/561ce0242d16bd2578538e3450e431e1e0137396))
* remove all activity log truncation — full content for sends, results, responses, errors ([f79574a](https://github.com/sethjuarez/cutready/commit/f79574a9cdb27b39a8ecdd28f767d35f731d5992))
* remove auto-commit snapshots on delete ([a5d77ab](https://github.com/sethjuarez/cutready/commit/a5d77ab1d60006450aa2b007241a331c00cb3384))
* remove green text for success entries in activity panel ([0b8a999](https://github.com/sethjuarez/cutready/commit/0b8a999d47ba0199c3debc994e662e4eadb18f1f))
* remove icon from feedback settings tab button ([bcebeed](https://github.com/sethjuarez/cutready/commit/bcebeed0de4b7fd9ce50f5af2dd783ffcfdfb6f8))
* remove saveVersion calls from delete actions in frontend ([413438b](https://github.com/sethjuarez/cutready/commit/413438b43006226ca94f3d8bc89a1fc7328c88d3))
* remove unused diff variables from SnapshotGraph ([2d268b2](https://github.com/sethjuarez/cutready/commit/2d268b2c19c465f72631cc7be7572df6c3850906))
* remove-visual button now clears the visual field instead of screenshot ([033311e](https://github.com/sethjuarez/cutready/commit/033311edc684b59afb5793e050b69d50b1d49de9))
* rename 'New Project' to 'New Workspace' on home screen ([1c27caf](https://github.com/sethjuarez/cutready/commit/1c27caf67017a09799d0fbc8159e151da2d0fa60))
* rename 'Open Project' to 'Open Workspace' on home screen ([dcce665](https://github.com/sethjuarez/cutready/commit/dcce665d3949e6f6ca42776f00eef3582cf8c752))
* rename 'Recent Projects' to 'Recent Workspaces' on home screen ([4d1e6b9](https://github.com/sethjuarez/cutready/commit/4d1e6b923f5cdbd81eaa7f3f9e1720b8a8ae0350))
* rename single-project triggers migration to multi-project mode ([dfd9390](https://github.com/sethjuarez/cutready/commit/dfd9390dfc9d9821c6071668a82ac9af01ded051))
* rename_project now renames folder and updates manifest path ([0bd085e](https://github.com/sethjuarez/cutready/commit/0bd085e8d9bb52aaab9322555385a0cd6c1b912f))
* render &lt;br&gt; and other HTML tags in markdown previews ([dda1780](https://github.com/sethjuarez/cutready/commit/dda17800f6591f789492703522faf60a8ef9a79e))
* render local images in note preview and chat ([76a0bd5](https://github.com/sethjuarez/cutready/commit/76a0bd57187d34617395467b1e8a9622105c8ac6))
* render markdown formatting in Word export ([a0b1ac2](https://github.com/sethjuarez/cutready/commit/a0b1ac2c7419ca8c8e82b07dd15c364003c8feb5))
* render nested sub-bullets in sketch planning row cells ([9d9fdc5](https://github.com/sethjuarez/cutready/commit/9d9fdc5b5a647dbf0d26edcceaff4f3d89c9c26b))
* repair all 4 remaining e2e test failures (81/81 green) ([739b7b6](https://github.com/sethjuarez/cutready/commit/739b7b65c4dce74e234f90953c37c3958db4fd56))
* replace clone error alert() with toast notification ([6ec965e](https://github.com/sethjuarez/cutready/commit/6ec965ec933c3ae831dfc7c000784d9ad388d92f))
* replace double-click rename with pencil icon button ([aeed297](https://github.com/sethjuarez/cutready/commit/aeed29752d1c87f30899aa5f93eb9901d82458b4))
* replace submit button with icon-only send button ([e18f690](https://github.com/sethjuarez/cutready/commit/e18f690bab25f57ceedebc8d0ad5c6f2a67e86e9))
* resize and budget images to prevent 400 API errors ([2cebe5d](https://github.com/sethjuarez/cutready/commit/2cebe5dd67ceeaff541ffd31b4515f25b92069b2))
* resolve \ token on canvas root ([176bc65](https://github.com/sethjuarez/cutready/commit/176bc653d2981e375d854f0de51565464e89bcb5))
* resolve git identity from gh CLI to fix reflog errors on fresh machines ([4af0a3c](https://github.com/sethjuarez/cutready/commit/4af0a3c246140548aa60582f5513b58130e11840))
* resolve short commit hashes in snapshot tools ([cfbf14c](https://github.com/sethjuarez/cutready/commit/cfbf14c60f461b8ad433a2e792389a3606bbdc97))
* Responses API tool calls ignored due to finish_reason=stop ([bd67c88](https://github.com/sethjuarez/cutready/commit/bd67c88d57c64e4570a283db925a237bea7d4dff))
* restore buildPreviewDsl and explicit colorScheme for DslRenderer ([325d73c](https://github.com/sethjuarez/cutready/commit/325d73c8ce38e1dcaa61c433dc71cec748f3a715))
* restore display-friendly user messages after backend response ([37cdf06](https://github.com/sethjuarez/cutready/commit/37cdf0670d0931d0a37b2945cd439624951bd2a2))
* restore last active project when reopening multi-project workspace ([7e05133](https://github.com/sethjuarez/cutready/commit/7e0513310924a8f8a146a49782a180c871848ef6))
* restore version history as Saves tab alongside Chat History ([3fae4cb](https://github.com/sethjuarez/cutready/commit/3fae4cbe9bcac1a8dc4e478cbd69194cd8aa16ad))
* restore-down icon — proper overlap with solid front rect ([db5b9e1](https://github.com/sethjuarez/cutready/commit/db5b9e1bef36f8bfd68547d2c2e38e5610eda01a))
* reverse history graph to show newest commits at top ([d47c3d6](https://github.com/sethjuarez/cutready/commit/d47c3d60e1b6157ec8c64e2a82c9bb3b25867eff))
* revert inner padding — should be handled by elucim editor ([3bfc1ba](https://github.com/sethjuarez/cutready/commit/3bfc1bae274cce3e6983a4ece191628915f2248a))
* sanitize all message content before API serialization ([e1796a8](https://github.com/sethjuarez/cutready/commit/e1796a804a068f308905cc6f37da1b4d2acf7038))
* scan .chats directory for sessions, rename tab to Sessions ([78ff3c2](https://github.com/sethjuarez/cutready/commit/78ff3c21c8865b512d604409350edd00c23f562e))
* shell open scope for Word export auto-open ([410aca2](https://github.com/sethjuarez/cutready/commit/410aca21299e84dce647249cff7062790d62b7b5))
* show actionable toast on clone 401 — guides users to gh auth login ([9fa97a2](https://github.com/sethjuarez/cutready/commit/9fa97a2363c98f835c9f2493e70db01ba7f61d54))
* show all deployed models, not just chat-capable ones ([763f431](https://github.com/sethjuarez/cutready/commit/763f4318e37f3baef6bfdf0a34d440fea83d1348))
* show all image actions on hover for existing screenshots ([cac038c](https://github.com/sethjuarez/cutready/commit/cac038c4df030ba038c61e2d0441a74f0d15b127))
* show codex/pro models in chat model picker dropdown ([fa8887a](https://github.com/sethjuarez/cutready/commit/fa8887ad92d29507486729ea00d749778ad66f81))
* show dotfiles/dotdirs in explorer tree view ([84892f2](https://github.com/sethjuarez/cutready/commit/84892f2c9d42f9d3161acc57b1e98b4f43cc1fef))
* show sparkle buttons even when description is empty ([894871b](https://github.com/sethjuarez/cutready/commit/894871b330d6ec7d2da2c4693ba43d29b2c49f1f))
* sidebar drag handle now visible on hover ([39d0d01](https://github.com/sethjuarez/cutready/commit/39d0d01350487e56dca8be3a57cbf649be229a6d))
* sparkle buttons scope updates to their own field ([6f2e871](https://github.com/sethjuarez/cutready/commit/6f2e871f4441d7bc93d073c41eb3375659b1d01a))
* standardize 'workspace' terminology across all UI strings ([50a412e](https://github.com/sethjuarez/cutready/commit/50a412e1512397f309cd169f81eed13285d36aea))
* support covector tag format in build workflows ([cbe005d](https://github.com/sethjuarez/cutready/commit/cbe005d509ab7a28129b6ad43cd9304c69428058))
* sync git index after gix commits and checkouts ([2d9e701](https://github.com/sethjuarez/cutready/commit/2d9e701aae1ff825ff0256ff68b91f563f507191))
* system prompts tell agents to use tools, not paste tables ([4691f9c](https://github.com/sethjuarez/cutready/commit/4691f9c72fa5b8783776c5a3b2894ecc1e49ba63))
* theme-consistent feedback icons and localStorage persistence ([fc00d49](https://github.com/sethjuarez/cutready/commit/fc00d497028b19fc39b3a312783f74a3a94b15e9))
* tool path resolution and new sketch creation ([45f8447](https://github.com/sethjuarez/cutready/commit/45f84473870e68e978758d36da16e4f0e7a9ad47))
* try Foundry /models endpoint (deployed only) before /openai/models ([7214df8](https://github.com/sethjuarez/cutready/commit/7214df83e0b7c23c97397126ef779cebf5c668a7))
* try Foundry deployments endpoints before falling back to models ([563f8b6](https://github.com/sethjuarez/cutready/commit/563f8b650d4d3a0050fe82629dfc0d69791ec8bd))
* update @elucim/dsl to 0.8.3 — renderToPng resolves CSS vars ([818d004](https://github.com/sethjuarez/cutready/commit/818d0041fcffbb05f5ad3bfb955744e2136b9c36))
* use @dnd-kit/sortable for tab reordering instead of HTML5 DnD ([2cf51e7](https://github.com/sethjuarez/cutready/commit/2cf51e79d540c7e0c63a840c1a1228f022888bec))
* use @elucim/dsl renderToPng for visual Word export ([5a51a97](https://github.com/sethjuarez/cutready/commit/5a51a97e4a6aa42b84164ddb181f98036d2fb589))
* use 0-based index in generate-visual prompt to prevent wrong-row placement ([7ac1e69](https://github.com/sethjuarez/cutready/commit/7ac1e692660325a6588b52d0b1c7be7eb54453dd))
* use absolute positioning for visual thumbnails to avoid flex collapse ([5ee117c](https://github.com/sethjuarez/cutready/commit/5ee117cdcbedece211439d4c63930b028716a5d8))
* use correct credential format for clone (token as password, not username) ([a6ebfec](https://github.com/sethjuarez/cutready/commit/a6ebfec63e63c7a1c7a63c4aecdf28c06e6516b6))
* use CutReady icon for empty state instead of emoji ([961f927](https://github.com/sethjuarez/cutready/commit/961f9277240c2487abd4905db09fcf24279ce73e))
* use CutReady logo with gradient glow for empty state ([3d9ebd2](https://github.com/sethjuarez/cutready/commit/3d9ebd2dcb64bf8929d40ba1084bd904ae83e9ff))
* use data-URI for SVG→PNG rasterization in Word export ([42a09db](https://github.com/sethjuarez/cutready/commit/42a09dbef51f0038bfddc4421f28380f2230016a))
* use default cursor on secondary panel tabs ([a488ac7](https://github.com/sethjuarez/cutready/commit/a488ac706bca200e7209f7a9a6af9ad6c3e2eaf4))
* use EditorProvider directly so save gets live document ([920c597](https://github.com/sethjuarez/cutready/commit/920c59797495129169b4017ce97bc0190d820668))
* use ElucimEditor directly and resolve \ colors ([d205090](https://github.com/sethjuarez/cutready/commit/d2050902412ac00548b5ac01fce88fbb12f0ab07))
* use explicit purple hex for user message border in both themes ([ac64f8f](https://github.com/sethjuarez/cutready/commit/ac64f8fbeb1f5453005627382449e2473249585a))
* use floppy-disk icon for visual editor save button ([5dd98f4](https://github.com/sethjuarez/cutready/commit/5dd98f4007475e966916fade194ae061226c14ec))
* use Foundry project /deployments?api-version=v1 for deployed models ([0333259](https://github.com/sethjuarez/cutready/commit/0333259dce575c20066f4ce2e3209bc09afa2219))
* use full CSS var name for editor canvas background override ([7f8586c](https://github.com/sethjuarez/cutready/commit/7f8586c7c44717589f3b1bc0ae88d77571683ca1))
* use line-art SVG icons in image manager sections ([68f77a3](https://github.com/sethjuarez/cutready/commit/68f77a338873bf587c5d24b5055aa618883d5582))
* use memory summarization when trimming for body size ([f0a444a](https://github.com/sethjuarez/cutready/commit/f0a444add1b5d975d2103ad3a15c8be4aea086a1))
* use native save dialog for Word export ([1bf18bc](https://github.com/sethjuarez/cutready/commit/1bf18bcd38e9aaec6159893e0a8f7e98294126c4))
* use native Word bullet and numbered list formatting ([9037f56](https://github.com/sethjuarez/cutready/commit/9037f5681a4d8af3441a86c8ee0d632786166169))
* use read_timeout instead of request timeout for streaming ([1d8d6f0](https://github.com/sethjuarez/cutready/commit/1d8d6f062fab5644e6848145658438284d64eedb))
* use ResizeObserver for correct visual preview sizing in lightbox ([beffc90](https://github.com/sethjuarez/cutready/commit/beffc9045ca370a22da370341d810212aa1b80a3))
* use shared Icons for sketch/note/storyboard in chat dropdowns ([fe59d29](https://github.com/sethjuarez/cutready/commit/fe59d29bedc813e884b0bce4b99c4a17d803ae4b))
* use stroke-based sparkle icon to match Feather/Lucide style ([495e0d0](https://github.com/sethjuarez/cutready/commit/495e0d06a645d1f295553a293ef72a28d133abaa))
* use SVG chat-bubble in feedback empty state and widen settings ([466077f](https://github.com/sethjuarez/cutready/commit/466077fabb16235bd71dd853a91d6e8cfc8f9563))
* use tauri-plugin-opener for opening local files after Word export ([714f8c6](https://github.com/sethjuarez/cutready/commit/714f8c6b5decf1f9fb115269e2b8d9d42b61e844))
* **ux:** clicking sidebar items dismisses settings panel ([9d59b8a](https://github.com/sethjuarez/cutready/commit/9d59b8a3e0cff4fc82af647a4a5ad42e057a0383))
* **ux:** improve bold/italic visibility in rendered markdown ([6bee31c](https://github.com/sethjuarez/cutready/commit/6bee31cd573be863ad067ccc9b6643c023c7db8c))
* **ux:** keep #mention text in chat input after autocomplete ([f03f1a0](https://github.com/sethjuarez/cutready/commit/f03f1a023f58a32687f5224139027fa2ef67c86c))
* **ux:** restyle model refresh button to match app design ([8cb416d](https://github.com/sethjuarez/cutready/commit/8cb416d60cf9eee6f426b359dd01ea5fba4a5d50))
* **ux:** settings reactivity, remove row clamp, consistent styles ([811aa8c](https://github.com/sethjuarez/cutready/commit/811aa8c24ce716b2fac1d66669110a686f2b894a))
* **ux:** show reference chips as footnotes instead of prefix ([a1c377b](https://github.com/sethjuarez/cutready/commit/a1c377b811c3b29de0c0da1e3e7c25de56d1c2ea))
* validate JSON after escape_non_ascii_json, fall back on corruption ([feddf8e](https://github.com/sethjuarez/cutready/commit/feddf8e18946b21bf5d71e05763038f0d94c6de8))
* vendor openssl-sys for macOS Intel cross-compilation ([69554c1](https://github.com/sethjuarez/cutready/commit/69554c1cf6bfd1374667c2e4d21113a0cdb7c781))
* visual critique reliability — UTF-8 panics, thresholds, em-dashes ([96d6291](https://github.com/sethjuarez/cutready/commit/96d6291a21f2f72459fa0906bc1de29b8976736e))
* visual export to Word — use Image+canvas instead of svgToCanvas ([ec6adb8](https://github.com/sethjuarez/cutready/commit/ec6adb819e323b65ae1d3562ddf122ad70dbbf75))
* visual lightbox renders blank — container had no dimensions ([0263a4c](https://github.com/sethjuarez/cutready/commit/0263a4c863981c3dcdd9fbd958964817a8d69df9))
* VisualCell crash when visual loads async — null dsl guard ([0763225](https://github.com/sethjuarez/cutready/commit/07632251bde40eb9bbac9e34b2b9f23d3c890b33))
* visuals fill canvas edge-to-edge instead of inner card ([4aea37d](https://github.com/sethjuarez/cutready/commit/4aea37d9a7a3852f63be329aa056104265daa7ec))
* web content no longer dumped into chat — compact ref shown, full content sent to LLM only ([91b546e](https://github.com/sethjuarez/cutready/commit/91b546e6fa2f09169a0eb7dd406cfdffeff48c18))
* widen settings panel to max-w-4xl ([e71f59a](https://github.com/sethjuarez/cutready/commit/e71f59abb31de94bd6f72d8c243eb71733ab4eb0))


### Performance Improvements

* cache model list with 5-minute TTL ([40b4fc3](https://github.com/sethjuarez/cutready/commit/40b4fc3ee57a05112985be6ce9e8b9c4a065d6e1))
* **ci:** replace rust-cache with sccache for faster builds ([19eec97](https://github.com/sethjuarez/cutready/commit/19eec97d50281e8a7b0852f8a79d35bd4d5f6383))

## [0.14.0](https://github.com/sethjuarez/cutready/compare/v0.13.0...v0.14.0) (2026-03-19)


### Features

* add Windows ARM64 (aarch64) build target to release workflow ([ee9f6cc](https://github.com/sethjuarez/cutready/commit/ee9f6cc2d4fea3d70bc343652423852d99cd0240)), closes [#19](https://github.com/sethjuarez/cutready/issues/19)


### Bug Fixes

* add CREATE_NO_WINDOW flag to all subprocess spawns ([ab89238](https://github.com/sethjuarez/cutready/commit/ab89238bc0c0b5176395d138c035ec7f356bc8af))

## [0.13.0](https://github.com/sethjuarez/cutready/compare/v0.12.0...v0.13.0) (2026-03-18)


### Features

* identity prompt dialog when git identity is unresolved ([8a5ce33](https://github.com/sethjuarez/cutready/commit/8a5ce3378b5ddb7574d94acd5840537e0edab05a))


### Bug Fixes

* resolve git identity from gh CLI to fix reflog errors on fresh machines ([409546b](https://github.com/sethjuarez/cutready/commit/409546bf14a295610f7073d68073a26c70214911))

## [0.12.0](https://github.com/sethjuarez/cutready/compare/v0.11.0...v0.12.0) (2026-03-18)


### Features

* add Export Logs command to command palette ([f18ddc0](https://github.com/sethjuarez/cutready/commit/f18ddc050238442b9b043d9283247bf79e15ea9b))
* add snapshot/versioning tools to AI agent ([5b55ecc](https://github.com/sethjuarez/cutready/commit/5b55eccb8927be940ed42c052c39747f20d9a0b1))
* submit feedback as GitHub issues via gh CLI ([0e85596](https://github.com/sethjuarez/cutready/commit/0e85596640c364a5d766ef33499f2755aebdad63))


### Bug Fixes

* add connector line to origin badge, match branch label style ([86bc0d2](https://github.com/sethjuarez/cutready/commit/86bc0d2161331d9e6ab35c76c2ce25e255ae5e79))
* add fs:allow-read-file permission for screenshot export ([1ae30d7](https://github.com/sethjuarez/cutready/commit/1ae30d70fbb2004205585b2e947c2c3299ad241a))
* add snapshot tools to chat available tools list ([0d25b24](https://github.com/sethjuarez/cutready/commit/0d25b2463f809fe7392e23ca7c3e0a36770bdaec))
* detect image type and use pixel dimensions for screenshot word export ([610a137](https://github.com/sethjuarez/cutready/commit/610a1371f216e60adf9a925c3104fa250e708658))
* handle inline images in note-to-Word export ([735724b](https://github.com/sethjuarez/cutready/commit/735724b6e147e95b6091b883bb356a6cbe433911))
* move ephemeral UI state to .git/cutready/, fix dirty detection ([255624f](https://github.com/sethjuarez/cutready/commit/255624f50bbb597881fbeb05d3fc4e6cefcf8150))
* refresh snapshot timeline after fetch and push ([ebd187f](https://github.com/sethjuarez/cutready/commit/ebd187fa17647341f48417a0500337372ea84f46))
* resolve short commit hashes in snapshot tools ([cfbf14c](https://github.com/sethjuarez/cutready/commit/cfbf14c60f461b8ad433a2e792389a3606bbdc97))
* restore last active project when reopening multi-project workspace ([7e05133](https://github.com/sethjuarez/cutready/commit/7e0513310924a8f8a146a49782a180c871848ef6))
* reverse history graph to show newest commits at top ([d47c3d6](https://github.com/sethjuarez/cutready/commit/d47c3d60e1b6157ec8c64e2a82c9bb3b25867eff))
* show actionable toast on clone 401 — guides users to gh auth login ([9fa97a2](https://github.com/sethjuarez/cutready/commit/9fa97a2363c98f835c9f2493e70db01ba7f61d54))
* use correct credential format for clone (token as password, not username) ([a6ebfec](https://github.com/sethjuarez/cutready/commit/a6ebfec63e63c7a1c7a63c4aecdf28c06e6516b6))

## [0.11.0](https://github.com/sethjuarez/cutready/compare/v0.10.0...v0.11.0) (2026-03-18)


### Features

* add CutReady-specific elucim themes with concrete hex values ([e882ea9](https://github.com/sethjuarez/cutready/commit/e882ea971aeed6a26339b9b8dff86b30cea454f6))
* import conflict dialog — overwrite, keep both, or cancel ([cf1b077](https://github.com/sethjuarez/cutready/commit/cf1b077ab04eabf391025ba085136496eacc165d))
* include visuals in image manager for orphan detection and cleanup ([aa54efb](https://github.com/sethjuarez/cutready/commit/aa54efb64f4c566f6cd4007d127088d2190562ae))
* integrate Elucim visual editor in expanded lightbox ([2b98e39](https://github.com/sethjuarez/cutready/commit/2b98e39a3b506786992b076c9d66c98610b3eb14))
* refresh visual thumbnails after editor save ([be1f483](https://github.com/sethjuarez/cutready/commit/be1f4836190e92b06e405e0066cce5ccd980de5f))
* render visual thumbnails in image manager with DslRenderer ([ef3c1e2](https://github.com/sethjuarez/cutready/commit/ef3c1e225f784386f6d289b1abb16c558ddd7e1c))
* split editor — right-click tab to open side-by-side preview ([df11fb8](https://github.com/sethjuarez/cutready/commit/df11fb818fe3aa3d66b75580bc40c2ab571efc4f))
* upgrade [@elucim](https://github.com/elucim) packages to 0.9.0 ([59ea145](https://github.com/sethjuarez/cutready/commit/59ea145a486b4b5d902e3f99cf6f8227a601366c))
* upgrade [@elucim](https://github.com/elucim) to 0.10.0, simplify editor integration ([8ef2e42](https://github.com/sethjuarez/cutready/commit/8ef2e426b425205bfe66fbdd78979acf35baff0e))
* upgrade [@elucim](https://github.com/elucim) to 0.11.0, major integration cleanup ([6ae69f2](https://github.com/sethjuarez/cutready/commit/6ae69f2752f1b9cefbed1fa5b66e1781a88e4fba))
* upgrade elucim to 0.13.1 — canvas scene now uses content theme ([5fa0606](https://github.com/sethjuarez/cutready/commit/5fa06063ad33b2caa181148e883453804c708f92))
* upgrade to elucim 0.12.0, remove workaround code ([1a31f55](https://github.com/sethjuarez/cutready/commit/1a31f55c0676b1f7c526b790fa79b5772a07ee31))
* upgrade to elucim 0.13.0 ([9ed35a0](https://github.com/sethjuarez/cutready/commit/9ed35a006f906857c9176d0ec6e501a636a231ed))


### Bug Fixes

* add get_visual mock for visual thumbnail rendering in web mode ([42de3e0](https://github.com/sethjuarez/cutready/commit/42de3e0d60e5d004144cb6f3a9d852cbe7370d58))
* add visual mock data to devMock for web mode testing ([92080a7](https://github.com/sethjuarez/cutready/commit/92080a7d8ab3b0bc527de443b8389bfbe2a2fbf9))
* complete editor theme tokens and hide nudge bar in edit mode ([4fd5c4e](https://github.com/sethjuarez/cutready/commit/4fd5c4e7a25ec38976c2fe7ccaa713bfa4cfe235))
* correct Tauri command names in split pane and allow splitting active tab ([8cfe5a5](https://github.com/sethjuarez/cutready/commit/8cfe5a5a1a5ccde0a16bbe0b0def1a72d2a2a66b))
* deduplicate @elucim/core via Vite alias ([fa7c29a](https://github.com/sethjuarez/cutready/commit/fa7c29a579b509c2aa9b954323a23d5ceb836018))
* import sketch/notes now copies referenced visuals and screenshots ([59ad9b2](https://github.com/sethjuarez/cutready/commit/59ad9b249e757c4e133671c8531e3a6052c004af))
* lower Responses API compaction threshold from 1MB to 128KB ([a6b0a1f](https://github.com/sethjuarez/cutready/commit/a6b0a1fd1c900027fb620dd3267719449ccb15cf))
* lower Responses API compaction to 64KB (server rejects at ~79KB) ([ac6755c](https://github.com/sethjuarez/cutready/commit/ac6755c684aff10eec23fa70d8d698f631326c07))
* multi-project migration now moves screenshots and visuals ([2a0f112](https://github.com/sethjuarez/cutready/commit/2a0f1128c393c384058e87f463c3131a5b9b97ba))
* override editor canvas background with CutReady warm colors ([8b0dc05](https://github.com/sethjuarez/cutready/commit/8b0dc0541a76151b001c2dd63af757bc4805e0ba))
* pass DSL content tokens to editor theme for canvas  resolution ([8fb39b4](https://github.com/sethjuarez/cutready/commit/8fb39b4fad3c9a06f1b30d47c266a34c6585a78a))
* pass explicit colorScheme to ElucimEditor for correct light/dark chrome ([7fba225](https://github.com/sethjuarez/cutready/commit/7fba225b58d19d294035f2bdc965866bb19e1652))
* repair all 4 remaining e2e test failures (81/81 green) ([739b7b6](https://github.com/sethjuarez/cutready/commit/739b7b65c4dce74e234f90953c37c3958db4fd56))
* resolve \ token on canvas root ([176bc65](https://github.com/sethjuarez/cutready/commit/176bc653d2981e375d854f0de51565464e89bcb5))
* restore buildPreviewDsl and explicit colorScheme for DslRenderer ([325d73c](https://github.com/sethjuarez/cutready/commit/325d73c8ce38e1dcaa61c433dc71cec748f3a715))
* revert inner padding — should be handled by elucim editor ([3bfc1ba](https://github.com/sethjuarez/cutready/commit/3bfc1bae274cce3e6983a4ece191628915f2248a))
* use absolute positioning for visual thumbnails to avoid flex collapse ([5ee117c](https://github.com/sethjuarez/cutready/commit/5ee117cdcbedece211439d4c63930b028716a5d8))
* use EditorProvider directly so save gets live document ([920c597](https://github.com/sethjuarez/cutready/commit/920c59797495129169b4017ce97bc0190d820668))
* use ElucimEditor directly and resolve \ colors ([d205090](https://github.com/sethjuarez/cutready/commit/d2050902412ac00548b5ac01fce88fbb12f0ab07))
* use floppy-disk icon for visual editor save button ([5dd98f4](https://github.com/sethjuarez/cutready/commit/5dd98f4007475e966916fade194ae061226c14ec))
* use full CSS var name for editor canvas background override ([7f8586c](https://github.com/sethjuarez/cutready/commit/7f8586c7c44717589f3b1bc0ae88d77571683ca1))
* use ResizeObserver for correct visual preview sizing in lightbox ([beffc90](https://github.com/sethjuarez/cutready/commit/beffc9045ca370a22da370341d810212aa1b80a3))
* validate JSON after escape_non_ascii_json, fall back on corruption ([feddf8e](https://github.com/sethjuarez/cutready/commit/feddf8e18946b21bf5d71e05763038f0d94c6de8))

## [0.10.0](https://github.com/sethjuarez/cutready/compare/v0.9.0...v0.10.0) (2026-03-18)


### Features

* add 'Show AI Changes' button to re-view last diff highlights ([e6418d0](https://github.com/sethjuarez/cutready/commit/e6418d0a1b233520e744c45ac5792c18993cd50a))
* AI change highlighting with inline diffs and undo support ([c450ce0](https://github.com/sethjuarez/cutready/commit/c450ce01ce22a22f4d880cac423c9d3ab665545c))
* click 'Unsaved changes' to view working tree diff ([155e0bb](https://github.com/sethjuarez/cutready/commit/155e0bb18a2eccb7f25c5bc42eefc8ca4719572b))
* complete multi-project support with versioning, migration, and recent projects ([cb817e1](https://github.com/sethjuarez/cutready/commit/cb817e1997191bef7d1caae3cfe3fafc389f38a6))
* encrypt secrets at rest with Tauri Stronghold ([41971a4](https://github.com/sethjuarez/cutready/commit/41971a42de66bfa89d997e3227d2f8e0d08af1bf))
* import .sk and .sb files into the current project ([6733a14](https://github.com/sethjuarez/cutready/commit/6733a14ff3dc1079b28e6d3be686ac28b669603e))
* improve migration UX and add project rename ([ada6ce1](https://github.com/sethjuarez/cutready/commit/ada6ce182401d9b2221a1e872e4f354c5e0610d0))
* LLM-powered compaction for dropped conversation messages ([52a9452](https://github.com/sethjuarez/cutready/commit/52a9452015d4ac8caed9fdb5d382ffdb3aaa7f7c))
* multi-project per repo backend + frontend foundation ([8231c42](https://github.com/sethjuarez/cutready/commit/8231c42a89041b893ecf1b9caa8d4f4d7c6561e0))
* show all project files in explorer tree view ([33611da](https://github.com/sethjuarez/cutready/commit/33611da5ab81d785b52b7653c8c762dedc5af1ec))
* show workspace / project breadcrumb in title bar ([0d8eec3](https://github.com/sethjuarez/cutready/commit/0d8eec3787ef8892fde258e5ee40c42d94ce25de))
* split settings into global and workspace with sidebar reorganization ([b0b3288](https://github.com/sethjuarez/cutready/commit/b0b328861d5bdbbcdcdc988123e9f27ba6865bb4))


### Bug Fixes

* add missing index sync to discard_changes and pop_stash ([5d5c0c8](https://github.com/sethjuarez/cutready/commit/5d5c0c8b6a67f2bea8617e6e081451a1798521e1))
* AI row highlight using background-color instead of box-shadow ([bd1e800](https://github.com/sethjuarez/cutready/commit/bd1e80050614bfe5b63775335eb7a77cb64deeb8))
* collapse dot-prefixed folders by default in tree view ([2c23a4f](https://github.com/sethjuarez/cutready/commit/2c23a4fad2829dd3ee7191239afe1c1757a14543))
* correct command palette shortcut hint (Ctrl+Shift+P, not Ctrl+K) ([d5d2718](https://github.com/sethjuarez/cutready/commit/d5d2718df13fc572063a1bc4df08db6bbe72226e))
* escape non-ASCII in JSON bodies to prevent API parse failures ([01ce5b3](https://github.com/sethjuarez/cutready/commit/01ce5b334ce764d0ac65111322a14178e8f4638e))
* global Escape key cancels all creation/rename actions ([a8c8164](https://github.com/sethjuarez/cutready/commit/a8c8164eae7a329d47cea605f0e5dc61b97b9ebf))
* handle multimodal content parts in chat message rendering ([910e0ea](https://github.com/sethjuarez/cutready/commit/910e0ea7c46a4c6a667b8976ed69f1a669693d74))
* move project switcher above explorer header ([3f56f5d](https://github.com/sethjuarez/cutready/commit/3f56f5db5057d21b7414f25a6a17687657f6577f))
* move project switcher below explorer header ([16c6f2d](https://github.com/sethjuarez/cutready/commit/16c6f2d06c32dd89d8f6dc275555553d78aa6f78))
* raise Responses API body limit to 1MB and improve error classification ([dbdd2d9](https://github.com/sethjuarez/cutready/commit/dbdd2d953785f1e6473dd64c464a09f0770ff484))
* refresh currentProject after rename so switcher label updates ([cd91e65](https://github.com/sethjuarez/cutready/commit/cd91e65f2e12c569a3fb5ce75c2dff3f18d39404))
* refresh sync status after saving snapshot ([23ad734](https://github.com/sethjuarez/cutready/commit/23ad7348eb3d9e509ed07abb4dd90beef523c52d))
* rename 'New Project' to 'New Workspace' on home screen ([1c27caf](https://github.com/sethjuarez/cutready/commit/1c27caf67017a09799d0fbc8159e151da2d0fa60))
* rename 'Open Project' to 'Open Workspace' on home screen ([dcce665](https://github.com/sethjuarez/cutready/commit/dcce665d3949e6f6ca42776f00eef3582cf8c752))
* rename 'Recent Projects' to 'Recent Workspaces' on home screen ([4d1e6b9](https://github.com/sethjuarez/cutready/commit/4d1e6b923f5cdbd81eaa7f3f9e1720b8a8ae0350))
* rename single-project triggers migration to multi-project mode ([dfd9390](https://github.com/sethjuarez/cutready/commit/dfd9390dfc9d9821c6071668a82ac9af01ded051))
* rename_project now renames folder and updates manifest path ([0bd085e](https://github.com/sethjuarez/cutready/commit/0bd085e8d9bb52aaab9322555385a0cd6c1b912f))
* replace clone error alert() with toast notification ([6ec965e](https://github.com/sethjuarez/cutready/commit/6ec965ec933c3ae831dfc7c000784d9ad388d92f))
* replace double-click rename with pencil icon button ([aeed297](https://github.com/sethjuarez/cutready/commit/aeed29752d1c87f30899aa5f93eb9901d82458b4))
* resize and budget images to prevent 400 API errors ([2cebe5d](https://github.com/sethjuarez/cutready/commit/2cebe5dd67ceeaff541ffd31b4515f25b92069b2))
* show dotfiles/dotdirs in explorer tree view ([84892f2](https://github.com/sethjuarez/cutready/commit/84892f2c9d42f9d3161acc57b1e98b4f43cc1fef))
* standardize 'workspace' terminology across all UI strings ([50a412e](https://github.com/sethjuarez/cutready/commit/50a412e1512397f309cd169f81eed13285d36aea))
* sync git index after gix commits and checkouts ([2d9e701](https://github.com/sethjuarez/cutready/commit/2d9e701aae1ff825ff0256ff68b91f563f507191))
* use CutReady icon for empty state instead of emoji ([961f927](https://github.com/sethjuarez/cutready/commit/961f9277240c2487abd4905db09fcf24279ce73e))
* use CutReady logo with gradient glow for empty state ([3d9ebd2](https://github.com/sethjuarez/cutready/commit/3d9ebd2dcb64bf8929d40ba1084bd904ae83e9ff))
* use explicit purple hex for user message border in both themes ([ac64f8f](https://github.com/sethjuarez/cutready/commit/ac64f8fbeb1f5453005627382449e2473249585a))

## [0.9.0](https://github.com/sethjuarez/cutready/compare/v0.8.0...v0.9.0) (2026-03-17)


### Features

* auto-open Word document after export ([d559bda](https://github.com/sethjuarez/cutready/commit/d559bda7362b657dd0cce538a5b4ab326f0236f4))
* auto-resolve GitHub token from gh CLI for clone ([8353afc](https://github.com/sethjuarez/cutready/commit/8353afc1bb089e2a5d9b26aaa0ef8f49ef4cd2c4))
* compaction UI pill and user message border ([4f20725](https://github.com/sethjuarez/cutready/commit/4f20725116549e1edafca9318062e4bbc31f3b51))
* export notes to Word (.docx) ([ca38242](https://github.com/sethjuarez/cutready/commit/ca38242c06503133be6c87b841e1ad4de23b59e0))
* portrait/landscape orientation picker for Word export ([a4e90be](https://github.com/sethjuarez/cutready/commit/a4e90be5fb2a9699fdce0c14d69fcb0015d5ecf2))


### Bug Fixes

* add opener:allow-open-path permission for file opening ([bd5e800](https://github.com/sethjuarez/cutready/commit/bd5e800a9d097bc847472314660c612592378f1e))
* add wildcard path scope to opener:allow-open-path ([2de1b2f](https://github.com/sethjuarez/cutready/commit/2de1b2f459b4f990a231fe8e4e378e039df09225))
* light-mode visuals and 200px thumbnail size in Word export ([c5e0e73](https://github.com/sethjuarez/cutready/commit/c5e0e73c5d0fac6da29b4a948bf943357370be9f))
* shell open scope for Word export auto-open ([410aca2](https://github.com/sethjuarez/cutready/commit/410aca21299e84dce647249cff7062790d62b7b5))
* update @elucim/dsl to 0.8.3 — renderToPng resolves CSS vars ([818d004](https://github.com/sethjuarez/cutready/commit/818d0041fcffbb05f5ad3bfb955744e2136b9c36))
* use @elucim/dsl renderToPng for visual Word export ([5a51a97](https://github.com/sethjuarez/cutready/commit/5a51a97e4a6aa42b84164ddb181f98036d2fb589))
* use data-URI for SVG→PNG rasterization in Word export ([42a09db](https://github.com/sethjuarez/cutready/commit/42a09dbef51f0038bfddc4421f28380f2230016a))
* use tauri-plugin-opener for opening local files after Word export ([714f8c6](https://github.com/sethjuarez/cutready/commit/714f8c6b5decf1f9fb115269e2b8d9d42b61e844))
* visual export to Word — use Image+canvas instead of svgToCanvas ([ec6adb8](https://github.com/sethjuarez/cutready/commit/ec6adb819e323b65ae1d3562ddf122ad70dbbf75))
* VisualCell crash when visual loads async — null dsl guard ([0763225](https://github.com/sethjuarez/cutready/commit/07632251bde40eb9bbac9e34b2b9f23d3c890b33))

## [0.8.0](https://github.com/sethjuarez/cutready/compare/v0.7.1...v0.8.0) (2026-03-16)


### Features

* 3-pass designer workflow with persisted design plans ([944fd48](https://github.com/sethjuarez/cutready/commit/944fd4863ffb49cf32b1a6bd3cec1fe7ae2989e8))
* add critique_visual tool for Designer agent self-improvement ([725d407](https://github.com/sethjuarez/cutready/commit/725d4076e64b6c86482ce2a7d954f5a391d98782))
* add Responses API support for codex and pro models ([8865e4c](https://github.com/sethjuarez/cutready/commit/8865e4c6653d1eeafd379543b68416d318d5667b))
* add validate_dsl tool and fix visual refresh race condition ([43b13ed](https://github.com/sethjuarez/cutready/commit/43b13ed3d4bd5d851799662fadb9618f698f69ce))
* add Visual agent and ✨ Generate Visual button ([c0ae278](https://github.com/sethjuarez/cutready/commit/c0ae27808a221e44adc7a428ebda52567da9ab08))
* add visual generation instructions popup and tool panic safety ([49e01d3](https://github.com/sethjuarez/cutready/commit/49e01d37c9dc58da997a7ecb671d60fa86a318e6))
* chunked AI paste refinement for large documents ([c58dbde](https://github.com/sethjuarez/cutready/commit/c58dbde6bad3ff674edc0e2f0bc3faed2b6bd2af))
* **ci:** add Azure Trusted Signing for Windows code signing ([7c654d6](https://github.com/sethjuarez/cutready/commit/7c654d6ee96293cbc827eac61c8a5fade1d01a44))
* Clone Repository button on home screen ([ce01190](https://github.com/sethjuarez/cutready/commit/ce0119069e1429967c53e5aff5de9472fd555d12))
* Designer agent uses gpt-5.1-codex model + auto-validates DSL ([0bb7317](https://github.com/sethjuarez/cutready/commit/0bb7317b2510a97b3dd44efa82a6dde0b5b955cb))
* embed screenshots in Word export ([62a7563](https://github.com/sethjuarez/cutready/commit/62a756398771ca3c453cf23b12719182f982ba76))
* integrate elucim visual system into sketch rows ([5107f46](https://github.com/sethjuarez/cutready/commit/5107f46e6074a644e30e517c19c563ea6c18d3e5))
* preview mode visual improvements — theme, responsive SVG, mini player ([026c208](https://github.com/sethjuarez/cutready/commit/026c20876c756c091796797e3c68ca0cc0004ca0))
* rename Visual agent to Designer with improved creative prompt ([96985e2](https://github.com/sethjuarez/cutready/commit/96985e2a15c586134b3c6096942e9cdc519563b8))
* semantic color tokens for theme-adaptive visuals ([dad498a](https://github.com/sethjuarez/cutready/commit/dad498a40302412ec6bc80059c567cc47c0ca645))
* show toast notification after Word export ([bf4b00f](https://github.com/sethjuarez/cutready/commit/bf4b00fb007d0067be163c2fea432078157aee62))
* structured dev trace logger (dev-trace.jsonl) ([b0e8d5b](https://github.com/sethjuarez/cutready/commit/b0e8d5bb1cf28d283e6572aaf32a25cd3727ba40))
* upgrade to elucim 0.4.0 with poster, ref API, and frame capture ([26043e6](https://github.com/sethjuarez/cutready/commit/26043e6593768538d7eba99e12ad0221d82038fe))
* visual preview lightbox with nudge-to-edit ([6cf4385](https://github.com/sethjuarez/cutready/commit/6cf43852069b36cec35aa1a5844ada0d0b643a81))


### Bug Fixes

* add dialog:allow-save and fs:allow-write-file permissions for Word export ([81290e9](https://github.com/sethjuarez/cutready/commit/81290e938bb06c1aef20b8b35e00ab972981293e))
* add HTTP timeouts to prevent hanging on slow models ([c137ba5](https://github.com/sethjuarez/cutready/commit/c137ba5f0764dbe89d5d362c787c7e8b0d282d09))
* apply model override for agent-triggered visual generation ([4231ca3](https://github.com/sethjuarez/cutready/commit/4231ca3de25122e2f9153d4e6ac602bd977995b7))
* auto-parse stringified DSL in validate/critique/set_row tools ([234b68d](https://github.com/sethjuarez/cutready/commit/234b68d1c2eececdc5cc878de7f1024d99eb7128))
* correct DSL property names and add E2E visual rendering tests ([0a1be59](https://github.com/sethjuarez/cutready/commit/0a1be5952bf921c186bd7c0003973d6f924fdc8f))
* deep DSL validation and 400 error diagnostics ([a80618e](https://github.com/sethjuarez/cutready/commit/a80618e4b9c5e6deed65363cefd2361294df7b83))
* Designer prompt rewrite + 960x540 canvas + semantic token verification ([80c43bd](https://github.com/sethjuarez/cutready/commit/80c43bd42f33d5a801ca35c6810ed94b504ec8f0))
* **docs:** point installation link to latest release ([0813425](https://github.com/sethjuarez/cutready/commit/08134253bd24effabbcecfbfbfb793059c5876b3))
* downgrade TEXT_OVERLAP and MARGIN_VIOLATION to suggestions ([00b9e11](https://github.com/sethjuarez/cutready/commit/00b9e1102db194a6ec066cc33e621187cd976697))
* handle flattened DSL args in validate/critique tools ([653abbf](https://github.com/sethjuarez/cutready/commit/653abbf72dec53ef646ecaeab0ae72ad09a950a7))
* harden against 400 JSON errors with validation and broader retry ([8895dc2](https://github.com/sethjuarez/cutready/commit/8895dc2778be78737c521c774031cd9d21f85c4e))
* improve Designer visual quality — fill canvas, relax limits, overflow detection ([d14c0e6](https://github.com/sethjuarez/cutready/commit/d14c0e6253503bf5ed7afacbadf19be8f1e38a7e))
* include Responses API models (codex/pro) in model dropdown ([db6794a](https://github.com/sethjuarez/cutready/commit/db6794a62c9bbcc39c916d0d8e25c23bb3d5dbf9))
* lazy-load elucim to fix React 19 ReactCurrentDispatcher crash ([06b16e7](https://github.com/sethjuarez/cutready/commit/06b16e75d1296f68c281623e4dfc97f6f03e0424))
* lower body size limit for Responses API to prevent 400 errors ([bca0214](https://github.com/sethjuarez/cutready/commit/bca0214ce5613716a8ecae0cdfcef9a2a33154fe))
* make Actions prominent in visual generation prompt ([f70bd74](https://github.com/sethjuarez/cutready/commit/f70bd74e18b1a216552ad0b49ad8da799107e722))
* make visual preview discoverable with expand button ([c0e7622](https://github.com/sethjuarez/cutready/commit/c0e762294d57c06c09206fa5b71cfd6b574f48e3))
* planner agent now recommends changes instead of applying them ([53222b6](https://github.com/sethjuarez/cutready/commit/53222b6079408a329c0d887f47915100c1d271a6))
* position toast above status bar and log export to activity ([0894628](https://github.com/sethjuarez/cutready/commit/0894628976ed250c645545dd3b06d90c86c11cc6))
* preserve visual/design_plan when frontend saves rows ([e65b7af](https://github.com/sethjuarez/cutready/commit/e65b7af6c4c07c5eace6326925a3a812aac99fcd))
* prevent AI paste refinement from truncating content ([fca1d2d](https://github.com/sethjuarez/cutready/commit/fca1d2d83ab16f382e54c40d416ac71e4ae2b39c))
* prevent JSON decode errors from control chars and UTF-8 truncation ([55db898](https://github.com/sethjuarez/cutready/commit/55db8981fa706bdcfb60074aec15a100e7dee789))
* preview mode — fill space, theme vars, replay in header ([4b50186](https://github.com/sethjuarez/cutready/commit/4b5018663ddcaa76a326313740bc3d9fdf880fa3))
* prioritize user instructions in visual generation ([8639d91](https://github.com/sethjuarez/cutready/commit/8639d912d7f6474ef1519919bdd2baab2a2eb9ad))
* reload sketch after set_row_visual tool so visuals appear in UI ([561ce02](https://github.com/sethjuarez/cutready/commit/561ce0242d16bd2578538e3450e431e1e0137396))
* remove-visual button now clears the visual field instead of screenshot ([033311e](https://github.com/sethjuarez/cutready/commit/033311edc684b59afb5793e050b69d50b1d49de9))
* render markdown formatting in Word export ([a0b1ac2](https://github.com/sethjuarez/cutready/commit/a0b1ac2c7419ca8c8e82b07dd15c364003c8feb5))
* Responses API tool calls ignored due to finish_reason=stop ([bd67c88](https://github.com/sethjuarez/cutready/commit/bd67c88d57c64e4570a283db925a237bea7d4dff))
* sanitize all message content before API serialization ([e1796a8](https://github.com/sethjuarez/cutready/commit/e1796a804a068f308905cc6f37da1b4d2acf7038))
* show codex/pro models in chat model picker dropdown ([fa8887a](https://github.com/sethjuarez/cutready/commit/fa8887ad92d29507486729ea00d749778ad66f81))
* use 0-based index in generate-visual prompt to prevent wrong-row placement ([7ac1e69](https://github.com/sethjuarez/cutready/commit/7ac1e692660325a6588b52d0b1c7be7eb54453dd))
* use native save dialog for Word export ([1bf18bc](https://github.com/sethjuarez/cutready/commit/1bf18bcd38e9aaec6159893e0a8f7e98294126c4))
* use native Word bullet and numbered list formatting ([9037f56](https://github.com/sethjuarez/cutready/commit/9037f5681a4d8af3441a86c8ee0d632786166169))
* use read_timeout instead of request timeout for streaming ([1d8d6f0](https://github.com/sethjuarez/cutready/commit/1d8d6f062fab5644e6848145658438284d64eedb))
* use stroke-based sparkle icon to match Feather/Lucide style ([495e0d0](https://github.com/sethjuarez/cutready/commit/495e0d06a645d1f295553a293ef72a28d133abaa))
* visual critique reliability — UTF-8 panics, thresholds, em-dashes ([96d6291](https://github.com/sethjuarez/cutready/commit/96d6291a21f2f72459fa0906bc1de29b8976736e))
* visual lightbox renders blank — container had no dimensions ([0263a4c](https://github.com/sethjuarez/cutready/commit/0263a4c863981c3dcdd9fbd958964817a8d69df9))
* visuals fill canvas edge-to-edge instead of inner card ([4aea37d](https://github.com/sethjuarez/cutready/commit/4aea37d9a7a3852f63be329aa056104265daa7ec))

## [0.7.1](https://github.com/sethjuarez/cutready/compare/v0.7.0...v0.7.1) (2026-03-06)


### Bug Fixes

* **ci:** add actions:write permission for build dispatch ([f464232](https://github.com/sethjuarez/cutready/commit/f464232898097597423fa77b63e632ea5a77bc94))


### Performance Improvements

* **ci:** replace rust-cache with sccache for faster builds ([19eec97](https://github.com/sethjuarez/cutready/commit/19eec97d50281e8a7b0852f8a79d35bd4d5f6383))

## [0.7.0](https://github.com/sethjuarez/cutready/compare/v0.6.0...v0.7.0) (2026-03-06)


### Features

* active branch renders leftmost in the snapshot graph ([12ceb55](https://github.com/sethjuarez/cutready/commit/12ceb55bb63c62bb54806b1703df4b577cbb72e9))
* activity panel logging for rich paste pipeline ([fb8e066](https://github.com/sethjuarez/cutready/commit/fb8e0660697171224ab73248c3d3e6632644b0dd))
* add Covector version management ([e2a317c](https://github.com/sethjuarez/cutready/commit/e2a317c0f9f01fa1870b0d21eaa44247d272a2a8))
* add description sparkle to storyboard ([f02a1fc](https://github.com/sethjuarez/cutready/commit/f02a1fcb21e732ff4bc75c835a474f5e68bfce03))
* add feedback history tab in settings ([0a2a644](https://github.com/sethjuarez/cutready/commit/0a2a6440d4a8649f594c7f85ba4739f94958fe9d))
* add feedback popover to title bar ([55840da](https://github.com/sethjuarez/cutready/commit/55840da289ec747dd9430cb86734a0836da914ed))
* add optional title and description to set_planning_rows ([a2dd004](https://github.com/sethjuarez/cutready/commit/a2dd004d3785e393fb74bf74ada0eebf91b4229e))
* add recording functionality and global hotkeys ([ccb59df](https://github.com/sethjuarez/cutready/commit/ccb59df51e195a80e7cc7175d9c6b8362b410ce2))
* add save_feedback as an AI agent tool ([06b0a67](https://github.com/sethjuarez/cutready/commit/06b0a67971e2d129c0abb26d437f68b6d7a94531))
* add screenshot support to sketch tools for note-to-sketch images ([636a3b0](https://github.com/sethjuarez/cutready/commit/636a3b0ae4a31aeef62ff7b9af1d97c250319f51))
* add update_storyboard AI tool for title/description updates ([fc071b8](https://github.com/sethjuarez/cutready/commit/fc071b8258e50ec0da723d897bbc3b6660be9da0))
* agent selector with prompt presets and tabbed settings ([eabf002](https://github.com/sethjuarez/cutready/commit/eabf002941fdc193c47a5c5ddcc90a05e48a59d0))
* AI edit flash indicator + file browser for image picker ([639ffda](https://github.com/sethjuarez/cutready/commit/639ffda59a9af4388d4bba5c9af36667d8103f64))
* AI-enhanced smart paste for Word→Markdown conversion ([7516ca4](https://github.com/sethjuarez/cutready/commit/7516ca4d543ee0bb58ec539c06e045bfc551b18f))
* API-reported context window + beforeunload archival ([cfeb62c](https://github.com/sethjuarez/cutready/commit/cfeb62cc22c2e309450cc6d4828eac2b1f4df0c8))
* attach debug log to feedback via toggle ([53fad36](https://github.com/sethjuarez/cutready/commit/53fad3658084d7a48c74455261a4c6f2be445f28))
* auto-open sketch after agent creates/updates it ([bc5481f](https://github.com/sethjuarez/cutready/commit/bc5481f61d0e5a7011b292ab7effae54fe25b455))
* auto-reference active note in chat context ([e90c869](https://github.com/sethjuarez/cutready/commit/e90c869cc44e0883ef6e6dbb75bb43e9948d36c5))
* auto-refresh OAuth token on app startup ([f22fffc](https://github.com/sethjuarez/cutready/commit/f22fffc9d6b2726fc44237a685b34abd74b9a11e))
* browse snapshots without committing ([435091c](https://github.com/sethjuarez/cutready/commit/435091c03d5db83d410a66b23cd99f27a1504d70))
* change note accent color from amber to rose/pink ([7ef963b](https://github.com/sethjuarez/cutready/commit/7ef963b86218d777fc50ac2c18ec438c248daa23))
* chat history tab in secondary panel ([78de47c](https://github.com/sethjuarez/cutready/commit/78de47c302c3e6135099f97ad04817c699b1ce1a))
* click circles to restore + ask about auto-save ([ace3dae](https://github.com/sethjuarez/cutready/commit/ace3dae5ee42356b0b96013796c351488b32e167))
* clipboard fallback for DRM-protected document import ([7a6ba87](https://github.com/sethjuarez/cutready/commit/7a6ba8764d527db3b8c3a77a5434b3ab6e0d5e3f))
* colorize file references in agent markdown responses ([b4a8bba](https://github.com/sethjuarez/cutready/commit/b4a8bbab38b2116d0c3873dfddfa0d2c6b4c755b))
* command palette, output panel, resizable sidebar, layout toggles ([1cf61a7](https://github.com/sethjuarez/cutready/commit/1cf61a7d2fea79939a965782e197367d54e11e14))
* create GitHub issue from feedback with LLM formatting ([7198a5a](https://github.com/sethjuarez/cutready/commit/7198a5a5674b978f51f12c2e99db3701fb66cdc2))
* Ctrl+S commits a version with auto-generated timestamp label ([7a842c3](https://github.com/sethjuarez/cutready/commit/7a842c38f5c6805e7f33c0fa36eeeaa4a093f13b))
* Ctrl+S prompts for snapshot name instead of auto-saving ([39c4b51](https://github.com/sethjuarez/cutready/commit/39c4b51547632dea8e0d103b7f5e6c59c215a93b))
* Ctrl+Z undo for planning table, delete confirmation ([c424e57](https://github.com/sethjuarez/cutready/commit/c424e577f2484e93800a7b82b7b4ef07ae6c8ae1))
* D3 hierarchy tree layout for automatic branch positioning ([57333e1](https://github.com/sethjuarez/cutready/commit/57333e14d8b4b679d089aa5e94356c2f48e2c89e))
* dev-mode diagnostic trace logger ([810f70a](https://github.com/sethjuarez/cutready/commit/810f70ab665d29285bcd0331c9cdcef069990ec3))
* dirty indicator + stash prompt for snapshot navigation ([8e2bfe5](https://github.com/sethjuarez/cutready/commit/8e2bfe57baf166b342e94a8c9a891e901eb13fe4))
* **display:** font family selector in settings ([8edea92](https://github.com/sethjuarez/cutready/commit/8edea9255ec7fcab00a0ba4656e716815e252f4f))
* document import (.docx, .pdf, .pptx) ([4b930cb](https://github.com/sethjuarez/cutready/commit/4b930cb386c020a4a184fab290386a20584b6a40))
* dual-mode sidebar with list/tree toggle ([7158586](https://github.com/sethjuarez/cutready/commit/71585861170567bac2cacea2a1ade91cf02d76a1))
* enforce linear-only mode when no remote configured ([32611e0](https://github.com/sethjuarez/cutready/commit/32611e04293014b909c78b629b216cda85241b29))
* enlarge screenshot column in planning table (96-&gt;180px, 64x48-&gt;160x96 thumbnails) ([7f9c8c9](https://github.com/sethjuarez/cutready/commit/7f9c8c9ad176a1a5feabf8ab045766d8ba59c900))
* expandable activity entries — click or 'expand' link to see full content ([b12bd85](https://github.com/sethjuarez/cutready/commit/b12bd8554ab03d973973e2a50d8ecd806bcfc3aa))
* export activity log to clipboard and .log file ([c500c82](https://github.com/sethjuarez/cutready/commit/c500c82db112c9def8cc14194d72261acd4cb6d9))
* extract images from imported .docx and .pptx ([738abae](https://github.com/sethjuarez/cutready/commit/738abae197173be353ee96d239d2368c14c33559))
* feedback batch — 9 UX improvements ([31c1448](https://github.com/sethjuarez/cutready/commit/31c14488997a782d7fde1ef47e56548839ea83fd))
* feedback delete with confirm, user message styling + delete ([5e0a484](https://github.com/sethjuarez/cutready/commit/5e0a484e8163e44d6377b8f80227c4184119c5c1))
* filter chat panel models to chat-capable only ([1a560a5](https://github.com/sethjuarez/cutready/commit/1a560a5a1c773f0874a9b188dd70f162f3b7722d))
* fork naming dialog + simplified dirty navigation ([484faf1](https://github.com/sethjuarez/cutready/commit/484faf123775c6d785358758c97b1aa4d71fb694))
* full-screen home, auto-open last project, persist layout ([ab97ab6](https://github.com/sethjuarez/cutready/commit/ab97ab67404c723b14a6df33d5a64e0927fcb778))
* GitHub remote collaboration — SyncBar, TimelineSelector, snapshot search, E2E tests ([c1c456c](https://github.com/sethjuarez/cutready/commit/c1c456c0a612b1b43a44862eaaf54bb376ce1bfe))
* grouped collapsible sections in image manager ([9fe4a1b](https://github.com/sethjuarez/cutready/commit/9fe4a1b4c3405783ea3ae0dfef16e5093672b0b1))
* implement initial structure for audio, ffmpeg, and screenshot utilities ([9c3c4a4](https://github.com/sethjuarez/cutready/commit/9c3c4a401008f92d71745e11b8a54b09dd592359))
* include app version in GitHub issue feedback ([8d0c85c](https://github.com/sethjuarez/cutready/commit/8d0c85c8ce81218350057b242ae048db71177eb7))
* indent branch labels by lane depth in snapshot graph ([faac23f](https://github.com/sethjuarez/cutready/commit/faac23fb77b12c5d210ed40856b34f9b53050cb6))
* keyboard shortcuts for sketch table rows ([3b9262f](https://github.com/sethjuarez/cutready/commit/3b9262fddb8f8978c4b3999ee480900c1c249ad3))
* layout dropdown in title bar for sidebar position ([3ca23e9](https://github.com/sethjuarez/cutready/commit/3ca23e91a491242255d106c5e6ffb46bb9b147e2))
* live-update standalone preview when sketch data changes ([1933c86](https://github.com/sethjuarez/cutready/commit/1933c86800baf08b67d43d8aeca5265ab1d17043))
* markdown-in, rich-out editing for planning table cells ([ac7ced0](https://github.com/sethjuarez/cutready/commit/ac7ced041c922d5c01471f90b1bdff40e35e4f85))
* Memory management UI in Settings ([2e4dccd](https://github.com/sethjuarez/cutready/commit/2e4dccd60746e63eb163969b4c995c40da861748))
* memory system with recall, save, and session archival ([cfff65b](https://github.com/sethjuarez/cutready/commit/cfff65b1647ec732eef72acf4b16a6e208ef6c1c))
* move rows up/down in planning table ([37d76a8](https://github.com/sethjuarez/cutready/commit/37d76a8ed17f149a4fa47c79310716243e5097bb))
* move save snapshot button to header row ([797d940](https://github.com/sethjuarez/cutready/commit/797d94078a073ba08425695d9fdbe86ac21be82a))
* multi-tab support, sidebar position toggle, and tab bar ([a36a896](https://github.com/sethjuarez/cutready/commit/a36a896ffbb61ad21f4a52f95f64d82b0eab2991))
* **notes:** add Edit/Preview toggle for rendered markdown ([e209e32](https://github.com/sethjuarez/cutready/commit/e209e322f284d62fd8a9f4f8ec69ff91e215bff7))
* Notion-style drag handle for row reordering ([c745344](https://github.com/sethjuarez/cutready/commit/c745344018d9c2fef09dfcc251993e1a70c5aed1))
* pending message stack, activity panel, and sub-agent delegation ([5e49632](https://github.com/sethjuarez/cutready/commit/5e4963262dc9e55c10e77d2bc0d4c3238e7be25a))
* per-file sketch storage with auto-migration ([a9b9143](https://github.com/sethjuarez/cutready/commit/a9b914354bf6b20b3999439a1b2c06722d57ea00))
* persist and restore editor state with snapshots ([192d5f3](https://github.com/sethjuarez/cutready/commit/192d5f358b5b551c68b5a3799d37de793700bac7))
* persist feedback to app data directory ([5d5de13](https://github.com/sethjuarez/cutready/commit/5d5de136f8f1ae65f8b0489b8747510fd08f1999))
* Phase 1 timeline switcher — solo mode, promote to main, test plan ([44097ec](https://github.com/sethjuarez/cutready/commit/44097ecf262a982c0288b0cec23ff5095d58cfb1))
* plain markdown editor, chat versioning, image cleanup & manager ([ac70ec1](https://github.com/sethjuarez/cutready/commit/ac70ec1e66bb1dbea99462d9ea2277120301c301))
* **preview:** render narrative and actions as markdown ([6a6edb5](https://github.com/sethjuarez/cutready/commit/6a6edb540e11033f08e0de484c5ed47a4cdfd652))
* proper tab order for planning table cells ([7bd780b](https://github.com/sethjuarez/cutready/commit/7bd780bf8e7a470931ea5386de7561a0b71b2514))
* redesign home page with branding and visual polish ([982efab](https://github.com/sethjuarez/cutready/commit/982efabae506713b26a46ad1cab7a820e3784114))
* redesign version history as commit graph with Save Snapshot ([1e3c9a5](https://github.com/sethjuarez/cutready/commit/1e3c9a547e90acc1d8709474652004e48daad500))
* remove recent projects button ([30da20a](https://github.com/sethjuarez/cutready/commit/30da20ab0081297adc1a9b117e117fee1c5f0203))
* rename Problems tab to Debug with log capture ([36df84f](https://github.com/sethjuarez/cutready/commit/36df84f8973714fadd0f034882f8ee337b01a5ba))
* rename Saves to Snapshots, add draggable tab reorder ([844aaa1](https://github.com/sethjuarez/cutready/commit/844aaa1958d8c4fe97518337f7f4a518180d4b17))
* render shared-tip branches as visible branch marker rows ([44eb84c](https://github.com/sethjuarez/cutready/commit/44eb84c80a990cad705d798eadf1c85dd943abc4))
* replace covector with release-please for automated versioning ([331ed46](https://github.com/sethjuarez/cutready/commit/331ed461be96b9ea32fef6a16af10cf7529b9004))
* replace hand-rolled markdown with react-markdown + GFM ([68bde84](https://github.com/sethjuarez/cutready/commit/68bde8462098786d961c2805a627ffd8e8696802))
* replace native drag with [@dnd-kit](https://github.com/dnd-kit) sortable rows ([e99cfa6](https://github.com/sethjuarez/cutready/commit/e99cfa62060552253362f930588a626e87c78459))
* reverse activity log + agent identification events ([e6ee63d](https://github.com/sethjuarez/cutready/commit/e6ee63d15c2533057ad4415f1673ac0fb3b3b3e0))
* rewrite History graph with d3 DAG layout + vertical/horizontal toggle ([7784019](https://github.com/sethjuarez/cutready/commit/7784019cf84f69098cd4aba34270d2de1679e76c))
* right-click context menu on activity bar to move sidebar ([ebde0d7](https://github.com/sethjuarez/cutready/commit/ebde0d7eb6d1bf3f85bb3bfa007b808bd010c548))
* save snapshot button shows text on hover only ([bce7b6b](https://github.com/sethjuarez/cutready/commit/bce7b6bea6f249951330048c0bf07b7bb3b13939))
* show -dev suffix on version in dev mode ([a118e78](https://github.com/sethjuarez/cutready/commit/a118e78e69b9de03c0598df3cc5c9bc66325859a))
* show all branch tips as badges on shared commits ([99ba6dd](https://github.com/sethjuarez/cutready/commit/99ba6dd2b6204df0a748e61329c88dc6bb32896a))
* show project name in title bar, app version in status bar ([3e84606](https://github.com/sethjuarez/cutready/commit/3e846067bf8b1971655ae339d103b0244d709abe))
* simplified snapshot navigation — click any snapshot to go there ([40bbf39](https://github.com/sethjuarez/cutready/commit/40bbf397a15afb9c59fd53a2bf151a509f06b9fe))
* simplify web references — #https://... instead of #web:https://... ([30e740b](https://github.com/sethjuarez/cutready/commit/30e740b11b5d4dc18aaa9a860dbcb6bdeec4c449))
* slugify project folder name + show preview ([22211fb](https://github.com/sethjuarez/cutready/commit/22211fbf63b6d98a7374b3ee23b775304a1d0650))
* smart paste with complexity detection and AI-first conversion ([40b76a1](https://github.com/sethjuarez/cutready/commit/40b76a1db18c9bfdcba776e89d0adfcf886a30ab))
* snapshot diff, bookmarks, collaborator info, PR button, clone, large-file guard, offline resilience ([86d1ae9](https://github.com/sethjuarez/cutready/commit/86d1ae95a516c077b9a5d26cfc5a75c0defc17e1))
* sort graph so branches appear at their fork point ([c150917](https://github.com/sethjuarez/cutready/commit/c150917a288021082ff453efb7f62c0924455dad))
* sparkle actions are silent — activity-only, no chat clutter ([35ee24b](https://github.com/sethjuarez/cutready/commit/35ee24b621e42d51a2b722b3a7ccbc3bb7c63417))
* sparkle buttons for AI-assisted editing ([2caecd2](https://github.com/sethjuarez/cutready/commit/2caecd25b56341e54e3a878ea475da450d93f21e))
* sparkle buttons on sketch title and description ([0f9af66](https://github.com/sethjuarez/cutready/commit/0f9af66d2fc9baa5899aa183ba5b35e1f54386a0))
* stash dirty work when browsing snapshots instead of committing ([3a0dd09](https://github.com/sethjuarez/cutready/commit/3a0dd09b8d49824949a751cccd464ff89a3c09bc))
* streaming chat responses with real-time UI updates ([510ea0e](https://github.com/sethjuarez/cutready/commit/510ea0e363fca54dcb13f701c3261afbad6aa39b))
* styled web reference chips in chat — expandable code-block preview on click ([5957fd9](https://github.com/sethjuarez/cutready/commit/5957fd9735160d4e776f0c34e0419e6f13ac891b))
* support old .doc format import with binary text extraction ([88bdd95](https://github.com/sethjuarez/cutready/commit/88bdd952c70e07143d1f93a9e8c6fdc0c902ce64))
* SVG tangled tree graph for snapshot timeline ([383e76a](https://github.com/sethjuarez/cutready/commit/383e76ae87bddab8babf56e2e73b396ab69ae1df))
* tangled tree layout for History graph with metro-style edge bundling ([450c94a](https://github.com/sethjuarez/cutready/commit/450c94ab35f733c39f833610f784821510f84c01))
* tasteful distinct icons for sketches and storyboards ([aa17e60](https://github.com/sethjuarez/cutready/commit/aa17e606e0b14db92952e587d4aabb8d7268ae52))
* timeline branching support with switcher UI ([2308d29](https://github.com/sethjuarez/cutready/commit/2308d29d3c359d8f6e232a7006aaa7fba40532b5))
* type-specific colors for chat reference chips and tool calls ([250b4f5](https://github.com/sethjuarez/cutready/commit/250b4f53531ee9f919c44024c0f82aab49765ca9))
* unified graph view — show all timelines, click any snapshot ([11ec959](https://github.com/sethjuarez/cutready/commit/11ec95984d8260348843245851dcb9e2b96cb8a4))
* uniform reference chips, AI sparkle button, icon-only note controls ([f179316](https://github.com/sethjuarez/cutready/commit/f17931634cf28b5c6d6a9a20dd31a556ad4873f2))
* UX polish — card rows, display settings, chat bubbles, and more ([606394d](https://github.com/sethjuarez/cutready/commit/606394d1ad671a3d97e80b4000b8a06912259ee4))
* **ux:** inline markdown preview for sketch description ([8da2ee9](https://github.com/sethjuarez/cutready/commit/8da2ee9b53537f04ae6cfddae5710eedc1d5028d))
* **ux:** modal snapshot dialog for save (Ctrl+S) ([9e53c8c](https://github.com/sethjuarez/cutready/commit/9e53c8c912265d7750a6570c58e37afb470fb5d3))
* vision/multimodal image support for AI ([78f019e](https://github.com/sethjuarez/cutready/commit/78f019ee62ddfc9a808c35f5b9a545528c0acfd6))
* web content preview + auto-refresh OAuth token ([4546f9f](https://github.com/sethjuarez/cutready/commit/4546f9f2c3d8743f0425a012fd71f09708c118db))
* web fetch tool and [@web](https://github.com/web): reference for pulling URLs into context ([898c72a](https://github.com/sethjuarez/cutready/commit/898c72aeea686ff917ad62b18d9cce5be63cbbc6))
* wire ChatPanel to Zustand store with disk persistence ([edf6af1](https://github.com/sethjuarez/cutready/commit/edf6af1840b50537575adb434d5d995030e78281))
* Word (.docx) export for sketches and storyboards ([94b1aa1](https://github.com/sethjuarez/cutready/commit/94b1aa1bd86fd245a984a3ab84cffb7fefd60726))


### Bug Fixes

* 'Keep this version' now restores as new HEAD commit ([396c311](https://github.com/sethjuarez/cutready/commit/396c311d763b1ae0a97f6fdc0638b3322476de1d))
* activity bar follows sidebar position, improved tab distinction ([20ce348](https://github.com/sethjuarez/cutready/commit/20ce348cfffbdc0861a15c0b974a6475f7ae12c1))
* activity panel chronological order with auto-scroll ([c06bed6](https://github.com/sethjuarez/cutready/commit/c06bed62e5afb1f464f71f3206dd5b62f94c2361))
* activity panel icons no longer inherit row color ([a31de6f](https://github.com/sethjuarez/cutready/commit/a31de6f0086c02ed35c7ac18cad7bc52cc47bb8e))
* activity panel logs all chat events (send, response, errors) ([a212938](https://github.com/sethjuarez/cutready/commit/a212938b18dc36f0d3764cdb7aa09a4dfcbeeb24))
* activity panel newest-on-top without bottom gap ([5834d98](https://github.com/sethjuarez/cutready/commit/5834d9822edafe504167c148ceb326f5af573c94))
* activity panel shows newest entries at top ([f4da6c9](https://github.com/sethjuarez/cutready/commit/f4da6c92ddaa951f22bd306be24b53286be4e466))
* add hover/drag visual indicator to resize splitters ([5c9a612](https://github.com/sethjuarez/cutready/commit/5c9a612197c0d9cb130c18e29ab6cc006aca2082))
* addRow no longer clears existing content ([6c45e6d](https://github.com/sethjuarez/cutready/commit/6c45e6d8bd989fe8aea6f77f55037074f3598417))
* align chat chip colors with explorer sidebar selection styles ([f5eceb6](https://github.com/sethjuarez/cutready/commit/f5eceb6010665fa8b7a2462fa6e9792d832fec93))
* align sidebar section headers consistently ([c73910c](https://github.com/sethjuarez/cutready/commit/c73910cafc88f76ee5a9231c9471169c01470430))
* align SVG edge coordinates with HTML node positions ([d514fd6](https://github.com/sethjuarez/cutready/commit/d514fd6a4a8b2fb75617db363c7d727c22a38817))
* auto-init git repo on project open so snapshots work ([1fb72e7](https://github.com/sethjuarez/cutready/commit/1fb72e77fd0780a43c26914ad9c1b8797d27eeeb))
* blank screen from layout overflow and TitleBar crash protection ([99dae0e](https://github.com/sethjuarez/cutready/commit/99dae0e9974420f684fdbbe8edb15081f53a2903))
* branch curve starts at right edge of HEAD circle, vertically centered ([d6fa892](https://github.com/sethjuarez/cutready/commit/d6fa89246e302a81fbf1b22ae229eb84c53d9af9))
* branch curve starts from center of HEAD circle ([adf2ed7](https://github.com/sethjuarez/cutready/commit/adf2ed7a418af62b5dc10649ca9c505ff8840771))
* cancel debounced saves on navigation to prevent false dirty state ([ab55065](https://github.com/sethjuarez/cutready/commit/ab550650cb76243f4f03ff0de1702ce88b3b8b9e))
* center drag handle vertically, always subtly visible ([2da1bd3](https://github.com/sethjuarez/cutready/commit/2da1bd3e442b1a66c7e019a5905ca9d2fdb9aaec))
* chat session load gracefully falls back when file is missing ([0204089](https://github.com/sethjuarez/cutready/commit/02040896f7af8ce0dc196ebab3060fbeb0421a9e))
* clarify 'Delete all orphaned' button label ([cb80c1b](https://github.com/sethjuarez/cutready/commit/cb80c1b4df88cc0986a85909f755de6e5a646d77))
* cleaner snapshot graph with continuous line + halo dots ([75b1676](https://github.com/sethjuarez/cutready/commit/75b16764f1227e77748bab28c85ccdc4a0b41c20))
* clear error message for protected/encrypted .docx files ([e901282](https://github.com/sethjuarez/cutready/commit/e901282c213af0831e2782251724e1ce18c22ace))
* clear feedback form immediately on submit ([b0d8fc5](https://github.com/sethjuarez/cutready/commit/b0d8fc5162f7f2519d41ceaa9514c55f741f5d93))
* comprehensive Word HTML cleanup for rich paste ([d30a6ab](https://github.com/sethjuarez/cutready/commit/d30a6ab2acaa030ab968e29e053e59e55b42e23d))
* correct tab order in sketch table cells ([183a83e](https://github.com/sethjuarez/cutready/commit/183a83ed0f1d5b075be228f8dfa223e6ac100b3e))
* **css:** match list left indent to container right padding (1rem) ([0cc3660](https://github.com/sethjuarez/cutready/commit/0cc3660ff93d976c0c1271360e285e4145623036))
* **css:** restore list-style-type for prose-desc (Tailwind preflight strips it) ([9d37a6a](https://github.com/sethjuarez/cutready/commit/9d37a6ab6c805405bb594ed1cedc3af75d3611ac))
* **css:** show list bullets/numbers with list-style-position: inside ([252a8dc](https://github.com/sethjuarez/cutready/commit/252a8dc22a0d28f912fa495228d84452884a1b63))
* **css:** use list-style-position: outside for aligned list text ([89ce52f](https://github.com/sethjuarez/cutready/commit/89ce52fc982741310e77fa5a81d6dd97bed5d7d8))
* darken light mode borders for better visibility in explorer ([1f683ae](https://github.com/sethjuarez/cutready/commit/1f683ae867b0ec1ecfe2520391b92591a7507a35))
* detect DRM-protected .docx and show clear error ([c22859f](https://github.com/sethjuarez/cutready/commit/c22859f5a62f670ed027014ddc8a081f8475e80a))
* dirty indicator renders above HEAD and connects to it ([0dc49ff](https://github.com/sethjuarez/cutready/commit/0dc49ff630ba4d6022c1b3e0b67e2d1bfd6808fe))
* disable HTTP connection pooling for LLM requests ([1373952](https://github.com/sethjuarez/cutready/commit/1373952a492ae32f87cdf34ca71065747df457b7))
* distinct activity bar color from explorer sidebar ([dfc8bf8](https://github.com/sethjuarez/cutready/commit/dfc8bf8716d7fd06c080b0f1ee871b191ed9ab6c))
* exportToWord test flakiness on Windows CI ([0dc4559](https://github.com/sethjuarez/cutready/commit/0dc4559f94a27a35eb5fdc47cd52fde30a1992a8))
* extra brace in SettingsPanel onClick handler ([f5b8fb4](https://github.com/sethjuarez/cutready/commit/f5b8fb4a0d1c73bf891d564d41bdc5752c32d16d))
* feedback buttons to ghost style + add clear all ([db7c3f3](https://github.com/sethjuarez/cutready/commit/db7c3f36498fe3cd778ef23e8eb312031a1490e8))
* feedback popover always saves to app data + copies to clipboard ([2eb27e0](https://github.com/sethjuarez/cutready/commit/2eb27e0936b97d47fb80fcd857bf01c29d1a4234))
* flush pending saves on unmount so edits survive tab close ([4d8eece](https://github.com/sethjuarez/cutready/commit/4d8eece4e680fd4674ab0ade5a152f3bee201fd5))
* force full graph+timeline reload after every navigation action ([69e176c](https://github.com/sethjuarez/cutready/commit/69e176c05aa427353ea7d54beee4e785ef7e274e))
* fork puts NEW direction on branch, keeps original work on main ([97d7362](https://github.com/sethjuarez/cutready/commit/97d7362f13ba8db9be7070b1ac06f21425e8f033))
* Foundry — strip /api/projects/... and use OpenAI-compatible path ([b4a8345](https://github.com/sethjuarez/cutready/commit/b4a834541111e563d2889cf33d2afcd80e14e328))
* Foundry api-version — use 2025-03-01-preview for chat and models ([6aeef2c](https://github.com/sethjuarez/cutready/commit/6aeef2cab3ee60bbbb5b3cec4696b01f39b36283))
* Foundry auth — revert scope to ai.azure.com, use deployments URL path ([599b5f9](https://github.com/sethjuarez/cutready/commit/599b5f934d4af3a5b5a25596a0bfb3e9ccca3b8f))
* Foundry chat URL — use /models/chat/completions with api-version=2024-05-01-preview ([0a3e95a](https://github.com/sethjuarez/cutready/commit/0a3e95a1b2efa6d493cc7e8f8cfbfd7bc65d8c4d))
* Foundry URL — model name in path, api-version=2024-05-01-preview ([9fd679d](https://github.com/sethjuarez/cutready/commit/9fd679d21ae22815305bf92f051d9614c0eab3e4))
* Foundry uses /openai/models, not /openai/deployments ([b9d9ccf](https://github.com/sethjuarez/cutready/commit/b9d9ccfc3bb70edd9ea7a9e9d8fb5e98272c3c0f))
* ghost branch edge renders on top of node box-shadow ([d6821bb](https://github.com/sethjuarez/cutready/commit/d6821bb356eb3be96e5e3716600e23bf6feeff4a))
* ghost branch node branches upward (forward in time) ([70ac42f](https://github.com/sethjuarez/cutready/commit/70ac42fb70ebca14abe05f385c8d4b77ffd00a33))
* ghost branch node renders next to HEAD, not at top ([1f46abe](https://github.com/sethjuarez/cutready/commit/1f46abe4cfe023d34248d705eda2cbfc208beb2a))
* guard against Azure gateway body size limit ([10e2eb7](https://github.com/sethjuarez/cutready/commit/10e2eb7d279caa9320fcd3fa655660dd23a94b0a))
* HEAD commit attributed to active timeline in graph ([a2f971e](https://github.com/sethjuarez/cutready/commit/a2f971ef13b7825ad7d50f0689db4ef8f5b5c919))
* home page content fits any window size ([6bc0d92](https://github.com/sethjuarez/cutready/commit/6bc0d92b6c1a957af374594f78e457d0734156ff))
* horizontal history graph now reads left-to-right (oldest to newest) ([367d591](https://github.com/sethjuarez/cutready/commit/367d59148a3f499a3f7f1f4e69eb9d876a7b438a))
* import error handling and file path extraction ([b2a12c4](https://github.com/sethjuarez/cutready/commit/b2a12c4d663a45ccfaf21b05722da14152050902))
* import icon arrow points down instead of up ([fe4bd0e](https://github.com/sethjuarez/cutready/commit/fe4bd0e7e5541adf4ae93c495ce80770e884c60a))
* improve chip contrast with stronger background tinge ([5171b86](https://github.com/sethjuarez/cutready/commit/5171b8640cda61a73db9c634495bb8db5df96534))
* improve contrast between sidebar and document content area ([da0f5a4](https://github.com/sethjuarez/cutready/commit/da0f5a4a13d8b60574843dbed3ed12ec112bc66b))
* improve orphaned image detection and add deletion safeguards ([fa0e69d](https://github.com/sethjuarez/cutready/commit/fa0e69de5e1709bfd258cd41297aae814e46e183))
* infinite re-render from useSyncExternalStore snapshot ([7911dce](https://github.com/sethjuarez/cutready/commit/7911dce57cefcba0374bf3345066aa50b45ad148))
* inline debug toggle and send button on same row ([9323a1a](https://github.com/sethjuarez/cutready/commit/9323a1a1a4fd0f07711caf3bc67f265767e722fc))
* keep #web:URL text in chat input instead of stripping it ([08b004b](https://github.com/sethjuarez/cutready/commit/08b004b27d223739c45316e3597d7b851c5d3d5c))
* lightbox now appends to &lt;body&gt; to escape Starlight nav stacking context ([bf0d37d](https://github.com/sethjuarez/cutready/commit/bf0d37d20f87fe2579535d6db48b9507a2be0686))
* list deployed models instead of all available models ([c916435](https://github.com/sethjuarez/cutready/commit/c9164357880287958cd20adaeec2550062ca1f33))
* make older snapshot dots larger (8px) for visibility ([700dc58](https://github.com/sethjuarez/cutready/commit/700dc588b29ad86bb4ecb27da997b8b3b90b463d))
* make sparkle buttons always visible instead of hover-only ([0fdb65c](https://github.com/sethjuarez/cutready/commit/0fdb65c65e8b158f38d7792e0081e3bb81f4d470))
* match feedback icon in settings tab and add title bar separator ([0b48f4e](https://github.com/sethjuarez/cutready/commit/0b48f4eccbf181244930079171013a0302b1ffad))
* model-aware context window compaction ([b8eb49e](https://github.com/sethjuarez/cutready/commit/b8eb49ee206756daadfd01bcf5b8fa69ad4fc610))
* nested button in chat session history ([327d6c8](https://github.com/sethjuarez/cutready/commit/327d6c8c2f5e3081772ba769600cd54fe2d7d972))
* **notes:** match preview container to edit container layout ([482b207](https://github.com/sethjuarez/cutready/commit/482b207bc142846df9a7bc93be62db42a1d27198))
* **notes:** separate prose-desc from centering wrapper ([37945ba](https://github.com/sethjuarez/cutready/commit/37945baaa6d8efaca13c963f36b1b894cfd29386))
* OAuth scope — use cognitiveservices.azure.com instead of ai.azure.com ([7589010](https://github.com/sethjuarez/cutready/commit/7589010f334e1a0a026bbadcc981de738725422f))
* orphaned images now checks sketch files for screenshot references ([796f5f5](https://github.com/sethjuarez/cutready/commit/796f5f525a917aeee21569ad47a3693fe2818d9a))
* persist chat session across app restarts ([6c37cae](https://github.com/sethjuarez/cutready/commit/6c37caec7ba1b0006ffb94e2e2ba606b456dbd5f))
* persist note preview mode across tab switches ([2b4409a](https://github.com/sethjuarez/cutready/commit/2b4409a397cfb718a86c184ca9654e313eeee8ce))
* persist open tabs across app restarts via localStorage ([bb06f1e](https://github.com/sethjuarez/cutready/commit/bb06f1e7f36db3c05d91ae7ca573d6c20e5d388e))
* preserve cell edits on blur before debounce save completes ([415e7bb](https://github.com/sethjuarez/cutready/commit/415e7bb429f3903aa47c49c5f9e8559f2e63a89c))
* preserve tool_call/tool_result message ordering ([7da23bb](https://github.com/sethjuarez/cutready/commit/7da23bba51d03d1609df9fbf91d324f32839c5aa))
* prevent chat dropdowns from clipping and going off-screen ([80c364b](https://github.com/sethjuarez/cutready/commit/80c364b3b579fcd00c285aadb47f53fe6ef67913))
* prevent cross-timeline navigation from moving wrong branch ref ([09ac331](https://github.com/sethjuarez/cutready/commit/09ac331d05ebee2490b38a0796c0d46325fbdc94))
* prevent stale debounce writes during snapshot navigation ([918f221](https://github.com/sethjuarez/cutready/commit/918f221b47d1ce049b5beaa3137911e8fce48932))
* **preview:** align text panel padding with tab headers ([017eb57](https://github.com/sethjuarez/cutready/commit/017eb57f0e50ce86bb1d4357acd6d679e82ba4fd))
* **preview:** reset all prose-desc margin/padding to fix left offset ([e78fd06](https://github.com/sethjuarez/cutready/commit/e78fd0695964d259ae862895f8f3ca5489d11425))
* proper table column sizing with table-layout fixed ([82a6e4f](https://github.com/sethjuarez/cutready/commit/82a6e4ffc80d7c9c8673788ffea8b3b299530259))
* reduce empty screenshot button height from h-12 to h-7 ([af52e25](https://github.com/sethjuarez/cutready/commit/af52e2573286fd2efebf8ee57053aabfff57e010))
* reduce note editor active-line highlight to prevent masking selections ([d9cff83](https://github.com/sethjuarez/cutready/commit/d9cff83d5dc5ddc8a67d7b7d9319534c5370dc37))
* reduce time column padding and widen to 54px ([316b952](https://github.com/sethjuarez/cutready/commit/316b95288d086e35d76d92ed0504441a1f1ab054))
* refresh dirty/rewound state after navigation and save ([9665191](https://github.com/sethjuarez/cutready/commit/96651914bc1280aea8447dd51164fce496db8fb4))
* refresh OAuth token before smart paste AI call ([0611252](https://github.com/sethjuarez/cutready/commit/0611252467d6cc61c293227bf577ffc0164ba2b1))
* reliable session archival via Rust-side CloseRequested ([84a3245](https://github.com/sethjuarez/cutready/commit/84a324545daafe15c97833eb7d4eca594746e492))
* remove 'Restored from' commits + fix stale rows in add/delete ([fb4154d](https://github.com/sethjuarez/cutready/commit/fb4154d83b1bd7db3775fb0d07b85a4fa29bf0d6))
* remove all activity log truncation — full content for sends, results, responses, errors ([f79574a](https://github.com/sethjuarez/cutready/commit/f79574a9cdb27b39a8ecdd28f767d35f731d5992))
* remove auto-commit on every sketch/storyboard save ([4a5b7ec](https://github.com/sethjuarez/cutready/commit/4a5b7ec9f432403ec53d6f98f73c6c66229650c1))
* remove auto-commit snapshots on delete ([a5d77ab](https://github.com/sethjuarez/cutready/commit/a5d77ab1d60006450aa2b007241a331c00cb3384))
* remove green text for success entries in activity panel ([0b8a999](https://github.com/sethjuarez/cutready/commit/0b8a999d47ba0199c3debc994e662e4eadb18f1f))
* remove icon from feedback settings tab button ([bcebeed](https://github.com/sethjuarez/cutready/commit/bcebeed0de4b7fd9ce50f5af2dd783ffcfdfb6f8))
* remove redundant document toolbar below tab bar ([a1dff87](https://github.com/sethjuarez/cutready/commit/a1dff87484f7578a305c27dbe8f6d3667cec94b5))
* remove saveVersion calls from delete actions in frontend ([413438b](https://github.com/sethjuarez/cutready/commit/413438b43006226ca94f3d8bc89a1fc7328c88d3))
* remove unused diff variables from SnapshotGraph ([2d268b2](https://github.com/sethjuarez/cutready/commit/2d268b2c19c465f72631cc7be7572df6c3850906))
* render &lt;br&gt; and other HTML tags in markdown previews ([dda1780](https://github.com/sethjuarez/cutready/commit/dda17800f6591f789492703522faf60a8ef9a79e))
* render local images in note preview and chat ([76a0bd5](https://github.com/sethjuarez/cutready/commit/76a0bd57187d34617395467b1e8a9622105c8ac6))
* render nested sub-bullets in sketch planning row cells ([9d9fdc5](https://github.com/sethjuarez/cutready/commit/9d9fdc5b5a647dbf0d26edcceaff4f3d89c9c26b))
* replace submit button with icon-only send button ([e18f690](https://github.com/sethjuarez/cutready/commit/e18f690bab25f57ceedebc8d0ad5c6f2a67e86e9))
* resizable secondary panel with working splitter ([5ae2055](https://github.com/sethjuarez/cutready/commit/5ae2055b6186065937f0bb272694f091490237e4))
* restore display-friendly user messages after backend response ([37cdf06](https://github.com/sethjuarez/cutready/commit/37cdf0670d0931d0a37b2945cd439624951bd2a2))
* restore snapshots fully + clarify project-wide scope ([c491b49](https://github.com/sethjuarez/cutready/commit/c491b4954c110695923bb7b7800aefebcc093dd0))
* restore version history as Saves tab alongside Chat History ([3fae4cb](https://github.com/sethjuarez/cutready/commit/3fae4cbe9bcac1a8dc4e478cbd69194cd8aa16ad))
* restore window drag region on title bar center area ([256f612](https://github.com/sethjuarez/cutready/commit/256f6125a7b18bad2515de28723fbb5b8184b670))
* restore-down icon — proper overlap with solid front rect ([db5b9e1](https://github.com/sethjuarez/cutready/commit/db5b9e1bef36f8bfd68547d2c2e38e5610eda01a))
* revert virtual node approach, keep clean shared-ancestor handling ([9991581](https://github.com/sethjuarez/cutready/commit/999158143785173c849eb4cc7531718577797284))
* scan .chats directory for sessions, rename tab to Sessions ([78ff3c2](https://github.com/sethjuarez/cutready/commit/78ff3c21c8865b512d604409350edd00c23f562e))
* secondary panel flips to opposite side of primary sidebar ([49aa99a](https://github.com/sethjuarez/cutready/commit/49aa99a8defdd181a54d2b104d008fc34ddacb9d))
* show all deployed models, not just chat-capable ones ([763f431](https://github.com/sethjuarez/cutready/commit/763f4318e37f3baef6bfdf0a34d440fea83d1348))
* show all image actions on hover for existing screenshots ([cac038c](https://github.com/sethjuarez/cutready/commit/cac038c4df030ba038c61e2d0441a74f0d15b127))
* show sparkle buttons even when description is empty ([894871b](https://github.com/sethjuarez/cutready/commit/894871b330d6ec7d2da2c4693ba43d29b2c49f1f))
* shrink time column from 80px to 50px ([ce45552](https://github.com/sethjuarez/cutready/commit/ce4555282425b904dac25e4d5702744e377059e8))
* sidebar drag handle now visible on hover ([39d0d01](https://github.com/sethjuarez/cutready/commit/39d0d01350487e56dca8be3a57cbf649be229a6d))
* simplify panel toggles — labels + remove position button ([d90fd5d](https://github.com/sethjuarez/cutready/commit/d90fd5d5c5526502d64f5367c00e9feef378f53f))
* simplify theme to light/dark toggle, detect system on first launch ([4f7dc33](https://github.com/sethjuarez/cutready/commit/4f7dc3334205714915387741d81f39cf3fd189e0))
* snapshot dots now clearly visible as circles ([2982ae9](https://github.com/sethjuarez/cutready/commit/2982ae9db693f6e37df9c0cdade93dd605c5329a))
* sparkle buttons scope updates to their own field ([6f2e871](https://github.com/sethjuarez/cutready/commit/6f2e871f4441d7bc93d073c41eb3375659b1d01a))
* splitter is 1px border line, no gap between panels ([f889d31](https://github.com/sethjuarez/cutready/commit/f889d317c91d3602f5948dcc1c076e5e9efeb4b0))
* splitter stays 1px visible but has 7px invisible grab area ([46d2430](https://github.com/sethjuarez/cutready/commit/46d2430a41eb1bc1c75c691d56f405430877500e))
* stable title bar icons, save icon, secondary panel border ([d96d1bb](https://github.com/sethjuarez/cutready/commit/d96d1bbe4758a7ace9d3b6a7e526f2d96f7f1467))
* standardize all panel header heights to h-9 (36px) ([9d3c3d8](https://github.com/sethjuarez/cutready/commit/9d3c3d899afa1bc03336cd658ede82508f951f0b))
* support covector tag format in build workflows ([cbe005d](https://github.com/sethjuarez/cutready/commit/cbe005d509ab7a28129b6ad43cd9304c69428058))
* system prompts tell agents to use tools, not paste tables ([4691f9c](https://github.com/sethjuarez/cutready/commit/4691f9c72fa5b8783776c5a3b2894ecc1e49ba63))
* Tab from Actions adds new row and focuses its Time cell ([7d72f2f](https://github.com/sethjuarez/cutready/commit/7d72f2f15bd9b6f5d478800ca400b4fe40ae421a))
* Tab into MarkdownCell auto-enters edit mode ([c51cc22](https://github.com/sethjuarez/cutready/commit/c51cc22dc10fe90d328f1457a720c5e4b28518f7))
* tab navigation from MarkdownCell + rename Demo Actions to Actions ([5331739](https://github.com/sethjuarez/cutready/commit/533173926b0416eade387efa1b9f1eb72a250959))
* theme-consistent feedback icons and localStorage persistence ([fc00d49](https://github.com/sethjuarez/cutready/commit/fc00d497028b19fc39b3a312783f74a3a94b15e9))
* time field uses local state to handle debounced save ([5af4a18](https://github.com/sethjuarez/cutready/commit/5af4a1866bed666d9c41256da9c01087c241b81e))
* title bar panel icons match actual spatial positions ([a430661](https://github.com/sethjuarez/cutready/commit/a430661659b3577b413a07fb73763473f8d74455))
* tool path resolution and new sketch creation ([45f8447](https://github.com/sethjuarez/cutready/commit/45f84473870e68e978758d36da16e4f0e7a9ad47))
* try Foundry /models endpoint (deployed only) before /openai/models ([7214df8](https://github.com/sethjuarez/cutready/commit/7214df83e0b7c23c97397126ef779cebf5c668a7))
* try Foundry deployments endpoints before falling back to models ([563f8b6](https://github.com/sethjuarez/cutready/commit/563f8b650d4d3a0050fe82629dfc0d69791ec8bd))
* use @dnd-kit/sortable for tab reordering instead of HTML5 DnD ([2cf51e7](https://github.com/sethjuarez/cutready/commit/2cf51e79d540c7e0c63a840c1a1228f022888bec))
* use colgroup for column widths, remove table-layout fixed ([6a23ed7](https://github.com/sethjuarez/cutready/commit/6a23ed734643ba993a4eaca766f65d1c7c6366da))
* use default cursor on secondary panel tabs ([a488ac7](https://github.com/sethjuarez/cutready/commit/a488ac706bca200e7209f7a9a6af9ad6c3e2eaf4))
* use detached HEAD for navigation — never move branch refs ([ce22e52](https://github.com/sethjuarez/cutready/commit/ce22e5206b2f093b38a73a98bb1782b65234649a))
* use Foundry project /deployments?api-version=v1 for deployed models ([0333259](https://github.com/sethjuarez/cutready/commit/0333259dce575c20066f4ce2e3209bc09afa2219))
* use line-art SVG icons in image manager sections ([68f77a3](https://github.com/sethjuarez/cutready/commit/68f77a338873bf587c5d24b5055aa618883d5582))
* use local rows state so multi-field edits don't overwrite each other ([fcd30af](https://github.com/sethjuarez/cutready/commit/fcd30af5ee609803c20a50c02adda8b381d6bd3b))
* use memory summarization when trimming for body size ([f0a444a](https://github.com/sethjuarez/cutready/commit/f0a444add1b5d975d2103ad3a15c8be4aea086a1))
* use product icon on home page instead of generic SVG ([80dc2ca](https://github.com/sethjuarez/cutready/commit/80dc2ca3eedfec518ce4e6efa18090532e0e4223))
* use shared Icons for sketch/note/storyboard in chat dropdowns ([fe59d29](https://github.com/sethjuarez/cutready/commit/fe59d29bedc813e884b0bce4b99c4a17d803ae4b))
* use SVG chat-bubble in feedback empty state and widen settings ([466077f](https://github.com/sethjuarez/cutready/commit/466077fabb16235bd71dd853a91d6e8cfc8f9563))
* use table-layout fixed so column widths are respected ([6850647](https://github.com/sethjuarez/cutready/commit/68506473c000b7d047a537b27ab80bbf7a13ce56))
* **ux:** clicking sidebar items dismisses settings panel ([9d59b8a](https://github.com/sethjuarez/cutready/commit/9d59b8a3e0cff4fc82af647a4a5ad42e057a0383))
* **ux:** improve bold/italic visibility in rendered markdown ([6bee31c](https://github.com/sethjuarez/cutready/commit/6bee31cd573be863ad067ccc9b6643c023c7db8c))
* **ux:** keep #mention text in chat input after autocomplete ([f03f1a0](https://github.com/sethjuarez/cutready/commit/f03f1a023f58a32687f5224139027fa2ef67c86c))
* **ux:** restyle model refresh button to match app design ([8cb416d](https://github.com/sethjuarez/cutready/commit/8cb416d60cf9eee6f426b359dd01ea5fba4a5d50))
* **ux:** settings reactivity, remove row clamp, consistent styles ([811aa8c](https://github.com/sethjuarez/cutready/commit/811aa8c24ce716b2fac1d66669110a686f2b894a))
* **ux:** show reference chips as footnotes instead of prefix ([a1c377b](https://github.com/sethjuarez/cutready/commit/a1c377b811c3b29de0c0da1e3e7c25de56d1c2ea))
* vendor openssl-sys for macOS Intel cross-compilation ([69554c1](https://github.com/sethjuarez/cutready/commit/69554c1cf6bfd1374667c2e4d21113a0cdb7c781))
* web content no longer dumped into chat — compact ref shown, full content sent to LLM only ([91b546e](https://github.com/sethjuarez/cutready/commit/91b546e6fa2f09169a0eb7dd406cfdffeff48c18))
* widen settings panel to max-w-4xl ([e71f59a](https://github.com/sethjuarez/cutready/commit/e71f59abb31de94bd6f72d8c243eb71733ab4eb0))
* widen splitter grab area to 5px with centered 1px visible line ([6d6b146](https://github.com/sethjuarez/cutready/commit/6d6b146ea230ba06f8934df5ba02c74606a48a89))
* widen splitter hit area and improve hover visibility ([f4f08f6](https://github.com/sethjuarez/cutready/commit/f4f08f675a4770e245dd46d2b611389e54231cc4))


### Performance Improvements

* cache model list with 5-minute TTL ([40b4fc3](https://github.com/sethjuarez/cutready/commit/40b4fc3ee57a05112985be6ce9e8b9c4a065d6e1))

## [0.5.3]

### New Features

- Memory management UI in Settings.
- Show `-dev` suffix on version in dev mode.
- Feedback delete with confirm, user message styling and delete.
- Dev-mode diagnostic trace logger.
- Vision/multimodal image support for AI.
- Grouped collapsible sections in image manager.

### Bug Fixes

- Nested button in chat session history.
- Guard against Azure gateway body size limit.
- Use memory summarization when trimming for body size.
- Disable HTTP connection pooling for LLM requests.
- Use line-art SVG icons in image manager sections.
- Clarify "Delete orphaned" button label.
- Persist note preview mode across tab switches.

### What's Changed

- Use slash separator for project name in title bar.

## [0.5.2]

- Memory system and conversation compaction.

## [0.5.1]

- Doc site screenshots and lightbox overhaul.

## [0.5.0]

- Merge engine, conflict resolution UI, history graph.

## [0.4.0]

- Timeline switcher, promote, workspace persistence.

## [0.3.2]

- Bug fixes and polish.

## [0.3.1]

- Bug fixes and polish.

## [0.3.0]

- Storyboard-Sketch refactor, sidebar, notes.

## [0.2.1]

- Bug fixes.

## [0.2.0]

- Command palette, layout features.

## [0.1.1]

- Security review and fixes.

## [0.1.0]

- Initial release. Project scaffold, app shell, navigation.
