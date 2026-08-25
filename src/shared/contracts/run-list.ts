import { z } from "zod";
import { RunSummarySchema } from "./run-detail.js";

/**
 * The paginated blog-post history contract.
 *
 * The status groups live here and nowhere else: the API validates against them,
 * the repositories build their SQL from them and the table labels them, so a
 * status can never mean one thing in the query and another in the interface.
 */
export const RunStatusSchema = RunSummarySchema.shape.status;
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RUN_LIST_FILTERS = [
  "all",
  "needs_attention",
  "in_progress",
  "finished",
  "cancelled",
] as const;
export const RunListFilterSchema = z.enum(RUN_LIST_FILTERS);
export type RunListFilter = z.infer<typeof RunListFilterSchema>;

/** The one definition of which run statuses each filter selects. */
export const RUN_LIST_FILTER_STATUSES = {
  all: RunStatusSchema.options,
  needs_attention: ["waiting", "retryable_failed", "blocked"],
  in_progress: ["queued", "running"],
  finished: ["succeeded"],
  cancelled: ["cancelled"],
} as const satisfies Record<RunListFilter, readonly RunStatus[]>;

/** Operator-facing names for each filter, so the API and table never disagree. */
export const RUN_LIST_FILTER_LABELS = {
  all: "All",
  needs_attention: "Needs attention",
  in_progress: "In progress",
  finished: "Finished",
  cancelled: "Cancelled",
} as const satisfies Record<RunListFilter, string>;

export const RUN_LIST_DEFAULT_PAGE = 1;
export const RUN_LIST_DEFAULT_LIMIT = 10;
export const RUN_LIST_MAX_LIMIT = 50;

/**
 * Query parameters arrive as strings, so they are coerced and then validated.
 * Anything that is not a positive integer, or an unknown filter, is rejected
 * rather than quietly replaced with a default.
 */
export const RunListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(RUN_LIST_DEFAULT_PAGE),
  limit: z.coerce.number().int().positive().max(RUN_LIST_MAX_LIMIT).default(RUN_LIST_DEFAULT_LIMIT),
  filter: RunListFilterSchema.default("all"),
});
export type RunListQuery = z.infer<typeof RunListQuerySchema>;

export const RunListPaginationSchema = z
  .object({
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total_items: z.number().int().nonnegative(),
    total_pages: z.number().int().nonnegative(),
    has_previous: z.boolean(),
    has_next: z.boolean(),
  })
  .strict();
export type RunListPagination = z.infer<typeof RunListPaginationSchema>;

export const RunListPageSchema = z
  .object({
    runs: z.array(RunSummarySchema),
    pagination: RunListPaginationSchema,
    filter: RunListFilterSchema,
  })
  .strict();
export type RunListPage = z.infer<typeof RunListPageSchema>;

/** Rows to skip for a page; the repositories must not paginate in memory. */
export const runListOffset = (query: Pick<RunListQuery, "page" | "limit">) =>
  (query.page - 1) * query.limit;

/**
 * Derived entirely from the filtered count, so a page beyond the last one
 * reports no next page rather than inventing one.
 */
export function runListPagination(input: {
  page: number;
  limit: number;
  total_items: number;
}): RunListPagination {
  const total_pages = Math.ceil(input.total_items / input.limit);
  return RunListPaginationSchema.parse({
    page: input.page,
    limit: input.limit,
    total_items: input.total_items,
    total_pages,
    has_previous: input.page > 1,
    has_next: input.page < total_pages,
  });
}
