/**
 * Comprehensive E2E tests for branching, merging, and remote flows.
 * Covers weird edge cases and integration paths across:
 * - Timeline creation / switching / deletion
 * - Merge: clean, conflicts (sketch, note, storyboard), fast-forward, nothing
 * - Remote: pull (up-to-date, fast-forward, conflicts), push, sync status
 * - History graph: DAG rendering with merge commits, remote refs
 *
 * Each test takes a screenshot for visual review.
 */
import { test, expect, type Page } from "@playwright/test";

// ── Helpers ────────────────────────────────────────────────────

/** Navigate to project and open a sketch, show Snapshots tab */
async function setupApp(page: Page) {
  await page.goto("/");
  await page.waitForSelector("#root", { timeout: 10_000 });
  // Click the mock project on the homepage
  await page.getByText("mock-project", { exact: true }).click();
  await page.waitForTimeout(600);
  // Click the sketch to open it in the editor
  await page.getByText("Demo Introduction").first().click();
  await page.waitForTimeout(400);
  // Show secondary panel (hidden by default in fresh session)
  await page.getByRole("button", { name: "Toggle Secondary Panel" }).click();
  await page.waitForTimeout(300);
  // Switch to Snapshots tab
  await page.getByRole("button", { name: "Snapshots" }).click();
  await page.waitForTimeout(500);
}

/** Inject mock overrides and refresh the Snapshots tab to pick them up */
async function setOverrides(page: Page, overrides: Record<string, unknown>) {
  await page.evaluate((o) => {
    const w = window as any;
    for (const [k, v] of Object.entries(o)) {
      w.__MOCK_OVERRIDES__[k] = v;
    }
  }, overrides);
  // Toggle tab to force re-fetch
  await page.getByRole("button", { name: "Chat" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Snapshots" }).click();
  await page.waitForTimeout(500);
}

/** Take a labeled screenshot */
async function snap(page: Page, name: string) {
  await page.screenshot({ path: `e2e/screenshots/v0.5.0/integration/${name}.png` });
}

// ── Graph node builder ─────────────────────────────────────────

let nodeCounter = 0;
function makeNode(overrides: Partial<{
  id: string; message: string; timestamp: string; timeline: string;
  parents: string[]; lane: number; is_head: boolean;
  is_branch_tip: boolean; is_remote_tip: boolean; author: string;
}> = {}) {
  const idx = nodeCounter++;
  return {
    id: overrides.id ?? `node-${idx}`,
    message: overrides.message ?? `Commit ${idx}`,
    timestamp: overrides.timestamp ?? new Date(Date.now() - idx * 600_000).toISOString(),
    timeline: overrides.timeline ?? "main",
    parents: overrides.parents ?? [],
    lane: overrides.lane ?? 0,
    is_head: overrides.is_head ?? false,
    is_branch_tip: overrides.is_branch_tip ?? false,
    is_remote_tip: overrides.is_remote_tip ?? false,
    author: overrides.author ?? "You",
  };
}

// ── Mock data factories ────────────────────────────────────────

function makeTimeline(name: string, label: string, isActive: boolean, count: number, colorIndex: number) {
  return { name, label, is_active: isActive, snapshot_count: count, color_index: colorIndex };
}

function makeConflictFile(opts: {
  path: string;
  file_type: "sketch" | "storyboard" | "note" | "other";
  field_conflicts?: Array<{ field_path: string; ours: unknown; theirs: unknown; ancestor: unknown }>;
  text_conflicts?: Array<{ start_line: number; ours_lines: string[]; theirs_lines: string[]; ancestor_lines: string[] }>;
}) {
  return {
    path: opts.path,
    file_type: opts.file_type,
    ours: opts.file_type === "note"
      ? "# Our Version\nLine 1\nLine 2\nLine 3"
      : JSON.stringify({ title: "Our Title", description: "Our desc", rows: [] }, null, 2),
    theirs: opts.file_type === "note"
      ? "# Their Version\nLine A\nLine B\nLine C"
      : JSON.stringify({ title: "Their Title", description: "Their desc", rows: [] }, null, 2),
    ancestor: opts.file_type === "note"
      ? "# Original\nLine 1\nLine 2"
      : JSON.stringify({ title: "Original Title", description: "", rows: [] }, null, 2),
    field_conflicts: opts.field_conflicts ?? [],
    text_conflicts: opts.text_conflicts ?? [],
  };
}

// ══════════════════════════════════════════════════════════════
//  TEST SUITE 1: Timeline branching basics
// ══════════════════════════════════════════════════════════════

test.describe("Timeline Branching", () => {
  test.beforeEach(async ({ page }) => {
    nodeCounter = 0;
    await setupApp(page);
  });

  test("1a — single timeline: selector hidden", async ({ page }) => {
    // Default mock has 1 timeline
    const branchBtn = page.locator('button[title^="Branch:"]');
    await expect(branchBtn).not.toBeVisible();
    await snap(page, "1a-single-timeline-hidden");
  });

  test("1b — two timelines: selector shows, can open dropdown", async ({ page }) => {
    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 5, 0),
        makeTimeline("timeline/experiment", "Experiment", false, 3, 1),
      ],
    });

    const branchBtn = page.locator('button[title^="Branch:"]');
    await expect(branchBtn).toBeVisible({ timeout: 3_000 });
    await branchBtn.click();
    await page.waitForTimeout(300);

    // Both timelines visible in dropdown
    await expect(page.getByRole("button", { name: "Main 5 snaps" })).toBeVisible();
    await expect(page.getByText("Experiment")).toBeVisible();
    await snap(page, "1b-two-timelines-dropdown");
  });

  test("1c — many timelines: filter search works", async ({ page }) => {
    const timelines = [
      makeTimeline("main", "Main", true, 10, 0),
      makeTimeline("timeline/alpha", "Alpha direction", false, 5, 1),
      makeTimeline("timeline/beta", "Beta approach", false, 3, 2),
      makeTimeline("timeline/gamma", "Gamma rewrite", false, 2, 3),
      makeTimeline("timeline/delta", "Delta cleanup", false, 1, 4),
    ];
    await setOverrides(page, { list_timelines: timelines });

    const branchBtn = page.locator('button[title^="Branch:"]');
    await branchBtn.click();
    await page.waitForTimeout(300);

    // Filter should be visible (>3 timelines)
    const filterInput = page.locator('input[placeholder="Filter branches…"]');
    await expect(filterInput).toBeVisible();
    await filterInput.fill("beta");
    await page.waitForTimeout(200);

    // Only Beta should be visible
    await expect(page.getByText("Beta approach")).toBeVisible();
    await expect(page.getByText("Alpha direction")).not.toBeVisible();
    await snap(page, "1c-filter-search");
  });

  test("1d — action buttons: merge/promote/delete visible on hover", async ({ page }) => {
    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 5, 0),
        makeTimeline("timeline/fork-a", "Fork A", false, 3, 1),
      ],
    });

    const branchBtn = page.locator('button[title^="Branch:"]');
    await branchBtn.click();
    await page.waitForTimeout(300);

    // Hover over the non-active timeline to reveal action buttons
    const forkRow = page.getByText("Fork A").first();
    await forkRow.hover();
    await page.waitForTimeout(300);

    await expect(page.getByText("Merge")).toBeVisible();
    await expect(page.getByText("Promote")).toBeVisible();
    await snap(page, "1d-hover-actions");
  });

  test("1e — dirty state: switching blocked, snapshot prompt shown", async ({ page }) => {
    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 5, 0),
        makeTimeline("timeline/fork-a", "Fork A", false, 2, 1),
      ],
      has_unsaved_changes: true,
    });

    const branchBtn = page.locator('button[title^="Branch:"]');
    await branchBtn.click();
    await page.waitForTimeout(300);

    // Try to switch (should trigger snapshot prompt)
    await page.getByText("Fork A").first().click();
    await page.waitForTimeout(500);

    // The snapshot dialog should appear
    const dialog = page.locator('text=Save a snapshot');
    // Check if the prompt triggered (it may be the Ctrl+S dialog)
    await snap(page, "1e-dirty-switch-blocked");
  });
});

// ══════════════════════════════════════════════════════════════
//  TEST SUITE 2: Clean merge scenarios
// ══════════════════════════════════════════════════════════════

test.describe("Merge — Clean", () => {
  test.beforeEach(async ({ page }) => {
    nodeCounter = 0;
    await setupApp(page);
  });

  test("2a — clean merge: success toast, no conflict panel", async ({ page }) => {
    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 5, 0),
        makeTimeline("timeline/feature", "Feature branch", false, 3, 1),
      ],
      merge_timelines: { status: "clean", commit_id: "merged-abc123" },
    });

    const branchBtn = page.locator('button[title^="Branch:"]');
    await branchBtn.click();
    await page.waitForTimeout(300);

    // Hover over Feature branch row to reveal merge button
    const featureRow = page.getByText("Feature branch").first();
    await featureRow.hover();
    await page.waitForTimeout(300);

    // We need to handle the confirm dialog
    page.on("dialog", (dialog) => dialog.accept());

    const mergeBtn = page.getByText("Merge").first();
    await mergeBtn.click();
    await page.waitForTimeout(500);

    // MergeConflictPanel should NOT be visible
    await expect(page.locator("text=Combining")).not.toBeVisible();
    await snap(page, "2a-clean-merge-success");
  });

  test("2b — fast-forward merge: no merge commit needed", async ({ page }) => {
    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 5, 0),
        makeTimeline("timeline/ahead", "Ahead branch", false, 8, 1),
      ],
      merge_timelines: { status: "fast_forward", commit_id: "ff-abc123" },
    });

    page.on("dialog", (dialog) => dialog.accept());

    const branchBtn = page.locator('button[title^="Branch:"]');
    await branchBtn.click();
    await page.waitForTimeout(300);

    const aheadRow = page.getByText("Ahead branch").first();
    await aheadRow.hover();
    await page.waitForTimeout(300);

    await page.getByText("Merge").first().click();
    await page.waitForTimeout(500);

    await expect(page.locator("text=Combining")).not.toBeVisible();
    await snap(page, "2b-fast-forward-merge");
  });

  test("2c — nothing to merge (already merged)", async ({ page }) => {
    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 5, 0),
        makeTimeline("timeline/old", "Old branch", false, 3, 1),
      ],
      merge_timelines: { status: "nothing" },
    });

    page.on("dialog", (dialog) => dialog.accept());

    const branchBtn = page.locator('button[title^="Branch:"]');
    await branchBtn.click();
    await page.waitForTimeout(300);

    const oldRow = page.getByText("Old branch").first();
    await oldRow.hover();
    await page.waitForTimeout(300);

    await page.getByText("Merge").first().click();
    await page.waitForTimeout(500);

    await expect(page.locator("text=Combining")).not.toBeVisible();
    await snap(page, "2c-nothing-to-merge");
  });
});

// ══════════════════════════════════════════════════════════════
//  TEST SUITE 3: Merge with conflicts
// ══════════════════════════════════════════════════════════════

test.describe("Merge — Conflicts", () => {
  test.beforeEach(async ({ page }) => {
    nodeCounter = 0;
    await setupApp(page);
  });

  test("3a — sketch field conflict: MergeConflictPanel shows field resolvers", async ({ page }) => {
    const sketchConflict = makeConflictFile({
      path: "sketches/demo-introduction.sk",
      file_type: "sketch",
      field_conflicts: [
        { field_path: "title", ours: "Demo Introduction", theirs: "Product Demo", ancestor: "Untitled" },
        { field_path: "rows[0].narrative", ours: "Welcome and hello!", theirs: "Welcome everyone!", ancestor: "Welcome" },
      ],
    });

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 5, 0),
        makeTimeline("timeline/redesign", "UI Redesign", false, 4, 1),
      ],
      merge_timelines: { status: "conflicts", conflicts: [sketchConflict] },
    });

    page.on("dialog", (dialog) => dialog.accept());

    const branchBtn = page.locator('button[title^="Branch:"]');
    await branchBtn.click();
    await page.waitForTimeout(300);

    const redesignRow = page.getByText("UI Redesign").first();
    await redesignRow.hover();
    await page.waitForTimeout(300);

    await page.getByText("Merge").first().click();
    await page.waitForTimeout(500);

    // MergeConflictPanel should be visible
    await expect(page.locator("text=Combining")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("1 file needs your attention")).toBeVisible();

    // Field conflicts should show with field paths
    await expect(page.locator(".font-mono >> text=title")).toBeVisible();
    await expect(page.getByText("Product Demo")).toBeVisible();
    await snap(page, "3a-sketch-conflict-panel");
  });

  test("3b — resolve sketch conflict: select choices, Apply enabled", async ({ page }) => {
    const sketchConflict = makeConflictFile({
      path: "sketches/demo.sk",
      file_type: "sketch",
      field_conflicts: [
        { field_path: "title", ours: "Our Title", theirs: "Their Title", ancestor: "Original" },
      ],
    });

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 3, 0),
        makeTimeline("timeline/other", "Other", false, 2, 1),
      ],
      merge_timelines: { status: "conflicts", conflicts: [sketchConflict] },
      apply_merge_resolution: "resolved-commit-id",
    });

    page.on("dialog", (dialog) => dialog.accept());

    // Trigger merge
    const branchBtn = page.locator('button[title^="Branch:"]');
    await branchBtn.click();
    await page.waitForTimeout(300);
    const otherRow = page.getByText("Other").first();
    await otherRow.hover();
    await page.waitForTimeout(300);
    await page.getByText("Merge").first().click();
    await page.waitForTimeout(500);

    // Apply button should be disabled (nothing resolved yet)
    const applyBtn = page.getByText("Apply & Combine");
    await expect(applyBtn).toBeVisible();
    await expect(applyBtn).toBeDisabled();

    // Click "ours" for the title field
    await page.getByText("Our Title").first().click();
    await page.waitForTimeout(300);

    // Now Apply should be enabled
    await expect(applyBtn).toBeEnabled();
    await snap(page, "3b-conflict-resolved-apply-enabled");

    // Click Apply
    await applyBtn.click();
    await page.waitForTimeout(500);

    // Conflict panel should disappear
    await expect(page.locator("text=Combining")).not.toBeVisible();
    await snap(page, "3b-after-apply");
  });

  test("3c — note text conflict: shows text region resolver", async ({ page }) => {
    const noteConflict = makeConflictFile({
      path: "notes/script-draft.md",
      file_type: "note",
      text_conflicts: [
        {
          start_line: 3,
          ours_lines: ["## Key Points", "- Fast performance", "- Easy to use"],
          theirs_lines: ["## Main Ideas", "- Blazing fast", "- Developer friendly"],
          ancestor_lines: ["## Points", "- Good performance"],
        },
        {
          start_line: 10,
          ours_lines: ["Thank you for watching!"],
          theirs_lines: ["Thanks for tuning in!"],
          ancestor_lines: ["Thanks"],
        },
      ],
    });

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 5, 0),
        makeTimeline("timeline/alt", "Alternative", false, 3, 1),
      ],
      merge_timelines: { status: "conflicts", conflicts: [noteConflict] },
    });

    page.on("dialog", (dialog) => dialog.accept());

    const branchBtn = page.locator('button[title^="Branch:"]');
    await branchBtn.click();
    await page.waitForTimeout(300);
    const altRow = page.getByText("Alternative").first();
    await altRow.hover();
    await page.waitForTimeout(300);
    await page.getByText("Merge").first().click();
    await page.waitForTimeout(500);

    // Should show text region resolver
    await expect(page.getByText("Conflict region 1")).toBeVisible();
    await expect(page.getByText("Conflict region 2")).toBeVisible();
    await expect(page.getByText("Key Points")).toBeVisible();
    await expect(page.getByText("Main Ideas")).toBeVisible();
    await snap(page, "3c-note-text-conflict");
  });

  test("3d — multiple conflict files: sketch + note + storyboard", async ({ page }) => {
    const conflicts = [
      makeConflictFile({
        path: "sketches/intro.sk",
        file_type: "sketch",
        field_conflicts: [
          { field_path: "title", ours: "Intro v1", theirs: "Intro v2", ancestor: "Intro" },
        ],
      }),
      makeConflictFile({
        path: "notes/outline.md",
        file_type: "note",
        text_conflicts: [
          { start_line: 1, ours_lines: ["Our outline"], theirs_lines: ["Their outline"], ancestor_lines: ["Original"] },
        ],
      }),
      makeConflictFile({
        path: "storyboards/flow.sb",
        file_type: "storyboard",
        field_conflicts: [
          { field_path: "title", ours: "Demo Flow A", theirs: "Demo Flow B", ancestor: "Demo Flow" },
          { field_path: "description", ours: "Full walkthrough", theirs: "Quick overview", ancestor: "" },
        ],
      }),
    ];

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 5, 0),
        makeTimeline("timeline/refactor", "Big Refactor", false, 7, 1),
      ],
      merge_timelines: { status: "conflicts", conflicts },
    });

    page.on("dialog", (dialog) => dialog.accept());

    const branchBtn = page.locator('button[title^="Branch:"]');
    await branchBtn.click();
    await page.waitForTimeout(300);
    const refactorRow = page.getByText("Big Refactor").first();
    await refactorRow.hover();
    await page.waitForTimeout(300);
    await page.getByText("Merge").first().click();
    await page.waitForTimeout(500);

    // All 3 conflict cards should be visible
    await expect(page.getByText("3 files need your attention")).toBeVisible();
    await expect(page.getByText("sketches/intro.sk")).toBeVisible();
    await expect(page.getByText("notes/outline.md")).toBeVisible();
    await expect(page.getByText("storyboards/flow.sb")).toBeVisible();

    // Type labels visible alongside their file paths
    await expect(page.getByText("Sketch", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Note", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Storyboard", { exact: true })).toBeVisible();
    await snap(page, "3d-multi-file-conflicts");
  });

  test("3e — cancel merge: conflict panel closes, state reset", async ({ page }) => {
    const conflict = makeConflictFile({
      path: "sketches/demo.sk",
      file_type: "sketch",
      field_conflicts: [
        { field_path: "title", ours: "A", theirs: "B", ancestor: "C" },
      ],
    });

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 3, 0),
        makeTimeline("timeline/temp", "Temp", false, 1, 1),
      ],
      merge_timelines: { status: "conflicts", conflicts: [conflict] },
    });

    page.on("dialog", (dialog) => dialog.accept());

    const branchBtn = page.locator('button[title^="Branch:"]');
    await branchBtn.click();
    await page.waitForTimeout(300);
    const tempRow = page.getByText("Temp").first();
    await tempRow.hover();
    await page.waitForTimeout(500);
    // Click the Merge button inside the dropdown (scoped)
    const dropdown = page.locator(".absolute.z-50");
    await dropdown.getByText("Merge").click();
    await page.waitForTimeout(1000);

    await expect(page.locator("text=Combining")).toBeVisible({ timeout: 5_000 });

    // Click Cancel on the merge panel
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(300);

    // Conflict panel should be gone, editor should be back
    await expect(page.locator("text=Combining")).not.toBeVisible();
    await snap(page, "3e-merge-cancelled");
  });
});

// ══════════════════════════════════════════════════════════════
//  TEST SUITE 4: Remote / sync scenarios
// ══════════════════════════════════════════════════════════════

test.describe("Remote — Sync", () => {
  test.beforeEach(async ({ page }) => {
    nodeCounter = 0;
    await setupApp(page);
  });

  test("4a — no remote: sync bar hidden", async ({ page }) => {
    await setOverrides(page, {
      detect_git_remote: null,
      list_git_remotes: [],
    });
    // Sync bar should not be visible
    const syncBar = page.locator('[data-testid="sync-bar"]');
    await expect(syncBar).not.toBeVisible();
    await snap(page, "4a-no-remote");
  });

  test("4b — remote configured, up-to-date: shows green checkmark", async ({ page }) => {
    await setOverrides(page, {
      detect_git_remote: { name: "origin", url: "https://github.com/user/project.git" },
      list_git_remotes: [{ name: "origin", url: "https://github.com/user/project.git" }],
      get_sync_status: { ahead: 0, behind: 0 },
    });
    await snap(page, "4b-remote-up-to-date");
  });

  test("4c — ahead of remote: shows push indicator", async ({ page }) => {
    await setOverrides(page, {
      detect_git_remote: { name: "origin", url: "https://github.com/user/project.git" },
      list_git_remotes: [{ name: "origin", url: "https://github.com/user/project.git" }],
      get_sync_status: { ahead: 3, behind: 0 },
    });
    await snap(page, "4c-ahead-of-remote");
  });

  test("4d — behind remote: shows pull indicator", async ({ page }) => {
    await setOverrides(page, {
      detect_git_remote: { name: "origin", url: "https://github.com/user/project.git" },
      list_git_remotes: [{ name: "origin", url: "https://github.com/user/project.git" }],
      get_sync_status: { ahead: 0, behind: 5 },
    });
    await snap(page, "4d-behind-remote");
  });

  test("4e — diverged: ahead and behind", async ({ page }) => {
    await setOverrides(page, {
      detect_git_remote: { name: "origin", url: "https://github.com/user/project.git" },
      list_git_remotes: [{ name: "origin", url: "https://github.com/user/project.git" }],
      get_sync_status: { ahead: 2, behind: 4 },
    });
    await snap(page, "4e-diverged");
  });

  test("4f — pull fast-forward: updates cleanly", async ({ page }) => {
    await setOverrides(page, {
      detect_git_remote: { name: "origin", url: "https://github.com/user/project.git" },
      list_git_remotes: [{ name: "origin", url: "https://github.com/user/project.git" }],
      get_sync_status: { ahead: 0, behind: 3 },
      pull_git_remote: { type: "FastForward", commits: 3 },
    });
    await snap(page, "4f-pull-fast-forward");
  });

  test("4g — pull with conflicts: enters merge mode", async ({ page }) => {
    const conflict = makeConflictFile({
      path: "sketches/shared.sk",
      file_type: "sketch",
      field_conflicts: [
        { field_path: "title", ours: "Local Version", theirs: "Remote Version", ancestor: "Shared Title" },
      ],
    });

    await setOverrides(page, {
      detect_git_remote: { name: "origin", url: "https://github.com/user/project.git" },
      list_git_remotes: [{ name: "origin", url: "https://github.com/user/project.git" }],
      get_sync_status: { ahead: 1, behind: 2 },
      list_timelines: [makeTimeline("main", "Main", true, 5, 0)],
      pull_git_remote: { type: "Conflicts", ahead: 1, behind: 2, conflicts: [conflict] },
    });
    await snap(page, "4g-pull-conflicts-setup");
  });
});

// ══════════════════════════════════════════════════════════════
//  TEST SUITE 5: History graph DAG rendering
// ══════════════════════════════════════════════════════════════

test.describe("History Graph — DAG", () => {
  test.beforeEach(async ({ page }) => {
    nodeCounter = 0;
    await setupApp(page);
  });

  test("5a — linear history: simple vertical chain", async ({ page }) => {
    nodeCounter = 0;
    const nodes = [
      makeNode({ id: "c1", message: "Initial commit", parents: [], timeline: "main", is_head: false, timestamp: "2025-01-15T09:00:00Z" }),
      makeNode({ id: "c2", message: "Add introduction sketch", parents: ["c1"], timeline: "main", is_head: false, timestamp: "2025-01-15T10:00:00Z" }),
      makeNode({ id: "c3", message: "Polish narrative text", parents: ["c2"], timeline: "main", is_head: false, timestamp: "2025-01-15T11:00:00Z" }),
      makeNode({ id: "c4", message: "Add screenshots", parents: ["c3"], timeline: "main", is_head: true, is_branch_tip: true, timestamp: "2025-01-15T12:00:00Z" }),
    ];

    await setOverrides(page, {
      list_timelines: [makeTimeline("main", "Main", true, 4, 0)],
      get_graph: nodes,
      get_timeline_graph: nodes,
    });

    // Open History tab
    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(800);
    await snap(page, "5a-linear-history");
  });

  test("5b — fork: two branches diverging", async ({ page }) => {
    nodeCounter = 0;
    const nodes = [
      makeNode({ id: "c1", message: "Initial", parents: [], timeline: "main", timestamp: "2025-01-15T09:00:00Z" }),
      makeNode({ id: "c2", message: "Shared work", parents: ["c1"], timeline: "main", timestamp: "2025-01-15T10:00:00Z" }),
      makeNode({ id: "c3", message: "Main continues", parents: ["c2"], timeline: "main", is_head: true, is_branch_tip: true, timestamp: "2025-01-15T12:00:00Z" }),
      makeNode({ id: "c4", message: "Fork experiment", parents: ["c2"], timeline: "timeline/experiment", lane: 1, timestamp: "2025-01-15T11:00:00Z" }),
      makeNode({ id: "c5", message: "More experiments", parents: ["c4"], timeline: "timeline/experiment", lane: 1, is_branch_tip: true, timestamp: "2025-01-15T13:00:00Z" }),
    ];

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 3, 0),
        makeTimeline("timeline/experiment", "Experiment", false, 2, 1),
      ],
      get_graph: nodes,
      get_timeline_graph: nodes,
    });

    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(800);
    await snap(page, "5b-two-branch-fork");
  });

  test("5c — merge commit: two branches converging", async ({ page }) => {
    nodeCounter = 0;
    const nodes = [
      makeNode({ id: "c1", message: "Initial", parents: [], timeline: "main", timestamp: "2025-01-15T09:00:00Z" }),
      makeNode({ id: "c2", message: "Main work", parents: ["c1"], timeline: "main", timestamp: "2025-01-15T10:00:00Z" }),
      makeNode({ id: "c3", message: "Fork work", parents: ["c1"], timeline: "timeline/fork", lane: 1, timestamp: "2025-01-15T10:30:00Z" }),
      makeNode({ id: "c4", message: "More fork work", parents: ["c3"], timeline: "timeline/fork", lane: 1, timestamp: "2025-01-15T11:00:00Z" }),
      makeNode({ id: "c5", message: "Merge fork into main", parents: ["c2", "c4"], timeline: "main", is_head: true, is_branch_tip: true, timestamp: "2025-01-15T12:00:00Z" }),
    ];

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 3, 0),
        makeTimeline("timeline/fork", "Fork", false, 2, 1),
      ],
      get_graph: nodes,
      get_timeline_graph: nodes,
    });

    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(800);
    await snap(page, "5c-merge-commit");
  });

  test("5d — complex DAG: four branches, merges, remote refs", async ({ page }) => {
    nodeCounter = 0;
    const now = Date.now();
    const t = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    const nodes = [
      makeNode({ id: "r0", message: "Root", parents: [], timeline: "main", timestamp: t(120) }),
      makeNode({ id: "m1", message: "Main: Setup project", parents: ["r0"], timeline: "main", timestamp: t(100) }),
      makeNode({ id: "m2", message: "Main: Add sketches", parents: ["m1"], timeline: "main", timestamp: t(80), is_remote_tip: true }),
      // Feature A branches from m1
      makeNode({ id: "a1", message: "Feature A: Draft intro", parents: ["m1"], timeline: "timeline/feature-a", lane: 1, timestamp: t(90) }),
      makeNode({ id: "a2", message: "Feature A: Polish", parents: ["a1"], timeline: "timeline/feature-a", lane: 1, timestamp: t(70) }),
      // Feature B branches from m2
      makeNode({ id: "b1", message: "Feature B: New flow", parents: ["m2"], timeline: "timeline/feature-b", lane: 2, timestamp: t(60) }),
      makeNode({ id: "b2", message: "Feature B: Screenshots", parents: ["b1"], timeline: "timeline/feature-b", lane: 2, timestamp: t(40), is_branch_tip: true }),
      // Merge Feature A back into main
      makeNode({ id: "m3", message: "Merge Feature A into main", parents: ["m2", "a2"], timeline: "main", timestamp: t(50) }),
      // Hotfix branches from m3
      makeNode({ id: "h1", message: "Hotfix: Fix typo", parents: ["m3"], timeline: "timeline/hotfix", lane: 3, timestamp: t(30), is_branch_tip: true }),
      // Main continues
      makeNode({ id: "m4", message: "Main: Final review", parents: ["m3"], timeline: "main", is_head: true, is_branch_tip: true, timestamp: t(10) }),
    ];

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 5, 0),
        makeTimeline("timeline/feature-a", "Feature A", false, 2, 1),
        makeTimeline("timeline/feature-b", "Feature B", false, 2, 2),
        makeTimeline("timeline/hotfix", "Hotfix", false, 1, 3),
      ],
      get_graph: nodes,
      get_timeline_graph: nodes,
    });

    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(800);
    await snap(page, "5d-complex-dag-four-branches");
  });

  test("5e — horizontal mode toggle", async ({ page }) => {
    nodeCounter = 0;
    const nodes = [
      makeNode({ id: "c1", message: "Start", parents: [], timeline: "main", timestamp: "2025-01-15T09:00:00Z" }),
      makeNode({ id: "c2", message: "Work A", parents: ["c1"], timeline: "main", timestamp: "2025-01-15T10:00:00Z" }),
      makeNode({ id: "c3", message: "Fork", parents: ["c1"], timeline: "timeline/fork", lane: 1, timestamp: "2025-01-15T10:30:00Z" }),
      makeNode({ id: "c4", message: "Main continues", parents: ["c2"], timeline: "main", is_head: true, is_branch_tip: true, timestamp: "2025-01-15T11:00:00Z" }),
      makeNode({ id: "c5", message: "Fork continues", parents: ["c3"], timeline: "timeline/fork", lane: 1, is_branch_tip: true, timestamp: "2025-01-15T11:30:00Z" }),
    ];

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 3, 0),
        makeTimeline("timeline/fork", "Fork", false, 2, 1),
      ],
      get_graph: nodes,
      get_timeline_graph: nodes,
    });

    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(800);

    // Toggle to horizontal
    const horizontalToggle = page.locator('button:has-text("↔"), button:has-text("Horizontal"), button[title*="horizontal"]');
    if (await horizontalToggle.count() > 0) {
      await horizontalToggle.first().click();
      await page.waitForTimeout(500);
    }
    await snap(page, "5e-horizontal-mode");
  });
});

// ══════════════════════════════════════════════════════════════
//  TEST SUITE 6: Edge cases and weird scenarios
// ══════════════════════════════════════════════════════════════

test.describe("Edge Cases", () => {
  test.beforeEach(async ({ page }) => {
    nodeCounter = 0;
    await setupApp(page);
  });

  test("6a — empty project: no snapshots, graph empty", async ({ page }) => {
    await setOverrides(page, {
      list_versions: [],
      list_timelines: [makeTimeline("main", "Main", true, 0, 0)],
      get_graph: [],
      get_timeline_graph: [],
    });
    await snap(page, "6a-empty-project");
  });

  test("6b — single commit: HEAD is root and tip simultaneously", async ({ page }) => {
    nodeCounter = 0;
    const nodes = [
      makeNode({ id: "only", message: "First and only", parents: [], timeline: "main", is_head: true, is_branch_tip: true, timestamp: "2025-01-15T10:00:00Z" }),
    ];

    await setOverrides(page, {
      list_timelines: [makeTimeline("main", "Main", true, 1, 0)],
      get_graph: nodes,
      get_timeline_graph: nodes,
    });

    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(800);
    await snap(page, "6b-single-commit");
  });

  test("6c — many branches: 6 timelines stress test", async ({ page }) => {
    nodeCounter = 0;
    const now = Date.now();
    const t = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

    const root = makeNode({ id: "root", message: "Root", parents: [], timeline: "main", timestamp: t(300) });
    const m1 = makeNode({ id: "m1", message: "Main v1", parents: ["root"], timeline: "main", timestamp: t(250) });

    const branches = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const allNodes = [root, m1];

    branches.forEach((name, i) => {
      allNodes.push(makeNode({
        id: `${name}-1`,
        message: `${name}: start`,
        parents: ["m1"],
        timeline: `timeline/${name}`,
        lane: i + 1,
        timestamp: t(200 - i * 30),
      }));
      allNodes.push(makeNode({
        id: `${name}-2`,
        message: `${name}: progress`,
        parents: [`${name}-1`],
        timeline: `timeline/${name}`,
        lane: i + 1,
        is_branch_tip: true,
        timestamp: t(100 - i * 15),
      }));
    });

    // Main continues
    allNodes.push(makeNode({
      id: "m2",
      message: "Main v2",
      parents: ["m1"],
      timeline: "main",
      is_head: true,
      is_branch_tip: true,
      timestamp: t(50),
    }));

    const timelines = [
      makeTimeline("main", "Main", true, 3, 0),
      ...branches.map((name, i) => makeTimeline(`timeline/${name}`, name.charAt(0).toUpperCase() + name.slice(1), false, 2, i + 1)),
    ];

    await setOverrides(page, {
      list_timelines: timelines,
      get_graph: allNodes,
      get_timeline_graph: allNodes,
    });

    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(1000);
    await snap(page, "6c-six-branches-stress");
  });

  test("6d — deep chain: 20 commits on one branch", async ({ page }) => {
    nodeCounter = 0;
    const now = Date.now();
    const nodes = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(makeNode({
        id: `c${i}`,
        message: `Commit ${i + 1}: Step ${i + 1}`,
        parents: i === 0 ? [] : [`c${i - 1}`],
        timeline: "main",
        is_head: i === 19,
        is_branch_tip: i === 19,
        timestamp: new Date(now - (20 - i) * 600_000).toISOString(),
      }));
    }

    await setOverrides(page, {
      list_timelines: [makeTimeline("main", "Main", true, 20, 0)],
      get_graph: nodes,
      get_timeline_graph: nodes,
    });

    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(1000);
    await snap(page, "6d-deep-chain-20-commits");
  });

  test("6e — diamond merge: branch and re-merge", async ({ page }) => {
    nodeCounter = 0;
    // A → B → D (main)
    //   ↘ C ↗   (fork)
    const nodes = [
      makeNode({ id: "A", message: "Root", parents: [], timeline: "main", timestamp: "2025-01-15T09:00:00Z" }),
      makeNode({ id: "B", message: "Main work", parents: ["A"], timeline: "main", timestamp: "2025-01-15T10:00:00Z" }),
      makeNode({ id: "C", message: "Fork work", parents: ["A"], timeline: "timeline/fork", lane: 1, timestamp: "2025-01-15T10:30:00Z" }),
      makeNode({ id: "D", message: "Diamond merge", parents: ["B", "C"], timeline: "main", is_head: true, is_branch_tip: true, timestamp: "2025-01-15T11:00:00Z" }),
    ];

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 3, 0),
        makeTimeline("timeline/fork", "Fork", false, 1, 1),
      ],
      get_graph: nodes,
      get_timeline_graph: nodes,
    });

    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(800);
    await snap(page, "6e-diamond-merge");
  });

  test("6f — octopus: merge commit with 3 parents (exotic)", async ({ page }) => {
    nodeCounter = 0;
    const nodes = [
      makeNode({ id: "root", message: "Root", parents: [], timeline: "main", timestamp: "2025-01-15T09:00:00Z" }),
      makeNode({ id: "a1", message: "Branch A", parents: ["root"], timeline: "timeline/a", lane: 1, timestamp: "2025-01-15T10:00:00Z" }),
      makeNode({ id: "b1", message: "Branch B", parents: ["root"], timeline: "timeline/b", lane: 2, timestamp: "2025-01-15T10:30:00Z" }),
      makeNode({ id: "m1", message: "Main work", parents: ["root"], timeline: "main", timestamp: "2025-01-15T11:00:00Z" }),
      makeNode({ id: "octopus", message: "Merge A + B into main", parents: ["m1", "a1", "b1"], timeline: "main", is_head: true, is_branch_tip: true, timestamp: "2025-01-15T12:00:00Z" }),
    ];

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", true, 3, 0),
        makeTimeline("timeline/a", "Branch A", false, 1, 1),
        makeTimeline("timeline/b", "Branch B", false, 1, 2),
      ],
      get_graph: nodes,
      get_timeline_graph: nodes,
    });

    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(800);
    await snap(page, "6f-octopus-merge-3-parents");
  });
});

// ══════════════════════════════════════════════════════════════
//  TEST SUITE 7: Snapshot sidebar with branch ancestry
// ══════════════════════════════════════════════════════════════

test.describe("Snapshot Sidebar — Branch Ancestry", () => {
  test.beforeEach(async ({ page }) => {
    nodeCounter = 0;
    await setupApp(page);
  });

  test("7a — sidebar shows ancestor commits in different color", async ({ page }) => {
    nodeCounter = 0;
    const nodes = [
      makeNode({ id: "m1", message: "Shared ancestor 1", parents: [], timeline: "main", timestamp: "2025-01-15T09:00:00Z" }),
      makeNode({ id: "m2", message: "Shared ancestor 2", parents: ["m1"], timeline: "main", timestamp: "2025-01-15T10:00:00Z" }),
      makeNode({ id: "f1", message: "Fork commit 1", parents: ["m2"], timeline: "timeline/fork", lane: 1, timestamp: "2025-01-15T11:00:00Z" }),
      makeNode({ id: "f2", message: "Fork commit 2", parents: ["f1"], timeline: "timeline/fork", lane: 1, is_head: true, is_branch_tip: true, timestamp: "2025-01-15T12:00:00Z" }),
    ];

    await setOverrides(page, {
      list_timelines: [
        makeTimeline("main", "Main", false, 2, 0),
        makeTimeline("timeline/fork", "My Fork", true, 2, 1),
      ],
      get_graph: nodes,
      get_timeline_graph: nodes,
      list_versions: [
        { id: "f2", message: "Fork commit 2", timestamp: "2025-01-15T12:00:00Z", summary: "" },
        { id: "f1", message: "Fork commit 1", timestamp: "2025-01-15T11:00:00Z", summary: "" },
        { id: "m2", message: "Shared ancestor 2", timestamp: "2025-01-15T10:00:00Z", summary: "" },
        { id: "m1", message: "Shared ancestor 1", timestamp: "2025-01-15T09:00:00Z", summary: "" },
      ],
    });
    await snap(page, "7a-sidebar-ancestry-colors");
  });
});

// ══════════════════════════════════════════════════════════════
//  TEST SUITE 8: Settings repository tab
// ══════════════════════════════════════════════════════════════

test.describe("Settings — Repository", () => {
  test("8a — repository tab: auth methods and fields", async ({ page }) => {
    nodeCounter = 0;
    await page.goto("/");
    await page.waitForSelector("#root", { timeout: 10_000 });
    await page.getByText("mock-project", { exact: true }).click();
    await page.waitForTimeout(600);
    await page.getByText("Demo Introduction").first().click();
    await page.waitForTimeout(400);

    // Open settings via nav button
    await page.getByRole("button", { name: "Settings" }).click();
    await page.waitForTimeout(500);

    // Click Repository tab
    const repoTab = page.getByRole("button", { name: /Repository/i });
    if (await repoTab.count() > 0) {
      await repoTab.click();
      await page.waitForTimeout(300);
    }

    await snap(page, "8a-settings-repository");
  });
});
