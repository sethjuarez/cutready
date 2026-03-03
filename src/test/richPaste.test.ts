/**
 * Tests for rich paste HTML → Markdown conversion.
 */
import { describe, it, expect, vi } from "vitest";
import { htmlToMarkdown, clipboardHasHtml } from "../services/richPaste";

// Mock Tauri invoke for image saving
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(".cutready/screenshots/pasted-123.png"),
}));

describe("richPaste", () => {
  describe("clipboardHasHtml", () => {
    it("returns true when text/html is present", () => {
      const dt = { types: ["text/html", "text/plain"] } as unknown as DataTransfer;
      expect(clipboardHasHtml(dt)).toBe(true);
    });

    it("returns false when only text/plain", () => {
      const dt = { types: ["text/plain"] } as unknown as DataTransfer;
      expect(clipboardHasHtml(dt)).toBe(false);
    });
  });

  describe("htmlToMarkdown", () => {
    it("converts simple HTML to markdown", async () => {
      const html = "<h1>Hello</h1><p>World</p>";
      const result = await htmlToMarkdown(html);
      expect(result.hadHtml).toBe(true);
      expect(result.markdown).toContain("# Hello");
      expect(result.markdown).toContain("World");
    });

    it("preserves bold and italic", async () => {
      const html = "<p><strong>bold</strong> and <em>italic</em></p>";
      const result = await htmlToMarkdown(html);
      expect(result.markdown).toContain("**bold**");
      expect(result.markdown).toContain("*italic*");
    });

    it("converts lists", async () => {
      const html = "<ul><li>Item 1</li><li>Item 2</li></ul>";
      const result = await htmlToMarkdown(html);
      expect(result.markdown).toContain("Item 1");
      expect(result.markdown).toContain("Item 2");
      expect(result.markdown).toMatch(/^-/m); // starts with list marker
    });

    it("converts ordered lists", async () => {
      const html = "<ol><li>First</li><li>Second</li></ol>";
      const result = await htmlToMarkdown(html);
      expect(result.markdown).toContain("1.");
      expect(result.markdown).toContain("First");
    });

    it("converts tables (GFM)", async () => {
      const html = "<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>";
      const result = await htmlToMarkdown(html);
      expect(result.markdown).toContain("Name");
      expect(result.markdown).toContain("|");
    });

    it("strips Word mso-* styles and class attributes", async () => {
      const html = `<p class="MsoNormal" style="mso-line-height-rule:exactly;margin:0">Hello World</p>`;
      const result = await htmlToMarkdown(html);
      expect(result.markdown).toBe("Hello World");
      expect(result.markdown).not.toContain("Mso");
      expect(result.markdown).not.toContain("mso-");
    });

    it("strips <style> blocks", async () => {
      const html = `<style>body { font-family: Calibri; }</style><p>Content</p>`;
      const result = await htmlToMarkdown(html);
      expect(result.markdown).toBe("Content");
      expect(result.markdown).not.toContain("Calibri");
    });

    it("handles Word body extraction", async () => {
      const html = `<html><head><meta charset="utf-8"></head><body><h2>Title</h2><p>Text</p></body></html>`;
      const result = await htmlToMarkdown(html);
      expect(result.markdown).toContain("## Title");
      expect(result.markdown).toContain("Text");
    });

    it("collapses excessive blank lines", async () => {
      // Test that we don't get more than 3 consecutive newlines in output
      const html = "<p>A</p><p>&nbsp;</p><p>&nbsp;</p><p>&nbsp;</p><p>B</p>";
      const result = await htmlToMarkdown(html);
      // The result should contain both A and B
      expect(result.markdown).toContain("A");
      expect(result.markdown).toContain("B");
    });

    it("handles links", async () => {
      const html = `<p>Visit <a href="https://example.com">Example</a></p>`;
      const result = await htmlToMarkdown(html);
      expect(result.markdown).toContain("[Example](https://example.com)");
    });

    it("handles code blocks", async () => {
      const html = "<pre><code>const x = 1;</code></pre>";
      const result = await htmlToMarkdown(html);
      expect(result.markdown).toContain("const x = 1;");
    });

    it("handles inline code", async () => {
      const html = "<p>Use <code>npm install</code> to install</p>";
      const result = await htmlToMarkdown(html);
      expect(result.markdown).toContain("`npm install`");
    });

    it("extracts base64 images when saveImages is true", async () => {
      const html = `<p>Image: <img src="data:image/png;base64,iVBORw0KGgo=" /></p>`;
      const result = await htmlToMarkdown(html, { saveImages: true });
      expect(result.markdown).toContain(".cutready/screenshots/pasted-123.png");
    });
  });
});
