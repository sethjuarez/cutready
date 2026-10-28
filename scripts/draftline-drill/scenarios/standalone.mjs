// Standalone projects: the folder is its own repository.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { clone, devCommit, git, gitChanges, gitTry, read, remoteFile, remoteHasBranch, sketch, standalone, write } from "../fixtures.mjs";

async function openStandalone(ctx, options) {
  const fx = standalone(ctx.root, options);
  const state = await ctx.open(fx.folder);
  ctx.require(state.currentProject && !state.error, "project opens", state.error);
  return { fx, state };
}

async function save(ctx, label) {
  const result = await ctx.act("saveVersion", label);
  ctx.check(result.ok, `save "${label}" succeeds`, result.error);
  return result;
}

export default [
  {
    id: "S01",
    group: "standalone",
    title: "Open a standalone project with a remote",
    async run(ctx) {
      const { state } = await openStandalone(ctx);
      ctx.check(state.currentProject.hybrid !== true, "not hybrid");
      ctx.check(state.currentRemote?.name === "origin", "origin detected", state.currentRemote);
      ctx.check(state.timelines?.find((t) => t.is_active)?.name === "main", "main is active", state.timelines);
      ctx.check(state.isDirty === false, "clean after open", state.isDirty);
    },
  },
  {
    id: "S02",
    group: "standalone",
    title: "Edit, save, and leave git clean",
    async run(ctx) {
      const { fx } = await openStandalone(ctx);
      write(join(fx.folder, "intro.sk"), sketch("Intro v2"));
      write(join(fx.folder, "outro.sk"), sketch("Outro"));
      await ctx.refresh();
      const dirty = await ctx.state("isDirty", "changedFiles");
      ctx.check(dirty.isDirty, "edit makes the project dirty");
      ctx.check(dirty.changedFiles.length === 2, "two changed files listed", dirty.changedFiles);
      await save(ctx, "Second draft");
      const after = await ctx.state("isDirty", "versions");
      ctx.check(!after.isDirty, "clean after save");
      ctx.check(after.versions[0]?.message?.includes("Second draft"), "save is the newest version", after.versions[0]);
      ctx.check(git(fx.folder, "status", "--porcelain") === "", "git status clean");
      ctx.check(git(fx.folder, "log", "-1", "--format=%s").includes("Second draft"), "commit carries the label");
    },
  },
  {
    id: "S03",
    group: "standalone",
    title: "Discard all changes, including a new file",
    async run(ctx) {
      const { fx } = await openStandalone(ctx);
      const original = read(join(fx.folder, "intro.sk"));
      write(join(fx.folder, "intro.sk"), sketch("Scratch"));
      write(join(fx.folder, "scratch.md"), "# throwaway\n");
      await ctx.refresh();
      await ctx.act("discardChanges");
      ctx.check(read(join(fx.folder, "intro.sk")) === original, "edited file restored");
      ctx.check(!existsSync(join(fx.folder, "scratch.md")), "new file removed");
      const s = await ctx.state("isDirty");
      ctx.check(!s.isDirty, "clean after discard");
      ctx.check(gitChanges(fx.folder).length === 0, "git status clean (marker pending first save)", gitChanges(fx.folder));
    },
  },
  {
    id: "S04",
    group: "standalone",
    title: "Shelve and restore unsaved work",
    async run(ctx) {
      const { fx } = await openStandalone(ctx);
      const original = read(join(fx.folder, "intro.sk"));
      const edited = sketch("Shelved edit");
      write(join(fx.folder, "intro.sk"), edited);
      await ctx.refresh();
      await ctx.act("stashChanges");
      const shelved = await ctx.state("hasStash");
      ctx.check(shelved.hasStash, "shelf exists");
      ctx.check(read(join(fx.folder, "intro.sk")) === original, "working copy reset");
      await ctx.act("popStash");
      ctx.check(read(join(fx.folder, "intro.sk")) === edited, "edit restored from shelf");
      await ctx.act("checkStash");
      ctx.check(!(await ctx.state("hasStash")).hasStash, "shelf consumed");
    },
  },
  {
    id: "S05",
    group: "standalone",
    title: "Branch, switch, guard dirty switch, delete",
    async run(ctx) {
      const { fx } = await openStandalone(ctx);
      const { versions } = await ctx.state("versions");
      const created = await ctx.act("createTimeline", versions[0].id, "alt-take");
      ctx.require(created.ok, "branch created", created.error);
      const switched = await ctx.act("switchTimeline", "alt-take");
      ctx.check(switched.ok && (await ctx.activeTimeline()) === "alt-take", "switched to alt-take", switched.error);
      write(join(fx.folder, "intro.sk"), sketch("Alt intro"));
      await ctx.refresh();
      await save(ctx, "Alt intro");
      await ctx.act("switchTimeline", "main");
      ctx.check(read(join(fx.folder, "intro.sk")) === sketch("Intro"), "main content back after switch");
      write(join(fx.folder, "intro.sk"), sketch("Unsaved on main"));
      await ctx.refresh();
      await ctx.toasts();
      const refused = await ctx.act("switchTimeline", "alt-take");
      ctx.check(!refused.ok, "dirty switch refused");
      ctx.check(read(join(fx.folder, "intro.sk")) === sketch("Unsaved on main"), "unsaved edit untouched");
      ctx.check((await ctx.activeTimeline()) === "main", "still on main");
      await ctx.act("discardChanges");
      const deleted = await ctx.act("deleteTimeline", "alt-take");
      ctx.check(deleted.ok, "delete branch", deleted.error);
      ctx.check(!gitTry(fx.folder, "rev-parse", "--verify", "-q", "refs/heads/alt-take").ok, "branch gone from git");
    },
  },
  {
    id: "S06",
    group: "standalone",
    title: "Restore an old save as a new save",
    async run(ctx) {
      const { fx } = await openStandalone(ctx);
      write(join(fx.folder, "intro.sk"), sketch("v2"));
      await ctx.refresh();
      await save(ctx, "v2");
      const { versions } = await ctx.state("versions");
      const first = versions[versions.length - 1];
      const before = versions.length;
      await ctx.act("restoreSnapshotAsNewSave", first.id, "Back to start");
      const after = await ctx.state("versions", "isDirty");
      ctx.check(read(join(fx.folder, "intro.sk")) === sketch("Intro"), "content matches the old save");
      ctx.check(after.versions.length === before + 1, "restore added a save (history kept)", after.versions.length);
      ctx.check(!after.isDirty, "clean after restore");
    },
  },
  {
    id: "S07",
    group: "standalone",
    title: "Publish saves to the remote",
    async run(ctx) {
      const { fx } = await openStandalone(ctx);
      write(join(fx.folder, "intro.sk"), sketch("Published"));
      await ctx.refresh();
      await save(ctx, "Publish me");
      await ctx.act("refreshSyncStatus");
      ctx.check((await ctx.state("syncStatus")).syncStatus?.ahead === 1, "one save ahead");
      await ctx.act("pushToRemote");
      const s = await ctx.state("syncStatus", "syncError");
      ctx.check(!s.syncError, "no sync error", s.syncError);
      ctx.check(s.syncStatus?.ahead === 0, "nothing ahead after publish", s.syncStatus);
      ctx.check(remoteFile(fx.remote, "main", "intro.sk") === sketch("Published").trim(), "remote has the save");
    },
  },
  {
    id: "S08",
    group: "standalone",
    title: "Fetch and apply a collaborator's saves",
    async run(ctx) {
      const { fx } = await openStandalone(ctx);
      fx.dev = join(ctx.root, "collab");
      clone(fx.remote, fx.dev);
      devCommit(fx, "planning.md", "# Planning\n\nFrom a collaborator.\n");
      await ctx.act("fetchFromRemote");
      ctx.check((await ctx.state("syncStatus")).syncStatus?.behind === 1, "one save behind");
      await ctx.act("pullFromRemote");
      const s = await ctx.state("syncStatus", "syncError", "isDirty");
      ctx.check(!s.syncError, "no sync error", s.syncError);
      ctx.check(read(join(fx.folder, "planning.md")).includes("From a collaborator"), "collaborator change applied");
      ctx.check(s.syncStatus?.behind === 0, "caught up", s.syncStatus);
    },
  },
  {
    id: "S09",
    group: "standalone",
    title: "Merge diverged saves that don't conflict",
    async run(ctx) {
      const { fx } = await openStandalone(ctx);
      fx.dev = join(ctx.root, "collab");
      clone(fx.remote, fx.dev);
      devCommit(fx, "planning.md", "# Planning\n\nRemote line.\n");
      write(join(fx.folder, "intro.sk"), sketch("Local intro"));
      await ctx.refresh();
      await save(ctx, "Local work");
      await ctx.act("fetchFromRemote");
      await ctx.act("pullFromRemote");
      const s = await ctx.state("syncError", "isMerging", "syncStatus");
      ctx.check(!s.syncError, "no sync error", s.syncError);
      ctx.check(read(join(fx.folder, "planning.md")).includes("Remote line"), "remote change merged");
      ctx.check(read(join(fx.folder, "intro.sk")) === sketch("Local intro"), "local change kept");
      await ctx.act("pushToRemote");
      ctx.check(remoteFile(fx.remote, "main", "intro.sk") === sketch("Local intro").trim(), "merge published");
    },
  },
  {
    id: "S10",
    group: "standalone",
    title: "Conflicting incoming saves open conflict resolution",
    async run(ctx) {
      const { fx } = await openStandalone(ctx);
      fx.dev = join(ctx.root, "collab");
      clone(fx.remote, fx.dev);
      devCommit(fx, "planning.md", "# Planning\n\nTheirs.\n");
      write(join(fx.folder, "planning.md"), "# Planning\n\nOurs.\n");
      await ctx.refresh();
      await save(ctx, "Ours");
      await ctx.act("fetchFromRemote");
      await ctx.act("pullFromRemote");
      const s = await ctx.state("isMerging", "mergeConflicts", "syncError");
      ctx.check(s.isMerging, "merge mode entered", s.syncError);
      ctx.check(s.mergeConflicts?.some((c) => String(c.path).endsWith("planning.md")), "planning.md in conflict", s.mergeConflicts);
      ctx.check(read(join(fx.folder, "planning.md")) === "# Planning\n\nOurs.\n", "working file untouched before resolving");
      if (s.isMerging) {
        const resolved = await ctx.act("applyMergeResolution", s.mergeConflicts.map((c) => ({ path: c.path, content: "# Planning\n\nBoth.\n" })));
        ctx.check(resolved.ok, "resolution applied", resolved.error);
        ctx.check(read(join(fx.folder, "planning.md")) === "# Planning\n\nBoth.\n", "resolved content on disk");
        ctx.check(git(fx.folder, "status", "--porcelain") === "", "git status clean after merge");
      }
    },
  },
  {
    id: "S11",
    group: "standalone",
    title: "Publish a new branch and adopt a collaborator's branch",
    async run(ctx) {
      const { fx } = await openStandalone(ctx);
      const { versions } = await ctx.state("versions");
      await ctx.act("startTimelineFromSnapshot", versions[0].id, "director-cut");
      write(join(fx.folder, "intro.sk"), sketch("Director"));
      await ctx.refresh();
      await save(ctx, "Director cut");
      await ctx.act("publishTimeline");
      ctx.check(remoteHasBranch(fx.remote, "director-cut"), "branch published");
      fx.dev = join(ctx.root, "collab");
      clone(fx.remote, fx.dev);
      devCommit(fx, "planning.md", "# Review notes\n", "Review", "review-pass");
      await ctx.act("fetchFromRemote");
      const branches = await ctx.act("loadRemoteBranches");
      ctx.check(branches.value?.some((b) => b.name === "review-pass" || b.id === "review-pass"), "remote branch listed", branches.value);
      const adopted = await ctx.act("checkoutRemoteTimeline", "review-pass");
      ctx.check(adopted.ok, "adopt remote branch", adopted.error);
      ctx.check((await ctx.activeTimeline()) === "review-pass", "now on review-pass");
      ctx.check(read(join(fx.folder, "planning.md")) === "# Review notes\n", "adopted content on disk");
    },
  },
  {
    id: "S12",
    group: "standalone",
    title: "Local-only state never dirties the project",
    async run(ctx) {
      const { fx } = await openStandalone(ctx);
      write(join(fx.folder, ".chats", "old.json"), "{}");
      write(join(fx.folder, ".cutready", "recordings", "take1.txt"), "raw");
      await ctx.refresh();
      ctx.check(!(await ctx.state("isDirty")).isDirty, "excluded paths are not changes");
      write(join(fx.folder, "chat-artifacts", "promoted.cv"), "{\"title\":\"Promoted\"}\n");
      await ctx.refresh();
      const s = await ctx.state("changedFiles");
      ctx.check(s.changedFiles.some((f) => f.path.endsWith("promoted.cv")), ".cv chat artifact is tracked", s.changedFiles);
    },
  },
];
