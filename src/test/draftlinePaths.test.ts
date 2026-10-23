import { describe, expect, it } from "vitest";
import {
  draftlineBase,
  draftlinePathVariants,
  draftlineProjectScope,
  draftlineToProjectPath,
  draftlineToRepoPath,
  hybridPathPrefix,
  hybridVariationName,
  projectToDraftlinePath,
  repoToDraftlinePath,
} from "../utils/draftlinePaths";

const hybridSingle = {
  root: "C:/code/contoso-app/cutready",
  repo_root: "C:/code/contoso-app/cutready",
  git_root: "C:/code/contoso-app",
  hybrid: true,
};

const hybridMulti = {
  root: "C:\\code\\contoso-app\\cutready\\alpha",
  repo_root: "C:\\code\\contoso-app\\cutready",
  git_root: "C:\\Code\\Contoso-App",
  hybrid: true,
};

const standaloneMulti = {
  root: "D:/ws/alpha",
  repo_root: "D:/ws",
  git_root: "D:/ws",
  hybrid: false,
};

describe("draftlinePaths", () => {
  it("maps hybrid multi-project Draftline paths to project paths and back", () => {
    expect(draftlineProjectScope(hybridMulti)).toBe("cutready/alpha");
    expect(draftlineToProjectPath("cutready/alpha/intro.sk", hybridMulti)).toBe("intro.sk");
    expect(projectToDraftlinePath("intro.sk", hybridMulti)).toBe("cutready/alpha/intro.sk");
    expect(draftlinePathVariants("cutready/alpha/intro.sk", hybridMulti)).toEqual({
      draftlinePath: "cutready/alpha/intro.sk",
      projectPath: "intro.sk",
    });
    expect(draftlinePathVariants("intro.sk", hybridMulti)).toEqual({
      draftlinePath: "cutready/alpha/intro.sk",
      projectPath: "intro.sk",
    });
    expect(draftlineToProjectPath("cutready/beta/intro.sk", hybridMulti)).toBeNull();
  });

  it("maps hybrid single-project paths through the folder prefix", () => {
    expect(draftlineProjectScope(hybridSingle)).toBe("cutready");
    expect(draftlineToProjectPath("cutready/intro.sk", hybridSingle)).toBe("intro.sk");
    expect(projectToDraftlinePath("screenshots/a.png", hybridSingle)).toBe("cutready/screenshots/a.png");
    expect(draftlineToProjectPath("src/app.ts", hybridSingle)).toBeNull();
  });

  it("converts Draftline paths to manifest-relative repo paths", () => {
    expect(hybridPathPrefix(hybridMulti)).toBe("cutready");
    expect(draftlineToRepoPath("cutready/alpha/intro.sk", hybridMulti)).toBe("alpha/intro.sk");
    expect(repoToDraftlinePath("alpha/intro.sk", hybridMulti)).toBe("cutready/alpha/intro.sk");
    expect(draftlineToRepoPath("src/app.ts", hybridMulti)).toBe("src/app.ts");
  });

  it("leaves standalone paths unchanged", () => {
    expect(hybridPathPrefix(standaloneMulti)).toBe("");
    expect(draftlineToRepoPath("alpha/intro.sk", standaloneMulti)).toBe("alpha/intro.sk");
    expect(draftlineProjectScope(standaloneMulti)).toBe("alpha");
    expect(draftlineToProjectPath("alpha/intro.sk", standaloneMulti)).toBe("intro.sk");
    expect(projectToDraftlinePath("intro.sk", { ...standaloneMulti, root: "D:/ws" })).toBe("intro.sk");
  });

  it("falls back to repo_root when git_root is missing or empty", () => {
    const legacy = { root: "D:/ws/alpha", repo_root: "D:/ws" };
    expect(draftlineBase(legacy)).toBe("D:/ws");
    expect(draftlineBase({ ...legacy, git_root: "" })).toBe("D:/ws");
    expect(draftlineToProjectPath("alpha/intro.sk", legacy)).toBe("intro.sk");
    expect(hybridPathPrefix(null)).toBe("");
  });

  it("prefixes hybrid variation names once", () => {
    expect(hybridVariationName("demo")).toBe("cutready/demo");
    expect(hybridVariationName("cutready/demo")).toBe("cutready/demo");
  });
});
