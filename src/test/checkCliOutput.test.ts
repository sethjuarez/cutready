import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs script without type declarations
import { checkCliOutput } from "../../scripts/check-cli-output.mjs";

describe("check-cli-output", () => {
  it("accepts the output module, marked MCP framing and tests", () => {
    const problems = checkCliOutput([
      { path: "output.rs", text: "fn f() -> Value { serde_json::to_value(x).unwrap() }" },
      {
        path: "mcp.rs",
        text: [
          'let ok = json!({ "jsonrpc": "2.0" }); // mcp framing',
          "// mcp framing: tool schemas",
          "json!([])",
        ].join("\n"),
      },
      {
        path: "main.rs",
        text: [
          '// json!({ "comment": true })',
          'let s = "json!({})";',
          "#[cfg(test)]",
          "mod tests {",
          "    fn t() { json!({}); }",
          "}",
        ].join("\n"),
      },
    ]);
    expect(problems).toEqual([]);
  });

  it("rejects hand-built output outside the boundary", () => {
    const problems = checkCliOutput([
      { path: "main.rs", text: 'print(json!({ "ok": true }));' },
      { path: "edit.rs", text: "Value::Array(items)\nlet m = Map::new();" },
      { path: "project.rs", text: "serde_json::to_value(&x)\n#[derive(Debug, Serialize)]\nstruct Out;" },
      { path: "mcp.rs", text: "let unmarked = json!({});" },
      { path: "review.rs", text: "let x = json!({}); // mcp framing" },
    ]);
    expect(problems).toHaveLength(7);
    expect(problems[0]).toMatch(/^main\.rs:1: json!/);
    expect(problems.join("\n")).toMatch(/mcp\.rs:1: json!.*mark `\/\/ mcp framing`/);
    expect(problems.join("\n")).toMatch(/review\.rs:1: json!/);
  });

  it("rejects printing, serializing and implementing Output outside the boundary", () => {
    const problems = checkCliOutput([
      { path: "edit.rs", text: 'println!("{}", serde_json::to_string(&value).unwrap());' },
      { path: "review.rs", text: "impl Output for Mine {\n    fn to_output(&self) -> Value { Value::String(s) }\n}" },
      { path: "project.rs", text: "std::io::stdout().write_all(bytes);" },
      { path: "main.rs", text: 'println!("{USAGE}"); // plain text: --help' },
      { path: "mcp.rs", text: 'println!("{USAGE}"); // plain text' },
    ]);
    expect(problems).toEqual([
      expect.stringMatching(/^edit\.rs:1: serde_json serialization/),
      expect.stringMatching(/^edit\.rs:1: print!\/println!/),
      expect.stringMatching(/^review\.rs:1: impl Output/),
      expect.stringMatching(/^project\.rs:1: stdout\(\)/),
      expect.stringMatching(/^mcp\.rs:1: print!\/println!/),
    ]);
  });
});
