import { z } from "zod";
import { FaqItemSchema } from "../checker/contracts.js";

const text = z.string().trim().min(1);

export const DraftClaimSchema = z
  .object({
    text,
    type: z.enum([
      "dimension",
      "material",
      "price",
      "delivery",
      "statistic",
      "provenance",
      "general",
    ]),
    provenance: text.optional(),
    /** Optional structured product handle/SKU/ID supplied by the draft producer; never inferred. */
    product_identifier: text.optional(),
    status: z.enum(["verified", "unverified"]),
  })
  .strict();
export const ImagePlacementSchema = z
  .object({
    /** Stable marker ID; the body must contain exactly `<!-- MOBELARIS_IMAGE:<marker> -->`. */
    marker: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  })
  .strict();
export const DraftImageSchema = z
  .object({ alt: z.string(), filename: z.string(), placement: ImagePlacementSchema })
  .strict();
export type DraftImage = z.infer<typeof DraftImageSchema>;
export const imagePlacementMarker = (marker: string) => `<!-- MOBELARIS_IMAGE:${marker} -->`;

export const StructuredDraftObjectSchema = z
  .object({
    title: text,
    /** Distinct SEO title. Historical stored drafts derive it from `title` at read time only. */
    meta_title: text.optional(),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    meta_description: text.max(160),
    og_title: text,
    og_description: text,
    images: z.array(DraftImageSchema),
    faqs: z.array(FaqItemSchema),
    markdown: text,
    claims: z.array(DraftClaimSchema),
  })
  .strict();
export const StructuredDraftSchema = StructuredDraftObjectSchema.superRefine((draft, context) => {
  const ids = draft.images.map((image) => image.placement.marker);
  if (new Set(ids).size !== ids.length)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["images"],
      message: "Image placement markers must be unique.",
    });
  draft.faqs.forEach((faq, index) => {
    if (!faq.question.trim())
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["faqs", index, "question"],
        message: "FAQ questions must not be empty.",
      });
    if (!faq.answer.trim())
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["faqs", index, "answer"],
        message: "FAQ answers must not be empty.",
      });
  });
});
export type StructuredDraft = z.infer<typeof StructuredDraftSchema>;

const LegacyDraftCoreSchema = z.object({
  title: text,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  meta_description: text.max(160),
  markdown: text,
  claims: z.array(DraftClaimSchema),
});

const LegacyStructuredDraftSchema = LegacyDraftCoreSchema.strict();

/** Historical shape written after on-page fields were added but before exact image placement. */
export const IntermediateLegacyStructuredDraftSchema = LegacyDraftCoreSchema.extend({
  og_title: text,
  og_description: text,
  images: z.array(z.object({ alt: z.string(), filename: z.string() }).strict()),
  faqs: z.array(FaqItemSchema),
}).strict();

export function assertExactImagePlacements(draft: StructuredDraft): void {
  for (const [index, image] of draft.images.entries()) {
    const marker = imagePlacementMarker(image.placement.marker);
    const count = draft.markdown.split(marker).length - 1;
    if (count !== 1)
      throw new Error(`Image placement marker for images.${index} must occur exactly once`);
  }
  const all = [...draft.markdown.matchAll(/<!-- MOBELARIS_IMAGE:([^>]+) -->/g)].map(
    (match) => match[1],
  );
  if (all.length !== draft.images.length || all.some((id) => !idsFor(draft).has(id!)))
    throw new Error("Image placement markers are missing, duplicated or ambiguous");
}
function idsFor(draft: StructuredDraft): Set<string> {
  return new Set(draft.images.map((image) => image.placement.marker));
}

export const LEGACY_DRAFT_PLACEHOLDER = "Legacy draft field unavailable";
export const LegacyDerivedFieldSchema = z.enum([
  "meta_title",
  "og_title",
  "og_description",
  "images",
  "faqs",
]);
export type LegacyDerivedField = z.infer<typeof LegacyDerivedFieldSchema>;
export type StoredDraftReadResult = {
  draft: StructuredDraft;
  legacy_derived_fields: LegacyDerivedField[];
};

/**
 * Historical read adapter only. It upgrades old immutable JSON bytes in memory and reports every
 * derived field; provider output must always use StructuredDraftSchema directly.
 */
export function readStoredStructuredDraft(value: unknown): StoredDraftReadResult {
  const current = StructuredDraftSchema.safeParse(value);
  if (current.success)
    return {
      draft: current.data,
      legacy_derived_fields:
        typeof value === "object" && value !== null && "meta_title" in value ? [] : ["meta_title"],
    };
  const intermediate = IntermediateLegacyStructuredDraftSchema.safeParse(value);
  if (intermediate.success) {
    const { images: _legacyImages, ...preserved } = intermediate.data;
    return {
      draft: StructuredDraftSchema.parse({ ...preserved, images: [] }),
      // Exact markers/placements cannot be inferred from the pre-placement image list.
      legacy_derived_fields: ["meta_title", "images"],
    };
  }
  const legacy = LegacyStructuredDraftSchema.parse(value);
  return {
    draft: StructuredDraftSchema.parse({
      ...legacy,
      og_title: LEGACY_DRAFT_PLACEHOLDER,
      og_description: LEGACY_DRAFT_PLACEHOLDER,
      images: [],
      faqs: [],
    }),
    legacy_derived_fields: ["meta_title", "og_title", "og_description", "images", "faqs"],
  };
}

export const ArtifactSchema = z
  .object({
    id: text,
    run_id: text,
    step_execution_id: text,
    parent_id: text.nullable(),
    kind: text,
    media_type: text,
    body_text: text,
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ArtifactRecord = z.infer<typeof ArtifactSchema>;

export const DocumentVersionSchema = z
  .object({
    id: text,
    run_id: text,
    artifact_id: text,
    parent_id: text.nullable(),
    revision: z.number().int().positive(),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type DocumentVersionRecord = z.infer<typeof DocumentVersionSchema>;
