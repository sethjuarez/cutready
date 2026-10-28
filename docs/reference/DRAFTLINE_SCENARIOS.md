# Draftline Scenario Coverage

CutReady hosts [Draftline](https://github.com/sethjuarez/draftline) 0.8.0. Draftline's playbook (`docs/scenarios.md` and `docs/scenario-flows/*.md`) defines the flows a host must support. This page maps every flow to CutReady's surface, tests, and gaps.

Audited 2026-10-24 against Draftline 0.6.0 (`4607ad4`). The tables below are that audit; [Since 0.8.0](#since-080) records what changed.

## Since 0.8.0

Draftline 0.7.0 and 0.8.0 replaced the checkout claim with a committed `.draftline` marker and fixed the hybrid gaps below in Draftline. CutReady adopts the published crate and surfaces the new codes.

| Gap | Now | Where |
| --- | --- | --- |
| G1 | Saves land on the checked-out branch, as a teammate's would. Send starts a `cutready/` branch from any other branch. | DL |
| G2 | Send never carries or rewinds a developer's unpushed commits. CutReady passes the preflight token. When the Git LFS driver runs, Draftline uploads LFS content before pushing (`git_filter_failed` on failure); otherwise CutReady refuses outgoing LFS pointers (`send_has_lfs_pointers`). | DL + CutReady |
| G4 | A lock whose process died on the same machine clears immediately. | DL |
| G8 | `folder_missing`, `folder_is_elsewhere`, `invalid_folder_marker`, and `newer_folder_marker` have plain messages. Opening a renamed folder's old path names the new one (`project_folder_renamed`); opening the new one keeps history. | DL + CutReady |
| G10 | Publish returns `base_renamed {from, to}`; the Changes panel offers to rename the branch. | DL + CutReady |

Still open: G3 (recovery UI), G5–G7, G9, and G11–G20. Draftline could add the new base name to `SyncStatus` so CutReady can offer the rename before publishing.

A crash and hybrid stress pass against 0.8.0 was clean: developer branch switch, unpushed base commits, folder rename and move, default-branch rename, kills mid-save, move and Send, foreign markers, and 0.5.0 recovery records.

## Legend

| Mark | Meaning |
| --- | --- |
| ✅ | Covered: UI, tests, and docs |
| ⚠️ | Partial: works, but with gaps |
| ❌ | Missing or unsafe |
| ➖ | Not exposed by design |

**Std** means standalone projects (the folder is its own repo). **Hyb** means hybrid projects (a CutReady folder inside a code repo).

## Flow Coverage

### Workspace and Content Policy

| Flow | Mode | Status | CutReady evidence | Gaps |
| --- | --- | --- | --- | --- |
| 1 Start or open | Both | ⚠️ | `init_project_folder_creates_draftline_workspace`, `second_hybrid_folder_in_same_checkout_is_refused_with_claimed_folder` | G3, G4, G5 |
| 1a Adopt a non-Draftline repo | Both | ❌ | `existing_plain_git_project_opens_as_draftline_workspace` (CutReady-shaped repos only) | G5 |
| 1b Sharing mode | Std | ⚠️ | `appStoreSync.test.ts` | G16 |
| 1c Add a remote later | Std | ❌ | `remote_urls_reject_and_redact_embedded_credentials` | G9 |
| 1d Start from a shared remote | Both | ⚠️ | `draftlineVersioning.test.ts` adopt tests | G17 |
| 1e Developer Copilot opens the repo | Hyb | ❌ | None | G20 |
| 1f Agent uses Draftline APIs | ➖ | ➖ | The in-app agent uses domain tools | None |
| 2 Business content policy | Both | ⚠️ | `content_policy_tracks_cutready_extensions_without_explicit_file_roots` | G20 (docs drift) |
| 2a Change policy after work exists | Both | ❌ | None | G18 |
| 2b Policy versus Git ignore and attributes | Both | ⚠️ | `draftlineErrors.test.ts` filter hazards | G12 |

### Authoring

| Flow | Mode | Status | CutReady evidence | Gaps |
| --- | --- | --- | --- | --- |
| 3 Save | Both | ❌ (Hyb) | `hybrid_save_leaves_developer_index_and_code_files_alone`, `snapshotSave.test.tsx` | G1 |
| 4 Discard | Both | ❌ (Hyb) | `discardFile.test.ts`, `discard_changes_preserves_excluded_runtime_state` | G7 |
| 4a Shelve selected work | Both | ❌ | `shelf_lifecycle_replaces_git_stash_for_tracked_content` (no UI) | G15 |
| 5 Create a variation | Both | ✅ | `hybrid_contract_namespaces_listing_and_new_variations`, `draftlineVersioning.test.ts` | None |
| 6 Switch variation | Both | ⚠️ | `dirty_variation_switch_preflights_without_moving_head` | G1 (developer branch shown as current) |
| 6a Relabel a variation | Both | ➖ | None | G20 |
| 7 Switch with unsaved work | Both | ⚠️ | `UnsavedWorkspaceDialog` | G7, G15 |
| 8 Review history | Both | ✅ | `draftlineVersioning.test.ts` graph and diff tests | None |
| 9 Restore | Both | ⚠️ | `restore_version_as_new_save_restores_tracked_content_without_runtime_state` | G1 |
| 9a Restore hazards | Both | ⚠️ | Relies on Draftline preflight | G20 (tests) |

### Collaboration

| Flow | Mode | Status | CutReady evidence | Gaps |
| --- | --- | --- | --- | --- |
| 10 Publish (Std) / Send for review (Hyb) | Both | ❌ (Hyb) | `send_for_review_pushes_a_cutready_branch_and_opens_a_pull_request`, `sendForReview.test.tsx`, live drill | G2, G11 |
| 11 Receive updates | Both | ❌ (Hyb) | `appStoreSync.test.ts` base-update tests | G1 (pull moves a developer branch) |
| 11a Adopt a remote variation | Both | ✅ | `draftlineVersioning.test.ts` | None |
| 11b Remote variation deleted or renamed | Both | ❌ | None | G10, G14 |
| 11c Change or remove the remote | Std | ❌ | None | G9 |
| 12 Reconcile conflicts | Both | ⚠️ | `two_client_remote_conflict_drill_preserves_resolved_content_and_runtime_state`, live drill | G1, G20 (no panel UI test) |

### Recovery and Cleanup

| Flow | Mode | Status | CutReady evidence | Gaps |
| --- | --- | --- | --- | --- |
| 12a Apply shelved work | Both | ❌ | Store functions only | G15 |
| 13 Remove a variation | Both | ⚠️ | `delete_variation_removes_non_current_variation` | G19 |
| 13b–13d Support refs | ➖ | ➖ | Fetched implicitly | G20 (docs) |
| 13f Purge, 13g Expire | ➖ | ➖ | None | G20 (docs) |
| 13h Large or binary assets | Both | ❌ | `appStoreSync.test.ts` large-file block | G11 |
| 14 Recover from an interruption | Both | ❌ | Dead helpers only | G3, G6 |
| 14a Out-of-band Git changes | Both | ⚠️ | `git_index_locked` and `local_state_changed` mapped, live drill | G13 |
| 14b Stale operation lock | Both | ❌ | None | G4 |

### Hybrid Projects

| Flow | Mode | Status | CutReady evidence | Gaps |
| --- | --- | --- | --- | --- |
| 15 Open inside a code repo | Hyb | ✅ | `hybrid_project_joins_enclosing_repo_without_nested_git`, live drill | None |
| 15a Save next to a developer | Hyb | ❌ | `hybrid_variations_hide_developer_branches` | G1 |
| 15b Developers commit with Git | Hyb | ✅ | `developer_commits_touching_the_folder_appear_in_versions`, live drill | None |
| 15c Send for review | Hyb | ❌ | See Flow 10 | G2 |
| 15d Get updates from base | Hyb | ✅ | `base_conflicts_outside_the_folder_need_a_developer`, live drill | None |
| 15e Separate copy (worktree) | ➖ | ➖ | None | None |
| 15f One workspace per checkout | Hyb | ⚠️ | `second_hybrid_folder_in_same_checkout_is_refused_with_claimed_folder` | G8 |

## Gap Backlog

**Owner** is where the fix belongs. **DL** means Draftline.

| ID | Severity | Gap | Owner |
| --- | --- | --- | --- |
| G1 | 🔴 Critical | In hybrid projects, save, restore, pull, and merge write to whatever branch is checked out. After a developer runs `git switch feature/x`, business saves land on that branch, and Send and publish then refuse with no in-app way out. `hybrid-projects.mdx` claims these operations are refused. | DL: refuse writes outside the namespace. CutReady: guard the branch, show a banner, offer "start a CutReady branch here" |
| G2 | 🔴 Critical | Send creates the review branch from `HEAD`. A developer's unpushed commits on the local base go into the PR, and local base is reset to the remote. The dialog says "your CutReady changes". | DL: refuse or report base commits outside the folder. CutReady: confirm and fix the copy |
| G3 | 🔴 Critical | No recovery UI. `recovery_required` is not mapped, and repair, rollback, and acknowledge are not wired. A crash mid-merge blocks every operation. Recovery records left by 1.37.0 can only be acknowledged. | CutReady (DL: confirm `acknowledge_recovery` is in the contract) |
| G4 | 🟠 High | No handling for a stale operation lock. `workspace_locked` is not mapped, and `clear_stale_lock` is not wired. | CutReady |
| G5 | 🟠 High | Opening a code repo root silently adopts it as a standalone project. It tracks the developer's `.md` and image files, publishes directly, and claims the checkout. | CutReady: `preflight_adopt_workspace` plus a confirmation step or subfolder picker |
| G6 | 🟠 High | A history cleanup left pending by 1.37.0 is stranded: there is no publish or undo, and a plain push is rejected. | CutReady: detect it and offer "keep remote" or "restore backup" |
| G7 | 🟠 High | Discard restores every changed file in the folder, including a developer's uncommitted edits. The confirmation lists no files and has no Shelve option. "Discard and continue" takes one click. | CutReady |
| G8 | 🟠 High | The checkout claim can point to a folder that no longer exists, for example after a rename or on another branch. Relocation is not exposed. | CutReady (DL: return a distinct error code) |
| G9 | 🟠 High | The Settings remote "Test" button makes no network call. Changing the URL when `origin` exists does nothing but reports success. There is no remove option. | CutReady |
| G10 | 🟠 High | A default-branch rename (`master` to `main`) strands saves. A stale `origin/HEAD` keeps targeting the old base. | DL: refresh `origin/HEAD` and add a diagnostic. CutReady: surface it |
| G11 | 🟠 High | The pre-push large-file check scans unsaved files, not the outgoing commits. | CutReady (DL: publish preflight) |
| G12 | 🟠 High | The large-file message tells users to add files to `.gitignore`, which makes them silently stop being tracked. Ignored tracked content is never surfaced. | CutReady |
| G13 | 🟡 Medium | A detached `HEAD` stops the project loading, with a raw `NoCurrentVariation` error. | CutReady |
| G14 | 🟡 Medium | `remote_variation_diagnostics` is never called, so a remote variation that was deleted shows no message. | CutReady |
| G15 | 🟡 Medium | Shelves have no UI, always use the same name `cutready-stash`, and swallow errors. | CutReady |
| G16 | 🟡 Medium | When there are several remotes, `remotes[0]` is picked arbitrarily. | CutReady |
| G17 | 🟡 Medium | Clone ignores hybrid layout: no namespace and no subfolder detection. | CutReady |
| G18 | 🟡 Medium | The content policy has no version or migration, so a release can silently change what is tracked. | CutReady |
| G19 | 🟡 Medium | `delete_variation` loses error codes because it uses `to_string()`. | CutReady |
| G20 | ⚪ Low | No developer or agent rules of engagement (AGENTS.md). Developer branches look like normal variations. No relabel. Docs drift: file-format policy, hybrid overclaims, unexposed flows. Dead registered commands. Missing tests for every gap above. | CutReady |

## Drill Coverage

A live drill on 2026-10-24 ran the real app under Auditaur against a private GitHub repo with a separate developer clone.

| Scenario | Result |
| --- | --- |
| Hybrid open, namespace filter, scoped save, developer WIP untouched | ✅ |
| `.git/index.lock` gives "Git is busy" | ✅ |
| Send for review opens a PR | ✅ |
| Get updates: clean, conflict inside the folder, conflict outside the folder | ✅ |

Still to drill once the gaps are fixed:

- Crash at each mutation step
- Developer branch switch, stash, and detached `HEAD` while the app is open
- Unpushed commits on the base before Send
- PR closed or merged
- Default-branch rename
- Upgrade from 1.37.0 with a pending cleanup
