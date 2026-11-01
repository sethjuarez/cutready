import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { checkParity, invokedCommands, registeredCommands } from "../../scripts/check-command-parity.mjs";

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

  it("finds literal invoke calls with and without type arguments", () => {
    const src = `invoke("a"); await invoke<Foo[]>('b', { x }); invoke(dynamic);`;
    expect(invokedCommands(src)).toEqual(["a", "b"]);
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
