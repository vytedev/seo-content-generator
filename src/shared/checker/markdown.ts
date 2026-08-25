import { fromMarkdown } from "mdast-util-from-markdown";
import type {
  Blockquote,
  Content,
  Heading,
  Link,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
} from "mdast";

export type MarkdownBlockKind = "heading" | "paragraph" | "list_item" | "blockquote";

export interface MarkdownLink {
  text: string;
  url: string;
}

export interface MarkdownBlock {
  kind: MarkdownBlockKind;
  text: string;
  line_start: number;
  line_end: number;
  section: string | null;
  section_path: string[];
  heading_level?: number;
  ordered?: boolean;
  links: MarkdownLink[];
  /** Semantic identity used internally for stable finding IDs; not tied to source lines. */
  semantic_key?: string;
}

export interface ParsedMarkdown {
  blocks: MarkdownBlock[];
  headings: MarkdownBlock[];
  paragraphs: MarkdownBlock[];
  list_items: MarkdownBlock[];
  blockquotes: MarkdownBlock[];
  links: Array<
    MarkdownLink & {
      line: number;
      section: string | null;
      section_path: string[];
      semantic_key?: string;
    }
  >;
  prose: string;
}

function normalise(value: string): string {
  return value.toLocaleLowerCase("en-GB").replace(/\s+/g, " ").trim();
}

/** Extract visible prose while deliberately excluding code and image alternative text. */
function phrasingText(nodes: PhrasingContent[]): string {
  const parts: string[] = [];
  const visit = (node: PhrasingContent) => {
    switch (node.type) {
      case "text":
        parts.push(node.value);
        break;
      case "break":
        parts.push(" ");
        break;
      case "inlineCode":
      case "image":
      case "imageReference":
      case "html":
        break;
      default:
        if ("children" in node) node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return parts.join("").replace(/\s+/g, " ").trim();
}

function nodeText(node: Nodes): string {
  if (node.type === "paragraph" || node.type === "heading") return phrasingText(node.children);
  if ("children" in node)
    return node.children
      .map((child) => nodeText(child))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  return "";
}

function linksIn(
  node: Nodes,
  definitions: ReadonlyMap<string, string>,
): Array<MarkdownLink & { line: number }> {
  const result: Array<MarkdownLink & { line: number }> = [];
  const visit = (current: Nodes) => {
    if (current.type === "link" || current.type === "linkReference") {
      const url =
        current.type === "link" ? current.url : definitions.get(normalise(current.identifier));
      if (url)
        result.push({
          text: phrasingText(current.children),
          url,
          line: current.position?.start.line ?? node.position?.start.line ?? 1,
        });
      return;
    }
    if (
      current.type === "image" ||
      current.type === "imageReference" ||
      current.type === "code" ||
      current.type === "inlineCode"
    )
      return;
    if ("children" in current) current.children.forEach((child) => visit(child));
  };
  visit(node);
  return result;
}

function position(node: Content): { line_start: number; line_end: number } {
  return {
    line_start: node.position?.start.line ?? 1,
    line_end: node.position?.end.line ?? node.position?.start.line ?? 1,
  };
}

/** Parse CommonMark into the framework-neutral checker shape using a standards-based mdast AST. */
export function parseMarkdown(markdown: string): ParsedMarkdown {
  const root: Root = fromMarkdown(markdown);
  const definitions = new Map(
    root.children
      .filter((node) => node.type === "definition")
      .map((node) => [normalise(node.identifier), node.url] as const),
  );
  const blocks: MarkdownBlock[] = [];
  let section: string | null = null;
  let sectionPath: string[] = [];
  // Structural locations deliberately exclude mutable prose. This keeps a finding
  // stable when the prose containing the same subject is edited. Two identical
  // subjects in the same structural container are inherently ambiguous; the
  // checker treats them as the same semantic issue rather than inventing a
  // text-based identity.
  const add = (
    kind: MarkdownBlockKind,
    node: Heading | Paragraph | ListItem | Blockquote,
    extras: Pick<MarkdownBlock, "heading_level" | "ordered"> = {},
  ) => {
    const text = nodeText(node);
    if (!text) return;
    const base = `${sectionPath.map(normalise).join("/") || "document"}|${kind}`;
    const links = linksIn(node, definitions).map(({ text: linkText, url }) => ({
      text: linkText,
      url,
    }));
    blocks.push({
      kind,
      text,
      ...position(node),
      section,
      section_path: [...sectionPath],
      ...extras,
      links,
      semantic_key: base,
    });
  };

  for (const node of root.children) {
    switch (node.type) {
      case "heading": {
        const text = nodeText(node);
        sectionPath = [...sectionPath.slice(0, node.depth - 1), text];
        section = text;
        add("heading", node, { heading_level: node.depth });
        break;
      }
      case "paragraph":
        add("paragraph", node);
        break;
      case "list":
        (node as List).children.forEach((item) =>
          add("list_item", item, { ordered: node.ordered === true }),
        );
        break;
      case "blockquote":
        add("blockquote", node);
        break;
      default:
        // Code, HTML, thematic breaks and definitions are not prose blocks.
        break;
    }
  }

  const links = blocks.flatMap((block) =>
    linksInBlock(root, block, definitions).map((link, index) => ({
      text: link.text,
      url: link.url,
      line: link.line,
      section: block.section,
      section_path: [...block.section_path],
      semantic_key: `${block.semantic_key ?? block.kind}|link|${normalise(link.url)}|${index + 1}`,
    })),
  );
  const proseBlocks = blocks.filter((block) => block.kind !== "heading");
  return {
    blocks,
    headings: blocks.filter((block) => block.kind === "heading"),
    paragraphs: blocks.filter((block) => block.kind === "paragraph"),
    list_items: blocks.filter((block) => block.kind === "list_item"),
    blockquotes: blocks.filter((block) => block.kind === "blockquote"),
    links,
    prose: proseBlocks.map((block) => block.text).join(" "),
  };
}

function linksInBlock(
  root: Root,
  block: MarkdownBlock,
  definitions: ReadonlyMap<string, string>,
): Array<MarkdownLink & { line: number }> {
  const candidate = root.children.find(
    (node) =>
      node.position?.start.line === block.line_start &&
      node.position?.end.line === block.line_end &&
      (block.kind !== "list_item" || node.type === "list"),
  );
  if (candidate && block.kind !== "list_item") return linksIn(candidate, definitions);
  if (block.kind === "list_item") {
    for (const node of root.children) {
      if (node.type !== "list") continue;
      const item = node.children.find(
        (child) =>
          child.position?.start.line === block.line_start &&
          child.position?.end.line === block.line_end,
      );
      if (item) return linksIn(item, definitions);
    }
  }
  return [];
}

export function countWords(value: string): number {
  return value.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}
