import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import * as parity from "../../scripts/check-command-parity.mjs";

const { calledMethods, checkParity, draftlineMethodCommands, invokedCommands, registeredCommands } = parity;

describe("check-command-parity", () => {
  it("reads cfg-gated and path-qualified handler entries", () => {
    const lib = `tauri::Builder::default()
      .invoke_handler(tauri::generate_handler![
        configure_hotkeys,
        commands::project::open_project, // trailing comment
        #[cfg(feature = "x")]
        commands::agent::sign_in,
      ])`;
    expect(registeredCommands(lib)).toEqual(["configure_hotkeys", "open_project", "sign_in"]);
  });

  it("ignores block-commented entries and brackets inside comments", () => {
    const lib = `generate_handler![kept, /* removed, */ next, // old ]) marker
      /* multi
         line, ]) */
      last,
    ])`;
    expect(registeredCommands(lib)).toEqual(["kept", "next", "last"]);
  });

  it("finds literal invoke calls, aliases and command-taking helpers", () => {
    const src = `import { invoke as rawInvoke } from "@tauri-apps/api/core";
      invoke("a"); await invoke<Foo[]>('b', { x }); invoke(dynamic);
      rawInvoke("c"); importWithConflict("d", path); client.invoke("not_a_command");`;
    expect(invokedCommands(src)).toEqual(["a", "b", "c", "d"]);
  });

  it("maps Draftline client and host-facade methods to commands", () => {
    const js = `export function createDraftlineClient(options = {}) {
    return {
        getHistory: (workspacePath) => run('get_history', {
            request: { workspace_path: workspacePath },
        }),
        save: (request) => run('save', { request }),
    };
}
export function createDraftlineHostFacade({ client }) {
    return {
        history: () => client.getHistory(workspacePath),
        save: (label) => client.save({ label }),
    };
}`;
    const methods = draftlineMethodCommands(js);
    expect([...methods.get("history")]).toEqual(["get_history"]);
    expect([...methods.get("getHistory")]).toEqual(["get_history"]);
    expect([...methods.get("save")]).toEqual(["save"]);
    expect(calledMethods("await facade.history(); x.other();", methods)).toEqual(["history"]);
  });

  it("reports every kind of drift", () => {
    const problems = checkParity({
      registered: ["kept", "new_cmd", "removed"],
      supported: ["kept", "ghost"],
      unsupported: { removed: "gone" },
      invoked: [{ file: "src/a.ts", name: "removed" }],
    });
    expect(problems).toEqual([
      "new_cmd: registered but missing from supported",
      "removed: registered but listed as unsupported",
      "ghost: supported but not registered in generate_handler!",
      "removed: invoked in src/a.ts but not a supported command",
    ]);
  });

  it("passes when the sets agree", () => {
    expect(
      checkParity({ registered: ["a"], supported: ["a"], unsupported: { b: "gone" }, invoked: [{ file: "f", name: "a" }] }),
    ).toEqual([]);
  });
});
