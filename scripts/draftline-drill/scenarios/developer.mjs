// A developer keeps using git in the same checkout while CutReady is open.
import { join } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { git, gitChanges, gitTry, read, sketch, write } from "../fixtures.mjs";
import { delay, killTrees } from "../app.mjs";
import { edit, openHybrid, save, startVariation } from "./hybrid.mjs";

export default [
  {
    id: "D01",
    group: "developer",
    title: "Developer's uncommitted code is invisible to save and discard",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      write(join(fx.repo, "src", "app.rs"), "fn main() { /* wip */ }\n");
      write(join(fx.repo, "src", "new.rs"), "// untracked\n");
      await ctx.refresh();
      ctx.check(!(await ctx.state("isDirty")).isDirty, "code changes don't dirty CutReady");
      await edit(ctx, fx, "intro.sk", sketch("Mine"));
      await save(ctx, "Mine");
      const files = git(fx.repo, "show", "--name-only", "--format=", "HEAD");
      ctx.check(!files.includes("src/"), "save excludes code", files);
      await edit(ctx, fx, "intro.sk", sketch("Throwaway"));
      await ctx.act("discardChanges");
      ctx.check(read(join(fx.repo, "src", "app.rs")) === "fn main() { /* wip */ }\n", "discard leaves code WIP alone");
      ctx.check(existsSync(join(fx.repo, "src", "new.rs")), "discard leaves untracked code alone");
      ctx.check(read(join(fx.folder, "intro.sk")) === sketch("Mine"), "discard reset the folder");
    },
  },
  {
    id: "D02",
    group: "developer",
    title: "Developer's staged index survives a CutReady save",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      write(join(fx.repo, "src", "staged.rs"), "// staged\n");
      git(fx.repo, "add", "src/staged.rs");
      await edit(ctx, fx, "intro.sk", sketch("Saved"));
      await save(ctx, "Saved while dev staged");
      const committed = git(fx.repo, "show", "--name-only", "--format=", "HEAD");
      ctx.check(!committed.includes("staged.rs"), "staged code not committed", committed);
      const staged = git(fx.repo, "diff", "--cached", "--name-only");
      ctx.check(staged === "src/staged.rs", "index still stages the developer's file", staged);
    },
  },
  {
    id: "D03",
    group: "developer",
    title: "Developer switches branches behind CutReady's back",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      git(fx.repo, "checkout", "-q", "-b", "feature/login");
      write(join(fx.folder, "intro.sk"), sketch("On feature"));
      await ctx.refresh();
      ctx.check((await ctx.activeTimeline()) === "feature/login", "app follows the developer's branch", await ctx.activeTimeline());
      await save(ctx, "Saved on feature");
      ctx.check(git(fx.repo, "log", "-1", "--format=%s", "feature/login").includes("Saved on feature"), "save landed on the checked-out branch");
      ctx.check(git(fx.repo, "log", "-1", "--format=%s", "main") === "Init", "main untouched");
    },
  },
  {
    id: "D04",
    group: "developer",
    title: "Detached HEAD: saving never loses work",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      git(fx.repo, "checkout", "-q", "--detach");
      await edit(ctx, fx, "intro.sk", sketch("Detached"));
      const result = await ctx.act("saveVersion", "Detached save");
      ctx.note(`detached save → ${result.ok ? "ok" : JSON.stringify(result.error)}`);
      const toasts = await ctx.toasts();
      ctx.check(read(join(fx.folder, "intro.sk")) === sketch("Detached"), "edit still on disk");
      if (result.ok) {
        const reachable = gitTry(fx.repo, "branch", "--contains", "HEAD").out;
        ctx.check(reachable.length > 0, "detached save is reachable from a branch", reachable);
      } else {
        ctx.check(Boolean(result.error?.message), "refusal explains itself", { result, toasts });
      }
    },
  },
  {
    id: "D05",
    group: "developer",
    title: "index.lock held by git: save refuses cleanly, then succeeds",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("Locked"));
      const lock = join(fx.repo, ".git", "index.lock");
      write(lock, "");
      const head = git(fx.repo, "rev-parse", "HEAD");
      const refused = await ctx.act("saveVersion", "While locked");
      ctx.check(!refused.ok, "save refused while git is busy");
      ctx.check(/busy|lock/i.test(String(refused.error?.message)), "message says git is busy", refused.error);
      ctx.check(git(fx.repo, "rev-parse", "HEAD") === head, "nothing committed");
      ctx.check(existsSync(lock), "git's lock left alone");
      rmSync(lock);
      await save(ctx, "After unlock");
    },
  },
  {
    id: "D06",
    group: "developer",
    title: "Concurrent developer git commands during saves",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      const tally = join(ctx.root, "hammer.json");
      const stopFile = join(ctx.root, "hammer.stop");
      const script = `
        const { spawnSync } = require("node:child_process");
        const fs = require("node:fs");
        let runs = 0, failures = 0;
        while (!fs.existsSync(${JSON.stringify(stopFile)})) {
          const r = spawnSync("git", ["status", "--porcelain"], { cwd: ${JSON.stringify(fx.repo)} });
          runs += 1; if (r.status !== 0) failures += 1;
        }
        fs.writeFileSync(${JSON.stringify(tally)}, JSON.stringify({ runs, failures }));`;
      const hammer = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
      const done = new Promise((resolve) => { hammer.on("exit", resolve); hammer.on("error", resolve); });
      const errors = [];
      try {
        for (let i = 0; i < 10; i += 1) {
          write(join(fx.folder, "intro.sk"), sketch(`Round ${i}`));
          await ctx.refresh();
          const result = await ctx.act("saveVersion", `Round ${i}`);
          if (!result.ok) errors.push(result.error?.message);
        }
      } finally {
        write(stopFile, "");
        const exited = await Promise.race([done.then(() => true), delay(30_000).then(() => false)]);
        if (!exited) killTrees([hammer.pid]);
      }
      const { runs, failures } = JSON.parse(read(tally));
      ctx.note(`${runs} concurrent git status runs`);
      ctx.check(errors.every((m) => /busy|lock/i.test(String(m))), "only clean busy refusals", errors);
      ctx.check(failures === 0, "developer git never failed", failures);
      if (errors.length) {
        await ctx.refresh();
        await save(ctx, "After hammer");
      }
      ctx.check(read(join(fx.folder, "intro.sk")) === sketch("Round 9"), "last edit kept");
      ctx.check(gitChanges(fx.repo).length === 0, "repo clean once saves land", gitChanges(fx.repo));
      ctx.check(gitTry(fx.repo, "fsck", "--no-progress").ok, "repository passes fsck");
    },
  },
  {
    id: "D07",
    group: "developer",
    title: "Developer commits inside the folder while the app is open",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      write(join(fx.folder, "planning.md"), "# Planning\n\nDeveloper edit.\n");
      git(fx.repo, "commit", "-qam", "Dev touches the demo");
      await ctx.refresh();
      const s = await ctx.state("isDirty", "versions");
      ctx.check(!s.isDirty, "clean after an external commit");
      ctx.check(s.versions[0]?.message?.includes("Dev touches the demo"), "external commit shows in history", s.versions[0]);
      const name = await startVariation(ctx, "after-dev");
      ctx.check(String(name).startsWith("cutready/"), "variation started", name);
      ctx.check(read(join(fx.folder, "planning.md")).includes("Developer edit"), "variation starts from the developer's commit");
    },
  },
];
