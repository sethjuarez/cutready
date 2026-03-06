# Changelog

## \[0.6.0]

### What's Changed

- [`e2a317c`](https://github.com/sethjuarez/cutready/commit/e2a317c0f9f01fa1870b0d21eaa44247d272a2a8) Added Covector-based version management with automated changelog generation and CI release workflow.

Covector manages this changelog. Do not edit manually.
Each release section is generated from `.changes/*.md` files.

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
