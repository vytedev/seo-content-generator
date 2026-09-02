import { z } from "zod";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Root, Content, PhrasingContent } from "mdast";
import { StructuredDraftSchema, assertExactImagePlacements, contentHash } from "./milestone-two.js";
import { normaliseHttpUrl } from "./checker/contracts.js";
import { assertEditoriallyExportable } from "./editorial-integrity.js";
import { HardFlagReasonSchema } from "./hard-flags.js";

const text = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ExportSourceSchema = z
  .object({
    id: text,
    uri: z.string().url(),
    title: text.optional(),
    publisher: text.optional(),
    retrieved_at: z.string().datetime({ offset: true }),
    content_hash: hash,
    evidence_location: text.optional(),
    evidence: text.optional(),
    evidence_hash: hash.nullable(),
  })
  .strict();
export const ExportClaimSchema = z
  .object({
    id: text,
    claim_text: text,
    type: z.enum([
      "dimension",
      "material",
      "price",
      "delivery",
      "statistic",
      "provenance",
      "general",
    ]),
    status: z.enum(["verified", "unverified", "contradicted"]),
    hard_flag: z.boolean(),
    /** Persisted additively from S2; absent on historical rows. */
    hard_flag_reason: HardFlagReasonSchema.nullable().optional(),
    location: z.record(z.string(), z.unknown()),
    product_identifier: text.optional(),
    claim_hash: hash,
    sources: z.array(ExportSourceSchema),
  })
  .strict()
  .superRefine((claim, context) => {
    if (!claim.hard_flag && claim.hard_flag_reason)
      context.addIssue({
        code: "custom",
        path: ["hard_flag_reason"],
        message: "A non-hard-flagged export claim cannot have a mandatory-review reason.",
      });
  });
export type ExportClaim = z.infer<typeof ExportClaimSchema>;
export const ExportRejectedFindingSchema = z
  .object({
    finding_id: text,
    disposition_id: text,
    review_set_id: text,
    review_set_membership_hash: hash,
    stable_key: text,
    category: text,
    rule_reference: text,
    severity: z.enum(["info", "warning", "blocker"]),
    location: z.record(z.string(), z.unknown()),
    issue: text,
    evidence: text.optional(),
    suggested_fix: text,
    rationale: z.string().nullable(),
    finding_hash: hash,
    disposition_hash: hash,
  })
  .strict();
export type ExportRejectedFinding = z.infer<typeof ExportRejectedFindingSchema>;
export const ExportLinkSchema = z
  .object({ url: z.string().url(), title: text, relevance: z.number() })
  .strict();
export type ExportLink = z.infer<typeof ExportLinkSchema>;
export const TemplateStatusSchema = z.enum(["pending_editorial_approval", "approved"]);
export const BlogSchemaTemplateSchema = z
  .object({
    row_id: text,
    registry_id: text,
    version: text,
    status: TemplateStatusSchema,
    requirements: z.array(text),
    body_hash: hash,
    policy: z.enum(["authorised", "local_pending_explicit"]),
  })
  .strict();
export const WriterTemplateSchema = z
  .object({
    row_id: text,
    template_id: text,
    version: text,
    status: TemplateStatusSchema,
    section_order: z.array(text).min(1),
    required_metadata: z.array(text),
    body_hash: hash,
    policy: z.enum(["authorised", "local_pending_explicit"]),
  })
  .strict();
export type WriterTemplate = z.infer<typeof WriterTemplateSchema>;
export type BlogSchemaTemplate = z.infer<typeof BlogSchemaTemplateSchema>;
const defaultHash = (value: unknown) => contentHash(JSON.stringify(value));
const writerBody = {
  section_order: [
    "Metadata",
    "Body copy",
    "Images",
    "FAQ",
    "Internal links used",
    "Schema requirements",
    "Translatable elements",
    "Fact-check claims",
    "Outstanding rejected findings",
  ],
  required_metadata: [
    "H1",
    "Author",
    "Date",
    "URL slug",
    "Meta title",
    "Meta description",
    "OG title",
    "OG description",
  ],
};
const schemaBody = {
  requirements: [
    "Article: headline, description, date, author (Mobelaris), image list",
    "FAQPage: one Question/Answer pair per exported FAQ, answerText verbatim",
    "BreadcrumbList: blog section path; exact approved template remains pending",
  ],
};
export const DEFAULT_WRITER_TEMPLATE = WriterTemplateSchema.parse({
  row_id: "00000000-0000-4000-8000-000000000101",
  template_id: "mobelaris.writer-submission",
  version: "1.0.0",
  status: "pending_editorial_approval",
  ...writerBody,
  body_hash: defaultHash(writerBody),
  policy: "local_pending_explicit",
});
export const DEFAULT_BLOG_SCHEMA_TEMPLATE = BlogSchemaTemplateSchema.parse({
  row_id: "00000000-0000-4000-8000-000000000102",
  registry_id: "mobelaris.blog-schema",
  version: "1.0.0",
  status: "pending_editorial_approval",
  ...schemaBody,
  body_hash: defaultHash(schemaBody),
  policy: "local_pending_explicit",
});

export const ExportRenderInputSchema = z
  .object({
    plane_ticket: text,
    draft: StructuredDraftSchema,
    author: text.default("Mobelaris"),
    primary_keyword: z.string().optional(),
    related_keywords: z.array(z.string()).default([]),
    page_type: z.string().optional(),
    locales_for_translation: z.array(z.string()).default([]),
    export_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .default("1970-01-01"),
    internal_links: z.array(ExportLinkSchema).default([]),
    claims: z.array(ExportClaimSchema).default([]),
    rejected_findings: z.array(ExportRejectedFindingSchema).default([]),
    writer_template: WriterTemplateSchema,
    schema_template: BlogSchemaTemplateSchema,
  })
  .strict();
export type ExportRenderInput = z.input<typeof ExportRenderInputSchema>;

export const InlineSpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    kind: z.enum(["bold", "italic", "code", "link"]),
    target: z.string().url().optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.end <= v.start) c.addIssue({ code: "custom", message: "Inline span must be ordered" });
    if ((v.kind === "link") !== Boolean(v.target))
      c.addIssue({ code: "custom", message: "Only links have targets" });
  });
const richText = { text: z.string(), spans: z.array(InlineSpanSchema).default([]) };
const RichTextSchema = z
  .object(richText)
  .strict()
  .superRefine((v, c) => {
    for (const [i, span] of v.spans.entries())
      if (span.end > v.text.length)
        c.addIssue({ code: "custom", path: ["spans", i], message: "Inline span is out of bounds" });
  });
export const GoogleDocsOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("paragraph"),
      style: z.enum(["TITLE", "HEADING_1", "HEADING_2", "HEADING_3", "NORMAL_TEXT"]),
      ...richText,
    })
    .strict(),
  z
    .object({
      type: z.literal("list_item"),
      ordered: z.boolean(),
      nesting_level: z.number().int().min(1).max(8).optional(),
      ...richText,
    })
    .strict(),
  z.object({ type: z.literal("blockquote"), ...richText }).strict(),
  z
    .object({ type: z.literal("table"), rows: z.array(z.array(RichTextSchema).min(1)).min(1) })
    .strict(),
  z
    .object({ type: z.literal("image_marker"), marker_id: text, filename: text, alt: text, text })
    .strict(),
]);
export type GoogleDocsOperation = z.infer<typeof GoogleDocsOperationSchema>;
export const ExportRenderResultSchema = z
  .object({
    title: text,
    markdown: z.string().min(1),
    content_hash: hash,
    render_hash: hash,
    operations: z.array(GoogleDocsOperationSchema),
    operation_count: z.number().int().nonnegative(),
  })
  .strict();
export type ExportRenderResult = z.infer<typeof ExportRenderResultSchema>;

function linksInMarkdown(markdown: string): ExportLink[] {
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const found: ExportLink[] = [];
  const walk = (node: any) => {
    if (node.type === "link")
      found.push({ url: node.url, title: rich(node.children).text || node.url, relevance: 0 });
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return found;
}
function validateLinks(markdown: string, shortlist: ExportLink[]): ExportLink[] {
  const byUrl = new Map(shortlist.map((x) => [normaliseHttpUrl(x.url), x]));
  return linksInMarkdown(markdown).map((link) => {
    const frozen = byUrl.get(normaliseHttpUrl(link.url));
    if (!frozen)
      throw new Error("Final Markdown contains an internal link outside the frozen shortlist");
    return { ...frozen, title: link.title };
  });
}
function rich(nodes: PhrasingContent[]): z.infer<typeof RichTextSchema> {
  let value = "";
  const spans: z.infer<typeof InlineSpanSchema>[] = [];
  const walk = (node: any, inherited?: "bold" | "italic" | "code") => {
    const start = value.length;
    if (node.type === "text" || node.type === "inlineCode") value += node.value;
    else if (node.type === "break") value += "\n";
    else
      for (const child of node.children ?? [])
        walk(
          child,
          node.type === "strong" ? "bold" : node.type === "emphasis" ? "italic" : inherited,
        );
    const end = value.length;
    const kind =
      node.type === "link"
        ? "link"
        : node.type === "inlineCode"
          ? "code"
          : node.type === "strong"
            ? "bold"
            : node.type === "emphasis"
              ? "italic"
              : undefined;
    if (kind && end > start)
      spans.push(
        InlineSpanSchema.parse({
          start,
          end,
          kind,
          ...(kind === "link" ? { target: node.url } : {}),
        }),
      );
  };
  for (const node of nodes) walk(node);
  return RichTextSchema.parse({
    text: value,
    spans: spans.sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind)),
  });
}
function markdownOperations(
  markdown: string,
  images: z.infer<typeof StructuredDraftSchema>["images"],
): GoogleDocsOperation[] {
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Root;
  const byMarker = new Map(images.map((i) => [i.placement.marker, i]));
  const out: GoogleDocsOperation[] = [];
  const emitList = (list: any, nestingLevel = 0) => {
    for (const item of list.children ?? []) {
      const directBlocks = (item.children ?? []).filter((child: any) => child.type !== "list");
      const phrasing = directBlocks.flatMap((block: any, index: number) => [
        ...(index === 0 ? [] : [{ type: "break" }]),
        ...(block.children ?? []),
      ]) as PhrasingContent[];
      out.push(
        GoogleDocsOperationSchema.parse({
          type: "list_item",
          ordered: Boolean(list.ordered),
          ...(nestingLevel > 0 ? { nesting_level: nestingLevel } : {}),
          ...rich(phrasing),
        }),
      );
      for (const child of item.children ?? [])
        if (child.type === "list") emitList(child, nestingLevel + 1);
    }
  };
  const emit = (node: Content) => {
    const n: any = node;
    if (n.type === "heading")
      out.push({
        type: "paragraph",
        style: `HEADING_${Math.min(n.depth, 3)}` as any,
        ...rich(n.children),
      });
    else if (n.type === "paragraph")
      out.push({ type: "paragraph", style: "NORMAL_TEXT", ...rich(n.children) });
    else if (n.type === "blockquote")
      out.push({ type: "blockquote", ...rich(n.children.flatMap((x: any) => x.children ?? [])) });
    else if (n.type === "list") emitList(n);
    else if (n.type === "html") {
      const match = /^<!-- MOBELARIS_IMAGE:([a-z0-9-]+) -->$/.exec(n.value.trim());
      if (match) {
        const image = byMarker.get(match[1]!);
        if (!image) throw new Error("Unknown image placement marker");
        out.push({
          type: "image_marker",
          marker_id: match[1]!,
          filename: image.filename,
          alt: image.alt,
          text: `[IMAGE ${match[1]} | filename: ${image.filename} | alt: ${image.alt}]`,
        });
      }
    } else if (n.type === "table")
      out.push({
        type: "table",
        rows: n.children.map((r: any) => r.children.map((c: any) => rich(c.children))),
      });
    else if (n.children) for (const child of n.children) emit(child);
  };
  for (const child of root.children) emit(child);
  return out.map((x) => GoogleDocsOperationSchema.parse(x));
}
const escape = (v: string) => v.replaceAll("|", "\\|").replaceAll("\n", " ");
function assertTemplatePolicy(template: {
  status: "approved" | "pending_editorial_approval";
  policy: "authorised" | "local_pending_explicit";
}) {
  if ((template.status === "approved") !== (template.policy === "authorised"))
    throw new Error("Template status and explicit selection policy conflict");
}
export function renderExport(input: unknown): ExportRenderResult {
  const p = ExportRenderInputSchema.parse(input);
  assertExactImagePlacements(p.draft);
  assertEditoriallyExportable(p.draft, p.primary_keyword ?? "");
  assertTemplatePolicy(p.writer_template);
  assertTemplatePolicy(p.schema_template);
  const used = validateLinks(p.draft.markdown, p.internal_links);
  const none = (v?: string) => v?.trim() || "None";
  const sections: Record<string, string> = {
    Metadata: [
      `# ${p.draft.title}`,
      "",
      "## Metadata",
      "",
      `- H1: ${p.draft.title}`,
      `- Author: ${p.author}`,
      `- Plane ticket: ${p.plane_ticket}`,
      `- Page type: ${none(p.page_type)}`,
      `- Primary keyword: ${none(p.primary_keyword)}`,
      `- Related keywords: ${p.related_keywords.join(", ") || "None"}`,
      `- Locales for translation: ${p.locales_for_translation.join(", ") || "None"}`,
      `- URL slug: ${p.draft.slug}`,
      `- Meta title: ${p.draft.meta_title ?? p.draft.title}`,
      `- Meta description: ${p.draft.meta_description}`,
      `- OG title: ${p.draft.og_title}`,
      `- OG description: ${p.draft.og_description}`,
      `- Date: ${p.export_date}`,
      `- Writer template status: ${p.writer_template.status} (${p.writer_template.policy})`,
      `- Schema template status: ${p.schema_template.status} (${p.schema_template.policy})`,
    ].join("\n"),
    "Body copy": ["## Body copy", "", p.draft.markdown.trim()].join("\n"),
    Images: [
      "## Images",
      "",
      ...(p.draft.images.length
        ? p.draft.images.map(
            (i) => `- ${i.filename} | alt: ${i.alt} | marker ID: ${i.placement.marker}`,
          )
        : ["None"]),
    ].join("\n"),
    FAQ: [
      "## FAQ",
      "",
      ...(p.draft.faqs.length
        ? p.draft.faqs.flatMap((f) => [`### ${f.question}`, "", f.answer, ""])
        : ["None"]),
    ].join("\n"),
    "Internal links used": [
      "## Internal links used",
      "",
      ...(used.length ? used.map((l) => `- [${l.title}](${l.url})`) : ["None"]),
    ].join("\n"),
    "Schema requirements": [
      "## Schema requirements",
      "",
      `Frozen template: ${p.schema_template.registry_id}@${p.schema_template.version} — ${p.schema_template.status}`,
      ...p.schema_template.requirements.map((x) => `- ${x}`),
    ].join("\n"),
    "Translatable elements": [
      "## Translatable elements",
      "",
      ...(p.locales_for_translation.length
        ? p.locales_for_translation.flatMap((locale) => [
            `### ${locale}`,
            "- H1 and metadata",
            "- URL slug",
            "- Body headings, paragraphs, lists, quotations and link visible text (targets unchanged)",
            "- FAQ questions and answers",
            "- Image alt text (marker IDs and filenames unchanged)",
          ])
        : ["None — no translation locales in the frozen handoff"]),
    ].join("\n"),
    "Fact-check claims": [
      "## Fact-check claims",
      "",
      "| Claim ID | Claim | Type | Status | Mandatory | Location | Product ID | Source IDs / evidence hashes |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...(p.claims.length
        ? p.claims.map(
            (c) =>
              `| ${c.id} | ${escape(c.claim_text)} | ${c.type} | ${c.status} | ${c.hard_flag ? "yes" : "no"} | ${escape(JSON.stringify(c.location))} | ${escape(c.product_identifier ?? "None")} | ${escape(c.sources.map((s) => `${s.id}: ${s.uri} [${s.content_hash}/${s.evidence_hash ?? "no evidence hash"}]`).join("; ") || "None")} |`,
          )
        : ["| None | None | None | None | None | None | None | None |"]),
    ].join("\n"),
    "Outstanding rejected findings": [
      "## Outstanding rejected findings",
      "",
      ...(p.rejected_findings.length
        ? p.rejected_findings.flatMap((f) => [
            `- ${f.finding_id} / ${f.disposition_id} | ${f.stable_key} | ${f.category} | ${f.rule_reference} | ${f.severity} | ${JSON.stringify(f.location)}`,
            `  Issue: ${f.issue}`,
            `  Evidence: ${f.evidence ?? "None"}`,
            `  Suggested fix (not applied): ${f.suggested_fix}`,
            `  Rejection rationale: ${f.rationale ?? "No rationale supplied"}`,
          ])
        : ["None"]),
    ].join("\n"),
  };
  const order = p.writer_template.section_order;
  if (
    new Set(order).size !== order.length ||
    order.some((x) => !(x in sections)) ||
    order.length !== Object.keys(sections).length
  )
    throw new Error("Writer template is missing or duplicates required renderer blocks");
  for (const field of p.writer_template.required_metadata)
    if (!sections.Metadata!.includes(`- ${field}:`))
      throw new Error(`Writer template requires missing metadata field: ${field}`);
  const markdown = `${order.map((x) => sections[x]).join("\n\n")}\n`;
  const operations = markdownOperations(markdown, p.draft.images);
  return ExportRenderResultSchema.parse({
    title: p.draft.title,
    markdown,
    content_hash: contentHash(markdown),
    render_hash: contentHash(JSON.stringify(operations)),
    operations,
    operation_count: operations.length,
  });
}
export const GoogleDocsExportSchema = z
  .object({ external_document_id: text, external_url: z.string().url(), replayed: z.boolean() })
  .strict();
export type GoogleDocsExport = z.infer<typeof GoogleDocsExportSchema>;
export interface GoogleDocsAdapter {
  export(key: string, rendered: ExportRenderResult): Promise<GoogleDocsExport>;
}
