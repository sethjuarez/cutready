// Folder moves and the full Send for review round trip.
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { fakeGitHub } from "../fakeGitHub.mjs";
import { devCommit, git, gitChanges, gitTry, hybrid, read, remoteFile, remoteHasBranch, sketch, standalone, write } from "../fixtures.mjs";
import { edit, openHybrid, save } from "./hybrid.mjs";

const marker = (repo) => JSON.parse(read(join(repo, ".draftline")) ?? "{}").folder;
const committedFiles = (repo) => git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();

/** Open an unrelated project so the app lets go of the folder before git moves it. */
async function park(ctx) {
  await ctx.open(standalone(join(ctx.root, "park")).folder);
}

/** After a move: the new path opens as hybrid with history, content, and a re-pointed marker. */
async function checkMoved(ctx, repo, folderRel, saved, content) {
  const head = git(repo, "rev-parse", "HEAD");
  const folder = join(repo, ...folderRel.split("/"));
  const state = await ctx.open(folder);
  ctx.require(!state.error && state.currentProject, "new path opens", state.error);
  ctx.check(state.currentProject.hybrid === true, "opens as hybrid", state.currentProject);
  ctx.check(marker(repo) === folderRel, `marker names ${folderRel}`, marker(repo));
  ctx.check(git(repo, "rev-parse", "HEAD") === head, "open adds no commit");
  ctx.check(gitTry(repo, "merge-base", "--is-ancestor", saved, "HEAD").ok, "earlier save still in history");
  ctx.check(read(join(folder, "intro.sk")) === content, "content intact");
  const { versions } = await ctx.state("versions");
  ctx.check(versions?.some((v) => v.id === saved || v.message?.includes("Before move")), "earlier save listed in versions", versions?.slice(0, 5));
  await edit(ctx, { folder }, "intro.sk", sketch("After move"));
  await save(ctx, "After move");
  const files = committedFiles(repo);
  ctx.check(files.every((f) => f === ".draftline" || f.startsWith(`${folderRel}/`)), "save commits only the moved folder (plus marker)", files);
  ctx.check(git(repo, "status", "--porcelain") === "", "repo clean after save", git(repo, "status", "--porcelain"));
  return folder;
}

/** In debug drills a local bare remote named `github.git` stands in for GitHub repo `drill/<scenario>`. */
async function openGitHubHybrid(ctx) {
  const fx = hybrid(ctx.root, { remoteName: "github.git" });
  const state = await ctx.open(fx.folder);
  ctx.require(state.currentProject && !state.error, "hybrid project opens", state.error);
  return { ...fx, owner: "drill", name: basename(ctx.root).toLowerCase() };
}

async function send(ctx, title) {
  await ctx.toasts();
  await ctx.act("pushToRemote");
  const { sendForReviewPrompt } = await ctx.state("sendForReviewPrompt");
  ctx.require(Boolean(sendForReviewPrompt), "publish opens the Send for review prompt", sendForReviewPrompt);
  await ctx.act("sendForReview", title);
  const s = await ctx.state("syncError", "shareUrl");
  ctx.check(!s.syncError, `send "${title}" succeeds`, s.syncError);
  return { ...s, toasts: await ctx.toasts() };
}

export default [
  {
    id: "M01",
    group: "moves",
    title: "Root to subfolder: a standalone project moved into cutready/ when code joins the repo",
    async run(ctx) {
      const fx = standalone(ctx.root);
      let state = await ctx.open(fx.folder);
      ctx.require(!state.error && state.currentProject, "standalone project opens", state.error);
      ctx.check(state.currentProject.hybrid !== true, "starts standalone");
      write(join(fx.folder, "intro.sk"), sketch("Before move"));
      await ctx.refresh();
      await save(ctx, "Before move");
      const saved = git(fx.folder, "rev-parse", "HEAD");
      ctx.note(`root marker: ${read(join(fx.folder, ".draftline"))?.trim() ?? "(none)"}`);
      await park(ctx);

      // The developer restructures by hand: everything CutReady moves into cutready/, code goes at the root.
      const sub = join(fx.folder, "cutready");
      mkdirSync(sub);
      for (const entry of readdirSync(fx.folder)) {
        if ([".git", ".draftline", "cutready"].includes(entry)) continue;
        renameSync(join(fx.folder, entry), join(sub, entry));
      }
      write(join(fx.folder, "src", "app.rs"), "fn main() {}\n");
      write(join(fx.folder, "README.md"), "# Contoso\n");
      git(fx.folder, "add", "-A");
      git(fx.folder, "commit", "-qm", "Move demo into cutready/ and add code");

      state = await ctx.open(fx.folder);
      const prompt = state.adoptionPrompt;
      ctx.check(prompt?.movedTo === "cutready", "old root asks to open cutready/ or keep the root", prompt ?? state.error ?? state.currentProject?.root);
      ctx.check(state.currentProject?.repo_root !== fx.folder, "old root isn't opened silently", state.currentProject?.repo_root);
      // Keeping the root is allowed and changes nothing; asking again on the next open is fine.
      state = await ctx.resolvePrompt("adopt");
      ctx.check(!state.error && state.currentProject && marker(fx.folder) === ".", "keeping the root opens it unchanged", state.error ?? marker(fx.folder));
      ctx.check(git(fx.folder, "status", "--porcelain") === "", "keeping the root leaves git clean", git(fx.folder, "status", "--porcelain"));
      state = await ctx.open(fx.folder);
      ctx.require(state.adoptionPrompt?.movedTo === "cutready", "root still offers the move", state.adoptionPrompt ?? state.error);
      state = await ctx.resolvePrompt("create");
      ctx.check(!state.error && state.currentProject?.hybrid === true, "choosing cutready/ opens it as hybrid", state.error ?? state.currentProject);
      await checkMoved(ctx, fx.folder, "cutready", saved, sketch("Before move"));
      ctx.check(read(join(fx.folder, "src", "app.rs")) === "fn main() {}\n", "developer code untouched");
    },
  },
  {
    id: "M02",
    group: "moves",
    title: "Subfolder to nested subfolder: cutready/ moved to demos/launch/",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("Before move"));
      await save(ctx, "Before move");
      const saved = git(fx.repo, "rev-parse", "HEAD");
      await park(ctx);
      mkdirSync(join(fx.repo, "demos"), { recursive: true });
      git(fx.repo, "mv", "cutready", "demos/launch");
      git(fx.repo, "commit", "-qm", "Nest the demo folder");

      const state = await ctx.open(fx.folder);
      ctx.check(/moved to .*launch/i.test(String(state.error)), "old path says where it moved", state.error);
      await checkMoved(ctx, fx.repo, "demos/launch", saved, sketch("Before move"));
    },
  },
  {
    id: "M03",
    group: "moves",
    title: "Subfolder to sibling while the app has it open",
    async run(ctx) {
      const { fx } = await openHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("Before move"));
      await save(ctx, "Before move");
      const saved = git(fx.repo, "rev-parse", "HEAD");
      // No park: the developer moves the folder out from under the running app.
      git(fx.repo, "mv", "cutready", "showcase");
      git(fx.repo, "commit", "-qm", "Rename demo folder");
      const head = git(fx.repo, "rev-parse", "HEAD");

      await ctx.refresh();
      const result = await ctx.act("saveVersion", "Save after move");
      const s = await ctx.state("error", "syncError");
      ctx.note(`save after move: ${JSON.stringify(result)} ${JSON.stringify(s)}`);
      ctx.check(git(fx.repo, "rev-parse", "HEAD") === head, "nothing committed at the old path");
      ctx.check(!gitChanges(fx.repo).some((l) => l.includes("cutready/")), "old folder not recreated with tracked content", gitChanges(fx.repo));
      ctx.check(read(join(fx.repo, "showcase", "intro.sk")) === sketch("Before move"), "moved content intact");
      await checkMoved(ctx, fx.repo, "showcase", saved, sketch("Before move"));
    },
  },
  {
    id: "R01",
    group: "review",
    title: "Send for review pushes a cutready/ branch and opens a pull request",
    async run(ctx) {
      const fx = await openGitHubHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("Review me"));
      await save(ctx, "Ready for review");
      const mainBefore = git(fx.remote, `--git-dir=${fx.remote}`, "rev-parse", "main");
      const r = await send(ctx, "Launch demo");
      const pulls = await fakeGitHub.opened(fx.owner, fx.name);
      ctx.require(pulls.length === 1, "one pull request opened", pulls);
      const [pull] = pulls;
      ctx.check(pull.head.startsWith("cutready/") && pull.base === "main", "PR is cutready/* → main", pull);
      ctx.check(pull.title === "Launch demo", "PR title", pull.title);
      ctx.check(remoteHasBranch(fx.remote, pull.head), "review branch pushed", pull.head);
      ctx.check(remoteFile(fx.remote, pull.head, "cutready/intro.sk") === sketch("Review me").trim(), "branch has the saved content");
      ctx.check(git(fx.remote, `--git-dir=${fx.remote}`, "rev-parse", "main") === mainBefore, "main untouched on remote");
      ctx.check(r.toasts.some((t) => /opened for review/i.test(t.message)), "success toast", r.toasts);
      ctx.check(r.shareUrl?.endsWith(`/pull/${pull.number}`), "share URL is the PR", r.shareUrl);
      ctx.check(git(fx.repo, "branch", "--show-current") === pull.head, "app now on the review branch");
      ctx.check(git(fx.repo, "status", "--porcelain") === "", "repo clean");
    },
  },
  {
    id: "R02",
    group: "review",
    title: "A second Send updates the same pull request without force",
    async run(ctx) {
      const fx = await openGitHubHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("First pass"));
      await save(ctx, "First pass");
      await send(ctx, "Review round");
      const [pull] = await fakeGitHub.opened(fx.owner, fx.name);
      ctx.require(Boolean(pull), "first PR opened");
      const first = git(fx.remote, `--git-dir=${fx.remote}`, "rev-parse", pull.head);
      await edit(ctx, fx, "intro.sk", sketch("Second pass"));
      await save(ctx, "Second pass");
      const r = await send(ctx, "Review round");
      const all = await fakeGitHub.opened(fx.owner, fx.name);
      ctx.check(all.length === 1, "no second PR", all);
      ctx.check(r.toasts.some((t) => /updated/i.test(t.message)), "toast says updated", r.toasts);
      const second = git(fx.remote, `--git-dir=${fx.remote}`, "rev-parse", pull.head);
      ctx.check(second !== first && gitTry(fx.remote, `--git-dir=${fx.remote}`, "merge-base", "--is-ancestor", first, second).ok, "branch fast-forwarded", { first, second });
      ctx.check(remoteFile(fx.remote, pull.head, "cutready/intro.sk") === sketch("Second pass").trim(), "branch has the new content");
    },
  },
  {
    id: "R03",
    group: "review",
    title: "PR merged, get updates, then Send again opens a new pull request",
    async run(ctx) {
      const fx = await openGitHubHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("Round one"));
      await save(ctx, "Round one");
      await send(ctx, "Round one");
      const [pull] = await fakeGitHub.opened(fx.owner, fx.name);
      ctx.require(Boolean(pull), "first PR opened");

      // A developer merges the PR on "GitHub" and keeps working on main.
      git(fx.dev, "fetch", "-q", "origin");
      git(fx.dev, "checkout", "-q", "-B", "main", "origin/main");
      git(fx.dev, "merge", "-q", "--no-ff", "-m", `Merge pull request #${pull.number}`, `origin/${pull.head}`);
      git(fx.dev, "push", "-q", "origin", "main");
      await fakeGitHub.close(pull);
      devCommit(fx, "src/app.rs", "fn main() { println!(\"after merge\"); }\n");

      await ctx.act("getUpdatesFromBase");
      const s = await ctx.state("syncError", "isMerging");
      ctx.check(!s.syncError && !s.isMerging, "updates from main come in cleanly", s);
      ctx.check(read(join(fx.repo, "src", "app.rs")).includes("after merge"), "developer code arrived");
      ctx.check(read(join(fx.folder, "intro.sk")) === sketch("Round one"), "CutReady content kept");

      await edit(ctx, fx, "intro.sk", sketch("Round two"));
      await save(ctx, "Round two");
      const r = await send(ctx, "Round two");
      const pulls = await fakeGitHub.opened(fx.owner, fx.name);
      ctx.check(pulls.length === 2 && pulls[1].state === "open", "a new PR opened", pulls);
      ctx.check(r.toasts.some((t) => /opened for review/i.test(t.message)), "toast says opened", r.toasts);
      const head = pulls[1]?.head;
      ctx.check(head && remoteFile(fx.remote, head, "cutready/intro.sk") === sketch("Round two").trim(), "new round pushed", head);
      ctx.check(head && remoteFile(fx.remote, head, "src/app.rs")?.includes("after merge"), "new round builds on merged main");
    },
  },
  {
    id: "R04",
    group: "review",
    title: "Developer edits the same sketch on main after Send: get updates opens conflict resolution",
    async run(ctx) {
      const fx = await openGitHubHybrid(ctx);
      await edit(ctx, fx, "intro.sk", sketch("Ours"));
      await save(ctx, "Ours");
      await send(ctx, "Conflicting round");
      devCommit(fx, "cutready/intro.sk", sketch("Theirs"), "Dev rewrites intro");
      await ctx.act("getUpdatesFromBase");
      const s = await ctx.state("syncError", "isMerging", "mergeConflicts");
      ctx.check(s.isMerging && s.mergeConflicts?.some((c) => String(c.path ?? c).includes("intro.sk")), "conflict resolution opens on intro.sk", s);
      ctx.check(read(join(fx.folder, "intro.sk")) === sketch("Ours"), "our content untouched until resolved");
      const cancel = await ctx.act("cancelMerge");
      ctx.note(`cancelMerge: ${JSON.stringify(cancel)}`);
    },
  },
];
