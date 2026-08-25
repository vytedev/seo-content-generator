import { describe, expect, it } from "vitest";
import { countWords, parseMarkdown } from "../src/shared/checker/index.js";

describe("stable Markdown parser", () => {
  it("normalises CRLF, joins paragraph lines and records sections and locations", () => {
    const parsed = parseMarkdown(
      "# Main\r\n\r\nFirst line\r\nsecond [link](https://example.com/a).\r\n\r\n## Next",
    );
    expect(parsed.headings.map((item) => [item.text, item.heading_level, item.line_start])).toEqual(
      [
        ["Main", 1, 1],
        ["Next", 2, 6],
      ],
    );
    expect(parsed.paragraphs[0]).toMatchObject({
      text: "First line second link.",
      line_start: 3,
      line_end: 4,
      section: "Main",
      section_path: ["Main"],
    });
    expect(parsed.links).toEqual([
      expect.objectContaining({
        text: "link",
        url: "https://example.com/a",
        line: 4,
        section: "Main",
        section_path: ["Main"],
      }),
    ]);
  });

  it("distinguishes ordered and unordered lists and groups consecutive blockquotes", () => {
    const parsed = parseMarkdown("## Items\n- One\n2. Two\n\n> Note one\n> Note two");
    expect(parsed.list_items.map(({ text, ordered }) => [text, ordered])).toEqual([
      ["One", false],
      ["Two", true],
    ]);
    expect(parsed.blockquotes[0]).toMatchObject({
      text: "Note one Note two",
      line_start: 5,
      line_end: 6,
    });
  });

  it("excludes fenced code including Markdown-looking content and supports tilde fences", () => {
    const parsed = parseMarkdown(
      "# Kept\n```md\n## Hidden\n[bad](https://bad.test)\n```\n~~~\n> hidden\n~~~\nVisible text",
    );
    expect(parsed.headings.map((item) => item.text)).toEqual(["Kept"]);
    expect(parsed.links).toEqual([]);
    expect(parsed.paragraphs.map((item) => item.text)).toEqual(["Visible text"]);
  });

  it("does not treat images as links and strips common inline formatting", () => {
    const parsed = parseMarkdown(
      "Text with ![chair](image.jpg), **bold**, `code` and [real](https://example.test).",
    );
    expect(parsed.links).toHaveLength(1);
    expect(parsed.paragraphs[0]?.text).toBe("Text with , bold, and real.");
  });

  it("supports CommonMark setext, balanced destinations and reference links with positions", () => {
    const parsed = parseMarkdown(
      "Main title\n==========\n\nRead [balanced](https://example.test/a_(b)) and [reference][shop].\n\n[shop]: https://example.test/shop",
    );
    expect(parsed.headings[0]).toMatchObject({ text: "Main title", heading_level: 1, line_end: 2 });
    expect(parsed.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "https://example.test/a_(b)", line: 4 }),
        expect.objectContaining({ url: "https://example.test/shop", line: 4 }),
      ]),
    );
  });

  it("excludes code and image alternatives from prose while retaining surrounding text", () => {
    const parsed = parseMarkdown(
      "Visible `ergonomic chairs` text ![ergonomic chairs](chair.jpg).\n\n```md\nergonomic chairs\n```",
    );
    expect(parsed.prose).toBe("Visible text .");
    expect(parsed.links).toEqual([]);
  });

  it("retains heading ancestry for nested placement rules", () => {
    const parsed = parseMarkdown(
      "# Article\n## Conclusion\n### Products\nUse [this](https://example.test/item).",
    );
    expect(parsed.paragraphs[0]).toMatchObject({
      section: "Products",
      section_path: ["Article", "Conclusion", "Products"],
    });
    expect(parsed.links[0]?.section_path).toEqual(["Article", "Conclusion", "Products"]);
  });

  it("counts hyphenated words and contractions consistently", () => {
    expect(countWords("reader-first isn't an after-thought — it’s useful")).toBe(6);
    expect(countWords("  -- ")).toBe(0);
  });
});
