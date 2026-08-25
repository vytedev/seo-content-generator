import { z } from "zod";

const text = z.string();
const httpUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: "URL must use HTTP or HTTPS." },
  );

export const ImageFieldSchema = z.object({ alt: text, filename: text }).strict();
export const FaqItemSchema = z.object({ question: text, answer: text }).strict();
export const OnPageFieldsSchema = z
  .object({
    meta_title: text,
    meta_description: text,
    og_title: text,
    og_description: text,
    slug: text,
    images: z.array(ImageFieldSchema),
    faqs: z.array(FaqItemSchema),
  })
  .strict();

export const InternalLinkHierarchySchema = z.enum([
  "collection",
  "designer_hub",
  "sub_collection",
  "product",
  "broad_category",
  "homepage",
]);
export type InternalLinkHierarchy = z.infer<typeof InternalLinkHierarchySchema>;

export const INTERNAL_LINK_HIERARCHY_RANK = {
  collection: 1,
  designer_hub: 2,
  sub_collection: 3,
  product: 4,
  broad_category: 5,
  homepage: 6,
} as const satisfies Record<InternalLinkHierarchy, number>;

export const VerifiedInternalLinkSchema = z
  .object({
    url: httpUrl,
    status: z.number().int().min(100).max(599),
    hierarchy: InternalLinkHierarchySchema,
    hierarchy_rank: z.number().int().min(1).max(6),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.hierarchy_rank !== INTERNAL_LINK_HIERARCHY_RANK[value.hierarchy]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hierarchy_rank"],
        message: `Hierarchy ${value.hierarchy} must have rank ${INTERNAL_LINK_HIERARCHY_RANK[value.hierarchy]}.`,
      });
    }
  });

function normaliseKeyword(value: string): string {
  return value.toLocaleLowerCase("en-GB").replace(/\s+/g, " ").trim();
}

export function normaliseHttpUrl(value: string): string {
  const url = new URL(value);
  url.hostname = url.hostname.toLocaleLowerCase("en-GB");
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

/** Boundary contract for deterministic step 1.4. Empty content values remain checkable. */
export const CheckerInputSchema = z
  .object({
    primary_keyword: z.string().trim().min(1),
    related_keywords: z.array(z.string().trim().min(1)).min(1),
    body_markdown: z.string(),
    on_page: OnPageFieldsSchema,
    internal_origins: z.array(httpUrl).min(1),
    verified_internal_links: z.array(VerifiedInternalLinkSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const related = value.related_keywords.map(normaliseKeyword);
    if (new Set(related).size !== related.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["related_keywords"],
        message: "Related keywords must be unique (case-insensitive).",
      });
    }
    if (related.includes(normaliseKeyword(value.primary_keyword))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["related_keywords"],
        message: "Primary and related keywords must not overlap.",
      });
    }

    const origins = value.internal_origins.flatMap((origin, index) => {
      try {
        const url = new URL(origin);
        if (origin !== url.origin) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["internal_origins", index],
            message:
              "Internal origin must be an exact HTTP(S) origin without path, query or fragment.",
          });
        }
        return [url.origin.toLocaleLowerCase("en-GB")];
      } catch {
        return [];
      }
    });
    if (new Set(origins).size !== origins.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["internal_origins"],
        message: "Internal origins must be unique.",
      });
    }

    const shortlistUrls = value.verified_internal_links.flatMap((link) => {
      try {
        return [normaliseHttpUrl(link.url)];
      } catch {
        return [];
      }
    });
    if (new Set(shortlistUrls).size !== shortlistUrls.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verified_internal_links"],
        message: "Shortlist URLs must be unique after normalisation.",
      });
    }
    value.verified_internal_links.forEach((link, index) => {
      try {
        if (!origins.includes(new URL(link.url).origin.toLocaleLowerCase("en-GB"))) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["verified_internal_links", index, "url"],
            message: "Shortlist URL must belong to an authoritative internal origin.",
          });
        }
      } catch {
        // The nested URL schema reports malformed URLs.
      }
    });
  });
export type CheckerInput = z.infer<typeof CheckerInputSchema>;

export const FindingSeveritySchema = z.enum(["info", "warning", "blocker"]);
export const FindingLocationSchema = z
  .object({
    field: z.string().min(1),
    line_start: z.number().int().positive().optional(),
    line_end: z.number().int().positive().optional(),
    section: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((location, context) => {
    if (location.line_end !== undefined && location.line_start === undefined)
      context.addIssue({
        code: "custom",
        path: ["line_end"],
        message: "line_end requires line_start",
      });
    if (location.line_end !== undefined && location.line_end < location.line_start!)
      context.addIssue({
        code: "custom",
        path: ["line_end"],
        message: "Location range must be ordered",
      });
  });

/** Normalised finding emitted by deterministic checks and suitable for later operator review. */
export const FindingSchema = z
  .object({
    id: z.string().regex(/^det_[0-9a-f]{8}$/),
    rule: z.string().min(1),
    severity: FindingSeveritySchema,
    location: FindingLocationSchema,
    issue: z.string().min(1),
    suggested_fix: z.string().min(1),
    provisional: z.boolean(),
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;
