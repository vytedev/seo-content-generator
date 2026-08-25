import { z } from "zod";

const text = z.string().trim().min(1);

const InternalLinkFields = {
  url: z.string().url(),
  title: text,
  relevance: z.number().min(0).max(1),
  status: z.number().int().min(100).max(599).optional(),
  hierarchy: z
    .enum(["collection", "designer_hub", "sub_collection", "product", "broad_category", "homepage"])
    .optional(),
  hierarchy_rank: z.number().int().min(1).max(6).optional(),
  verified_at: z.string().datetime().optional(),
  verification_method: z.enum(["head", "get"]).optional(),
  source: z
    .enum(["sitemap", "sitemap+gsc", "gsc", "ghost_content", "ghost_content+gsc"])
    .optional(),
  primary_topic: text.optional(),
  keyword_overlap: z.number().min(0).max(1).optional(),
  topical_score: z.number().min(0).max(1).optional(),
  hierarchy_score: z.number().min(0).max(1).optional(),
  gsc_score: z.number().min(0).max(1).optional(),
  gsc_clicks: z.number().nonnegative().optional(),
  gsc_impressions: z.number().nonnegative().optional(),
  gsc_queries: z.array(text).max(100).optional(),
  gsc_property: text.optional(),
  gsc_start_date: z.string().date().optional(),
  gsc_end_date: z.string().date().optional(),
  ghost_id: text.optional(),
  ghost_content_type: z.enum(["post", "page"]).optional(),
  sitemap_url: z.string().url().optional(),
  sitemap_last_modified: z.string().datetime().optional(),
  retrieved_at: z.string().datetime().optional(),
} as const;

/** Compatibility contract for historical/mock artefacts. */
export const InternalLinkSchema = z.object(InternalLinkFields).strict();
export type InternalLink = z.infer<typeof InternalLinkSchema>;

/** Live discovery cannot omit verification, ranking, source or provenance inputs. */
export const LiveInternalLinkSchema = z
  .object({
    ...InternalLinkFields,
    status: z.literal(200),
    hierarchy: InternalLinkFields.hierarchy.unwrap(),
    hierarchy_rank: z.number().int().min(1).max(6),
    verified_at: z.string().datetime(),
    verification_method: z.enum(["head", "get"]),
    source: z.enum(["sitemap", "sitemap+gsc", "gsc", "ghost_content", "ghost_content+gsc"]),
    keyword_overlap: z.number().min(0).max(1),
    topical_score: z.number().min(0).max(1),
    hierarchy_score: z.number().min(0).max(1),
    gsc_score: z.number().min(0).max(1),
    retrieved_at: z.string().datetime(),
  })
  .strict()
  .superRefine((link, context) => {
    if (link.source.includes("ghost") && (!link.ghost_id || !link.ghost_content_type))
      context.addIssue({ code: "custom", message: "Ghost provenance is required" });
    if (link.source.includes("sitemap") && !link.sitemap_url)
      context.addIssue({ code: "custom", message: "Sitemap provenance is required" });
    if (
      link.source.includes("gsc") &&
      (!link.gsc_property || !link.gsc_start_date || !link.gsc_end_date)
    )
      context.addIssue({ code: "custom", message: "GSC provenance is required" });
  });

export const LinkDiscoveryCountsSchema = z
  .object({
    ghost_collected: z.number().int().nonnegative().default(0),
    sitemap_collected: z.number().int().nonnegative().optional(),
    gsc_collected: z.number().int().nonnegative(),
    deduplicated: z.number().int().nonnegative(),
    commercial: z.number().int().nonnegative(),
    editorial: z.number().int().nonnegative(),
    verification_attempted: z.number().int().nonnegative(),
    verification_omitted_bound: z.number().int().nonnegative().optional(),
    verification_omitted_deadline: z.number().int().nonnegative().optional(),
    direct_200: z.number().int().nonnegative(),
    rejected_non_200: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    shortlisted: z.number().int().nonnegative(),
  })
  .strict();
export type LinkDiscoveryCounts = z.infer<typeof LinkDiscoveryCountsSchema>;

export const LinkDiscoveryMetadataSchema = z
  .object({
    availability: z.enum(["available", "partial", "stale", "unavailable"]),
    eligibility: z.enum(["eligible", "blocked"]).default("eligible"),
    reason: z
      .enum([
        "verified_commercial_candidates",
        "source_unavailable",
        "no_candidates",
        "editorial_only",
        "verification_failed",
      ])
      .optional(),
    providerStatus: z
      .object({
        ghost: z.enum(["available", "unavailable", "not_configured"]).optional(),
        sitemap: z.enum(["available", "unavailable", "not_configured"]).optional(),
        gsc: z.enum(["available", "unavailable", "not_configured", "not_connected"]),
      })
      .strict()
      .refine((status) => Boolean(status.sitemap || status.ghost), {
        message:
          "Sitemap status is required for current artefacts; Ghost status is retained for historical artefacts",
      }),
    counts: LinkDiscoveryCountsSchema.default({
      ghost_collected: 0,
      gsc_collected: 0,
      deduplicated: 0,
      commercial: 0,
      editorial: 0,
      verification_attempted: 0,
      direct_200: 0,
      rejected_non_200: 0,
      unresolved: 0,
      shortlisted: 0,
    }),
    cache: z
      .object({
        state: z.enum(["miss", "fresh", "stale", "refreshed"]),
        retrieved_at: z.string().datetime().nullable(),
        expires_at: z.string().datetime().nullable(),
      })
      .strict()
      .default({ state: "miss", retrieved_at: null, expires_at: null }),
    identity: z
      .object({
        query_hash: z.string().regex(/^[a-f0-9]{64}$/),
        config_hash: z.string().regex(/^[a-f0-9]{64}$/),
        origin_policy_hash: z.string().regex(/^[a-f0-9]{64}$/),
        request_hash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .default({
        query_hash: "0".repeat(64),
        config_hash: "0".repeat(64),
        origin_policy_hash: "0".repeat(64),
        request_hash: "0".repeat(64),
      }),
    bypass: z
      .object({
        enabled: z.boolean(),
        used: z.boolean(),
        reason: z.enum(["local_unverified_link_testing"]).nullable(),
      })
      .strict()
      .default({ enabled: false, used: false, reason: null })
      .superRefine((bypass, context) => {
        if (bypass.used && (!bypass.enabled || !bypass.reason))
          context.addIssue({
            code: "custom",
            message: "Used bypass requires enabled state and reason",
          });
        if (!bypass.used && bypass.reason)
          context.addIssue({ code: "custom", message: "Unused bypass cannot have a reason" });
      }),
    cacheId: z.string().uuid().optional(),
    cacheWrite: z
      .object({
        cache_key: text,
        request_hash: z.string().regex(/^[a-f0-9]{64}$/),
        response_hash: z.string().regex(/^[a-f0-9]{64}$/),
        provider: text,
        retrieved_at: z.string().datetime(),
        expires_at: z.string().datetime(),
        payload: z.unknown(),
        observed_retrieved_at: z.string().datetime().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LinkDiscoveryMetadata = z.infer<typeof LinkDiscoveryMetadataSchema>;
export type LinkDiscoveryMetadataInput = z.input<typeof LinkDiscoveryMetadataSchema>;
