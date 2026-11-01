import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs script without type declarations
import { checkCoreDeps, parseTree } from "../../scripts/check-core-deps.mjs";

const clean = `cutready-core v0.1.0 (C:\\repo\\crates\\cutready-core) []
chrono v0.4.45 [alloc,serde,std]
serde v1.0.229 [default,derive,std]
serde v1.0.229 [default,derive,std] (*)
proc-macro2 v1.0.107 [default,proc-macro]`;

describe("check-core-deps", () => {
  it("parses packages and their features", () => {
    const packages = parseTree(clean);
    expect([...packages.keys()]).toEqual(["cutready-core", "chrono", "serde", "proc-macro2"]);
    expect([...packages.get("chrono")]).toEqual(["alloc", "serde", "std"]);
    expect(checkCoreDeps(packages)).toEqual([]);
  });

  it("rejects host, storage, network and app crates", () => {
    const dirty = `${clean}
tauri v2.5.0 [default]
windows-sys v0.61.2 []
libgit2-sys v0.18.0 []
rusqlite v0.37.0 [bundled]
reqwest v0.12.0 [json]
cutready v0.9.0 (C:\\repo\\src-tauri) []
draftline v0.10.1 []`;
    const problems = checkCoreDeps(parseTree(dirty));
    expect(problems.map((p: string) => p.split(":")[0])).toEqual([
      "tauri",
      "windows-sys",
      "libgit2-sys",
      "rusqlite",
      "reqwest",
      "cutready",
      "draftline",
    ]);
  });

  it("allows tokio but not its process feature", () => {
    expect(checkCoreDeps(parseTree(`${clean}\ntokio v1.47.0 [rt,sync]`))).toEqual([]);
    expect(checkCoreDeps(parseTree(`${clean}\ntokio v1.47.0 [process,rt]`))).toEqual([
      'tokio feature "process": core never spawns processes',
    ]);
  });
});
