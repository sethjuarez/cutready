import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs script without type declarations
import { checkDocumentWrites, maskNonCode, missingAllowlisted } from "../../scripts/check-document-writes.mjs";

const delegatingProject = `
pub fn delete_sketch(path: &Path, root: &Path) -> Result<(), ProjectError> {
    document_writer::write_storyboard(root, &sb_path, &sb, Expected::Version(v))?;
    document_writer::delete(root, path)?;
    Ok(())
}
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
      { path: "engine/document_goldens.rs", text: "fn f() { project::write_sketch(&s, &p, r); }" },
      {
        path: "commands/note.rs",
        text: [
          "fn save_pasted_image() {",
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

  it("rejects the retired in-process write mutex, even in tests", () => {
    const problems = checkDocumentWrites([
      {
        path: "commands/export.rs",
        text: "// workspace_write_lock was here\nfn f() {\n    let _g = crate::engine::workspace_write_lock::lock()?;\n}\n#[cfg(test)]\nmod tests { fn t(l: State<ProjectLock>) {} }",
      },
    ]);
    expect(problems).toEqual([
      expect.stringContaining("commands/export.rs:3: workspace_write_lock is gone"),
      expect.stringContaining("commands/export.rs:6: ProjectLock is gone"),
    ]);
  });

  it("rejects project helpers that write the filesystem themselves", () => {
    const text = delegatingProject.replace(
      "document_writer::delete(root, path)?;",
      "std::fs::remove_file(path)?;",
    );
    const problems = checkDocumentWrites([{ path: "engine/project.rs", text }]);
    expect(problems).toEqual([expect.stringContaining("delete_sketch writes the filesystem directly")]);
  });

  const writer = [
    "pub(crate) fn import_document(root: &Path, abs: &Path, doc: Imported) -> Result<Written, WriteError> {",
    "    replace(root, abs, doc, Expected::Unchecked)",
    "}",
    "pub fn write_note(root: &Path, abs: &Path, content: &str, expected: Expected) {}",
    "#[cfg(test)]",
    "mod tests { fn t() { edit(root, \"a.md\", Expected::Unchecked, &ops); } }",
  ].join("\n");

  it("allows Expected::Unchecked only in import_document, called only by importers", () => {
    const problems = checkDocumentWrites([
      { path: "engine/document_writer.rs", text: writer },
      { path: "commands/import.rs", text: "fn import_docx() { document_writer::import_document(&r, &p, Imported::Note(&m))?; }" },
      { path: "engine/video_import.rs", text: "fn import_video_from_sidecar_with_progress() { document_writer::import_document(&r, &p, doc)?; }" },
      { path: "engine/agent/document_ops.rs", text: "fn f() { document_writer::write_note(r, p, c, expected)?; }" },
    ]);
    expect(problems).toEqual([]);
  });

  it("rejects Expected::Unchecked anywhere else, even in the writer", () => {
    const problems = checkDocumentWrites([
      { path: "commands/sketch.rs", text: "use document_writer::Expected::Unchecked;\nfn f() {\n    edit(r, p, Unchecked, &ops)?;\n}" },
      { path: "engine/document_writer.rs", text: `${writer}\nfn other() { replace(r, a, d, Expected::Unchecked) }` },
    ]);
    expect(problems).toEqual([
      expect.stringContaining("commands/sketch.rs:1: Expected::Unchecked"),
      expect.stringContaining("commands/sketch.rs:3: Expected::Unchecked"),
      expect.stringContaining("engine/document_writer.rs:7: Expected::Unchecked"),
    ]);
  });

  it("rejects import_document outside the importers", () => {
    const problems = checkDocumentWrites([
      { path: "commands/note.rs", text: "fn save() {\n    document_writer::import_document(&r, &p, Imported::Note(&c))?;\n}" },
    ]);
    expect(problems).toEqual([expect.stringContaining("commands/note.rs:2: import_document is for importing")]);
  });

  it("rejects import_document in importer files outside the import functions", () => {
    const problems = checkDocumentWrites([
      {
        path: "commands/import.rs",
        text: "fn import_docx() { import_document(&r, &p, doc)?; }\nfn sync_imports() {\n    import_document(&r, &p, doc)?;\n}",
      },
    ]);
    expect(problems).toEqual([expect.stringContaining("commands/import.rs:3: import_document is for importing")]);
  });

  it("rejects asset write marks outside the allowlisted asset helpers", () => {
    const marked = "    // asset write: not really\n    std::fs::write(&abs, json)?;";
    const problems = checkDocumentWrites([
      { path: "commands/note.rs", text: `fn save_pasted_image() {}\nfn update_note() {\n${marked}\n}` },
      { path: "commands/storyboard.rs", text: `fn update_storyboard() {\n${marked}\n}` },
      { path: "engine/project.rs", text: delegatingProject.replace("document_writer::delete(root, path)?;", "// asset write\n    std::fs::remove_file(path)?;") },
    ]);
    expect(problems).toEqual([
      expect.stringContaining('commands/note.rs:4: "// asset write" is only for the asset helpers'),
      expect.stringContaining('commands/storyboard.rs:3: "// asset write" is only for the asset helpers'),
      expect.stringContaining('engine/project.rs:5: "// asset write" is only for the asset helpers'),
    ]);
  });

  it("reports allowlisted importer and asset functions that no longer exist", () => {
    const problems = missingAllowlisted([
      { path: "commands/sketch.rs", text: "fn update_sketch() {}\n#[cfg(test)]\nmod tests { fn write_visual_doc() {} }" },
    ]);
    expect(problems).toEqual([expect.stringContaining("commands/sketch.rs: write_visual_doc is missing")]);
  });

  it("requires the writer to keep import_document", () => {
    const problems = checkDocumentWrites([{ path: "engine/document_writer.rs", text: "pub fn edit() {}" }]);
    expect(problems).toEqual([expect.stringContaining("import_document is missing")]);
  });

  it("treats split-out *_tests.rs modules as test code", () => {
    const fixture = "fn t() { edit(root, \"a.md\", Expected::Unchecked, &ops); import_document(r, p, &s); }";
    const problems = checkDocumentWrites([
      { path: "engine/document_writer_tests.rs", text: fixture },
      { path: "engine/document_writer_test_helpers.rs", text: fixture },
    ]);
    expect(problems).toEqual([
      expect.stringContaining("document_writer_test_helpers.rs:1: Expected::Unchecked"),
      expect.stringContaining("document_writer_test_helpers.rs:1: import_document is for importing"),
    ]);
  });

  it("masks strings, raw strings, chars and comments without moving lines", () => {
    const text = 'let a = "{"; // }\nlet b = r#"}"#; let c = \'{\';\n/* { */ x';
    const masked = maskNonCode(text);
    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n")).toHaveLength(3);
    expect(masked).not.toMatch(/[{}]/);
  });
});
