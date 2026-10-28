// Hybrid projects: a CutReady folder inside a developer's code repository.
import { join } from "node:path";
import { git, gitChanges, gitTry, hybrid, devCommit, read, remoteFile, sketch, standalone, write } from "../fixtures.mjs";

export async function openHybrid(ctx, options) {
  const fx = hybrid(ctx.root, options);
  const state = await ctx.open(fx.folder);
  ctx.require(state.currentProject && !state.error, "hybrid project opens", state.error);
  return { fx, state };
}

export async function save(ctx, label) {
  const result = await ctx.act("saveVersion", label);
  ctx.check(result.ok, `save "${label}" succeeds`, result.error);
  return result;
}

export async function edit(ctx, fx, rel, content) {
  write(join(fx.folder, rel), content);
  await ctx.refresh();
}

/** Start and switch to a CutReady variation; returns its real (namespaced) name. */
export async function startVariation(ctx, label) {
  const { versions } = await ctx.state("versions");
  const created = await ctx.act("startTimelineFromSnapshot", versions[0].id, label);
  ctx.require(created.ok, `variation ${label} started`, created.error);
  return ctx.activeTimeline();
}

const remoteBranches = (remote) => git(remote, `--git-dir=${remote}`, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean);

export default [
  {
    id: "H01",
    group: "hybrid",
    title: "Open a folder inside a code repo as a hybrid project",
    async run(ctx) {
      const { fx, state } = await openHybrid(ctx);
      ctx.check(state.currentProject.hybrid === true, "hybrid detected", state.currentProject);
      ctx.check(state.currentRemote?.name === "origin", "origin detected", state.currentRemote);
      ctx.check(JSON.parse(read(join(fx.repo, ".draftline")) ?? "{}").folder === "cutready", "marker names the folder");
      ctx.check(!state.isDirty, "clean after open");
      ctx.check(!gitTry(fx.repo, "rev-parse", "--verify", "-q", "refs/heads/cutready").ok, "no stray branch created on open");
    },
  },
  {
    id: "H02",
    group: "hybrid",
    title: "Saves commit only the folder (plus marker) on the checked-out branch",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("Hybrid intro"));
      await save(ctx, "Hybrid save");
      const files = git(fx.repo, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();
      ctx.check(JSON.stringify(files) === JSON.stringify([".draftline", "cutready/intro.sk"]), "commit has folder + marker only", files);
      ctx.check(git(fx.repo, "branch", "--show-current") === "main", "still on the developer's branch");
      ctx.check(git(fx.repo, "status", "--porcelain") === "", "repo clean");
      const runtime = join(fx.repo, ".git", "cutready", "cutready");
      ctx.check(!gitTry(fx.repo, "ls-files", "--error-unmatch", ".git/cutready").ok, "runtime state not tracked", runtime);
    },
  },
  {
    id: "H03",
    group: "hybrid",
    title: "A second CutReady folder in the same repo is refused",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("Claim"));
      await save(ctx, "Claim folder");
      write(join(fx.repo, "other", "x.sk"), sketch("Other"));
      const before = git(fx.repo, "rev-parse", "HEAD");
      const state = await ctx.open(join(fx.repo, "other"));
      ctx.check(Boolean(state.error), "open refused", state);
      ctx.check(/cutready/i.test(String(state.error)), "message points to the real folder", state.error);
      ctx.check(git(fx.repo, "rev-parse", "HEAD") === before, "nothing committed");
      ctx.check(JSON.parse(read(join(fx.repo, ".draftline"))).folder === "cutready", "marker unchanged");
    },
  },
  {
    id: "H04",
    group: "hybrid",
    title: "Invalid and newer-format markers refuse to open without rewriting",
    async run(ctx) {
      const broken = hybrid(join(ctx.root, "broken"), { marker: "not json" });
      let state = await ctx.open(broken.folder);
      ctx.check(Boolean(state.error), "broken marker refused", state);
      ctx.check(read(join(broken.repo, ".draftline")) === "not json", "broken marker untouched");
      const newer = hybrid(join(ctx.root, "newer"), { marker: "{\"format\": 99, \"folder\": \"cutready\"}\n" });
      state = await ctx.open(newer.folder);
      ctx.check(Boolean(state.error), "newer marker refused", state);
      ctx.check(/newer/i.test(String(state.error)), "message says newer version", state.error);
      ctx.check(read(join(newer.repo, ".draftline")).includes("99"), "newer marker untouched");
    },
  },
  {
    id: "H05",
    group: "hybrid",
    title: "A developer renamed the folder: old path points to the new one, new path adopts its history",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("Before rename"));
      await save(ctx, "Before rename");
      const saved = git(fx.repo, "rev-parse", "HEAD");
      await ctx.open(standalone(join(ctx.root, "park")).folder); // let go of the folder before git moves it
      git(fx.repo, "mv", "cutready", "showcase");
      git(fx.repo, "commit", "-qm", "Rename demo folder");
      const head = git(fx.repo, "rev-parse", "HEAD");

      let state = await ctx.open(fx.folder);
      ctx.check(/moved to .*showcase/i.test(String(state.error)), "old path says where it moved", state.error);
      ctx.check(JSON.parse(read(join(fx.repo, ".draftline"))).folder === "cutready", "old path leaves the marker alone");

      state = await ctx.open(join(fx.repo, "showcase"));
      ctx.check(!state.error && state.currentProject?.hybrid, "new path opens as hybrid", state.error);
      ctx.check(JSON.parse(read(join(fx.repo, ".draftline"))).folder === "showcase", "marker re-pointed");
      ctx.check(git(fx.repo, "rev-parse", "HEAD") === head, "open adds no commit");
      ctx.check(gitTry(fx.repo, "merge-base", "--is-ancestor", saved, "HEAD").ok, "earlier save still in history");
      ctx.check(read(join(fx.repo, "showcase", "intro.sk")) === sketch("Before rename"), "content intact");
      ctx.check(gitChanges(fx.repo).map((l) => l.trim()).join() === "M .draftline", "only the marker is pending", gitChanges(fx.repo));
      await edit(ctx, { ...fx, folder: join(fx.repo, "showcase") }, "intro.sk", sketch("After rename"));
      await save(ctx, "After rename");
      ctx.check(git(fx.repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort().join() === ".draftline,showcase/intro.sk", "next save commits marker and edit");
      ctx.check(gitChanges(fx.repo).length === 0, "clean after save", gitChanges(fx.repo));
    },
  },
  {
    id: "H06",
    group: "hybrid",
    title: "Send for review to a non-GitHub remote fails without pushing",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("Send me"));
      await save(ctx, "Ready for review");
      await ctx.act("pushToRemote");
      const prompt = await ctx.state("sendForReviewPrompt");
      ctx.check(Boolean(prompt.sendForReviewPrompt), "publish opens the Send for review prompt", prompt);
      const before = remoteBranches(fx.remote);
      await ctx.act("sendForReview", "Drill review");
      const s = await ctx.state("syncError", "isSyncing");
      ctx.check(Boolean(s.syncError), "send reports an error", s);
      ctx.check(JSON.stringify(remoteBranches(fx.remote)) === JSON.stringify(before), "nothing pushed", remoteBranches(fx.remote));
      ctx.check(remoteFile(fx.remote, "main", "cutready/intro.sk") === sketch("Intro").trim(), "base untouched on remote");
    },
  },
  {
    id: "H07",
    group: "hybrid",
    title: "Variations live in the cutready/ namespace",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      const name = await startVariation(ctx, "narration");
      ctx.check(String(name).startsWith("cutready/"), "variation is namespaced", name);
      ctx.check(git(fx.repo, "branch", "--show-current") === name, "repo checked out on the variation");
      await edit(ctx, fx, "intro.sk", sketch("Narration pass"));
      await save(ctx, "Narration");
      const switched = await ctx.act("switchTimeline", "main");
      ctx.check(switched.ok, "switch back to main", switched.error);
      ctx.check(read(join(fx.folder, "intro.sk")) === sketch("Intro"), "main content restored");
      ctx.check(read(join(fx.repo, "src", "app.rs")) === "fn main() {}\n", "code untouched by switch");
    },
  },
  {
    id: "H08",
    group: "hybrid",
    title: "Get updates from main: clean merge brings developer code in",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      await startVariation(ctx, "updates");
      await edit(ctx, fx, "intro.sk", sketch("Variation"));
      await save(ctx, "Variation work");
      devCommit(fx, "src/app.rs", "fn main() { println!(\"v2\"); }\n");
      await ctx.toasts();
      await ctx.act("getUpdatesFromBase");
      const s = await ctx.state("syncError", "isMerging");
      ctx.check(!s.syncError && !s.isMerging, "clean merge", s);
      ctx.check(read(join(fx.repo, "src", "app.rs")).includes("v2"), "developer code merged in");
      ctx.check(read(join(fx.folder, "intro.sk")) === sketch("Variation"), "CutReady work kept");
      ctx.check((await ctx.toasts()).some((t) => /brought in/i.test(t.message)), "success toast");
      await ctx.act("getUpdatesFromBase");
      ctx.check((await ctx.toasts()).some((t) => /up to date/i.test(t.message)), "second run says up to date");
    },
  },
  {
    id: "H09",
    group: "hybrid",
    title: "Get updates from main: conflict inside the folder opens resolution",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      await startVariation(ctx, "conflict-in");
      await edit(ctx, fx, "planning.md", "# Planning\n\nOurs.\n");
      await save(ctx, "Ours");
      devCommit(fx, "cutready/planning.md", "# Planning\n\nTheirs.\n");
      await ctx.act("getUpdatesFromBase");
      const s = await ctx.state("isMerging", "mergeConflicts", "syncError");
      ctx.check(s.isMerging, "merge mode entered", s.syncError);
      ctx.check(s.mergeConflicts?.some((c) => String(c.path).endsWith("planning.md")), "planning.md in conflict", s.mergeConflicts);
      if (s.isMerging) {
        const resolved = await ctx.act("applyMergeResolution", s.mergeConflicts.map((c) => ({ path: c.path, content: "# Planning\n\nBoth.\n" })));
        ctx.check(resolved.ok, "resolution applied", resolved.error);
        ctx.check(read(join(fx.folder, "planning.md")) === "# Planning\n\nBoth.\n", "resolved content on disk");
        ctx.check(git(fx.repo, "status", "--porcelain") === "", "repo clean after merge");
      }
    },
  },
  {
    id: "H10",
    group: "hybrid",
    title: "Get updates from main: conflict outside the folder needs a developer",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      const name = await startVariation(ctx, "conflict-out");
      write(join(fx.repo, "src", "app.rs"), "fn main() { /* branch */ }\n");
      git(fx.repo, "commit", "-qam", "Developer edit on the CutReady branch");
      devCommit(fx, "src/app.rs", "fn main() { /* main */ }\n");
      const head = git(fx.repo, "rev-parse", "HEAD");
      await ctx.act("getUpdatesFromBase");
      const s = await ctx.state("syncError", "isMerging");
      ctx.check(/developer/i.test(String(s.syncError)), "asks for a developer", s);
      ctx.check(!s.isMerging, "no merge UI for code conflicts");
      ctx.check(git(fx.repo, "rev-parse", "HEAD") === head, "branch not moved");
      ctx.check(git(fx.repo, "branch", "--show-current") === name, "still on the variation");
      ctx.check(gitChanges(fx.repo).length === 0, "repo clean (marker pending first save)", gitChanges(fx.repo));
    },
  },
  {
    id: "H11",
    group: "hybrid",
    title: "Standalone-only flows are refused in hybrid projects",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("Direct"));
      await save(ctx, "Direct");
      const before = remoteBranches(fx.remote);
      await ctx.act("publishTimeline");
      ctx.check(Boolean((await ctx.state("sendForReviewPrompt")).sendForReviewPrompt), "publish routes to Send for review");
      await ctx.act("cancelSendForReview");
      ctx.check(remoteFile(fx.remote, "main", "cutready/intro.sk") === sketch("Intro").trim(), "main not pushed directly");
      ctx.check(JSON.stringify(remoteBranches(fx.remote)) === JSON.stringify(before), "no branches pushed");
    },
  },
];
