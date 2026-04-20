/**
 * Tests for rich paste HTML → Markdown conversion.
 *
 * Tests cover:
 * - Basic HTML elements (headings, bold, italic, lists, links, code)
 * - Word-specific HTML (MsoNormal, mso-* styles, <o:p>, <style> blocks)
 * - Table normalization (Word tables use <td> not <th>/<thead>)
 * - Image extraction (base64 data URIs)
 * - Heading spacing and blank line collapsing
 * - Full realistic Word document clipboard output
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { htmlToMarkdown, clipboardHasHtml, detectPasteComplexity, splitMarkdownChunks } from "../services/richPaste";

// Mock Tauri invoke for image saving
const mockInvoke = vi.fn().mockResolvedValue(".cutready/screenshots/pasted-123.png");
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

beforeEach(() => {
  mockInvoke.mockClear();
});

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

    it("returns false when empty types", () => {
      const dt = { types: [] } as unknown as DataTransfer;
      expect(clipboardHasHtml(dt)).toBe(false);
    });
  });

  // ─── Basic HTML conversion ─────────────────────────────────────

  describe("basic HTML → Markdown", () => {
    it("converts h1 heading", async () => {
      const { markdown } = await htmlToMarkdown("<h1>Title</h1>");
      expect(markdown).toBe("# Title");
    });

    it("converts h2 heading", async () => {
      const { markdown } = await htmlToMarkdown("<h2>Subtitle</h2>");
      expect(markdown).toBe("## Subtitle");
    });

    it("converts h3 heading", async () => {
      const { markdown } = await htmlToMarkdown("<h3>Section</h3>");
      expect(markdown).toBe("### Section");
    });

    it("preserves bold with <strong>", async () => {
      const { markdown } = await htmlToMarkdown("<p><strong>bold text</strong></p>");
      expect(markdown).toContain("**bold text**");
    });

    it("preserves bold with <b>", async () => {
      const { markdown } = await htmlToMarkdown("<p><b>bold text</b></p>");
      expect(markdown).toContain("**bold text**");
    });

    it("preserves italic with <em>", async () => {
      const { markdown } = await htmlToMarkdown("<p><em>italic text</em></p>");
      expect(markdown).toContain("*italic text*");
    });

    it("preserves italic with <i>", async () => {
      const { markdown } = await htmlToMarkdown("<p><i>italic text</i></p>");
      expect(markdown).toContain("*italic text*");
    });

    it("converts unordered lists", async () => {
      const { markdown } = await htmlToMarkdown("<ul><li>Apple</li><li>Banana</li><li>Cherry</li></ul>");
      expect(markdown).toContain("Apple");
      expect(markdown).toContain("Banana");
      expect(markdown).toContain("Cherry");
      expect(markdown).toMatch(/^-/m);
    });

    it("converts ordered lists", async () => {
      const { markdown } = await htmlToMarkdown("<ol><li>First</li><li>Second</li><li>Third</li></ol>");
      expect(markdown).toContain("1.");
      expect(markdown).toContain("First");
      expect(markdown).toContain("Second");
      expect(markdown).toContain("Third");
    });

    it("converts nested lists", async () => {
      const { markdown } = await htmlToMarkdown(
        "<ul><li>Parent<ul><li>Child 1</li><li>Child 2</li></ul></li></ul>"
      );
      expect(markdown).toContain("Parent");
      expect(markdown).toContain("Child 1");
      expect(markdown).toContain("Child 2");
    });

    it("converts links", async () => {
      const { markdown } = await htmlToMarkdown('<p>Visit <a href="https://example.com">Example</a></p>');
      expect(markdown).toContain("[Example](https://example.com)");
    });

    it("converts inline code", async () => {
      const { markdown } = await htmlToMarkdown("<p>Use <code>npm install</code> to install</p>");
      expect(markdown).toContain("`npm install`");
    });

    it("converts code blocks", async () => {
      const { markdown } = await htmlToMarkdown("<pre><code>const x = 1;\nconst y = 2;</code></pre>");
      expect(markdown).toContain("const x = 1;");
      expect(markdown).toContain("const y = 2;");
    });

    it("converts blockquotes", async () => {
      const { markdown } = await htmlToMarkdown("<blockquote><p>A wise quote</p></blockquote>");
      expect(markdown).toContain("> A wise quote");
    });

    it("converts horizontal rules", async () => {
      const { markdown } = await htmlToMarkdown("<p>Above</p><hr><p>Below</p>");
      expect(markdown).toContain("---");
    });

    it("converts strikethrough", async () => {
      const { markdown } = await htmlToMarkdown("<p><del>deleted text</del></p>");
      expect(markdown).toContain("~deleted text~");
    });
  });

  // ─── Tables ────────────────────────────────────────────────────

  describe("table conversion", () => {
    it("converts table with proper <thead>/<th>", async () => {
      const html = `<table>
        <thead><tr><th>Name</th><th>Age</th></tr></thead>
        <tbody><tr><td>Alice</td><td>30</td></tr><tr><td>Bob</td><td>25</td></tr></tbody>
      </table>`;
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("| Name | Age |");
      expect(markdown).toContain("| Alice | 30 |");
      expect(markdown).toContain("| Bob | 25 |");
      expect(markdown).toContain("---"); // separator row
    });

    it("converts table with <th> but no <thead> wrapper", async () => {
      const html = `<table>
        <tr><th>Name</th><th>Age</th></tr>
        <tr><td>Alice</td><td>30</td></tr>
      </table>`;
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("Name");
      expect(markdown).toContain("Alice");
      expect(markdown).toContain("|");
      expect(markdown).not.toContain("<table");
    });

    it("converts Word-style table (<td><b> for headers)", async () => {
      const html = `<table>
        <tr><td><b>Step</b></td><td><b>Action</b></td><td><b>Expected Result</b></td></tr>
        <tr><td>1</td><td>Click Login button</td><td>Login form appears</td></tr>
        <tr><td>2</td><td>Enter credentials</td><td>Dashboard loads</td></tr>
        <tr><td>3</td><td>Click Settings</td><td>Settings page opens</td></tr>
      </table>`;
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("|");
      expect(markdown).toContain("Step");
      expect(markdown).toContain("Action");
      expect(markdown).toContain("Expected Result");
      expect(markdown).toContain("Click Login button");
      expect(markdown).toContain("Enter credentials");
      expect(markdown).toContain("Click Settings");
      expect(markdown).not.toContain("<table");
      expect(markdown).not.toContain("<td");
    });

    it("converts Word table with border styles", async () => {
      const html = `<table style="border-collapse:collapse;mso-table-lspace:0">
        <tr>
          <td style="border:solid windowtext 1.0pt;mso-border-alt:solid windowtext .5pt;padding:0 5.4pt"><b>Feature</b></td>
          <td style="border:solid windowtext 1.0pt;mso-border-alt:solid windowtext .5pt;padding:0 5.4pt"><b>Status</b></td>
        </tr>
        <tr>
          <td style="border:solid windowtext 1.0pt;padding:0 5.4pt">Auth</td>
          <td style="border:solid windowtext 1.0pt;padding:0 5.4pt">Done</td>
        </tr>
      </table>`;
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("Feature");
      expect(markdown).toContain("Status");
      expect(markdown).toContain("Auth");
      expect(markdown).toContain("Done");
      expect(markdown).toContain("|");
      expect(markdown).not.toContain("windowtext");
      expect(markdown).not.toContain("mso-");
    });

    it("handles table with empty cells", async () => {
      const html = `<table>
        <tr><td><b>A</b></td><td><b>B</b></td></tr>
        <tr><td>1</td><td></td></tr>
      </table>`;
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("|");
      expect(markdown).not.toContain("<table");
    });

    it("handles multiple tables in one paste", async () => {
      const html = `
        <p>Table 1:</p>
        <table><tr><td><b>X</b></td><td><b>Y</b></td></tr><tr><td>1</td><td>2</td></tr></table>
        <p>Table 2:</p>
        <table><tr><td><b>A</b></td><td><b>B</b></td></tr><tr><td>3</td><td>4</td></tr></table>`;
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("Table 1");
      expect(markdown).toContain("Table 2");
      // Both tables should be converted
      const pipeCount = (markdown.match(/\|/g) || []).length;
      expect(pipeCount).toBeGreaterThanOrEqual(8); // At least 2 tables with pipes
    });
  });

  // ─── Word HTML cleanup ─────────────────────────────────────────

  describe("Word HTML cleanup", () => {
    it("strips MsoNormal class", async () => {
      const html = '<p class="MsoNormal">Hello World</p>';
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toBe("Hello World");
      expect(markdown).not.toContain("Mso");
    });

    it("strips mso-* inline styles", async () => {
      const html = '<p style="mso-line-height-rule:exactly;mso-pagination:widow-orphan;margin:0">Text</p>';
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toBe("Text");
    });

    it("strips <style> blocks", async () => {
      const html = `<style>
        p.MsoNormal, li.MsoNormal { margin: 0; font-family: Calibri; mso-fareast-font-family: Calibri; }
        h1 { mso-style-priority:9; font-family: "Calibri Light"; }
      </style><p>Content</p>`;
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toBe("Content");
    });

    it("handles <o:p> tags from Word", async () => {
      const html = '<p class="MsoNormal">Hello<o:p>&nbsp;</o:p></p>';
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("Hello");
      expect(markdown).not.toContain("o:p");
    });

    it("extracts body from full HTML document", async () => {
      const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
        xmlns:w="urn:schemas-microsoft-com:office:word"
        xmlns:m="http://schemas.microsoft.com/office/2004/12/omml"
        xmlns="http://www.w3.org/TR/REC-html40">
        <head><meta charset=utf-8><title>Document</title>
        <style>body{font-family:Calibri}</style></head>
        <body lang=EN-US>
          <h1>My Document</h1>
          <p class="MsoNormal">Some content here.</p>
        </body></html>`;
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("# My Document");
      expect(markdown).toContain("Some content here.");
      expect(markdown).not.toContain("xmlns");
      expect(markdown).not.toContain("Calibri");
    });

    it("strips VML shapes (v: namespace)", async () => {
      const html = '<p>Text</p><v:shapetype id="_x0000_t75" coordsize="21600,21600"></v:shapetype><p>More</p>';
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("Text");
      expect(markdown).toContain("More");
      expect(markdown).not.toContain("shapetype");
    });

    it("handles Word spans with meaningful formatting", async () => {
      // Spans with font-weight should be kept (they contain bold text)
      const html = '<p><span style="font-weight:bold;mso-bidi-font-weight:normal">Important</span> text</p>';
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("Important");
    });
  });

  // ─── Heading spacing ──────────────────────────────────────────

  describe("heading spacing", () => {
    it("blank line between heading and paragraph", async () => {
      const { markdown } = await htmlToMarkdown("<h1>Title</h1><p>Paragraph</p>");
      expect(markdown).toMatch(/# Title\n\nParagraph/);
    });

    it("blank line between paragraph and heading", async () => {
      const { markdown } = await htmlToMarkdown("<p>Text</p><h2>Next Section</h2>");
      expect(markdown).toMatch(/Text\n\n## Next Section/);
    });

    it("blank line between consecutive headings", async () => {
      const { markdown } = await htmlToMarkdown("<h1>Title</h1><h2>Subtitle</h2><p>Content</p>");
      expect(markdown).toContain("# Title");
      expect(markdown).toContain("## Subtitle");
      expect(markdown).toContain("Content");
    });

    it("multiple sections with proper spacing", async () => {
      const html = `
        <h1>Document Title</h1>
        <p>Introduction paragraph.</p>
        <h2>Section 1</h2>
        <p>Section 1 content.</p>
        <h2>Section 2</h2>
        <p>Section 2 content.</p>
        <h3>Subsection 2.1</h3>
        <p>Subsection content.</p>`;
      const { markdown } = await htmlToMarkdown(html);

      expect(markdown).toContain("# Document Title");
      expect(markdown).toContain("## Section 1");
      expect(markdown).toContain("## Section 2");
      expect(markdown).toContain("### Subsection 2.1");

      // No more than 2 consecutive newlines anywhere
      expect(markdown).not.toMatch(/\n{3,}/);
    });

    it("no excessive blank lines in output", async () => {
      const html = "<p>A</p><p>&nbsp;</p><p>&nbsp;</p><p>&nbsp;</p><p>B</p>";
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).not.toMatch(/\n{3,}/);
    });
  });

  // ─── Images ────────────────────────────────────────────────────

  describe("image handling", () => {
    it("converts <img> to markdown image syntax", async () => {
      const html = '<p><img src="https://example.com/photo.jpg" alt="Photo"></p>';
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("![Photo](https://example.com/photo.jpg)");
    });

    it("saves base64 PNG images when saveImages is true", async () => {
      const html = '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="Screenshot"></p>';
      const { markdown } = await htmlToMarkdown(html, { saveImages: true });
      expect(mockInvoke).toHaveBeenCalledWith("save_pasted_image", {
        base64Data: "iVBORw0KGgo=",
        extension: "png",
      });
      expect(markdown).toContain(".cutready/screenshots/pasted-123.png");
    });

    it("saves base64 JPEG images", async () => {
      const html = '<p><img src="data:image/jpeg;base64,/9j/4AAQ=" /></p>';
      await htmlToMarkdown(html, { saveImages: true });
      expect(mockInvoke).toHaveBeenCalledWith("save_pasted_image", {
        base64Data: "/9j/4AAQ=",
        extension: "jpeg",
      });
    });

    it("handles multiple images in one paste", async () => {
      mockInvoke
        .mockResolvedValueOnce(".cutready/screenshots/pasted-001.png")
        .mockResolvedValueOnce(".cutready/screenshots/pasted-002.png");

      const html = `
        <p><img src="data:image/png;base64,AAA=" /></p>
        <p>Some text between images</p>
        <p><img src="data:image/png;base64,BBB=" /></p>`;
      const { markdown } = await htmlToMarkdown(html, { saveImages: true });
      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(markdown).toContain("pasted-001.png");
      expect(markdown).toContain("pasted-002.png");
      expect(markdown).toContain("Some text between images");
    });

    it("does not call invoke when saveImages is false", async () => {
      const html = '<p><img src="data:image/png;base64,iVBORw0KGgo=" /></p>';
      await htmlToMarkdown(html, { saveImages: false });
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("does not call invoke when saveImages is not set", async () => {
      const html = '<p><img src="data:image/png;base64,iVBORw0KGgo=" /></p>';
      await htmlToMarkdown(html);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("handles image save failure gracefully", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("No project open"));
      const html = '<p><img src="data:image/png;base64,iVBORw0KGgo=" /></p>';
      // Should not throw
      const { markdown } = await htmlToMarkdown(html, { saveImages: true });
      expect(markdown).toBeDefined();
    });

    it("skips an embedded image when saving it times out", async () => {
      mockInvoke.mockImplementationOnce(() => new Promise(() => {}));
      const warnings: string[] = [];
      const html = '<p>Before</p><p><img src="data:image/png;base64,iVBORw0KGgo=" /></p><p>After</p>';

      const { markdown } = await htmlToMarkdown(html, {
        saveImages: true,
        imageSaveTimeoutMs: 5,
        onStatus: (message, level) => {
          if (level === "warn") warnings.push(message);
        },
      });

      expect(markdown).toContain("Before");
      expect(markdown).toContain("After");
      expect(warnings.some((message) => message.includes("timed out"))).toBe(true);
    });

    it("handles image with width/height attributes (Word-style)", async () => {
      const html = '<p><img src="data:image/png;base64,AAAA=" width="640" height="480" border="0"></p>';
      const { markdown } = await htmlToMarkdown(html, { saveImages: true });
      expect(mockInvoke).toHaveBeenCalled();
      expect(markdown).toContain(".cutready/screenshots/pasted-123.png");
    });
  });

  // ─── Realistic Word documents ─────────────────────────────────

  describe("realistic Word clipboard HTML", () => {
    it("demo script with headings, bold, italic, and table", async () => {
      const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
        xmlns:w="urn:schemas-microsoft-com:office:word"
        xmlns="http://www.w3.org/TR/REC-html40">
        <head>
          <meta charset=utf-8>
          <style>
            p.MsoNormal { margin: 0; font-size: 11.0pt; font-family: "Calibri",sans-serif; mso-fareast-font-family: Calibri; }
            h1 { mso-style-priority: 9; font-family: "Calibri Light",sans-serif; color: #2F5496; }
          </style>
        </head>
        <body lang=EN-US style='tab-interval:.5in;word-wrap:break-word'>
          <h1>Demo Script: Product Launch</h1>
          <p class="MsoNormal"><b>Narrator:</b> Welcome to the <i>product launch</i> demo.</p>
          <p class="MsoNormal">&nbsp;</p>
          <h2>Scene 1: Introduction</h2>
          <p class="MsoNormal">Open the <b>Dashboard</b> and navigate to <b>Settings</b>.</p>
          <p class="MsoNormal">&nbsp;</p>
          <h2>Scene 2: Feature Demo</h2>
          <p class="MsoNormal">Show the following steps:</p>
          <table class="MsoTableGrid" border=1 cellspacing=0 cellpadding=0
            style='border-collapse:collapse;mso-table-layout-alt:fixed;border:none;
            mso-border-alt:solid windowtext .5pt;mso-yfti-tbllook:1184;mso-padding-alt:0 5.4pt 0 5.4pt'>
            <tr style='mso-yfti-irow:0;mso-yfti-firstrow:yes'>
              <td width=100 style='width:75.0pt;border:solid windowtext 1.0pt;
                mso-border-alt:solid windowtext .5pt;padding:0 5.4pt 0 5.4pt'>
                <p class="MsoNormal"><b>Step<o:p></o:p></b></p>
              </td>
              <td width=300 style='width:225.0pt;border:solid windowtext 1.0pt;
                mso-border-alt:solid windowtext .5pt;padding:0 5.4pt 0 5.4pt'>
                <p class="MsoNormal"><b>Action<o:p></o:p></b></p>
              </td>
              <td width=200 style='width:150.0pt;border:solid windowtext 1.0pt;
                mso-border-alt:solid windowtext .5pt;padding:0 5.4pt 0 5.4pt'>
                <p class="MsoNormal"><b>Expected Result<o:p></o:p></b></p>
              </td>
            </tr>
            <tr style='mso-yfti-irow:1'>
              <td width=100 style='width:75.0pt;border:solid windowtext 1.0pt;
                padding:0 5.4pt 0 5.4pt'>
                <p class="MsoNormal">1<o:p></o:p></p>
              </td>
              <td width=300 style='width:225.0pt;border:solid windowtext 1.0pt;
                padding:0 5.4pt 0 5.4pt'>
                <p class="MsoNormal">Click the <b>New Project</b> button<o:p></o:p></p>
              </td>
              <td width=200 style='width:150.0pt;border:solid windowtext 1.0pt;
                padding:0 5.4pt 0 5.4pt'>
                <p class="MsoNormal">Project wizard opens<o:p></o:p></p>
              </td>
            </tr>
            <tr style='mso-yfti-irow:2;mso-yfti-lastrow:yes'>
              <td width=100 style='width:75.0pt;border:solid windowtext 1.0pt;
                padding:0 5.4pt 0 5.4pt'>
                <p class="MsoNormal">2<o:p></o:p></p>
              </td>
              <td width=300 style='width:225.0pt;border:solid windowtext 1.0pt;
                padding:0 5.4pt 0 5.4pt'>
                <p class="MsoNormal">Enter project name and click <b>Create</b><o:p></o:p></p>
              </td>
              <td width=200 style='width:150.0pt;border:solid windowtext 1.0pt;
                padding:0 5.4pt 0 5.4pt'>
                <p class="MsoNormal">Project created successfully<o:p></o:p></p>
              </td>
            </tr>
          </table>
          <p class="MsoNormal">&nbsp;</p>
          <h2>Scene 3: Conclusion</h2>
          <p class="MsoNormal">Return to the <b>Home</b> screen and summarize.</p>
        </body>
      </html>`;

      const { markdown } = await htmlToMarkdown(html);

      // Headings preserved
      expect(markdown).toContain("# Demo Script: Product Launch");
      expect(markdown).toContain("## Scene 1: Introduction");
      expect(markdown).toContain("## Scene 2: Feature Demo");
      expect(markdown).toContain("## Scene 3: Conclusion");

      // Bold and italic preserved
      expect(markdown).toContain("**Narrator:**");
      expect(markdown).toContain("*product launch*");
      expect(markdown).toContain("**Dashboard**");
      expect(markdown).toContain("**Settings**");

      // Table converted to Markdown (not raw HTML)
      expect(markdown).toContain("|");
      expect(markdown).toContain("Step");
      expect(markdown).toContain("Action");
      expect(markdown).toContain("Expected Result");
      expect(markdown).toContain("New Project");
      expect(markdown).toContain("Project wizard opens");
      expect(markdown).not.toContain("<table");
      expect(markdown).not.toContain("<td");
      expect(markdown).not.toContain("MsoTableGrid");
      expect(markdown).not.toContain("windowtext");

      // No Word cruft remains
      expect(markdown).not.toContain("mso-");
      expect(markdown).not.toContain("MsoNormal");
      expect(markdown).not.toContain("o:p");
      expect(markdown).not.toContain("<style");
      expect(markdown).not.toContain("Calibri");

      // No excessive blank lines
      expect(markdown).not.toMatch(/\n{3,}/);
    });

    it("Word document with images", async () => {
      const html = `<html><head>
        <style>p.MsoNormal{font-family:Calibri}</style>
        </head><body>
        <h1 class="MsoNormal">Screenshot Guide</h1>
        <p class="MsoNormal">Step 1: Open the app</p>
        <p class="MsoNormal"><img width=640 height=480
          src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg="
          v:shapes="Picture_x0020_1"></p>
        <p class="MsoNormal">Step 2: Click the button</p>
        <p class="MsoNormal"><img width=640 height=480
          src="data:image/png;base64,R0lGODlhAQABAIAA="
          v:shapes="Picture_x0020_2"></p>
        </body></html>`;

      mockInvoke
        .mockResolvedValueOnce(".cutready/screenshots/pasted-001.png")
        .mockResolvedValueOnce(".cutready/screenshots/pasted-002.png");

      const { markdown } = await htmlToMarkdown(html, { saveImages: true });

      expect(markdown).toContain("# Screenshot Guide");
      expect(markdown).toContain("Step 1: Open the app");
      expect(markdown).toContain("Step 2: Click the button");
      expect(markdown).toContain("pasted-001.png");
      expect(markdown).toContain("pasted-002.png");
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it("Word document with bulleted and numbered lists", async () => {
      const html = `<body>
        <h2 class="MsoNormal">Requirements</h2>
        <ul style='margin-top:0;margin-bottom:0;mso-list:l0 level1 lfo1'>
          <li class="MsoListParagraph" style='mso-list:l0 level1 lfo1'>
            <span style="mso-fareast-font-family:Calibri">User authentication</span></li>
          <li class="MsoListParagraph" style='mso-list:l0 level1 lfo1'>
            <span style="mso-fareast-font-family:Calibri">Data encryption</span></li>
          <li class="MsoListParagraph" style='mso-list:l0 level1 lfo1'>
            <span style="mso-fareast-font-family:Calibri">API rate limiting</span></li>
        </ul>
        <p class="MsoNormal">&nbsp;</p>
        <h2>Steps to Follow</h2>
        <ol style='margin-top:0;margin-bottom:0'>
          <li class="MsoListParagraph">Install dependencies</li>
          <li class="MsoListParagraph">Configure environment</li>
          <li class="MsoListParagraph">Run the tests</li>
        </ol>
      </body>`;

      const { markdown } = await htmlToMarkdown(html);

      expect(markdown).toContain("## Requirements");
      expect(markdown).toContain("User authentication");
      expect(markdown).toContain("Data encryption");
      expect(markdown).toContain("API rate limiting");
      // Should have list markers
      expect(markdown).toMatch(/^-/m);

      expect(markdown).toContain("## Steps to Follow");
      expect(markdown).toContain("Install dependencies");
      expect(markdown).toContain("Configure environment");
      expect(markdown).toContain("Run the tests");
      // Should have numbered list
      expect(markdown).toMatch(/^\d+\./m);
    });

    it("Word document with mixed formatting", async () => {
      const html = `<body>
        <p class="MsoNormal"><b>Important:</b> This is a <i>critical</i> update.</p>
        <p class="MsoNormal">Visit <a href="https://docs.example.com">the documentation</a> for details.</p>
        <p class="MsoNormal">Use the command <span style="font-family:Consolas;mso-bidi-font-family:Calibri"><code>git pull origin main</code></span> to update.</p>
      </body>`;

      const { markdown } = await htmlToMarkdown(html);

      expect(markdown).toContain("**Important:**");
      expect(markdown).toContain("*critical*");
      expect(markdown).toContain("[the documentation](https://docs.example.com)");
      expect(markdown).toContain("git pull origin main");
    });
  });

  describe("real-world clipboard payloads", () => {
    it("browser article payload keeps headings, links, lists, and code", async () => {
      const html = `<html><body>
        <!--StartFragment-->
        <article>
          <h1>Azure AI Foundry Agent Updates</h1>
          <p>Read the <a href="https://learn.microsoft.com/azure/ai-foundry/">official docs</a>.</p>
          <h2>Highlights</h2>
          <ul>
            <li><strong>Tracing</strong> is now easier to inspect.</li>
            <li>Use <code>list_models</code> before routing image requests.</li>
          </ul>
        </article>
        <!--EndFragment-->
      </body></html>`;

      const { markdown } = await htmlToMarkdown(html);

      expect(markdown).toContain("# Azure AI Foundry Agent Updates");
      expect(markdown).toContain("[official docs](https://learn.microsoft.com/azure/ai-foundry/)");
      expect(markdown).toContain("**Tracing**");
      expect(markdown).toContain("`list_models`");
      expect(markdown).not.toContain("StartFragment");
    });

    it("Teams-style payload strips shell chrome while keeping message content", async () => {
      const html = `<div class="ts-message">
        <div role="heading">Seth Juarez</div>
        <p><span style="font-weight:600">Decision:</span> keep compaction conservative.</p>
        <p>Next steps:</p>
        <ol><li>Add classifier tests</li><li>Run a live smoke test</li></ol>
      </div>`;

      const { markdown } = await htmlToMarkdown(html);

      expect(markdown).toContain("Seth Juarez");
      expect(markdown).toContain("Decision:");
      expect(markdown).toContain("keep compaction conservative");
      expect(markdown).toContain("Add classifier tests");
      expect(markdown).toContain("Run a live smoke test");
      expect(markdown).not.toContain("ts-message");
    });

    it("Outlook-style payload strips Office conditionals and preserves action items", async () => {
      const html = `<html><body>
        <!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]-->
        <p class="MsoNormal"><b>Subject:</b> Demo follow-up</p>
        <p class="MsoNormal">Please fix the following:</p>
        <ul><li>Storyboard focus</li><li>Rich Paste timeout</li></ul>
      </body></html>`;

      const { markdown } = await htmlToMarkdown(html);

      expect(markdown).toContain("**Subject:**");
      expect(markdown).toContain("Demo follow-up");
      expect(markdown).toContain("Storyboard focus");
      expect(markdown).toContain("Rich Paste timeout");
      expect(markdown).not.toContain("OfficeDocumentSettings");
      expect(markdown).not.toContain("MsoNormal");
    });
  });

  // ─── Edge cases ────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty HTML", async () => {
      const { markdown } = await htmlToMarkdown("");
      expect(markdown).toBe("");
    });

    it("handles whitespace-only HTML", async () => {
      const { markdown } = await htmlToMarkdown("   \n   ");
      expect(markdown).toBe("");
    });

    it("handles plain text (no HTML tags)", async () => {
      const { markdown } = await htmlToMarkdown("Just plain text");
      expect(markdown).toBe("Just plain text");
    });

    it("handles HTML entities", async () => {
      const { markdown } = await htmlToMarkdown("<p>Price: $10 &amp; up &mdash; limited time</p>");
      expect(markdown).toContain("$10");
      expect(markdown).toContain("&");
    });

    it("handles single-row table (no body rows)", async () => {
      const html = "<table><tr><td><b>Header Only</b></td></tr></table>";
      const { markdown } = await htmlToMarkdown(html);
      // Should not crash — single row can't become a proper MD table
      expect(markdown).toContain("Header Only");
    });

    it("preserves line breaks within paragraphs", async () => {
      const html = "<p>Line 1<br>Line 2<br>Line 3</p>";
      const { markdown } = await htmlToMarkdown(html);
      expect(markdown).toContain("Line 1");
      expect(markdown).toContain("Line 2");
      expect(markdown).toContain("Line 3");
    });

    it("returns hadHtml: true", async () => {
      const result = await htmlToMarkdown("<p>Hello</p>");
      expect(result.hadHtml).toBe(true);
    });

    it("falls back to basic conversion when backend-enforced AI cleanup times out", async () => {
      mockInvoke.mockRejectedValueOnce("agent_chat timed out after 5ms");
      const html = '<h1>Report</h1><table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table><img src="chart.png">';
      const warnings: string[] = [];

      const { markdown } = await htmlToMarkdown(html, {
        aiConfig: {
          provider: "azure_openai",
          endpoint: "https://example.test",
          api_key: "test",
          model: "gpt-test",
          bearer_token: null,
        },
        aiTimeoutMs: 5,
        onStatus: (message, level) => {
          if (level === "warn") warnings.push(message);
        },
      });

      expect(markdown).toContain("A");
      expect(markdown).toContain("1");
      expect(mockInvoke).toHaveBeenCalledWith("agent_chat", expect.objectContaining({ timeoutMs: 5 }));
      expect(warnings.some((message) => message.includes("timed out"))).toBe(true);
    });
  });

  // ─── Paste complexity detection ─────────────────────────────────

  describe("detectPasteComplexity", () => {
    it("scores simple text as low complexity", () => {
      const result = detectPasteComplexity("<p>Hello world</p>");
      expect(result.score).toBeLessThan(4);
      expect(result.hasTables).toBe(false);
      expect(result.hasImages).toBe(false);
    });

    it("scores tables as complex", () => {
      const html = "<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>";
      const result = detectPasteComplexity(html);
      expect(result.hasTables).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(3);
    });

    it("scores images as moderately complex", () => {
      const html = '<p>Text</p><img src="pic.png"><p>More</p>';
      const result = detectPasteComplexity(html);
      expect(result.hasImages).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(2);
    });

    it("scores tables + images as highly complex", () => {
      const html = `
        <h1>Report</h1>
        <h2>Overview</h2>
        <table><tr><td>A</td></tr></table>
        <img src="chart.png">
        <img src="graph.png">
        <img src="logo.png">`;
      const result = detectPasteComplexity(html);
      expect(result.score).toBeGreaterThanOrEqual(4);
      expect(result.hasTables).toBe(true);
      expect(result.hasImages).toBe(true);
      expect(result.hasMultipleHeadings).toBe(true);
    });

    it("detects nested lists", () => {
      const html = "<ul><li>A<ul><li>B</li></ul></li></ul>";
      const result = detectPasteComplexity(html);
      expect(result.hasNestedLists).toBe(true);
    });
  });

  describe("splitMarkdownChunks", () => {
    it("returns single chunk for short content", () => {
      const md = "# Hello\n\nSome text.";
      const chunks = splitMarkdownChunks(md, 1000);
      expect(chunks).toEqual([md]);
    });

    it("splits at blank lines for large content", () => {
      const section1 = "# Section 1\n\n" + "Line.\n".repeat(50);
      const section2 = "# Section 2\n\n" + "More.\n".repeat(50);
      const md = section1 + "\n" + section2;
      const chunks = splitMarkdownChunks(md, 400);
      expect(chunks.length).toBeGreaterThan(1);
      // All original content is preserved
      const rejoined = chunks.join("\n\n");
      for (const keyword of ["Section 1", "Section 2", "Line.", "More."]) {
        expect(rejoined).toContain(keyword);
      }
    });

    it("splits at headings when possible", () => {
      const md = "# A\n\nText A.\n\n## B\n\nText B.\n\n## C\n\nText C.";
      const chunks = splitMarkdownChunks(md, 25);
      expect(chunks.length).toBeGreaterThan(1);
      // Each chunk should be non-empty
      for (const chunk of chunks) {
        expect(chunk.trim().length).toBeGreaterThan(0);
      }
    });

    it("never produces empty chunks", () => {
      const md = "\n\n\n# Title\n\nContent\n\n\n";
      const chunks = splitMarkdownChunks(md, 10);
      for (const chunk of chunks) {
        expect(chunk.trim().length).toBeGreaterThan(0);
      }
    });

    it("preserves all content across chunks", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: some content here`);
      const md = lines.join("\n");
      const chunks = splitMarkdownChunks(md, 500);
      const rejoined = chunks.join("\n\n");
      for (const line of lines) {
        expect(rejoined).toContain(line);
      }
    });
  });
});

