import { describe, expect, it } from "vitest";
import { labelTemplateProblem, stripLabelTemplate } from "../domain/versioning/labelTemplate";

describe("save label template", () => {
  it("accepts one line with {subject} once; blank clears it", () => {
    expect(labelTemplateProblem("")).toBeNull();
    expect(labelTemplateProblem("docs(demo): {subject}")).toBeNull();
    expect(labelTemplateProblem("docs: {subject} {subject}")).toMatch(/exactly once/);
    expect(labelTemplateProblem("docs: subject")).toMatch(/exactly once/);
    expect(labelTemplateProblem("a {subject}\nb")).toMatch(/one line/);
  });

  it("strips the prefix and suffix from the first line only", () => {
    expect(stripLabelTemplate("docs(demo): Outline", "docs(demo): {subject}")).toBe("Outline");
    expect(stripLabelTemplate("[x] Outline (demo)\nmore", "[x] {subject} (demo)")).toBe("Outline\nmore");
  });

  it("leaves labels that don't follow the template", () => {
    expect(stripLabelTemplate("Outline", "docs(demo): {subject}")).toBe("Outline");
    expect(stripLabelTemplate("docs(demo): ", "docs(demo): {subject}")).toBe("docs(demo): ");
    expect(stripLabelTemplate("docs(demo): Outline", null)).toBe("docs(demo): Outline");
    expect(stripLabelTemplate("docs(demo): Outline", "broken")).toBe("docs(demo): Outline");
    expect(stripLabelTemplate("Outline", "{subject}")).toBe("Outline");
  });
});
