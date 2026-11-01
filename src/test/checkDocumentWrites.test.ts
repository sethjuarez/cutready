import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs script without type declarations
import { checkDocumentWrites, maskNonCode } from "../../scripts/check-document-writes.mjs";

const delegatingProject = `
pub fn write_sketch(s: &Sketch, path: &Path, root: &Path) -> Result<(), ProjectError> {
    document_writer::replace_sketch(path, s)?;
    Ok(())
}
pub fn write_storyboard() {}
pub fn write_note() {}
pub fn delete_sketch() {}
pub fn delete_storyboard() {}
pub fn delete_note(path: &Path) {
    document_writer::delete(path)?;
    // asset write: orphaned image cleanup
    std::fs::remove_file(image);
}
pub fn save_upgraded_storyboard() {}
`;

describe("check-document-writes", () => {
  it("accepts writer calls, allowlisted callers, marked assets and test fixtures", () => {
    const problems = checkDocumentWrites([
      { path: "engine/project.rs", text: delegatingProject },
      { path: "engine/agent/tools.rs", text: "fn f() { project::write_sketch(&s, &p, r); }" },
      {
        path: "commands/note.rs",
        text: [
          "fn save() {",
          '    let msg = "std::fs::write is fine in a string";',
          "    // asset write: image",
          "    std::fs::write(&image, &data)?;",
          "}",
          "#[cfg(test)]",
          "mod tests {",
          "    fn fixture() { std::fs::remove_file(&p).unwrap(); project::write_note(&p, \"\"); }",
          "}",
        ].join("\n"),
      },
    ]);
    expect(problems).toEqual([]);
  });

  it("rejects legacy document writes outside the allowlist", () => {
    const problems = checkDocumentWrites([
      { path: "commands/export.rs", text: "fn f() {\n    project::write_storyboard(&sb, &p, r)?;\n}" },
    ]);
    expect(problems).toEqual([expect.stringContaining("commands/export.rs:2: write_storyboard bypasses")]);
  });

  it("rejects unmarked raw writes in document commands", () => {
    const problems = checkDocumentWrites([
      { path: "commands/sketch.rs", text: "fn f() {\n    std::fs::write(&abs, json)?;\n}" },
    ]);
    expect(problems).toEqual([expect.stringContaining("commands/sketch.rs:2: raw filesystem write")]);
  });

  it("rejects project helpers that write the filesystem themselves", () => {
    const text = delegatingProject.replace(
      "document_writer::replace_sketch(path, s)?;",
      "std::fs::write(path, json)?;",
    );
    const problems = checkDocumentWrites([{ path: "engine/project.rs", text }]);
    expect(problems).toEqual([expect.stringContaining("write_sketch writes the filesystem directly")]);
  });

  it("masks strings, raw strings, chars and comments without moving lines", () => {
    const text = 'let a = "{"; // }\nlet b = r#"}"#; let c = \'{\';\n/* { */ x';
    const masked = maskNonCode(text);
    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n")).toHaveLength(3);
    expect(masked).not.toMatch(/[{}]/);
  });
});
