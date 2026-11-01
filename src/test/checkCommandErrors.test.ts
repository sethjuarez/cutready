import { describe, expect, it } from "vitest";
import {
  checkCommandErrors,
  commands,
  genericArgs,
  resolveAlias,
  returnsStringError,
  stringCommands,
  typeAliases,
  updateCaps,
  // @ts-expect-error - plain .mjs script without type declarations
} from "../../scripts/check-command-errors.mjs";

const AGENT = "src-tauri/src/commands/agent.rs";
const NOTE = "src-tauri/src/commands/note.rs";

describe("check-command-errors", () => {
  it("splits top-level generic arguments", () => {
    expect(genericArgs("Result<Vec<(u8, String)>, String>", "Result")).toEqual(["Vec<(u8, String)>", "String"]);
    expect(genericArgs("std::result::Result<HashMap<String, u8>, CmdError>", "Result")).toEqual([
      "HashMap<String, u8>",
      "CmdError",
    ]);
    expect(genericArgs("Option<String>", "Result")).toBeNull();
  });

  it("only flags Result<_, String>", () => {
    expect(returnsStringError("Result<(), String>")).toBe(true);
    expect(returnsStringError("Result<Option<String>, std::string::String>")).toBe(true);
    expect(returnsStringError("Result<String, CmdError>")).toBe(false);
    expect(returnsStringError("contract::TauriCommandResult<String>")).toBe(false);
    expect(returnsStringError("Vec<String>")).toBe(false);
  });

  it("treats a leading :: and spaced paths like any other path", () => {
    expect(returnsStringError("::std::result::Result<(), ::std::string::String>")).toBe(true);
    expect(returnsStringError("std :: result :: Result<u8, :: std :: string :: String>")).toBe(true);
    expect(returnsStringError("::std::result::Result<String, ::cutready_contracts::CmdError>")).toBe(false);
  });

  it("resolves module-level aliases for the error or the whole result", () => {
    const text = [
      "type E = String;",
      "pub(crate) type R<T> = Result<T, String>;",
      "pub type Alias<T> = std::result::Result<T, E>;",
      "type Typed<T> = Result<T, CmdError>;",
      "impl TryFrom<u8> for Thing {",
      "    type Error = String;",
      "}",
      "#[cfg(test)]",
      "mod tests {",
      "    type Ok = String;",
      "}",
    ].join("\n");
    const aliases = typeAliases(text);
    expect(Object.keys(aliases).sort()).toEqual(["Alias", "E", "R", "Typed"]);
    expect(resolveAlias("R<Vec<u8>>", aliases)).toBe("Result<Vec<u8>, String>");
    expect(returnsStringError("Result<(), E>", aliases)).toBe(true);
    expect(returnsStringError("R<Option<String>>", aliases)).toBe(true);
    expect(returnsStringError("self::R<()>", aliases)).toBe(true);
    expect(returnsStringError("Alias<u8>", aliases)).toBe(true);
    expect(returnsStringError("Typed<String>", aliases)).toBe(false);
    expect(returnsStringError("Result<(), Error>", aliases)).toBe(false);
    expect(returnsStringError("Result<(), E>")).toBe(false);
  });

  it("counts commands that hide the String error behind an alias", () => {
    const text = [
      "type E = String;",
      "type R<T> = Result<T, String>;",
      "#[tauri::command]",
      "pub fn by_error() -> Result<(), E> { Ok(()) }",
      "#[tauri::command]",
      "pub fn by_result() -> R<u8> { Ok(1) }",
      "#[tauri::command]",
      "pub fn rooted() -> ::std::result::Result<(), ::std::string::String> { Ok(()) }",
      "#[tauri::command]",
      "pub fn multiline(",
      "    a: u8,",
      ") -> std::result::Result<",
      "    Vec<u8>,",
      "    String,",
      "> {",
      "    Ok(vec![a])",
      "}",
      "#[tauri::command]",
      "pub fn typed() -> Result<(), CmdError> { Ok(()) }",
    ].join("\n");
    expect(stringCommands(text)).toEqual(["by_error", "by_result", "rooted", "multiline"]);
  });

  it("finds tauri and auditaur commands outside tests, comments and strings", () => {
    const text = [
      "#[tauri::command]",
      "pub async fn plain(x: Vec<u8>) -> Result<String, String> {",
      '    let s = "#[tauri::command] fn fake() -> Result<(), String> {}";',
      "    Ok(s.into())",
      "}",
      "#[auditaur_command(skip_all, err)]",
      "pub async fn traced(",
      "    state: State<'_, AppState>,",
      "    f: fn(u8) -> u8,",
      ") -> Result<Vec<Item>, CmdError> {",
      "    todo!()",
      "}",
      "// #[tauri::command]",
      "// fn commented() -> Result<(), String> {}",
      "#[tauri::command]",
      "pub fn generic<R: Runtime>(app: AppHandle<R>) -> Result<(), String>",
      "where",
      "    R: Send,",
      "{",
      "    Ok(())",
      "}",
      "#[tauri::command]",
      "pub fn no_result() -> bool { true }",
      "#[cfg(test)]",
      "mod tests {",
      "    #[tauri::command]",
      "    fn in_test() -> Result<(), String> { Ok(()) }",
      "}",
    ].join("\n");
    expect(commands(text).map((c: { name: string }) => c.name)).toEqual(["plain", "traced", "generic", "no_result"]);
    expect(stringCommands(text)).toEqual(["plain", "generic"]);
  });

  it("only lets allowlisted commands return String in strict files", () => {
    const allowlist = { [AGENT]: ["azure_token_refresh"] };
    expect(checkCommandErrors({ [AGENT]: ["azure_token_refresh"] }, { [AGENT]: 1 }, allowlist)).toEqual([]);
    expect(checkCommandErrors({ [AGENT]: ["azure_token_refresh", "list_models"] }, { [AGENT]: 2 }, allowlist)).toEqual([
      `${AGENT}: list_models returns Result<_, String>; return CmdError instead (ADR 0003)`,
    ]);
  });

  it("caps String commands per file and only lets caps go down", () => {
    expect(checkCommandErrors({ [NOTE]: ["a", "b"] }, { [NOTE]: 2 }, {})).toEqual([]);
    expect(checkCommandErrors({ [NOTE]: ["a", "b", "c"] }, { [NOTE]: 2 }, {})[0]).toContain("over its cap of 2");
    expect(checkCommandErrors({ [NOTE]: ["a"] }, { [NOTE]: 2 }, {})[0]).toContain("run --update to lower it");
    expect(checkCommandErrors({ "src-tauri/src/commands/new.rs": ["a"] }, {}, {})[0]).toContain("over its cap of 0");
    expect(checkCommandErrors({}, { [NOTE]: 2 }, {})[0]).toContain("run --update to drop it");
    expect(updateCaps({ [NOTE]: ["a"], [AGENT]: ["x", "y", "z"] }, { [NOTE]: 2, [AGENT]: 2, "gone.rs": 1 })).toEqual({
      [NOTE]: 1,
      [AGENT]: 2,
    });
  });
});
