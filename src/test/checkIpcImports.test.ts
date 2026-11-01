import { describe, expect, it } from "vitest";
import {
  checkIpcImports,
  countInvokes,
  isExempt,
  updateCaps,
  // @ts-expect-error - plain .mjs script without type declarations
} from "../../scripts/check-ipc-imports.mjs";

describe("check-ipc-imports", () => {
  it("counts raw invoke calls, including generic and aliased ones", () => {
    const text = [
      'import { Channel, invoke } from "../services/tauri";',
      "// invoke(\"commented_out\")",
      'await invoke("a");',
      'const x = await invoke<string>("b", { y });',
    ].join("\n");
    expect(countInvokes(text)).toBe(2);
    expect(countInvokes('import { invoke as call } from "@tauri-apps/api/core";\ncall("a"); call<number>("b");')).toBe(2);
    expect(countInvokes('import { invoke } from "./tauri";')).toBe(0);
    expect(countInvokes('import { listen } from "../services/tauri";\ninvoke("a");')).toBeNull();
    expect(countInvokes('import { invoke } from "./ipc/sketches";\ninvoke();')).toBeNull();
    expect(countInvokes('import * as tauri from "../services/tauri";\ntauri.invoke("a"); tauri.listen("x");')).toBe(1);
    expect(countInvokes('import * as core from "@tauri-apps/api/core";\ncore.invoke<string>("a");')).toBe(1);
    expect(countInvokes('import * as tauri from "../services/tauri";\ntauri . invoke("a");')).toBe(1);
  });

  it("ignores lookalikes in strings, templates and other objects", () => {
    const text = [
      'import * as tauri from "../services/tauri";',
      'import { invoke } from "../services/tauri";',
      'const s = "tauri.invoke(" + \'invoke("x")\';',
      "const t = `tauri.invoke( ${await tauri.invoke(\"real\")} invoke(`;",
      "other.tauri.invoke(\"x\"); api.invoke(\"y\"); reinvoke(\"z\");",
      "return invoke(\"counted\");",
    ].join("\n");
    expect(countInvokes(text)).toBe(2);
  });

  it("only counts real imports and supports $ identifiers", () => {
    expect(countInvokes('const docs = "import * as tauri from \'@tauri-apps/api/core\'";\ntauri.invoke("x");')).toBeNull();
    expect(countInvokes('// import { invoke } from "../services/tauri";\ninvoke("x");')).toBeNull();
    expect(countInvokes('import * as $tauri from "@tauri-apps/api/core";\n$tauri.invoke("x");')).toBe(1);
    expect(countInvokes('import { invoke as $call } from "@tauri-apps/api/core";\n$call("x"); a$call("y");')).toBe(1);
    expect(countInvokes('import/* note */ * as tauri from "@tauri-apps/api/core";\ntauri.invoke("x");')).toBe(1);
    expect(countInvokes('import {\n  // backend call\n  invoke,\n} from "@tauri-apps/api/core";\ninvoke("x");')).toBe(1);
  });

  it("caps existing importers and rejects new ones", () => {
    const caps = { "src/a.ts": 3, "src/b.ts": 2, "src/gone.ts": 1 };
    expect(checkIpcImports({ "src/a.ts": 3, "src/b.ts": 2, "src/gone.ts": 1 }, caps)).toEqual([]);
    expect(checkIpcImports({ "src/a.ts": 4, "src/b.ts": 1, "src/new.ts": 0 }, caps)).toEqual([
      expect.stringMatching(/^src\/a\.ts: 4 invoke calls, over its cap of 3/),
      expect.stringMatching(/^src\/b\.ts: 1 invoke calls, under its cap of 2; run --update/),
      expect.stringMatching(/^src\/new\.ts: imports invoke; add a typed wrapper in src\/ipc\//),
      expect.stringMatching(/^src\/gone\.ts: capped but no longer imports invoke/),
    ]);
  });

  it("only lowers caps", () => {
    expect(updateCaps({ "src/a.ts": 5, "src/b.ts": 1 }, { "src/a.ts": 3, "src/b.ts": 2, "src/gone.ts": 1 })).toEqual({
      "src/a.ts": 3,
      "src/b.ts": 1,
    });
  });

  it("exempts the wrapper, typed IPC modules and tests", () => {
    expect(isExempt("src/services/tauri.ts")).toBe(true);
    expect(isExempt("src/ipc/events.ts")).toBe(true);
    expect(isExempt("src/test/app.test.tsx")).toBe(true);
    expect(isExempt("src/stores/appStore.ts")).toBe(false);
  });
});
